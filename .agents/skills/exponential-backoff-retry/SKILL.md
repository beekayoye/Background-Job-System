---
name: exponential-backoff-retry
description: >-
  Procedures for calculating exponential backoff delays with random jitter, tracking retry attempts, and transitioning jobs to dead status.
  Use this skill when implementing retry logic, verifying backoff math, or handling dead-letter state transitions.
---

# Exponential Backoff & Retry Skill

This skill outlines the calculation, state transitions, and manual recovery workflows for retrying transiently failed background jobs.

## 1. Locked Backoff Formula

All retry scheduling must call `computeBackoffDelay()` in `src/lib/backoff.ts`:

$$\text{delay} = \min(\text{BACKOFF\_CAP\_MS}, \text{BACKOFF\_BASE\_MS} \times 2^{\text{attempts}}) + \text{random}(0, \text{JITTER\_FACTOR} \times \text{delay})$$

### TypeScript Implementation:
```typescript
export function computeBackoffDelay(
  attempts: number,
  baseMs: number = config.BACKOFF_BASE_MS,
  capMs: number = config.BACKOFF_CAP_MS,
  jitterFactor: number = config.JITTER_FACTOR
): number {
  const baseDelay = Math.min(capMs, baseMs * Math.pow(2, attempts));
  const jitter = Math.random() * (jitterFactor * baseDelay);
  return Math.round(baseDelay + jitter);
}
```

### Config Defaults:
- `BACKOFF_BASE_MS`: `30000` (30 seconds)
- `BACKOFF_CAP_MS`: `300000` (5 minutes)
- `JITTER_FACTOR`: `0.2` (up to 20% random jitter)
- `MAX_ATTEMPTS`: `5`

---

## 2. Retry State Transition Workflow

When a retryable failure occurs:

```
[Job Fails Retryably]
         │
         ▼
 Increment `attempts`
 Save `lastError`
         │
         ├────────────────────────────────────────┐
         ▼                                        ▼
 (attempts < maxAttempts)               (attempts >= maxAttempts)
         │                                        │
         ▼                                        ▼
 Compute backoff `delay`                  Set `status = 'dead'`
 Set `runAt = now() + delay`              Finished processing
 Set `status = 'pending'`
```

---

## 3. Manual Dead-Letter Recovery Procedure

When an operator reviews dead jobs and triggers a manual retry via `POST /api/jobs/:id/retry`:

1. Query the job row by `id`.
2. Validate that `job.status === 'dead'`. If not, return HTTP `400 Bad Request` with an explanatory error.
3. Reset fields:
   ```typescript
   await prisma.job.update({
     where: { id },
     data: {
       status: 'pending',
       attempts: 0,
       lastError: null,
       runAt: new Date(),
       startedAt: null,
       finishedAt: null,
     },
   });
   ```
4. Return HTTP `200 OK` with the reset job data.
