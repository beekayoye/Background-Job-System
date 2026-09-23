# Code Quality, Phased Build Order & Break-It Tests

These rules define coding standards, the phased execution sequence, test requirements, and protocols for handling ambiguity.

---

## 1. Code Quality & Standards

- **TypeScript Strict Mode:** `"strict": true` in `tsconfig.json`. No `any` types unless accompanied by an explanatory code comment justifying why a narrower type cannot be used.
- **Async/Await Only:** Use standard modern `async`/`await` and Promise handling. No legacy callback-style code.
- **Clean Naming:** Field and variable names must match the PRD schema exactly (`idempotencyKey`, `maxAttempts`, `lastError`, `startedAt`, `finishedAt`, `runAt`).
- **Clean Logging:** No stray `console.log` statements. Logging is restricted to structured error messages and critical system pause alerts.
- **Linting & Formatting:** ESLint and Prettier must pass with zero errors and zero warnings.

---

## 2. Phased Build Order (Do Not Skip Ahead)

Implementation must follow this sequential order. No subsequent phase may begin until the preceding phase is verified:

1. **Phase 1: Environment & Enqueue Layer**
   - Setup Prisma schema, migration scripts, `.env.example`, and typed `config.ts`.
   - Build `POST /api/jobs` with server-side UUID generation for missing keys and idempotency enforcement at the database level.
2. **Phase 2: Worker & Email Pipeline**
   - Implement `claim.ts` with the verbatim atomic query.
   - Implement `src/jobs/email/` provider interface, mock adapter, failure classification, and `backoff.ts`.
   - Verify end-to-end execution from `pending` to `succeeded` or `dead`.
3. **Phase 3: Recovery, Dead-Letter & UI**
   - Implement `sweep.ts` stuck-job recovery loop.
   - Implement `GET /api/jobs/:id`, `GET /api/jobs/dead`, and `POST /api/jobs/:id/retry`.
   - Build minimal static HTML page in `src/public/index.html`.
4. **Phase 4: Break-It Test Suite & Verification**
   - Execute all five break-it test scripts and capture concrete evidence.

---

## 3. Required Break-It Tests (Phase 4)

All five automated break-it test scripts in `tests/break-it/` must pass:

1. **`01-idempotency.ts`:** Submits duplicate idempotency keys concurrently; verifies that exactly 1 database row is created and subsequent requests receive HTTP 200 with the original job ID.
2. **`02-concurrency-cap.ts`:** Enqueues 50 concurrent jobs against a single worker process; verifies that concurrent active jobs never exceed `CONCURRENCY_LIMIT`.
3. **`03-forced-failure-to-dead.ts`:** Simulates an unrecoverable failure; verifies that the job attempts retries with expanding backoff delays and transitions to `status = 'dead'` after exactly `maxAttempts`.
4. **`04-stuck-job-recovery.ts`:** Simulates worker termination mid-execution; verifies that `sweep.ts` detects the stale job after `STUCK_JOB_TIMEOUT_MS`, increments `attempts`, and resets it to `pending`.
5. **`05-two-worker-race.ts`:** Runs two concurrent worker processes against the same pending queue; verifies zero double-claims across all jobs.

---

## 4. Ambiguity & Scope Protocol

- **Never invent features:** Do not add user signups, email template engines, analytics dashboards, or multi-tenant billing unless explicitly requested.
- **Never write speculative code:** Adhere strictly to the current phase requirements.
- **Stop and ask:** If a requirement in the PRD or `AGENTS.md` is contradictory or ambiguous, stop and ask the user rather than silently guessing.
