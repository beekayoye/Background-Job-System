# Architecture & Stack Constraints

These rules define the mandatory technology stack, process topology, and structural boundaries for the Background Job System as established in the PRD (v3) and `AGENTS.md`.

---

## 1. Core Technology Stack

- **Language & Runtime:** Node.js Active LTS (22.x line) with TypeScript in `strict` mode. Never use plain JavaScript for source files. Pin the engine version in `package.json` and `.nvmrc`.
- **Database:** PostgreSQL only. No SQLite, MySQL, or serverless Postgres abstractions that alter the locking semantics of `FOR UPDATE SKIP LOCKED`.
- **ORM:** Prisma. Do not use Drizzle, TypeORM, Knex, or custom query builders.
- **API Framework:** Express. Do not use Next.js API routes or fullstack meta-frameworks.
- **Worker Process:** Long-running dedicated Node.js process. Never use serverless functions, cron lambdas, or external message broker queues (e.g., BullMQ, SQS, RabbitMQ).
- **Deployment Target:** Local machine only. Never add Dockerfiles, cloud deploy configs, Terraform, or CI/CD deploy pipelines unless explicitly instructed.

---

## 2. Process Topology & Boundaries

The API server and the background worker **must** operate as two completely independent processes:

1. **API Process (`src/api/server.ts`):**
   - Handles HTTP requests only.
   - Enqueues jobs by inserting records into Postgres and immediately returns HTTP `202 Accepted`.
   - Never performs synchronous job execution or email sending.
   - Never imports or executes worker polling loops.

2. **Worker Process (`src/worker/worker.ts`):**
   - Runs the infinite polling loop and execution pipeline.
   - Runs the stuck-job sweep loop.
   - Can be started, stopped, or killed independently of the API server without affecting HTTP intake.

---

## 3. Strict Folder Layout

Code must strictly follow this folder organization:

```
/prisma
  schema.prisma

/src
  /api
    server.ts            # Express application entry point
    routes/
      jobs.ts             # POST /api/jobs, GET /api/jobs/:id, GET /api/jobs/dead, POST /api/jobs/:id/retry
    middleware/
      auth.ts              # Fixed API key authentication check

  /worker
    worker.ts              # Worker polling process entry point
    claim.ts                # Atomic claim query (only place this query exists)
    sweep.ts                 # Stuck-job sweep interval loop

  /jobs
    /email
      provider.ts            # EmailProvider interface & default adapter
      handler.ts               # Email execution & error classification

  /lib
    prisma.ts                  # Singleton PrismaClient instance
    backoff.ts                   # Exponential backoff + jitter calculation
    config.ts                     # Environment variable validation & typed config export

  /public
    index.html                     # Minimal trigger & status UI (vanilla HTML/JS)

/tests
  break-it/
    01-idempotency.ts              # Duplicate idempotency key test
    02-concurrency-cap.ts          # Concurrency limit enforcement test
    03-forced-failure-to-dead.ts   # Max attempts & backoff to dead status test
    04-stuck-job-recovery.ts       # Worker kill & recovery sweep test
    05-two-worker-race.ts          # Two concurrent workers atomic claim test
```

---

## 4. Architectural Invariants

- **Single Prisma Client:** `src/lib/prisma.ts` creates and exports the one and only `PrismaClient` singleton. Never instantiate `new PrismaClient()` elsewhere.
- **Single Config Loader:** `src/lib/config.ts` is the only module permitted to read `process.env`. All other modules import typed, validated config values from it.
- **Minimal UI:** UI is restricted to one static HTML page (`/public/index.html`) with vanilla JavaScript. No frontend frameworks, component libraries, or build bundlers.
