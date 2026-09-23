# Protection & Safety Rules (What Must Never Happen)

The following 12 rules represent absolute boundaries for safety, data privacy, and system integrity. **Violating any rule on this list constitutes an immediate failure of the task.**

---

## 1. No Synchronous External Calls on Request Path
- **Rule:** Never call the email provider API synchronously inside the Express request handler (`POST /api/jobs`).
- **Enforcement:** The HTTP enqueue handler must only validate input, insert a row with `status = 'pending'`, and return HTTP `202`. All sending must occur asynchronously inside the worker process.

---

## 2. No Double Claims Across Workers
- **Rule:** Never allow two worker processes to claim or process the same job.
- **Enforcement:** The atomic `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)` query in `src/worker/claim.ts` is the only mechanism permitted to claim jobs.

---

## 3. No Retrying Permanent Failures
- **Rule:** Never retry a job whose failure is classified as permanent (e.g., HTTP `400 Bad Request`, or a recipient address rejected as syntactically invalid).
- **Enforcement:** Permanent failures must immediately transition the job to `status = 'dead'`. Retrying invalid addresses damages sender reputation and triggers account suspensions.

---

## 4. No Mass Dead-Lettering on Credential Outages (401/403)
- **Rule:** Never dead-letter queued jobs individually upon encountering an HTTP `401 Unauthorized` or `403 Forbidden` response from the email provider.
- **Enforcement:** On the first 401/403 error, log a critical system alert and pause the worker polling loop. An invalid API key is an operational outage, not individual unfixable jobs.

---

## 5. No Claim of Exactly-Once Delivery
- **Rule:** Never claim or attempt to engineer distributed two-phase locking for "exactly-once" email delivery.
- **Enforcement:** The system provides **at-least-once delivery**. A worker crash between a successful provider response and writing `status = 'succeeded'` is a documented residual risk. Mitigate this by writing `succeeded` immediately upon response receipt.

---

## 6. No Complex Authentication
- **Rule:** Never implement user registration, passwords, OAuth, session cookies, or JWTs.
- **Enforcement:** Authentication is restricted exclusively to a single fixed API key checked via `src/api/middleware/auth.ts`.

---

## 7. No Multi-Tenancy or Billing
- **Rule:** Never implement tenant segregation, subscription plans, usage quotas, or billing models.
- **Enforcement:** Single demo user architecture only.

---

## 8. No Cloud Deployment or Infrastructure Assumptions
- **Rule:** Never introduce Dockerfiles, container manifests, cloud orchestration, Terraform, or managed message queues.
- **Enforcement:** The system is strictly designed for local machine execution.

---

## 9. No Deliverability or Analytics Features
- **Rule:** Never build email tracking (open/click tracking), spam analysis, or visual template editing.
- **Enforcement:** System responsibility ends when the email provider returns an accepted message ID.

---

## 10. No Committed Secrets
- **Rule:** Never commit `EMAIL_API_KEY`, `DATABASE_URL`, or any credentials to source control or logs.
- **Enforcement:** Maintain a `.env.example` with empty/placeholder values. Secrets must be read exclusively from environment variables.

---

## 11. No Plaintext PII Logging
- **Rule:** Never log full recipient email addresses or email body content in plaintext application logs at `info` level.
- **Enforcement:** Log only job IDs, status transitions, and error messages. Email payload content is personal data (PII).

---

## 12. No Frontend Frameworks or Design Systems
- **Rule:** Never add React, Vue, Tailwind CSS, or component libraries.
- **Enforcement:** The frontend consists of a single static HTML/JS file (`src/public/index.html`) demonstrating trigger submission, job status polling, and dead-letter review.
