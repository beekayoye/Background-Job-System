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

async function runConcurrencyCapTest() {
  console.log('======================================================');
  console.log('🧪 Break-It Test 02: In-Process Concurrency Cap');
  console.log('======================================================');
  console.log(`Configured CONCURRENCY_LIMIT: ${config.CONCURRENCY_LIMIT}`);

  const TOTAL_JOBS = 50;
  const batchId = `concurrency-${Date.now()}`;
  const jobIds: string[] = [];

  console.log(`\n1. Enqueueing ${TOTAL_JOBS} valid jobs via POST /api/jobs...`);
  const enqueuePromises = [];
  for (let i = 1; i <= TOTAL_JOBS; i++) {
    const payload = {
      type: 'send_email',
      payload: {
        to: `load-test-${i}@example.com`,
        subject: `Concurrency load test job #${i}`,
        body: `Testing worker concurrency cap of ${config.CONCURRENCY_LIMIT}`,
      },
      idempotencyKey: `${batchId}-${i}-${uuidv4()}`,
    };
    enqueuePromises.push(sendPostRequest('/api/jobs', payload));
  }

  const enqueueResults = await Promise.all(enqueuePromises);
  for (const res of enqueueResults) {
    if (res.statusCode !== 202) {
      throw new Error(`Failed to enqueue job: HTTP ${res.statusCode}`);
    }
    jobIds.push(res.data.id);
  }
  console.log(`✔ Successfully enqueued ${jobIds.length} jobs.`);

  console.log('\n2. Spawning single worker process...');
  let maxObservedConcurrency = 0;
  let concurrencyViolations = 0;

  const workerProcess = spawn('npm.cmd', ['run', 'dev:worker'], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  workerProcess.stdout?.on('data', (data) => {
    const text = data.toString();
    const lines = text.split('\n');
    for (const line of lines) {
      const match = line.match(/Active jobs:\s*(\d+)\/(\d+)/);
      if (match) {
        const currentActive = parseInt(match[1], 10);
        const limit = parseInt(match[2], 10);
        if (currentActive > maxObservedConcurrency) {
          maxObservedConcurrency = currentActive;
        }
        if (currentActive > limit) {
          concurrencyViolations++;
          console.error(`🚨 CONCURRENCY VIOLATION! Active: ${currentActive}, Limit: ${limit}`);
        }
        console.log(`[WORKER LOG] ${line.trim()}`);
      }
    }
  });

  workerProcess.stderr?.on('data', (data) => {
    // Pipe standard error for debugging
    process.stderr.write(data);
  });

  console.log('\n3. Monitoring job completion in PostgreSQL database...');
  const startTime = Date.now();
  const TIMEOUT_MS = 60000;

  while (Date.now() - startTime < TIMEOUT_MS) {
    const completedCount = await prisma.job.count({
      where: {
        id: { in: jobIds },
        status: 'succeeded',
      },
    });

    if (completedCount === TOTAL_JOBS) {
      console.log(`\n🎉 All ${TOTAL_JOBS} jobs completed with status "succeeded"!`);
      break;
    }

    await sleep(500);
  }

  // Gracefully stop worker
  console.log('\nStopping worker process...');
  killProcess(workerProcess);
  await sleep(1000);

  // Final assertions
  const succeededJobs = await prisma.job.count({
    where: {
      id: { in: jobIds },
      status: 'succeeded',
    },
  });

  console.log('\n======================================================');
  console.log('📊 Concurrency Test Summary:');
  console.log(`- Total Enqueued: ${TOTAL_JOBS}`);
  console.log(`- Total Succeeded: ${succeededJobs}`);
  console.log(`- Configured Concurrency Limit: ${config.CONCURRENCY_LIMIT}`);
  console.log(`- Peak Observed Active Concurrency: ${maxObservedConcurrency}`);
  console.log(`- Concurrency Violations (> ${config.CONCURRENCY_LIMIT}): ${concurrencyViolations}`);
  console.log('======================================================');

  if (succeededJobs !== TOTAL_JOBS) {
    throw new Error(`Expected ${TOTAL_JOBS} succeeded jobs, got ${succeededJobs}`);
  }

  if (concurrencyViolations > 0 || maxObservedConcurrency > config.CONCURRENCY_LIMIT) {
    throw new Error(`ASSERTION FAILED: Concurrency cap exceeded! Peak was ${maxObservedConcurrency}`);
  }

  console.log('✅ ASSERTION PASSED: Concurrency cap strictly enforced. Never exceeded CONCURRENCY_LIMIT.');
  await prisma.$disconnect();
}

if (require.main === module) {
  runConcurrencyCapTest().catch(async (err) => {
    console.error('❌ Concurrency cap test failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
