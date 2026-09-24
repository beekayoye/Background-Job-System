import http from 'http';
import { app } from '../src/api/server';
import { prisma } from '../src/lib/prisma';
import { config } from '../src/lib/config';

async function testDelete() {
  const server = app.listen(3299);
  try {
    const job = await prisma.job.create({
      data: {
        type: 'send_email',
        payload: { to: 'delete-me@example.com', subject: 'To be deleted', body: 'Test' },
        idempotencyKey: 'del-test-' + Date.now(),
        status: 'dead',
        lastError: 'Simulated failure for deletion test',
      },
    });
    console.log('Created test dead job:', job.id);

    const res = await new Promise<{ statusCode: number; data: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: 'localhost',
          port: 3299,
          path: '/api/jobs/' + job.id,
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + config.FIXED_API_KEY },
        },
        (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ statusCode: r.statusCode || 0, data }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    console.log('DELETE response status:', res.statusCode);
    console.log('DELETE response body:', res.data);
    const inDb = await prisma.job.findUnique({ where: { id: job.id } });
    console.log('Job exists in DB after deletion:', inDb !== null);
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

testDelete().catch(console.error);
