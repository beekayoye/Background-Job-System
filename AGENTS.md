# AGENTS.md

Instructions for any AI coding agent (including Antigravity) building this project. The PRD tells you **what** to build and **why**. This file tells you **how to behave** while building it. If something here conflicts with your own judgment or with a "better" idea, this file wins. If something here conflicts with the PRD, stop and ask — do not silently pick one.

---

## 1. What is this project

This is a background job processing system. It takes a slow, unreliable unit of work — sending a transactional email through a third-party provider — off the live HTTP request path, runs it asynchronously, retries it safely on failure, and proves what happened to every job through a status endpoint and a dead-letter view.

- **Who it's for:** a single demo user, identified by a fixed API key. No public users, no customer base.
- **Version being built:** v3 of the PRD, dated 2026-09-22 — the version where the job type is a transactional email send, not the earlier AI-model-call version.
- **Source of truth:** `prd-reliable-job-system-v2.md` (the PRD, v3 content) in this repo. If this AGENTS.md and the PRD ever disagree on *what* the product does, the PRD wins. If they disagree on *how* to build it, this file wins. If you can't tell which kind of disagreement it is, stop and ask — see Section 7.
- **Framing:** this is a portfolio/learning project demonstrating reliable job processing patterns, not a commercial product (PRD Product Summary, Assumption 1). Do not build as if there are paying customers, a sales funnel, or a growth target, unless a human tells you otherwise.

---

## 2. What is locked

Everything in this section was already decided in the PRD. **You must never change, swap, "improve," or work around any of it**, even if you know a library you like better, even if a newer pattern exists, even if it would make the code shorter.

### 2.1 Stack

- **Language/runtime:** Node.js, Active LTS release, TypeScript. Do not use plain JavaScript for source files.
- **Database:** PostgreSQL. Not MySQL, not SQLite, not a hosted "serverless Postgres" abstraction that changes the semantics of `FOR UPDATE SKIP LOCKED`.
- **ORM:** Prisma. Do not hand-roll a query builder or swap to Drizzle/TypeORM/Knex.
- **API framework:** Express (chosen over Next.js API routes because this project has no frontend beyond one static page — PRD Technical Requirements).
- **Worker:** a separate, long-running Node.js process. Not a serverless function, not a cron-triggered Lambda, not a queue-as-a-service (SQS, BullMQ-on-Redis, etc.). The whole point of this project is building the queueing and claiming logic yourself.
- **Deployment target:** local machine only, this version. Never add Dockerfiles for production hosting, cloud deploy configs, or CI/CD deploy pipelines unless a human explicitly asks (PRD Non-Goal 4).
- **Config:** every tunable value lives in an environment variable. Never hardcode a config value as a literal in source code, even a "temporary" one.

### 2.2 Locked data model

Implement the Prisma schema exactly as specified below. Do not add fields, rename fields, change types, drop the index, or convert `type`/`status` between String and enum differently than shown.

```prisma
// Payload shape for this job type: { "to": string, "subject": string, "body": string }
model Job {
  id             String    @id @default(uuid())
  type           String
  payload        Json
  status         JobStatus @default(pending)
  attempts       Int       @default(0)
  maxAttempts    Int       @default(5)
  lastError      String?
  runAt          DateTime  @default(now())
  startedAt      DateTime?
  finishedAt     DateTime?
  idempotencyKey String    @unique
  result         Json?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([status, runAt])
}

enum JobStatus {
  pending
  processing
  succeeded
  failed
  dead
}
```

`type` is intentionally a `String`, not an enum — new job types can be added later without a migration. Do not "fix" this into an enum.

### 2.3 Locked technical contracts

These are not suggestions. An implementation that "works" but deviates from any of these still fails the task.

- **Claim query.** The worker claims a job with exactly this statement. Never replace it with a `findFirst` followed by an `update` (that reintroduces the race condition this whole project exists to prevent):
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
- **Backoff formula.** Use exactly this, in one shared function, never re-implemented per call site:
  `delay = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^attempts) + random(0, JITTER_FACTOR * delay)`
- **Duplicate idempotency key** returns HTTP `200` with the existing job. Not `202` — nothing new was created.
- **New job enqueued successfully** returns HTTP `202` with the job id. Never do the work before responding.
- **Concurrency cap is per worker process**, not global. Do not build a shared cross-process counter (Redis, a Postgres advisory-lock count, etc.) unless a human explicitly asks for it.

### 2.4 Locked config defaults

| Variable | Default | Never do this |
| --- | --- | --- |
| MAX_ATTEMPTS | 5 | Don't hardcode 5 in the retry logic — read it from env, this is just the default value |
| BACKOFF_BASE_MS | 30000 | — |
| BACKOFF_CAP_MS | 300000 | Don't set this back to 30 minutes — it was deliberately lowered so it's actually reachable within MAX_ATTEMPTS |
| JITTER_FACTOR | 0.2 | — |
| CONCURRENCY_LIMIT | 5 | — |
| STUCK_JOB_TIMEOUT_MS | 300000 | — |
| POLL_INTERVAL_MS | 1000 | — |
| EMAIL_API_KEY | — (required, no default) | Never commit a real value; never log it |
| EMAIL_API_TIMEOUT_MS | 10000 | — |
| EMAIL_FROM_ADDRESS | — (required, no default) | — |

### 2.5 Email provider — locked pending one decision

The PRD does not lock a specific email provider (SendGrid, Postmark, AWS SES, and Mailgun are all still open — PRD Open Question 2/12). This is the one piece of "locked" scope that is deliberately unresolved. Do not silently pick one and wire its SDK directly into business logic. Instead:

- Define a small internal `EmailProvider` interface (send a message, return a provider message id or throw a classified error).
- Implement exactly one concrete adapter behind it, clearly marked as the placeholder/default, so swapping providers later never touches the job-processing logic.
- If you must pick one to make forward progress, pick the one with the simplest sandbox/test mode and say so in your output — do not treat the choice as final or hide that it was your default, not a confirmed decision.

---

## 3. What must never happen

Everything below is a business or user-protection rule. **Breaking any rule on this list means the task failed, even if the code runs, even if the feature "works."** Where a PRD section backs the rule, it's cited.

1. **Never call the email provider synchronously inside the HTTP request handler.** Enqueue must only ever write a row and return. All sending happens in the worker process. (PRD Goal 1, Problem Statement)
2. **Never let two workers process the same job.** The atomic claim statement in Section 2.3 is the only acceptable mechanism — no exceptions, no "it passed my test so it's probably fine." (PRD Goal 3, FR5)
3. **Never retry a job whose failure was classified as permanent** (malformed request, or a recipient address the provider itself rejected as invalid). Retrying a rejected address risks the sending domain's reputation and account standing. (PRD Email Delivery Pipeline — Permanent failures)
4. **Never dead-letter every queued job one at a time on a credential failure (401/403).** On the first 401/403, pause pulling new jobs and raise an alert instead. A bad API key is a system-wide outage, not 50 individual unfixable jobs. (PRD Email Delivery Pipeline — System-level failures)
5. **Never claim or imply exactly-once email delivery.** This system provides at-least-once delivery. Do not build extra machinery (two-phase commit, distributed locks, etc.) to "solve" this without being explicitly asked — document the residual risk instead of hiding it or over-engineering around it. (PRD Assumption 19, Risk 7)
6. **Never add authentication beyond the fixed API key.** No signup, no session login, no OAuth, no password reset flow. Only requests carrying the correct fixed API key may enqueue a job or read job status. (PRD Non-Goal 5)
7. **Never add multi-tenant support or billing.** Single demo user only, this version. (PRD Non-Goal 2)
8. **Never deploy this to the cloud, and never add infrastructure that assumes cloud deployment** (managed queues, managed Postgres with proprietary extensions, autoscaling configs). (PRD Non-Goal 4)
9. **Never build email deliverability, tracking, or analytics features** (open/click tracking, spam scoring, template editing UI). This system only confirms the provider accepted the send. (PRD Non-Goal 6)
10. **Never commit secrets.** `EMAIL_API_KEY` and `DATABASE_URL` must only ever come from environment variables, never appear in source, never appear in logs, never appear in a committed `.env` file. Provide `.env.example` with empty/placeholder values instead.
11. **Never log the full email body or full recipient address in plaintext application logs at info level.** Payload data is personal data by definition (PRD Risk 2). If you need to log for debugging, log the job id, not the payload contents.
12. **Never build UI beyond the one static trigger/status page and the dead-letter view.** No design system, no component library, no styling framework. (PRD Non-Goal 1)

---

## 4. How the work is arranged

### 4.1 Folder layout

```
/prisma
  schema.prisma

/src
  /api
    server.ts            # Express app entry point — the HTTP process
    routes/
      jobs.ts             # POST /api/jobs, GET /api/jobs/:id, GET /api/jobs/dead, POST /api/jobs/:id/retry
    middleware/
      auth.ts              # checks the fixed API key; nothing else

  /worker
    worker.ts              # entry point — the polling loop process, run separately from server.ts
    claim.ts                # the one atomic claim query from Section 2.3, and nowhere else
    sweep.ts                 # the stuck-job sweep loop (runs inside the worker process, its own interval)

  /jobs
    /email
      provider.ts            # EmailProvider interface + the one placeholder adapter (Section 2.5)
      handler.ts               # calls the provider, classifies retryable / permanent / system-level failures

  /lib
    prisma.ts                  # one shared Prisma client instance — never instantiate a second one
    backoff.ts                   # the one backoff+jitter function from Section 2.3 — every retry path calls this, nothing recomputes it inline
    config.ts                     # loads and validates every env var in Section 2.4 in one place, at startup — fail fast if one required var is missing

  /public
    index.html                     # the minimal trigger + status page — plain HTML/CSS/vanilla JS, no build step, no framework

/tests
  break-it/
    01-idempotency.ts              # Phase 4 test scripts — see Section 6
    02-concurrency-cap.ts
    03-forced-failure-to-dead.ts
    04-stuck-job-recovery.ts
    05-two-worker-race.ts

.env.example
package.json
tsconfig.json
README.md
```

### 4.2 Boundaries that must never be crossed

- **`/api` and `/worker` are two separate entry points, run as two separate processes.** Never import worker polling logic into the Express app so it "just runs in the background" of the API process. They must be startable and killable independently — the stuck-job-recovery test in Phase 4 depends on being able to kill the worker process without touching the API.
- **Only `claim.ts` may run the atomic claim query.** No other file writes `status = 'processing'`.
- **Only `backoff.ts` computes retry delays.** No inline `Math.pow` or hand-rolled backoff math anywhere else in the codebase.
- **Only `provider.ts` knows which email vendor is in use.** `handler.ts` and everything upstream of it talks to the `EmailProvider` interface, never to a vendor SDK directly.
- **`config.ts` is the only place that reads `process.env`.** Every other file imports typed config values from it.

### 4.3 Build order — do not get ahead of yourself

Build in this order and do not start a later phase until the one before it is working and verified. Building the dead-letter UI before the enqueue endpoint works, or wiring retries before the atomic claim is proven correct, counts as a failure even if it "happens to work" later.

1. **Phase 1:** Postgres + Prisma migration + `.env` setup, then `POST /api/jobs` with idempotency enforcement at the database level.
2. **Phase 2:** the worker's claim loop, the email pipeline, backoff, and the dead-status transition.
3. **Phase 3:** the stuck-job sweep, the dead-letter endpoint + view, the status endpoint, and the static trigger/status page.
4. **Phase 4:** the five break-it test scripts and their captured evidence.

---

## 5. How the code should look

- TypeScript in `strict` mode. No `any` unless you leave a comment explaining why nothing else works.
- Node.js Active LTS (currently the 22.x line) — pin it in `package.json` `engines` and in `.nvmrc`. Do not target an End-of-Life Node version.
- `async`/`await` everywhere. No callback-style code, no unhandled promise rejections.
- Use the exact field and variable names from the PRD's Prisma schema and config table (Sections 2.2, 2.4). Don't rename `idempotencyKey` to `idempotency_key`, don't rename `EMAIL_API_KEY` to `SMTP_KEY`, even if you think it reads better.
- One responsibility per file, matching the folder layout in Section 4.1. If a file is doing two things from two different folders' worth of responsibility, split it.
- No commented-out code. No `console.log` left in outside of the specific structured logs the PRD calls for (the 401/403 system-pause alert, and error logging tied to `lastError`).
- Comment the *why*, not the *what* — the atomic claim query and the backoff clamp deserve a comment explaining the race condition or the math; a line like `payload: Json // the payload` does not.
- Run a linter and formatter (ESLint + Prettier, or the project's existing config if one exists) and leave zero warnings before calling anything done.

---

## 6. What counts as done

Before reporting a phase or the project complete, go through this checklist and report the result of each item honestly — including the ones that failed.

**Build health**
- [ ] `tsc --noEmit` (or the project's build command) passes with zero errors.
- [ ] The linter runs with zero errors and zero warnings.
- [ ] `prisma migrate` applies cleanly against a fresh database.

**Functional requirements (PRD Section 5, FR1–FR12)**
- [ ] POST /api/jobs returns 202 with a job id and performs no synchronous work.
- [ ] Missing idempotencyKey is generated server-side before insert.
- [ ] Duplicate idempotencyKey returns 200 with the existing job, not a new row.
- [ ] The claim query in Section 2.3 is used verbatim, atomically.
- [ ] CONCURRENCY_LIMIT is enforced per worker process.
- [ ] Failure handling increments attempts, stores lastError, and applies the exact backoff formula, or transitions to dead at maxAttempts.
- [ ] The stuck-job sweep resets processing jobs older than STUCK_JOB_TIMEOUT_MS back to pending.
- [ ] GET /api/jobs/:id returns status, attempts, lastError, timestamps.
- [ ] GET /api/jobs/dead lists dead jobs with full payload and lastError.
- [ ] POST /api/jobs/:id/retry resets a dead job to pending with attempts at 0.
- [ ] The static trigger/status page exists and works against the live API.

**Break-it tests (PRD Phase 4) — each needs a script and captured evidence**
- [ ] 50 concurrent enqueues against a single worker process, with the concurrent count logged and shown to hold at CONCURRENCY_LIMIT.
- [ ] A job forced to fail every time is traced to dead status, with growing backoff timestamps visible.
- [ ] The worker is killed mid-job and restarted; the stuck job is recovered and reprocessed.
- [ ] The same idempotency key submitted twice results in exactly one job row.
- [ ] Two worker processes run concurrently against the same queue with zero double-claimed jobs.

**Business/user protection rules (Section 3)**
- [ ] None of the 12 "must never happen" rules were violated. If one was, it's reported explicitly, not omitted.

Do not report "done" if any box above is unchecked. Report the checklist as-is, with the unchecked boxes visible, rather than only listing what passed.

---

## 7. What to do when unsure

You will hit situations this document and the PRD don't fully answer — the email provider choice (Section 2.5) is the known one, but others will come up.

- **Never invent a new feature or expand scope to fill the gap.** If the PRD doesn't ask for it, you don't build it, no matter how natural it seems (a settings page, a login screen, a retry-all button, email templates, a metrics dashboard — none of these were asked for).
- **Never write speculative or "just in case" code.** If you're not sure a piece of logic is needed yet, per the Build Order in Section 4.3, it probably isn't yet — leave it out rather than stub it in badly.
- **Prefer the smallest correct implementation over a clever one.** If you're choosing between a straightforward approach and one that's shorter but harder to follow, take the straightforward one.
- **If a decision is genuinely unresolved in the PRD** (an Open Question — email provider, encryption at rest, payload size limits, etc.), do not silently resolve it by guessing. Either implement behind an interface so the decision is deferred cleanly (as in Section 2.5), or stop and flag the specific open question by name rather than pushing forward on an assumption.
- **If you're unsure whether something belongs in this phase**, it doesn't. Finish and verify the current phase from Section 4.3 first.
- **When truly stuck between two reasonable interpretations of a rule in this file or the PRD, stop and ask a human. Do not pick one silently and keep going.** A wrong guess compounds; a stalled task with a clear question does not.