---
name: atomic-job-claiming
description: >-
  Runbook and instructions for implementing and verifying atomic job claiming using PostgreSQL FOR UPDATE SKIP LOCKED.
  Use this skill when developing, debugging, or testing worker queue claiming and concurrency enforcement.
---

# Atomic Job Claiming Skill

This skill provides step-by-step procedures for implementing and verifying race-condition-free background job claiming using PostgreSQL's `FOR UPDATE SKIP LOCKED` mechanism.

## 1. Locked Query Implementation

All job claiming must be executed via `src/worker/claim.ts` using this exact raw SQL statement:

```sql
UPDATE "Job"
SET status = 'processing', "startedAt" = now()
WHERE id = (
  SELECT id FROM "Job"
  WHERE status = 'pending' AND "runAt" <= now()
  ORDER BY "runAt" ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

### Why this query is locked:
1. `FOR UPDATE SKIP LOCKED` allows concurrent worker processes to skip rows already locked by another transaction, eliminating contention and lock wait times.
2. The enclosing `UPDATE ... WHERE id = (SELECT ...)` ensures that selection and state transition (`pending` -> `processing`) happen in a single atomic database operation.
3. Replacing this with Prisma's `findFirst` + `update` introduces a race condition window where multiple workers can select the same pending job before either updates its status.

---

## 2. In-Process Concurrency Management

Each worker process enforces `CONCURRENCY_LIMIT` independently using an active job counter and promise pool.

### Worker Polling Procedure:
1. Calculate available capacity:
   ```typescript
   const availableCapacity = config.CONCURRENCY_LIMIT - activeJobs.size;
   ```
2. If `availableCapacity <= 0`, do not issue claim queries; sleep for `POLL_INTERVAL_MS`.
3. If `availableCapacity > 0`, query and claim up to `availableCapacity` jobs.
4. Add the job promise to the `activeJobs` tracking set.
5. On completion or failure, remove the job from `activeJobs` and trigger the next polling cycle.

---

## 3. Verification & Testing

To verify atomic claiming integrity:
1. Run the concurrent worker race test:
   ```bash
   npx ts-node tests/break-it/05-two-worker-race.ts
   ```
2. Validate that across 50+ enqueued jobs, zero jobs are claimed or processed by more than one worker.
3. Check database logs to ensure no deadlocks occur during peak concurrent queries.
