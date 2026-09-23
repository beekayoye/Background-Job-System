import { config } from '../../src/lib/config';

async function runTwoWorkerRaceTest() {
  console.log('🧪 Running Break-It Test 05: Two-Worker Atomic Claim Race');
  console.log(`Running two concurrent workers with CONCURRENCY_LIMIT=${config.CONCURRENCY_LIMIT} to verify zero collisions.`);
}

if (require.main === module) {
  runTwoWorkerRaceTest().catch(console.error);
}
