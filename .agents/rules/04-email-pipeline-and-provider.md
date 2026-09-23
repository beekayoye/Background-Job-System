# Email Delivery Pipeline & Provider Abstraction

These rules define how the email delivery pipeline operates, including provider decoupling, error classification, and result recording.

---

## 1. Provider Interface Decoupling

Because the PRD intentionally leaves the choice of specific email provider open (SendGrid, Postmark, AWS SES, Mailgun), all email interactions must be isolated behind an interface in `src/jobs/email/provider.ts`:

```typescript
export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  from: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  messageId: string;
  timestamp: string;
  rawResponse?: unknown;
}

export interface EmailProvider {
  send(params: SendEmailParams): Promise<SendEmailResult>;
}
```

- **Rule:** `src/jobs/email/handler.ts` and worker logic must **only** interact with the `EmailProvider` interface, never directly importing vendor SDKs.
- **Rule:** Implement a default mock/sandbox adapter behind this interface to enable offline and end-to-end test execution.

---

## 2. Failure Classification Matrix

Errors thrown by the email provider must be caught and classified inside `src/jobs/email/handler.ts` into three distinct categories:

### A. Retryable Failures
- **Conditions:** Network connection timeouts, DNS errors, HTTP `429 Too Many Requests` (rate limited), HTTP `5xx Server Errors` from provider, or responses missing a valid `messageId`.
- **Action:**
  1. Increment `attempts`.
  2. Save error string to `lastError`.
  3. If `attempts < maxAttempts`, set `status = 'pending'` and compute new `runAt` using the locked backoff formula.
  4. If `attempts >= maxAttempts`, transition `status = 'dead'`.

### B. Permanent Failures
- **Conditions:** HTTP `400 Bad Request` (malformed payload), invalid/unparseable recipient email address, or recipient domain rejected explicitly by provider validation.
- **Action:**
  1. Immediately transition to `status = 'dead'`.
  2. Set `lastError` with provider rejection reason.
  3. **Do not retry** regardless of remaining `attempts`.

### C. System-Level Failures
- **Conditions:** HTTP `401 Unauthorized` or `403 Forbidden` (invalid/expired `EMAIL_API_KEY`).
- **Action:**
  1. Emit a critical error log alert.
  2. Pause the worker polling loop.
  3. Do **not** transition individual queued jobs to dead.

---

## 3. Execution & Result Recording

- **Timeout:** Enforce a hard execution timeout (`EMAIL_API_TIMEOUT_MS`, default `10000ms`) on every provider HTTP request.
- **Result Field:** Upon successful provider dispatch, populate the `result` JSON column with `{ messageId: string, timestamp: string }` and immediately update `status = 'succeeded'` and `finishedAt = now()`.
