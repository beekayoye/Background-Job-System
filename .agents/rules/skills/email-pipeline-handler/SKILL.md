---
name: email-pipeline-handler
description: >-
  Procedures for building, testing, and error-classifying the transactional email delivery pipeline behind the EmailProvider interface.
  Use this skill when implementing email adapters, handling rate limits, timeouts, or credential failure alerts.
---

# Email Pipeline Handler Skill

This skill defines the implementation runbook for sending transactional emails, classifying provider responses, and protecting system stability.

## 1. Provider Interface Architecture

All email dispatch logic must reside behind the `EmailProvider` interface defined in `src/jobs/email/provider.ts`:

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

### Implementing Concrete Adapters:
- Implement a default sandbox/mock adapter (`MockEmailProvider` or `Resend`/`SendGrid`/`Postmark` adapter).
- The adapter must enforce `EMAIL_API_TIMEOUT_MS` (default 10000ms) on outgoing HTTP requests.

---

## 2. Failure Classification Matrix

When catching exceptions during execution in `src/jobs/email/handler.ts`, classify the error strictly according to this runbook:

### 1. Retryable Failures (Job returns to `pending` with backoff):
- **Triggers:** Network socket timeouts, DNS resolution errors, HTTP `429 Too Many Requests`, HTTP `5xx Server Errors`, or responses where `messageId` is missing/null.
- **Action:** Increment `attempts`, record `lastError`, compute new `runAt` using the locked backoff formula, and set `status = 'pending'`.

### 2. Permanent Failures (Job transitions directly to `dead`):
- **Triggers:** HTTP `400 Bad Request` (malformed payload), recipient email address rejected by provider as syntactically invalid or non-existent.
- **Action:** Set `status = 'dead'`, record `lastError`, and do not retry, even if `attempts < maxAttempts`.

### 3. System-Level Failures (Worker pause & critical alert):
- **Triggers:** HTTP `401 Unauthorized` or `403 Forbidden` (invalid/expired `EMAIL_API_KEY`).
- **Action:**
  1. Emit a critical system alert log.
  2. Set `isWorkerPaused = true` to stop claiming new jobs from the queue.
  3. Keep existing queued jobs in `pending` (do not dead-letter).

---

## 3. Result Storage Procedure

Upon successful provider confirmation:
1. Update `result` JSON column with:
   ```json
   {
     "messageId": "msg_abc123",
     "timestamp": "2026-09-23T10:00:00.000Z"
   }
   ```
2. Set `status = 'succeeded'` and `finishedAt = new Date()`.
3. Perform database update immediately to minimize the residual crash-window risk.
