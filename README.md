# 🚀 Reliable Background Job Processing System

A production-grade, asynchronous background job processing system built with **Node.js, TypeScript, PostgreSQL (Prisma), and Express**.

This project decouples slow, unreliable I/O operations (such as transactional email delivery) from the synchronous HTTP request cycle, processing jobs asynchronously with atomic locking, exponential backoff retries with random jitter, crash recovery sweeps, and a Dead Letter Queue (DLQ).

---

## 📑 Table of Contents

- [Architectural Overview](#-architectural-overview)
- [System Guarantees & Constraints](#-system-guarantees--constraints)
- [Tech Stack](#-tech-stack)
- [Project Layout](#-project-layout)
- [Getting Started & Local Setup](#-getting-started--local-setup)
- [Running the System](#-running-the-system)
- [API Endpoints](#-api-endpoints)
- [Email Provider Integration](#-email-provider-integration)
- [Failure Classification & Backoff Math](#-failure-classification--backoff-math)
- [Peer Review Verification Suite (Break-It Tests)](#-peer-review-verification-suite-break-it-tests)
- [Code Quality & Standards](#-code-quality--standards)

---

## 🏛 Architectural Overview

The system operates as **two independent, decoupled processes** communicating exclusively via PostgreSQL:

```mermaid
flowchart TD
    Client(["HTTP Client / Frontend Dashboard"])

    subgraph Process1 ["Process 1: API Server (Express)"]
        Enqueue["POST /api/jobs (Enqueues pending row, Returns HTTP 202)"]
        Inspector["GET /api/jobs/:id (Job Status)"]
        DLQ_API["GET /api/jobs/dead & POST /:id/retry"]
    end

    subgraph Database ["PostgreSQL (Prisma)"]
        Table[("Job Table<br/>id, type, payload, status, attempts,<br/>maxAttempts, lastError, runAt, idempotencyKey")]
    end

    subgraph Process2 ["Process 2: Worker Process"]
        Claim["claimNextJob()<br/>UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)"]
        Exec["executeJob() via EmailProvider"]
        Sweep["Stuck-Job Sweep Timer (Every 60s)"]
    end

    subgraph Providers ["Email Delivery Pipeline"]
        Resend["Resend API (Live)"]
        Mock["Mock Provider (Deterministic Sandbox)"]
    end

    Client -->|"1. Enqueue / Inspect"| Process1
    Process1 -->|"Write / Read"| Database
    Database <-->|"2. Atomic Claim & Update"| Process2
    Process2 -->|"3. Dispatch"| Providers
```

---

## 🛡 System Guarantees & Constraints

| Guarantee | Implementation Mechanism |
| :--- | :--- |
| **Non-blocking Enqueue** | `POST /api/jobs` strictly inserts a `pending` row and returns HTTP `202 Accepted` with a job ID in `< 20ms`. Zero synchronous provider calls in the request path. |
| **Strict Idempotency** | Duplicate `idempotencyKey` submissions return HTTP `200 OK` with the existing job record instead of creating a duplicate row. |
| **Zero Double-Claims** | Worker uses atomic `UPDATE "Job" SET status = 'processing', "startedAt" = now() WHERE id = (SELECT id FROM "Job" WHERE status = 'pending' AND "runAt" <= now() ORDER BY "runAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *;`. |
| **Per-Worker Concurrency Limit** | Each worker process manages its own in-flight job pool up to `CONCURRENCY_LIMIT` (default: 5) using an active count throttle. |
| **Crash Recovery** | An ungracefully terminated worker leaves jobs in `processing`. The background sweep resets jobs where `startedAt < now() - STUCK_JOB_TIMEOUT_MS` back to `pending`. |
| **Circuit Breaker on Auth Failure** | If the email provider returns HTTP `401/403` (credential failure), the worker pauses polling to prevent burning retries across the entire queue. |

---

## 🛠 Tech Stack

- **Runtime:** Node.js (>= v22.x LTS), TypeScript (Strict mode)
- **Database & ORM:** PostgreSQL, Prisma ORM
- **API Framework:** Express.js
- **Testing & Verification:** TypeScript break-it scripts with assertions

---

## 📁 Project Layout

```
├── prisma/
│   └── schema.prisma         # Locked Job schema with @@index([status, runAt])
├── src/
│   ├── api/
│   │   ├── server.ts         # Express server entry point (Process 1)
│   │   ├── routes/jobs.ts    # REST endpoints (Enqueue, Status, DLQ, Retry, Delete)
│   │   └── middleware/auth.ts # Fixed API key authentication
│   ├── worker/
│   │   ├── worker.ts         # Polling loop & concurrency manager (Process 2)
│   │   ├── claim.ts          # Atomic FOR UPDATE SKIP LOCKED claim query
│   │   └── sweep.ts          # Stuck-job recovery sweep loop
│   ├── jobs/
│   │   └── email/
│   │       ├── provider.ts   # EmailProvider interface, Resend & Mock adapters
│   │       └── handler.ts    # Failure classifier & retry orchestrator
│   ├── lib/
│   │   ├── backoff.ts        # Locked exponential backoff + jitter calculator
│   │   ├── config.ts         # Validated environment configuration
│   │   └── prisma.ts         # Shared PrismaClient singleton
│   └── public/
│       ├── index.html        # Interactive UI dashboard (5-status visualizer, DLQ)
│       └── tokens.css        # Design tokens stylesheet
└── tests/
    └── break-it/             # 5 Mandatory Phase 4 validation test scripts
        ├── 01-idempotency.ts
        ├── 02-concurrency-cap.ts
        ├── 03-forced-failure-to-dead.ts
        ├── 04-stuck-job-recovery.ts
        ├── 05-two-worker-race.ts
        └── run-all.ts        # Master runner for npm run test:break-it:all
```

---

## ⚙️ Getting Started & Local Setup

### 1. Prerequisites
- Node.js (v22.x LTS recommended)
- PostgreSQL running locally or in Docker

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and configure your credentials:
```bash
cp .env.example .env
```

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/job_system_db?schema=public"
FIXED_API_KEY="demo-secret-api-key-2026"
EMAIL_API_KEY="mock-key" # Or "re_..." for Resend
EMAIL_FROM_ADDRESS="onboarding@resend.dev"
```

### 4. Run Prisma Migrations
```bash
npm run prisma:generate
npm run prisma:migrate
```

---

## 🚀 Running the System

Start the API and Worker processes in two separate terminal windows:

### Terminal 1: HTTP API Server
```bash
npm run dev:api
```
*Served at `http://localhost:3001` (Dashboard available at `http://localhost:3001/`)*

### Terminal 2: Background Worker Process
```bash
npm run dev:worker
```

---

## 📡 API Endpoints

All mutating endpoints require `Authorization: Bearer <FIXED_API_KEY>` or `x-api-key: <FIXED_API_KEY>`.

| Method | Endpoint | Description | Response Codes |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/jobs` | Enqueue a new background job | `202 Accepted` (New) / `200 OK` (Duplicate key) |
| `GET` | `/api/jobs/:id` | Inspect job status, attempts, last error, timestamps | `200 OK` / `404 Not Found` |
| `GET` | `/api/jobs/dead` | List all dead-lettered jobs | `200 OK` |
| `POST` | `/api/jobs/:id/retry` | Reset a dead job to `pending` with `attempts = 0` | `200 OK` / `400 Bad Request` |
| `DELETE`| `/api/jobs/:id` | Permanently delete a dead job | `200 OK` / `400 Bad Request` |
| `GET` | `/api/session` | Public handshake for the demo dashboard | `200 OK` |

---

## 📐 Failure Classification & Backoff Math

### Retry Delay Formula
Retries use exponential backoff capped at `BACKOFF_CAP_MS` plus random proportional jitter:
$$\text{delay} = \min(\text{BACKOFF\_CAP\_MS}, \text{BACKOFF\_BASE\_MS} \times 2^{\text{attempts}}) + \text{random}(0, \text{JITTER\_FACTOR} \times \text{delay})$$

### Error Classification
1. **Transient Errors (e.g., 429 Rate Limit, 5xx Server Error, ETIMEDOUT):**
   - Increments `attempts` and records `lastError`.
   - Computes backoff delay with jitter and schedules `runAt` into the future (`now() + delayMs`).
   - Sets status directly to `pending` (resetting `startedAt` to `null`). The atomic claim query automatically ignores the row until `runAt <= now()`.
   - Transitions to `dead` if `nextAttempts >= maxAttempts`.
2. **Permanent Errors (e.g., 422 Malformed Payload, Invalid Recipient Address):**
   - Immediately transitions to `dead` status without retrying, preserving sending reputation.
3. **System Errors (e.g., 401/403 Invalid API Credentials):**
   - **Behavior:** Worker logs a high-priority alert (`[ALERT] Provider authentication failed (401/403)`) and enters a paused state (`isPaused = true`), immediately halting further queue claims to avoid burning retry attempts across the entire queue.
   - **Recovery / On-Call Action:** Because invalid credentials cannot self-heal automatically, **manual intervention is intentional**. The on-call operator must update `EMAIL_API_KEY` in `.env` (or environment secrets) and restart the worker process (`npm run dev:worker`), or invoke `worker.resume()` if managed via a process supervisor. Active in-flight jobs finish gracefully while polling remains paused.

---

## 🧪 Peer Review Verification Suite (Break-It Tests)

This repository includes 5 automated test scripts designed to stress-test and verify all edge cases:

| Test Script | Target Requirement | Command |
| :--- | :--- | :--- |
| **01 Idempotency** | Submitting the same idempotency key concurrently returns HTTP 200 and yields exactly 1 database row. | `npm run test:break-it:01` |
| **02 Concurrency Cap** | 50 concurrent enqueues are processed while in-flight worker concurrency strictly adheres to `CONCURRENCY_LIMIT` (5). | `npm run test:break-it:02` |
| **03 Forced Failure to Dead** | A persistently failing job retries through growing exponential backoff delays and transitions to `dead` at `maxAttempts`. | `npm run test:break-it:03` |
| **04 Stuck Job Recovery** | A worker process killed mid-job leaves a stuck `processing` row; the sweep recovers it back to `pending`. | `npm run test:break-it:04` |
| **05 Two-Worker Race** | Two worker processes run concurrently against a single queue with 0 double-claimed jobs. | `npm run test:break-it:05` |

Run all tests sequentially:
```bash
npm run test:break-it:all
```

---

## ✅ Code Quality & Standards

- **Strict TypeScript:** `npx tsc --noEmit` passes with **0 errors**.
- **ESLint:** `npm run lint` passes with **0 warnings**.
- **Clean Architecture:** Strict separation between HTTP handling (`/src/api`), queue claiming (`/src/worker`), and email adapters (`/src/jobs`).
