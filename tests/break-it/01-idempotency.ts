import { v4 as uuidv4 } from 'uuid';
import { config } from '../../src/lib/config';

async function runIdempotencyTest() {
  console.log('🧪 Running Break-It Test 01: Idempotency Enforcement');

  const testKey = `test-key-${uuidv4()}`;
  const endpoint = `http://localhost:${config.API_PORT}/api/jobs`;

  console.log(`Submitting requests to ${endpoint} with idempotencyKey: ${testKey}`);
  console.log('✔ Test script structure initialized.');
}

if (require.main === module) {
  runIdempotencyTest().catch(console.error);
}
