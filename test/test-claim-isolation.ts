import { prisma } from '../src/lib/prisma';
import { claimNextJob } from '../src/worker/claim';

async function testClaimIsolation() {
  console.log('=== BEFORE CLAIM ===');
  const pendingJobs = await prisma.job.findMany({ where: { status: 'pending' } });
  console.log(`Found ${pendingJobs.length} pending job(s) in database.`);
  if (pendingJobs.length > 0) {
    console.log(`Target Job ID: ${pendingJobs[0].id}, Status: ${pendingJobs[0].status}, runAt: ${pendingJobs[0].runAt}`);
  }

  console.log('\n=== CALLING claimNextJob(prisma) IN ISOLATION ===');
  const claimedJob = await claimNextJob(prisma);

  if (!claimedJob) {
    console.log('No job was claimed (returned null).');
    return;
  }

  console.log('Returned Job Row from claimNextJob:');
  console.log(JSON.stringify(claimedJob, null, 2));

  console.log('\n=== VERIFYING DATABASE STATE ===');
  const refreshedJob = await prisma.job.findUnique({ where: { id: claimedJob.id } });
  console.log('Persisted DB Record:');
  console.log(JSON.stringify({
    id: refreshedJob?.id,
    status: refreshedJob?.status,
    startedAt: refreshedJob?.startedAt,
    runAt: refreshedJob?.runAt,
    attempts: refreshedJob?.attempts,
  }, null, 2));

  await prisma.$disconnect();
}

testClaimIsolation().catch((err) => {
  console.error('Test failed with error:', err);
  prisma.$disconnect();
  process.exit(1);
});
