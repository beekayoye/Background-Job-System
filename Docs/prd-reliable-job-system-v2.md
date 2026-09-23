# Reliable Background Job System — PRD (v3)

*Version 3 — the job type was changed from an AI model API call to sending a transactional email through a third-party provider, decided on 2026-09-22. Every AI-specific line has been replaced. The original required section list (from the PRD-generation prompt) named this section "AI Processing Pipeline" on the assumption the job type would be an AI call — it is renamed "Email Delivery Pipeline" below to match the actual job type, and that deviation is called out here rather than done silently. Version 2's review corrections (concurrency-cap wording, the exact claim query, the missing UI page, the backoff math, etc.) are all still in effect below.*

## Product Summary

This system moves a slow or unreliable unit of work out of the live request path and runs it in the background with retries, atomic locking, and full audit visibility. The job type is a call to a third-party transactional email provider that sends an email — recipient, subject, and body — based on user-submitted input. A client submits a job through an HTTP endpoint, receives an id immediately, and polls a status endpoint until the job succeeds, exhausts its retries, or lands in a dead state that a human must review. [ASSUMPTION] This is built and evaluated as a portfolio and learning project demonstrating reliable job processing patterns, not launched as a commercial product, since the project type input was not confirmed. This assumption directly shapes the Business Model and Phased Roadmap sections below; if it's wrong, treat both as placeholders.

## Problem Statement

Today, if a request handler calls the email provider directly and waits for the response, three things break at once. First, the request thread is held open for as long as the provider takes to accept the send, which can be seconds or can time out entirely, so the user's connection may drop before a confirmation ever comes back. Second, if the send fails (rate limit, timeout, transient 500 from the provider), there is no retry: the user gets an error and has to resubmit by hand, with no record that the first attempt ever happened. Third, if the user's client retries the same submission automatically (a double click, a network retry), the system has no way to recognize it is the same logical request, so it calls the email provider twice — and unlike a generic API call, this failure mode is immediately visible and embarrassing: the recipient gets the same email in their inbox twice. The job system fixes this by making enqueue instant and separate from execution, retrying failures automatically with backoff, and using an idempotency key to collapse duplicate submissions into one job.

## Goals and Non-Goals

**Goals** (each testable against a break-it test):

1. Enqueuing a job performs no synchronous external API calls during the request, verified by code review and request tracing, and returns 202 with a job id.
2. A duplicate idempotency key never creates a second job row, verified by submitting the same key twice and counting rows.
3. Two workers running against the same queue never both claim the same job, verified by running two worker processes concurrently.
4. A job that fails every attempt reaches dead status after exactly maxAttempts tries, with retry delays visibly growing between attempts.
5. A worker killed mid-job never permanently loses that job; it is recovered and retried after the stuck job timeout.
6. Concurrency never exceeds CONCURRENCY_LIMIT **per worker process**, verified by enqueuing 50 jobs against a single worker process and logging the concurrent count.

**Non-Goals**

1. No UI beyond a minimal trigger form and a status/dead-letter view. No design system, no styling polish.
2. No multi-tenant support and no billing. Single demo user only.
3. No horizontal scaling beyond the number of worker processes started manually in this version. No orchestration, no auto-scaling.
4. No cloud deployment. This version runs on a local machine only.
5. No session-based authentication, signup, or password flow.
6. **[Updated for email]** Email deliverability, spam-filter placement, open/click tracking, and template rendering quality are not evaluated or guaranteed by this system — only that the send request was accepted by the provider and a provider message id was recorded.

## User Personas

**Demo User.** Submits a job — an email to send, given a recipient, subject, and body — either through the minimal trigger page or by calling the enqueue endpoint directly with a fixed API key. Needs an immediate acknowledgment (job id, 202 status) and a way to check whether the email was sent, is still retrying, or has failed permanently.

**Operator (the developer).** Watches the system while it runs and after it fails. Needs a single view that lists every job stuck in dead status with its full payload and last error message, and a button to manually retry one without touching the database directly. This is the first place the operator looks when something goes wrong.

## Functional Requirements

1. POST /api/jobs accepts a type, payload, and an optional idempotencyKey, writes a row with status pending, and returns 202 with the job id. It performs no work synchronously.
2. If the client omits idempotencyKey, the server generates one (UUID v4) before insert, so the column stays non-nullable and the uniqueness constraint is always enforced.
3. If idempotencyKey matches an existing row, the endpoint returns **HTTP 200** (not 202, since no new resource was created) with the existing job's id and current status.
4. [ASSUMPTION] idempotencyKey is not scoped per user and does not expire in this version. This is a known limitation, not an oversight — see Open Questions.
5. The worker claims a job with this exact atomic statement, which both picks the oldest eligible job and guarantees exactly one worker receives it:
   ```sql
   UPDATE jobs
   SET status = 'processing', started_at = now()
   WHERE id = (
     SELECT id FROM jobs
     WHERE status = 'pending' AND run_at <= now()
     ORDER BY run_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED
   )
   RETURNING *;
   ```
6. The worker processes at most CONCURRENCY_LIMIT jobs at the same time, **enforced per worker process** (see Technical Requirements for what this means when multiple worker processes run at once).
7. On failure, the worker increments attempts, stores the error in lastError, and if attempts is below maxAttempts, sets status back to pending and sets runAt to now plus a clamped exponential backoff delay with jitter: `delay = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^attempts) + random(0, JITTER_FACTOR * delay)`. If attempts has reached maxAttempts, status is set to dead.
8. A sweep process runs on an interval and resets any job in processing for longer than STUCK_JOB_TIMEOUT_MS back to pending, incrementing attempts.
9. GET /api/jobs/:id returns status, attempts, lastError, and timestamps for a given job id.
10. GET /api/jobs/dead lists every job in dead status with its full payload and lastError.
11. POST /api/jobs/:id/retry resets a dead job back to pending with attempts reset to 0, for manual recovery from the dead letter view.
12. A single static HTML page with a form that POSTs to /api/jobs and an input field that GETs /api/jobs/:id and displays the result — this is the "minimal trigger and status view" required by the project brief.

## Email Delivery Pipeline

*[Renamed from "AI Processing Pipeline." The original required section list assumed an AI job type by default; now that the job type is email sending, this section covers the same ground for the new job type: the exact external call, its failure classification, and — the part that matters most for email specifically — how idempotent delivery is actually handled.]*

The worker calls a single third-party transactional email provider's API (SendGrid, Postmark, and AWS SES are the leading candidates — see Open Questions for which one) sending the payload's `to`, `subject`, and `body` fields as the request. The call is made with a hard timeout of EMAIL_API_TIMEOUT_MS (default 10000ms). [ASSUMPTION: shorter than the AI pipeline's former timeout, since transactional email APIs typically respond in well under a second when healthy.]

**Retryable failures** (job returns to pending with backoff): request timeout, HTTP 429 (rate limited), HTTP 5xx from the provider, and network-level connection errors.

**Permanent failures, per job** (job goes straight to dead regardless of remaining attempts): HTTP 400 (malformed request) and a recipient address the provider's own validation rejects as syntactically invalid. Repeatedly retrying a send to an address the provider has already rejected risks the sending domain's reputation and can get the whole account rate-limited or suspended, so this must not retry.

**System-level failures** (unchanged in design from v2): HTTP 401/403 (bad credentials) is a sign the whole pipeline is broken, not that one job is unfixable. On the first 401/403, the worker logs a critical alert and pauses pulling new jobs entirely, rather than dead-lettering every queued email one at a time while the credential problem persists.

**Idempotent delivery — the hardest part of this pipeline.** [ASSUMPTION, and the single biggest open risk in this document] A worker can call the provider successfully, receive a 200 and a message id, and then crash before it writes `succeeded` to the job row. The sweep will later see that job as stuck, reset it to pending, and a second worker will send the same email again. This PRD does not claim to fully solve that without knowing the chosen provider: if the provider accepts a client-supplied idempotency or dedupe token, that token should be the job's `idempotencyKey`, and the provider itself refuses the duplicate send. If it doesn't, the honest position is that this system provides **at-least-once delivery, not exactly-once**, and the crash window between "provider accepted the send" and "job row marked succeeded" is a documented residual risk (see Risks), not a solved problem. Writing `succeeded` immediately after the provider call returns, with nothing else in between, is the practical mitigation — it narrows the window, it does not close it.

**Result storage.** The `result` Json field on the Job row stores the provider's response once the send succeeds — a message id and a timestamp — written before status is set to succeeded.

## Technical Requirements

**Framework: Express.** [ASSUMPTION] Chosen over Next.js API routes because this system has no frontend beyond a minimal trigger and status page, and Express keeps the API and worker as plain Node processes without pulling in a React build pipeline for a project that is fundamentally a backend systems exercise.

**Worker polling loop.** A dedicated Node.js process runs an infinite loop: sleep POLL_INTERVAL_MS, query for up to (CONCURRENCY_LIMIT minus jobs currently in flight) eligible jobs (status pending, runAt <= now), attempt to atomically claim each with the UPDATE-returning statement in Functional Requirement 5, and process claimed jobs concurrently up to the cap using an in-process semaphore or a fixed-size promise pool. [ASSUMPTION] POLL_INTERVAL_MS is not in the original fixed config list; default 1000ms.

**Concurrency cap is per worker process, not global.** CONCURRENCY_LIMIT is enforced independently inside each worker process. Running two worker processes for the atomic-claim test means total system concurrency can reach 2× CONCURRENCY_LIMIT — that is expected and correct behavior for that test, not a cap violation. The 50-job concurrency-cap test (Phase 4) is run against a **single** worker process specifically so the logged concurrent count can be checked against CONCURRENCY_LIMIT directly.

A separate sweep loop runs every STUCK_JOB_TIMEOUT_MS / 2 and resets processing jobs older than STUCK_JOB_TIMEOUT_MS.

**Configuration values and defaults:**

| Variable | Default | Purpose |
| --- | --- | --- |
| DATABASE_URL | — | Postgres connection string |
| MAX_ATTEMPTS | 5 | retries before a job goes dead |
| BACKOFF_BASE_MS | 30000 | base delay for exponential backoff |
| BACKOFF_CAP_MS | 300000 | maximum backoff delay, chosen so it is actually reachable within MAX_ATTEMPTS — see Risks |
| JITTER_FACTOR | 0.2 | [ASSUMPTION] max proportion of the computed delay added as random jitter |
| CONCURRENCY_LIMIT | 5 | max jobs processed at once, per worker process |
| STUCK_JOB_TIMEOUT_MS | 300000 | time in processing before a job is considered stuck |
| POLL_INTERVAL_MS | 1000 | [ASSUMPTION] worker loop sleep interval |
| EMAIL_API_KEY | — | [Renamed from AI_API_KEY] credential for the email provider |
| EMAIL_API_TIMEOUT_MS | 10000 | [Renamed and re-tuned from AI_API_TIMEOUT_MS] per-call timeout for the send request |
| EMAIL_FROM_ADDRESS | — | [ASSUMPTION, new] the verified sender address the provider requires for every send |

## Business Model

[ASSUMPTION] Because the project type input was left unconfirmed, this PRD treats the system as an internal, unmonetized portfolio project built to demonstrate reliable background job processing, not a product with pricing or customers. This section is intentionally left thin rather than padded with an invented pricing model. See Open Questions: confirm whether this should instead be framed as a real product pitch, which would require defining pricing, target customer, and a competitive comparison.

## Risks

1. **Email provider cost and rate limits.** Every retry re-calls a paid or rate-limited third-party email API. A misconfigured backoff or a provider outage could hit rate limits fast or run up cost on paid tiers; mitigated by capped attempts and exponential backoff, but the cap must be tuned to the provider's actual limits, which are unknown until one is chosen.
2. **Sensitive data in the payload.** The payload — recipient address, subject, body — is stored as plain JSON in Postgres with no encryption, and a recipient's email address is personal data by definition, not a hypothetical concern. It sits in the database and in lastError messages indefinitely, since this version has no data retention or deletion policy.
3. **Single local Postgres instance, no backup.** Because deployment is local-only in this version, a disk failure or accidental drop loses every job record and all history, with no recovery path.
4. **Recovery window after a worker crash.** A job stays in processing, unrecoverable, for up to STUCK_JOB_TIMEOUT_MS before the sweep resets it. If that value is set too high, users see stalled jobs for longer than expected; if set too low, a slow-but-healthy job could be reset and retried while still legitimately running — see Risk 7 for why this specific scenario matters more for email than it did for the earlier AI job type.
5. **Unbounded input size.** Nothing in the fixed requirements caps the email body length. A very large body could exceed the provider's own size limit, causing repeated permanent failures, or push the account into a higher pricing tier unexpectedly.
6. **No automated regression test suite.** Reliability is proven only by manually run break-it tests documented with screenshots. Nothing catches a future code change that silently reintroduces a fixed bug (for example, breaking the atomic claim query again).
7. **[New, job-type specific] Duplicate-send risk in the crash window.** As documented in the Email Delivery Pipeline section, a worker crash between a successful provider response and the job being marked succeeded can cause the same email to be sent twice on retry. This is only fully closed if the chosen provider supports a dedupe/idempotency token; otherwise it remains a known, unsolved residual risk of this design, not something this PRD papers over.
8. **[New, job-type specific] Sender reputation and deliverability.** Repeated retries to failing or invalid addresses, or a spike in send volume during the 50-job concurrency test, can affect the sending domain's reputation with the provider or with receiving mail servers — independent of whether this system's own logic is correct.

## Prisma Data Model

```prisma
// Payload shape for this job type: { "to": string, "subject": string, "body": string }
model Job {
  id             String    @id @default(uuid())
  type           String    // intentionally a String, not an enum: new job types can be added without a migration; validity of `type` is checked in application code at the enqueue endpoint, not the database
  payload        Json
  status         JobStatus @default(pending)
  attempts       Int       @default(0)
  maxAttempts    Int       @default(5)
  lastError      String?
  runAt          DateTime  @default(now())
  startedAt      DateTime?
  finishedAt     DateTime?
  idempotencyKey String    @unique // server-generates a UUID when the client omits one (see Functional Requirement 2); not scoped per user and does not expire in this version; doubles as the provider's dedupe token if one is supported
  result         Json?     // stores the email provider's response (message id, timestamp) once the send succeeds
  createdAt      DateTime  @default(now()) // [ASSUMPTION] audit trail, distinct from runAt
  updatedAt      DateTime  @updatedAt        // [ASSUMPTION] audit trail

  @@index([status, runAt]) // required for the worker's claim query to be efficient
}

enum JobStatus {
  pending
  processing
  succeeded
  failed
  dead
}
```

*Note: Prisma does not natively express an `attempts <= maxAttempts` CHECK constraint. This invariant is enforced only in application code (the retry handler), not the database, in this version.*

## Success Metrics

1. Job success rate (succeeded / total non-pending jobs) of at least 95% under normal, non-adversarial test conditions, **measured over a minimum of 30 jobs** — smaller sample sizes are not treated as meaningful.
2. Two separate latency metrics, since a single metric would conflate system performance with the email provider's own performance:
   - *Enqueue-to-claim latency* (this system's own responsibility): under 2 seconds median when a worker is idle and polling.
   - *End-to-end completion time* including the email provider's own response time: reported for visibility, not held to a strict target, since it depends on a provider this system does not control.
3. Dead letter rate under 5% of total jobs submitted during normal testing; 100% of forced-failure test jobs correctly reach dead within maxAttempts.
4. Zero incidents of a single job being processed twice, verified across the two-worker concurrency test and the double-submission idempotency test — **with the explicit caveat from Risk 7** that this metric covers claim-level double-processing, not the separate, unresolved crash-window duplicate-send risk.
5. 100% of stuck jobs (worker killed mid-processing) are recovered and re-processed within STUCK_JOB_TIMEOUT_MS + POLL_INTERVAL_MS of the kill.
6. Concurrency cap holds at exactly CONCURRENCY_LIMIT, per worker process, with zero violations when 50 jobs are enqueued at once against a single worker process, confirmed by logged concurrent-count samples.

## Assumptions

**Highest blast radius — confirm these first:** assumption 1 below is the one that, if wrong, forces a rewrite of Business Model, Success Metrics wording, and the Phased Roadmap. The rest are narrower and can be corrected in place without touching other sections.

1. This is a portfolio/learning project, not a commercial product (project type input was left unconfirmed).
2. **[Confirmed, no longer an assumption]** The job type is sending a transactional email through a third-party provider (recipient, subject, body). This replaces the earlier default assumption of an AI model API call. The specific provider — SendGrid, Postmark, AWS SES, or Mailgun — is still unspecified; see Open Questions.
3. No deadline was given; none is assumed for the roadmap below.
4. Express is used instead of Next.js API routes, since there is no frontend beyond a minimal trigger/status page.
5. A `result` Json field was added to the Job model to store the provider's response; the fixed field list did not include one.
6. `createdAt`, `updatedAt`, and an index on `(status, runAt)` were added to the Job model for auditability and query performance; none were in the fixed field list.
7. `POLL_INTERVAL_MS`, `EMAIL_API_TIMEOUT_MS`, `EMAIL_FROM_ADDRESS`, and `JITTER_FACTOR` were added as configuration values; none were in the fixed config list.
8. A duplicate idempotency key with a different payload returns the existing job and silently ignores the new payload, rather than raising a conflict error.
9. An unknown job type fails immediately with no retries, since retrying cannot fix a code-level configuration error.
10. A malformed payload — including a missing or syntactically invalid `to` address — is rejected at enqueue time with an HTTP 400 and never creates a job row.
11. Job data, including recipient addresses and message bodies, is retained indefinitely in this version; no cleanup or archival job exists. This is a sharper concern now than it was for the earlier AI job type — see Risk 2.
12. Job ids are UUIDs generated by the database default.
13. CONCURRENCY_LIMIT is enforced per worker process, not globally across all running worker processes.
14. BACKOFF_CAP_MS is 300,000ms so it is actually reachable within the default MAX_ATTEMPTS, instead of sitting as dead configuration.
15. idempotencyKey has no per-user scoping and no expiration in this version — a deliberate limitation, not an oversight — and is the natural candidate to pass through as the provider's dedupe token if one is supported.
16. **[Updated for email]** A provider response that returns HTTP 200 without a usable message id is treated as a retryable failure — the send cannot be confirmed as accepted without one.
17. HTTP 401/403 from the email provider triggers a system-wide pause and alert, rather than dead-lettering every affected job individually.
18. The minimal trigger/status page is a single static HTML file with vanilla JavaScript — no frontend framework.
19. **[New] Exactly-once delivery is not guaranteed by this design.** It provides at-least-once delivery with a best-effort narrow crash window, unless the chosen provider's own dedupe mechanism closes the gap — see Risk 7.

## Phased Roadmap

**Phase 1: Environment and data layer.** Set up the local Postgres instance, `.env` configuration, and Prisma migration tooling. Define the Prisma schema and run the migration. Build POST /api/jobs with payload validation, server-side idempotency key generation, and idempotency enforcement at the database level. Deliverable: a job can be enqueued, returns 202 with an id, and duplicate keys return the same job with a 200.

**Phase 2: Worker and email pipeline.** Build the worker's polling loop with the exact atomic claim statement. Implement the email provider API call, the retryable/permanent/system-level failure classification, exponential backoff with jitter (clamped to BACKOFF_CAP_MS), and the transition to dead status after maxAttempts. Deliverable: a job runs end to end from pending to succeeded or dead, and a real (or sandbox-mode) email is actually delivered.

**Phase 3: Recovery and visibility.** Build the stuck-job sweep, the dead letter list endpoint and view with manual retry, the GET /api/jobs/:id status endpoint, **and the minimal trigger + status HTML page**. Deliverable: a stuck job recovers automatically, a dead job is visible and retryable without touching the database, and a human can submit and check a job without curl or Postman.

**Phase 4: Break-it test suite and evidence.** Script and run all five required tests: 50 concurrent enqueues against a single worker process with concurrency logging, a 100%-failure job traced through to dead with visible, growing backoff timestamps, a worker killed and restarted mid-job, a duplicate idempotency key submission, and two workers run concurrently against the same queue (expected to show up to 2× CONCURRENCY_LIMIT in flight, which is correct, not a violation). Deliverable: documented results and screenshots for each test, matching the Success Metrics above.

## Open Questions

1. Is this system a portfolio/learning project, or should it be framed as a real product with a business model, pricing, and target customer?
2. Which email provider will be used — SendGrid, Postmark, AWS SES, or Mailgun? This determines the exact retryable/permanent error mapping in the Email Delivery Pipeline section, and whether a native idempotency/dedupe token is available.
3. Is there a deadline for this project?
4. Should the provider's response be stored directly on the Job row (as the `result` field added here), or in a separate table keyed by job id?
5. Does the payload need encryption at rest or a redaction policy, given it stores a real recipient email address and message content, not synthetic test data?
6. Is a maximum email body length required, to avoid provider size-limit failures and unexpected cost?
7. Should idempotencyKey be scoped per user and given an expiration window (Stripe-style), instead of the current permanent, unscoped unique constraint?
8. Is a per-job-type pause-and-alert on repeated 401/403 sufficient, or does this need a real alerting channel (email, Slack, PagerDuty) rather than just a log line — noting the mild irony of alerting by email if the email pipeline itself is what's down?
9. Should CONCURRENCY_LIMIT eventually be enforced globally across multiple worker processes (via a shared counter), or is per-process enforcement acceptable indefinitely?
10. Is the chosen relationship between MAX_ATTEMPTS (5) and BACKOFF_CAP_MS (300000ms) the right tuning, or should these be revisited once the real email provider's rate-limit behavior is known?
11. Is a single static HTML page (no framework) an acceptable "minimal trigger and status view," or is a lightweight framework expected?
12. **[New] Does the chosen email provider support a client-supplied idempotency or dedupe token?** If yes, use idempotencyKey as that token and exactly-once delivery becomes achievable. If no, this system remains at-least-once by design, and that residual risk (Risk 7) should be explicitly accepted or escalated before this ships anywhere real.
