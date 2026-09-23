import http from 'http';
import { spawn, ChildProcess, execSync } from 'child_process';
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

function forceKillProcess(proc: ChildProcess) {
  if (proc.pid) {
    try {
      execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' });
    } catch {
      proc.kill('SIGKILL');
    }
  }
}

async function runStuckJobRecoveryTest() {
  console.log('======================================================');
  console.log('🧪 Break-It Test 04: Stuck Job Recovery Sweep');
  console.log('======================================================');

  // 1. Clean up jobs
  await prisma.job.deleteMany();

  const payload = {
    type: 'send_email',
    payload: {
      to: 'crash-test@example.com',
      subject: 'SLOW_SEND: In-flight worker crash simulation',
      body: 'Worker will be forcefully killed while processing this job.',
    },
    idempotencyKey: `crash-${Date.now()}`,
  };

  console.log('1. Enqueueing job via POST /api/jobs:');
  const enqueueRes = await sendPostRequest('/api/jobs', payload);
  const jobId = enqueueRes.data.id;
  console.log(`HTTP Status: ${enqueueRes.statusCode}, Job ID: ${jobId}`);

  // 2. Start worker process
  console.log('\n2. Starting worker via `npm run dev:worker`...');
  let workerProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });

  // Wait until job is claimed and in 'processing' status
  console.log('Waiting for worker to claim and enter "processing" state...');
  let claimed = false;
  for (let i = 0; i < 40; i++) {
    const current = await prisma.job.findUnique({ where: { id: jobId } });
    if (current && current.status === 'processing') {
      claimed = true;
      break;
    }
    await sleep(250);
  }

  if (!claimed) {
    throw new Error('Worker did not claim job within timeout.');
  }

  // 3. Force kill the worker with SIGKILL / taskkill /F
  console.log('\n⚡ Force-killing worker process mid-send (SIGKILL / taskkill /F)...');
  forceKillProcess(workerProcess);
  await sleep(500);

  // 4. Inspect DB row immediately after kill
  const rowAfterKill = await prisma.job.findUnique({ where: { id: jobId } });
  console.log('\n[JOB ROW IMMEDIATELY AFTER WORKER KILL] (Stuck in processing):');
  console.log(JSON.stringify(rowAfterKill, null, 2));

  // 5. Fast-forward startedAt past STUCK_JOB_TIMEOUT_MS to simulate timeout elapsed
  console.log(`\nFast-forwarding startedAt past STUCK_JOB_TIMEOUT_MS (${config.STUCK_JOB_TIMEOUT_MS}ms)...`);
  const staleDate = new Date(Date.now() - (config.STUCK_JOB_TIMEOUT_MS + 10000));
  await prisma.job.update({
    where: { id: jobId },
    data: { startedAt: staleDate },
  });

  // 6. Restart worker
  console.log('\n3. Restarting worker with `npm run dev:worker`...');
  workerProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });

  console.log('Waiting for sweep loop and worker polling loop to recover and re-process job (3s)...');
  await sleep(3000);

  console.log('Stopping restarted worker process...');
  forceKillProcess(workerProcess);
  await sleep(500);

  // 7. Inspect final DB row
  const rowAfterRecovery = await prisma.job.findUnique({ where: { id: jobId } });
  console.log('\n[JOB ROW AFTER SWEEP RECOVERY & RESTART]:');
  console.log(JSON.stringify(rowAfterRecovery, null, 2));

  await prisma.$disconnect();
}

runStuckJobRecoveryTest().catch(async (err) => {
  console.error('Fatal test error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
