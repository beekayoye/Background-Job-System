import { spawn } from 'child_process';
import path from 'path';

interface TestResult {
  file: string;
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

const BREAK_IT_TESTS = [
  { file: '01-idempotency.ts', name: '01 Idempotency Guarantee' },
  { file: '02-concurrency-cap.ts', name: '02 In-Process Concurrency Cap' },
  { file: '03-forced-failure-to-dead.ts', name: '03 Forced Failure to Dead-Letter' },
  { file: '04-stuck-job-recovery.ts', name: '04 Stuck-Job Crash Recovery Sweep' },
  { file: '05-two-worker-race.ts', name: '05 Multi-Worker Atomic Claim Race' },
];

function runTest(testFile: string): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const startTime = Date.now();
  const filePath = path.join(__dirname, testFile);

  return new Promise((resolve) => {
    console.log(`\n======================================================================`);
    console.log(`▶ Running: ${testFile}`);
    console.log(`======================================================================`);

    const child = spawn('npx', ['ts-node', filePath], {
      stdio: 'inherit',
      shell: true,
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      if (code === 0) {
        resolve({ success: true, durationMs });
      } else {
        resolve({ success: false, durationMs, error: `Exited with code ${code}` });
      }
    });

    child.on('error', (err) => {
      const durationMs = Date.now() - startTime;
      resolve({ success: false, durationMs, error: err.message });
    });
  });
}

async function runAllBreakItTests() {
  console.log('🧪 Starting Phase 4 Break-It Test Suite Verification...\n');
  const results: TestResult[] = [];

  for (const t of BREAK_IT_TESTS) {
    const res = await runTest(t.file);
    results.push({
      file: t.file,
      name: t.name,
      success: res.success,
      durationMs: res.durationMs,
      error: res.error,
    });
  }

  console.log('\n======================================================================');
  console.log('📊 CONSOLIDATED BREAK-IT TEST SUMMARY MATRIX');
  console.log('======================================================================');

  let allPassed = true;
  for (const r of results) {
    const statusIcon = r.success ? '✅ PASS' : '❌ FAIL';
    const duration = `${(r.durationMs / 1000).toFixed(2)}s`;
    console.log(`${statusIcon} | ${r.name.padEnd(42)} | ${duration.padStart(8)}${r.error ? ` (${r.error})` : ''}`);
    if (!r.success) allPassed = false;
  }
  console.log('======================================================================');

  if (allPassed) {
    console.log('🎉 ALL 5 BREAK-IT TESTS PASSED SUCCESSFULLY!\n');
    process.exit(0);
  } else {
    console.error('⚠️ ONE OR MORE BREAK-IT TESTS FAILED.\n');
    process.exit(1);
  }
}

runAllBreakItTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
