import { PrismaClient } from '@prisma/client';
import { computeBackoffDelay } from '../lib/backoff';
import { AppConfig } from '../lib/config';

/**
 * Sweeps for stuck jobs left in 'processing' status longer than STUCK_JOB_TIMEOUT_MS
 * and resets them back to 'pending' (or 'dead' if maxAttempts is reached).
 */
export async function sweepStuckJobs(prisma: PrismaClient, config: AppConfig): Promise<number> {
  const cutoff = new Date(Date.now() - config.STUCK_JOB_TIMEOUT_MS);

  // Find stuck processing jobs
  const stuckJobs = await prisma.job.findMany({
    where: {
      status: 'processing',
      startedAt: {
        lte: cutoff,
      },
    },
  });

  if (stuckJobs.length === 0) return 0;

  for (const job of stuckJobs) {
    const nextAttempts = job.attempts + 1;
    const errorMessage = `Job timed out in processing state after ${config.STUCK_JOB_TIMEOUT_MS}ms; recovered by sweep.`;

    if (nextAttempts >= job.maxAttempts) {
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'dead',
          attempts: nextAttempts,
          lastError: errorMessage,
          finishedAt: new Date(),
        },
      });
    } else {
      const delayMs = computeBackoffDelay(nextAttempts, config.BACKOFF_BASE_MS, config.BACKOFF_CAP_MS, config.JITTER_FACTOR);
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'pending',
          attempts: nextAttempts,
          lastError: errorMessage,
          runAt: new Date(Date.now() + delayMs),
          startedAt: null,
        },
      });
    }
  }

  return stuckJobs.length;
}

/**
 * Starts the recurring sweep timer loop inside the worker process.
 */
export function startSweepLoop(prisma: PrismaClient, config: AppConfig): NodeJS.Timeout {
  const intervalMs = Math.round(config.STUCK_JOB_TIMEOUT_MS / 2);
  const timer = setInterval(async () => {
    try {
      const recovered = await sweepStuckJobs(prisma, config);
      if (recovered > 0) {
        console.log(`🧹 Stuck job sweep recovered ${recovered} stalled jobs.`);
      }
    } catch (err) {
      console.error('Error executing stuck job sweep:', err);
    }
  }, intervalMs);

  return timer;
}
