---
name: break-it-testing
description: >-
  Runbooks and verification procedures for executing and recording evidence for the five mandatory Phase 4 break-it test scripts.
  Use this skill when running test scripts, measuring concurrency caps, capturing backoff evidence, or verifying multi-worker race conditions.
---

# Break-It Testing Skill

This skill provides step-by-step procedures for executing, capturing evidence, and validating the five mandatory Phase 4 break-it tests required by the PRD and `AGENTS.md`.

## 1. Test Suite Overview

| Test Script | Target Goal | Success Criteria |
| :--- | :--- | :--- |
| `01-idempotency.ts` | Duplicate submissions | 1 job row created; second call returns 200 with existing job ID |
| `02-concurrency-cap.ts` | Concurrency limit | Active jobs never exceed `CONCURRENCY_LIMIT` on a single worker |
| `03-forced-failure-to-dead.ts`| Backoff & dead transition | Exactly `maxAttempts` retries with expanding intervals to `dead` |
| `04-stuck-job-recovery.ts` | Worker crash recovery | Sweep detects stuck job and resets it to `pending` |
| `05-two-worker-race.ts` | Two-worker race condition | Zero jobs claimed or processed twice across concurrent workers |

---

## 2. Test Execution Procedures

### Test 1: Idempotency Enforcement (`01-idempotency.ts`)
```bash
npx ts-node tests/break-it/01-idempotency.ts
```
1. Generate a fixed `idempotencyKey`.
2. Issue two concurrent `POST /api/jobs` requests with the same key.
3. Assert that request 1 receives HTTP `202` and request 2 receives HTTP `200`.
4. Assert that `SELECT count(*) FROM jobs WHERE idempotencyKey = ...` returns exactly 1.

### Test 2: In-Process Concurrency Cap (`02-concurrency-cap.ts`)
```bash
npx ts-node tests/break-it/02-concurrency-cap.ts
```
1. Start a single worker process with `CONCURRENCY_LIMIT = 5`.
2. Enqueue 50 slow jobs simultaneously.
3. Sample the worker's active in-flight count every 50ms.
4. Assert that the active count never exceeds 5 at any point in time.

### Test 3: Forced Failure to Dead (`03-forced-failure-to-dead.ts`)
```bash
npx ts-node tests/break-it/03-forced-failure-to-dead.ts
```
1. Configure the mock email provider to return HTTP 500 continuously for a specific test job.
2. Monitor the job row's `status`, `attempts`, `lastError`, and `runAt` values across retries.
3. Assert that retry delays grow exponentially with jitter.
4. Assert that after attempt 5 (`maxAttempts`), `status` transitions to `dead`.

### Test 4: Stuck Job Recovery (`04-stuck-job-recovery.ts`)
```bash
npx ts-node tests/break-it/04-stuck-job-recovery.ts
```
1. Start worker process A.
2. Enqueue a job and wait for worker A to claim it (`status = 'processing'`).
3. Kill worker A process immediately (`kill -9`).
4. Trigger or wait for the sweep loop (`sweep.ts`).
5. Assert that the job transitions back to `status = 'pending'` with `attempts = 1`.
6. Start worker process B and assert that the job is claimed and completes.

### Test 5: Two-Worker Race Condition (`05-two-worker-race.ts`)
```bash
npx ts-node tests/break-it/05-two-worker-race.ts
```
1. Spawn two separate worker processes (Worker A and Worker B) connected to the same database.
2. Enqueue 50 jobs rapidly.
3. Record the claiming worker ID for every job execution.
4. Assert that each of the 50 jobs was claimed and processed by exactly one worker with zero collisions.

---

## 3. Evidence Capture & Reporting

Before marking Phase 4 complete:
1. Capture console output logs for all 5 test scripts.
2. Ensure all assertions in the test scripts pass with exit code 0.
3. Document timestamp progressions and database verification logs.
