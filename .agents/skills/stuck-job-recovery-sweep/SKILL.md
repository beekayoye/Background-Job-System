---
name: stuck-job-recovery-sweep
description: >-
  Procedures for identifying, resetting, and testing stuck background jobs left in processing status after worker crashes or ungraceful termination.
  Use this skill when implementing the sweep timer, tuning recovery intervals, or testing crash recovery.
---

# Stuck-Job Recovery Sweep Skill

This skill provides step-by-step procedures for recovering background jobs abandoned in `processing` status due to process crashes, OOM errors, or network disconnections.

## 1. Sweep Timer Loop Lifecycle

The sweep process runs inside `src/worker/sweep.ts` on a dedicated recurring interval:

- **Interval:** Runs every `STUCK_JOB_TIMEOUT_MS / 2` (default every 150,000ms / 2.5 minutes).
- **Inactivity Threshold:** `STUCK_JOB_TIMEOUT_MS` (default 300,000ms / 5 minutes).

### Sweep Loop Implementation:
```typescript
export function startStuckJobSweep(prisma: PrismaClient, config: Config) {
  const intervalMs = config.STUCK_JOB_TIMEOUT_MS / 2;

  const timer = setInterval(async () => {
    try {
      await recoverStuckJobs(prisma, config);
    } catch (err) {
      console.error('Error in stuck job sweep loop:', err);
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
```

---

## 2. Stuck Job Identification & Recovery Logic

1. Calculate the cutoff timestamp:
   ```typescript
   const cutoffDate = new Date(Date.now() - config.STUCK_JOB_TIMEOUT_MS);
   ```
2. Identify stuck candidate rows:
   ```sql
   SELECT * FROM jobs
   WHERE status = 'processing'
     AND started_at <= $1;
   ```
3. For each stuck job:
   - Increment `attempts = attempts + 1`.
   - Update `lastError = "Job timed out in processing state; recovered by sweep"`.
   - If `attempts < maxAttempts`:
     - Calculate backoff `delay` using `computeBackoffDelay(attempts)`.
     - Set `status = 'pending'`, `runAt = now() + delay`.
   - If `attempts >= maxAttempts`:
     - Set `status = 'dead'`.

---

## 3. Verification & Crash Test Runbook

To verify stuck job recovery:
1. Enqueue a long-running job.
2. Allow the worker to claim the job and transition it to `processing`.
3. Terminate the worker process immediately (`SIGKILL` / `kill -9`).
4. Ensure the API server continues running.
5. Wait for the sweep interval to elapse or trigger the sweep manually.
6. Verify the job row has `status = 'pending'` (or `dead`), `attempts = 1`, and `lastError` populated.
7. Restart the worker and verify the job is claimed and successfully re-processed.
