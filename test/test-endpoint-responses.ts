import http from 'http';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/lib/config';

function request(method: string, path: string, body?: any): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: 'localhost',
        port: config.API_PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.FIXED_API_KEY}`,
          ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(raw) });
          } catch {
            resolve({ statusCode: res.statusCode || 0, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function run() {
  const targetId = '82aaf9c1-609a-48ba-9733-ca254da84a44';

  // Ensure the succeeded job exists for this test
  const existing = await prisma.job.findUnique({ where: { id: targetId } });
  if (!existing) {
    await prisma.job.create({
      data: {
        id: targetId,
        type: 'send_email',
        payload: {
          to: 'happy-user@example.com',
          subject: 'Welcome to our platform!',
          body: 'Thank you for signing up.',
        },
        status: 'succeeded',
        attempts: 0,
        maxAttempts: 5,
        idempotencyKey: 'happy-1790162041942',
        result: {
          messageId: 'mock_msg_1790162044782_q7xlsbe',
          timestamp: new Date().toISOString(),
        },
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(),
      },
    });
  }

  console.log('======================================================');
  console.log('1. GET /api/jobs/' + targetId);
  console.log('======================================================');
  const res1 = await request('GET', `/api/jobs/${targetId}`);
  console.log(`HTTP Status: ${res1.statusCode}`);
  console.log('Response Body:\n' + JSON.stringify(res1.body, null, 2));

  console.log('\n======================================================');
  console.log('2. GET /api/jobs/dead');
  console.log('======================================================');
  const res2 = await request('GET', '/api/jobs/dead');
  console.log(`HTTP Status: ${res2.statusCode}`);
  console.log('Response Body:\n' + JSON.stringify(res2.body, null, 2));

  console.log('\n======================================================');
  console.log('3. POST /api/jobs/' + targetId + '/retry');
  console.log('======================================================');
  const res3 = await request('POST', `/api/jobs/${targetId}/retry`);
  console.log(`HTTP Status: ${res3.statusCode}`);
  console.log('Response Body:\n' + JSON.stringify(res3.body, null, 2));

  await prisma.$disconnect();
}

run().catch(async (err) => {
  console.error('Error executing endpoint tests:', err);
  await prisma.$disconnect();
  process.exit(1);
});
