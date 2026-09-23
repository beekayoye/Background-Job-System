# Locked Technical Contracts & Data Model

These rules define the locked technical specifications, SQL queries, formulas, and schema definitions. Deviations from these contracts constitute a failure of the implementation.

---

## 1. Locked Prisma Schema

The Prisma data model in `prisma/schema.prisma` must match the following schema definition verbatim. Do not rename fields, change types, or convert `type` into an enum:

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

- `type` is intentionally `String` so new job types can be added without migrations.
- `attempts <= maxAttempts` is enforced in application code.

---

## 2. Locked Atomic Claim Query

The worker must claim pending jobs using **only** this exact atomic statement in `src/worker/claim.ts`:

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

- **Rule:** Never use `findFirst()` followed by `update()`. That reintroduces race conditions between concurrent worker processes.
- **Rule:** No file other than `src/worker/claim.ts` may set `status = 'processing'`.

---

## 3. Locked Exponential Backoff & Jitter Formula

All retry delay calculations must use this exact formula, implemented solely within `src/lib/backoff.ts`:

$$\text{delay} = \min(\text{BACKOFF\_CAP\_MS}, \text{BACKOFF\_BASE\_MS} \times 2^{\text{attempts}}) + \text{random}(0, \text{JITTER\_FACTOR} \times \text{delay})$$

```typescript
export function computeBackoffDelay(attempts: number, baseMs: number, capMs: number, jitterFactor: number): number {
  const baseDelay = Math.min(capMs, baseMs * Math.pow(2, attempts));
  const jitter = Math.random() * (jitterFactor * baseDelay);
  return Math.round(baseDelay + jitter);
}
```

- **Rule:** Never recompute backoff or exponential math inline at call sites.

---

## 4. HTTP Status Code Contracts

- **New Job Enqueued:** Returns HTTP `202 Accepted` with `{ id: string, status: "pending" }`. No execution work is performed during this request.
- **Duplicate Idempotency Key:** Returns HTTP `200 OK` with the existing job's data. Do not return `202` (no new resource was created).
- **Missing Idempotency Key:** The API server generates a UUID v4 before database insertion to ensure `idempotencyKey` remains unique and non-null.

---

## 5. Locked Configuration Defaults

All configuration variables must be loaded and validated at startup in `src/lib/config.ts`:

| Variable | Default Value | Invariant Rule |
| :--- | :--- | :--- |
| `MAX_ATTEMPTS` | `5` | Do not hardcode 5 in retry logic; read from config |
| `BACKOFF_BASE_MS` | `30000` (30s) | Base exponential backoff delay |
| `BACKOFF_CAP_MS` | `300000` (5m) | Maximum backoff delay |
| `JITTER_FACTOR` | `0.2` | Proportion of delay added as random jitter |
| `CONCURRENCY_LIMIT` | `5` | Enforced **per worker process**, not globally |
| `STUCK_JOB_TIMEOUT_MS`| `300000` (5m) | Inactivity threshold before stuck job recovery |
| `POLL_INTERVAL_MS` | `1000` (1s) | Worker loop polling sleep interval |
| `EMAIL_API_KEY` | *(Required)* | Never commit or log real API keys |
| `EMAIL_API_TIMEOUT_MS`| `10000` (10s) | HTTP request timeout for email provider calls |
| `EMAIL_FROM_ADDRESS` | *(Required)* | Verified sender email address |
