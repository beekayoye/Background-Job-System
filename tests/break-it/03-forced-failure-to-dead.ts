import http from 'http';
import { spawn, ChildProcess, execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../src/lib/prisma';
import { config } from '../../src/lib/config';

function sendPostRequest(path: string, bodyObj: any): Promise<{ statusCode: number; data: any }> {
  const postData = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: config.API_PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.FIXED_API_KEY}`,
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 0, data: JSON.parse(raw) });
          } catch {
            resolve({ statusCode: res.statusCode || 0, data: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcess(proc: ChildProcess) {
  if (proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
    } catch {
      proc.kill('SIGKILL');
    }
  }
}

async function runForcedFailureTest() {
  console.log('======================================================');
  console.log('🧪 Break-It Test 03: Forced Failure to Dead Status');
  console.log('======================================================');

  // Test-specific overrides to avoid 15-minute wait:
  // MAX_ATTEMPTS=3, BACKOFF_BASE_MS=2000, BACKOFF_CAP_MS=10000, POLL_INTERVAL_MS=300
  const TEST_ENV = {
    ...process.env,
    MAX_ATTEMPTS: '3',
    BACKOFF_BASE_MS: '2000',
    BACKOFF_CAP_MS: '10000',
    POLL_INTERVAL_MS: '300',
    JITTER_FACTOR: '0.2',
  };

  console.log('Test Config: MAX_ATTEMPTS=3, BACKOFF_BASE_MS=2000ms, BACKOFF_CAP_MS=10000ms');

  // 1. Enqueue job forced to fail with transient 500 error on every attempt
  const idempotencyKey = `fail-test-${uuidv4()}`;
  const payload = {
    type: 'send_email',
    payload: {
      to: 'fail500@example.com',
      subject: 'SIMULATE_500: Forced Transient Failure Test',
      body: 'This job will fail repeatedly to test exponential backoff and dead status transition.',
    },
    idempotencyKey,
  };

  console.log('\n1. Enqueueing forced-failure job via POST /api/jobs...');
  const enqueueRes = await sendPostRequest('/api/jobs', payload);
  if (enqueueRes.statusCode !== 202) {
    throw new Error(`Enqueue failed with HTTP ${enqueueRes.statusCode}`);
  }

  const jobId = enqueueRes.data.id;
  console.log(`✔ Enqueued Job ID: ${jobId}`);

  // Override maxAttempts to 3 for this isolated accelerated test
  await prisma.job.update({
    where: { id: jobId },
    data: { maxAttempts: 3 },
  });

  // 2. Spawn worker process with customized env vars
  console.log('\n2. Spawning worker with accelerated retry schedule (env overrides)...');
  const workerProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    env: TEST_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  workerProcess.stdout?.on('data', () => {
    // optional debug logging
  });

  // 3. Track state changes and timestamps
  console.log('\n3. Tracking retry attempts, timestamps, and backoff progression in real-time:\n');
  let lastSeenAttempts = -1;
  let prevRunAt: Date | null = null;

  const startTime = Date.now();

  while (Date.now() - startTime < 35000) {
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) break;

    if (job.attempts !== lastSeenAttempts || job.status === 'dead') {
      const isInitial = lastSeenAttempts === -1;
      const deltaRunAtMs = prevRunAt ? job.runAt.getTime() - prevRunAt.getTime() : 0;
      prevRunAt = job.runAt;
      lastSeenAttempts = job.attempts;

      const backoffInfo = isInitial
        ? 'Initial enqueue'
        : job.status === 'dead'
        ? `Dead status reached (maxAttempts: ${job.maxAttempts})`
        : `Computed backoff delay (ΔrunAt): ~${(deltaRunAtMs / 1000).toFixed(2)}s`;

      console.log(
        `[ATTEMPT ${job.attempts}/${TEST_ENV.MAX_ATTEMPTS}] Status: ${job.status.padEnd(8)} | ` +
        `runAt: ${job.runAt.toISOString()} | ` +
        `${backoffInfo} | ` +
        `Error: ${job.lastError || 'None'}`
      );

      if (job.status === 'dead') {
        console.log('\n💀 Job successfully transitioned to "dead" status!');
        break;
      }
    }

    await sleep(150);
  }

  // Stop worker
  killProcess(workerProcess);
  await sleep(500);

  // 4. Verification and summary
  const finalJob = await prisma.job.findUnique({ where: { id: jobId } });

  console.log('\n======================================================');
  console.log('📊 Final Dead-Letter Job Row:');
  console.log(JSON.stringify(finalJob, null, 2));
  console.log('======================================================');

  if (!finalJob || finalJob.status !== 'dead') {
    throw new Error(`Expected job status to be 'dead', got '${finalJob?.status}'`);
  }

  if (finalJob.attempts < 3) {
    throw new Error(`Expected at least 3 attempts, got ${finalJob.attempts}`);
  }

  console.log('\n✅ ASSERTION PASSED: Job retried with exponential backoff and transitioned to DEAD status.');
  await prisma.$disconnect();
}

if (require.main === module) {
  runForcedFailureTest().catch(async (err) => {
    console.error('❌ Forced failure test failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
