# Worker Polling, Concurrency & Stuck-Job Sweep

These rules govern the background worker lifecycle, in-process concurrency management, and recovery mechanisms for abandoned or stuck jobs.

---

## 1. Worker Polling Loop

The worker process (`src/worker/worker.ts`) executes an asynchronous polling cycle:

1. Calculate available capacity: $\text{availableSlots} = \text{CONCURRENCY\_LIMIT} - \text{activeJobsCount}$.
2. If $\text{availableSlots} > 0$:
   - Query and claim up to $\text{availableSlots}$ jobs using the atomic query in `src/worker/claim.ts`.
   - Dispatch each claimed job to an in-process promise pool / async handler.
3. If no jobs claimed or no slots available, sleep for `POLL_INTERVAL_MS` (default `1000ms`).
4. Repeat.

- **Rule:** `CONCURRENCY_LIMIT` is strictly enforced **per worker process**. Multiple worker processes running simultaneously will each process up to `CONCURRENCY_LIMIT` jobs concurrently.

---

## 2. Stuck-Job Sweep Loop

A background timer inside the worker process (`src/worker/sweep.ts`) runs periodically to recover jobs abandoned due to ungraceful worker termination or crashes:

- **Sweep Interval:** Runs every $\text{STUCK\_JOB\_TIMEOUT\_MS} / 2$ (default every 2.5 minutes).
- **Stuck Criteria:** Any job where `status = 'processing'` and `startedAt <= now() - STUCK_JOB_TIMEOUT_MS` (default 5 minutes).
- **Recovery Action:**
  - Increment `attempts`.
  - Append an explanatory message to `lastError` (e.g., `"Job timed out in processing state; recovered by sweep"`).
  - If `attempts < maxAttempts`, reset `status = 'pending'` and compute new `runAt` using backoff.
  - If `attempts >= maxAttempts`, transition `status = 'dead'`.

---

## 3. Dead-Letter View & Manual Retry

- **List Dead Jobs:** `GET /api/jobs/dead` returns all jobs with `status = 'dead'`, including their full `payload`, `attempts`, `lastError`, and timestamp history.
- **Manual Retry:** `POST /api/jobs/:id/retry` allows an operator to recover a dead job:
  - Validates that the target job has `status = 'dead'`.
  - Resets `status = 'pending'`, `attempts = 0`, `lastError = null`, and `runAt = now()`.
  - Returns HTTP `200 OK` with the reset job record.
