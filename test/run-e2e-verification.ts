import http from 'http';
import { spawn, ChildProcess } from 'child_process';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/lib/config';

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

async function runVerification() {
  console.log('======================================================');
  console.log('🧹 1. Cleaning up previous test records in PostgreSQL');
  console.log('======================================================');
  const deleteResult = await prisma.job.deleteMany();
  console.log(`Deleted ${deleteResult.count} old job records.`);

  console.log('\n======================================================');
  console.log('🚀 2. Task 4: End-to-End Happy Path Test');
  console.log('======================================================');

  const happyPayload = {
    type: 'send_email',
    payload: {
      to: 'happy-user@example.com',
      subject: 'Welcome to our platform!',
      body: 'Thank you for signing up.',
    },
    idempotencyKey: `happy-${Date.now()}`,
  };

  console.log('Enqueueing fresh job via POST /api/jobs:');
  const enqueueRes = await sendPostRequest('/api/jobs', happyPayload);
  console.log(`HTTP Status: ${enqueueRes.statusCode}`);
  console.log(`Enqueue Response:`, JSON.stringify(enqueueRes.data, null, 2));

  const jobId = enqueueRes.data.id;
  const beforeRow = await prisma.job.findUnique({ where: { id: jobId } });
  console.log('\n[BEFORE WORKER RUN] Job row in DB (Pending):');
  console.log(JSON.stringify(beforeRow, null, 2));

  console.log('\nStarting worker process via `npm run dev:worker`...');
  let workerProcess: ChildProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });

  // Allow worker loop to poll, claim, and execute the job
  console.log('Waiting for worker to claim and complete the job (2.5s)...');
  await sleep(2500);

  console.log('Stopping worker process...');
  workerProcess.kill('SIGTERM');
  await sleep(500);

  const afterRow = await prisma.job.findUnique({ where: { id: jobId } });
  console.log('\n[AFTER WORKER RUN] Job row in DB (Succeeded):');
  console.log(JSON.stringify(afterRow, null, 2));

  console.log('\n======================================================');
  console.log('⚠️ 3. Task 5: End-to-End Failure & Retry Path Test');
  console.log('======================================================');

  const failPayload = {
    type: 'send_email',
    payload: {
      to: 'retry-test@example.com',
      subject: 'SIMULATE_500: Server transient error',
      body: 'This payload triggers a simulated 500 error in MockEmailProvider.',
    },
    idempotencyKey: `fail-${Date.now()}`,
  };

  console.log('Enqueueing failing job via POST /api/jobs:');
  const failEnqueueRes = await sendPostRequest('/api/jobs', failPayload);
  const failJobId = failEnqueueRes.data.id;
  console.log(`HTTP Status: ${failEnqueueRes.statusCode}, Job ID: ${failJobId}`);

  console.log('\nStarting worker process for Attempt 1...');
  workerProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });

  await sleep(2500);
  workerProcess.kill('SIGTERM');
  await sleep(500);

  const attempt1Row = await prisma.job.findUnique({ where: { id: failJobId } });
  console.log('\n[AFTER ATTEMPT 1] Job row in DB (Attempts = 1, Backoff scheduled):');
  console.log(JSON.stringify(attempt1Row, null, 2));

  // Advance runAt to now so the worker can claim Attempt 2 immediately without waiting 30 seconds
  console.log('\nAdvancing runAt to now() for immediate Attempt 2 claim...');
  await prisma.job.update({
    where: { id: failJobId },
    data: { runAt: new Date() },
  });

  console.log('\nStarting worker process for Attempt 2...');
  workerProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });

  await sleep(2500);
  workerProcess.kill('SIGTERM');
  await sleep(500);

  const attempt2Row = await prisma.job.findUnique({ where: { id: failJobId } });
  console.log('\n[AFTER ATTEMPT 2] Job row in DB (Attempts = 2, Growing backoff delay):');
  console.log(JSON.stringify(attempt2Row, null, 2));

  await prisma.$disconnect();
  console.log('\n✨ End-to-End Verification Complete!');
}

runVerification().catch(async (err) => {
  console.error('Fatal test error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
