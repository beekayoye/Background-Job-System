import http from 'http';
import { app } from '../src/api/server';
import { config } from '../src/lib/config';
import { prisma } from '../src/lib/prisma';

function request(port: number, bodyObj: any): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(bodyObj);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/api/jobs',
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
            resolve({ statusCode: res.statusCode || 0, body: JSON.parse(raw) });
          } catch {
            resolve({ statusCode: res.statusCode || 0, body: raw });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function run() {
  const TEST_PORT = 3099;
  const server = app.listen(TEST_PORT);

  try {
    console.log('======================================================');
    console.log('1. POST /api/jobs with type: "send_email" (Valid)');
    console.log('======================================================');
    const validRes = await request(TEST_PORT, {
      type: 'send_email',
      payload: {
        to: 'user@example.com',
        subject: 'UI Form Submission Verification',
        body: 'Testing type send_email',
      },
      idempotencyKey: `ui-submit-${Date.now()}`,
    });
    console.log(`HTTP Status: ${validRes.statusCode}`);
    console.log('Response Body (Full Row):\n' + JSON.stringify(validRes.body, null, 2));

    console.log('\n======================================================');
    console.log('2. POST /api/jobs with type: "not_a_real_type" (Invalid)');
    console.log('======================================================');
    const invalidRes = await request(TEST_PORT, {
      type: 'not_a_real_type',
      payload: {
        to: 'user@example.com',
        subject: 'Should Fail',
        body: 'Testing unsupported type rejection',
      },
      idempotencyKey: `bad-type-${Date.now()}`,
    });
    console.log(`HTTP Status: ${invalidRes.statusCode}`);
    console.log('Response Body:\n' + JSON.stringify(invalidRes.body, null, 2));
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

run().catch(console.error);
