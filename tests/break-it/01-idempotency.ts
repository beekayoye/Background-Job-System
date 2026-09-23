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

async function runIdempotencyTest() {
  console.log('======================================================');
  console.log('🧪 Break-It Test 01: Idempotency Key Enforcement');
  console.log('======================================================');

  const idempotencyKey = `idempotency-test-${uuidv4()}`;
  const payload = {
    type: 'send_email',
    payload: {
      to: 'idempotency-check@example.com',
      subject: 'Testing Idempotency',
      body: 'Ensuring duplicate key submissions create exactly one row.',
    },
    idempotencyKey,
  };

  console.log(`1. Sending FIRST POST /api/jobs with key "${idempotencyKey}"...`);
  const firstRes = await sendPostRequest('/api/jobs', payload);
  console.log(`-> Response 1: HTTP ${firstRes.statusCode}`);
  console.log(`   Job ID: ${firstRes.data.id}`);

  if (firstRes.statusCode !== 202) {
    throw new Error(`Expected HTTP 202 for fresh enqueue, got ${firstRes.statusCode}`);
  }

  console.log(`\n2. Sending SECOND POST /api/jobs with SAME key "${idempotencyKey}"...`);
  const secondRes = await sendPostRequest('/api/jobs', payload);
  console.log(`-> Response 2: HTTP ${secondRes.statusCode}`);
  console.log(`   Job ID: ${secondRes.data.id}`);

  if (secondRes.statusCode !== 200) {
    throw new Error(`Expected HTTP 200 for duplicate enqueue, got ${secondRes.statusCode}`);
  }

  if (firstRes.data.id !== secondRes.data.id) {
    throw new Error(`Job IDs do not match! (first: ${firstRes.data.id}, second: ${secondRes.data.id})`);
  }

  console.log('\n3. Querying database directly for all rows with this idempotencyKey...');
  const rows = await prisma.job.findMany({
    where: { idempotencyKey },
  });

  console.log(`-> Found ${rows.length} row(s) in PostgreSQL database.`);
  console.log('Database Row details:');
  console.log(JSON.stringify(rows, null, 2));

  if (rows.length !== 1) {
    throw new Error(`ASSERTION FAILED: Expected exactly 1 row, found ${rows.length}`);
  }

  console.log('\n✅ ASSERTION PASSED: Exactly 1 row exists. Idempotency is fully enforced.');
  await prisma.$disconnect();
}

if (require.main === module) {
  runIdempotencyTest().catch(async (err) => {
    console.error('❌ Idempotency test failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
}
