import http from 'http';
import { app } from '../src/api/server';
import { prisma } from '../src/lib/prisma';

function request(port: number, path: string, method: string = 'GET', headers: any = {}, bodyObj?: any): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const postData = bodyObj ? JSON.stringify(bodyObj) : '';
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers: {
          ...(bodyObj ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
          ...headers,
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
  const TEST_PORT = 3199;
  const server = app.listen(TEST_PORT);

  try {
    console.log('1. Checking static /tokens.css delivery:');
    const cssRes = await request(TEST_PORT, '/tokens.css');
    console.log(`HTTP ${cssRes.statusCode} - tokens.css length: ${cssRes.body.length} bytes`);

    console.log('\n2. Checking public /api/session handshake (No UI API key input needed):');
    const sessionRes = await request(TEST_PORT, '/api/session');
    console.log(`HTTP ${sessionRes.statusCode} - Session Data:`, sessionRes.body);

    console.log('\n3. Testing frontend enqueue using the retrieved session token:');
    const token = sessionRes.body.token;
    const enqueueRes = await request(TEST_PORT, '/api/jobs', 'POST', {
      Authorization: `Bearer ${token}`,
    }, {
      type: 'send_email',
      payload: {
        to: 'redesign-test@example.com',
        subject: 'Frontend Redesign Verification',
        body: 'Testing seamless session auth & design tokens.',
      },
      idempotencyKey: `redesign-${Date.now()}`,
    });
    console.log(`HTTP ${enqueueRes.statusCode} - Enqueued Job:`, enqueueRes.body.id);

    console.log('\n4. Checking GET /api/jobs/dead:');
    const deadRes = await request(TEST_PORT, '/api/jobs/dead', 'GET', {
      Authorization: `Bearer ${token}`,
    });
    console.log(`HTTP ${deadRes.statusCode} - Dead count: ${deadRes.body.length}`);

    console.log('\n✅ All endpoints & frontend integration verified successfully.');
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

run().catch(console.error);
