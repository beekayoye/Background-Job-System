import http from 'http';
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

async function runTwoWorkerRaceTest() {
  console.log('======================================================');
  console.log('🧪 Break-It Test 05: Two-Worker Atomic Claim Race');
  console.log('======================================================');

  const TOTAL_JOBS = 20;
  const batchId = `race-${Date.now()}`;
  const jobIds: string[] = [];

  console.log(`\n1. Enqueueing ${TOTAL_JOBS} jobs via POST /api/jobs...`);
  const enqueuePromises = [];
  for (let i = 1; i <= TOTAL_JOBS; i++) {
    const payload = {
      type: 'send_email',
      payload: {
        to: `race-test-${i}@example.com`,
        subject: `Two-worker race test #${i}`,
        body: 'Verifying atomic FOR UPDATE SKIP LOCKED prevents double processing across 2 workers.',
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
  console.log(`✔ Enqueued ${jobIds.length} jobs.`);

  console.log('\n2. Waiting for both running workers to process all 20 jobs from the shared queue...');
  const startTime = Date.now();
  const TIMEOUT_MS = 30000;

  while (Date.now() - startTime < TIMEOUT_MS) {
    const completedCount = await prisma.job.count({
      where: {
        id: { in: jobIds },
        status: 'succeeded',
      },
    });

    process.stdout.write(`\rProgress: ${completedCount}/${TOTAL_JOBS} jobs succeeded...`);

    if (completedCount === TOTAL_JOBS) {
      break;
    }

    await sleep(300);
  }
  console.log('\n');

  // 3. Final database verification
  const jobs = await prisma.job.findMany({
    where: { id: { in: jobIds } },
  });

  const succeededJobs = jobs.filter((j) => j.status === 'succeeded');
  const doubleClaimed = jobs.filter((j) => j.attempts > 1);
  const messageIds = new Set(
    jobs.map((j) => (j.result as any)?.messageId).filter((m) => typeof m === 'string')
  );

  console.log('======================================================');
  console.log('📊 Two-Worker Race Verification Results:');
  console.log(`- Total Batch Jobs: ${TOTAL_JOBS}`);
  console.log(`- Total Succeeded: ${succeededJobs.length}/${TOTAL_JOBS}`);
  console.log(`- Jobs With Multiple Attempts (>1): ${doubleClaimed.length}`);
  console.log(`- Unique Provider Message IDs: ${messageIds.size}/${TOTAL_JOBS}`);
  console.log('======================================================');

  if (succeededJobs.length !== TOTAL_JOBS) {
    throw new Error(`Expected all ${TOTAL_JOBS} jobs to succeed, but got ${succeededJobs.length}`);
  }

  if (doubleClaimed.length > 0) {
    throw new Error(`ASSERTION FAILED: ${doubleClaimed.length} jobs had >1 attempt (possible double claim)!`);
  }

  if (messageIds.size !== TOTAL_JOBS) {
    throw new Error(`ASSERTION FAILED: Expected ${TOTAL_JOBS} unique message IDs, got ${messageIds.size}`);
  }

  console.log('✅ ASSERTION PASSED: Zero double-claims, zero collisions across 2 concurrent workers!');
  await prisma.$disconnect();
}

if (require.main === module) {
  runTwoWorkerRaceTest().catch(async (err) => {
    console.error('❌ Two-worker race test failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
