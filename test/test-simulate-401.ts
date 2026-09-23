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

async function run401Test() {
  console.log('======================================================');
  console.log('🧪 Testing System-Level Failure (SIMULATE_401)');
  console.log('======================================================');

  // Clean old records
  await prisma.job.deleteMany();

  const payload = {
    type: 'send_email',
    payload: {
      to: 'auth-fail@example.com',
      subject: 'SIMULATE_401: Invalid Credentials Test',
      body: 'Trigger 401 error',
    },
    idempotencyKey: `auth-fail-${Date.now()}`,
  };

  console.log('1. Enqueueing job with SIMULATE_401 trigger:');
  const res = await sendPostRequest('/api/jobs', payload);
  console.log(`HTTP Status: ${res.statusCode}`);
  const jobId = res.data.id;

  const beforeJob = await prisma.job.findUnique({ where: { id: jobId } });
  console.log('\n[BEFORE WORKER RUN] Initial Pending Job:');
  console.log(JSON.stringify(beforeJob, null, 2));

  console.log('\n2. Starting worker via `npm run dev:worker`...');
  const workerProcess: ChildProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: true,
  });

  console.log('Waiting for worker to claim and encounter 401 (2.5s)...');
  await sleep(2500);

  console.log('Stopping worker process...');
  workerProcess.kill('SIGTERM');
  await sleep(500);

  const afterJob = await prisma.job.findUnique({ where: { id: jobId } });
  console.log('\n[AFTER 401 ENCOUNTERED] Job Record in DB:');
  console.log(JSON.stringify(afterJob, null, 2));

  await prisma.$disconnect();
}

run401Test().catch(async (err) => {
  console.error('Test failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
