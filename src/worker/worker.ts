import { prisma } from '../lib/prisma';
import { config } from '../lib/config';
import { claimNextJob } from './claim';
import { startSweepLoop } from './sweep';
import { MockEmailProvider, EmailProvider } from '../jobs/email/provider';
import { processEmailJob } from '../jobs/email/handler';

export class Worker {
  private isRunning: boolean = false;
  private isPaused: boolean = false;
  private activeJobsCount: number = 0;
  private provider: EmailProvider;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(customProvider?: EmailProvider) {
    this.provider = customProvider || new MockEmailProvider();
  }

  public getActiveJobsCount(): number {
    return this.activeJobsCount;
  }

  public pause(): void {
    this.isPaused = true;
    console.log('⏸ Worker paused from polling new jobs.');
  }

  public resume(): void {
    this.isPaused = false;
    console.log('▶ Worker resumed polling.');
  }

  public async start(): Promise<void> {
    this.isRunning = true;
    console.log(`👷 Worker started (Concurrency Limit: ${config.CONCURRENCY_LIMIT}, Poll: ${config.POLL_INTERVAL_MS}ms)`);

    // Start background sweep timer
    this.sweepTimer = startSweepLoop(prisma, config);

    // Main polling loop
    while (this.isRunning) {
      if (this.isPaused) {
        await new Promise((r) => setTimeout(r, config.POLL_INTERVAL_MS));
        continue;
      }

      // Check available capacity against CONCURRENCY_LIMIT
      const availableCapacity = config.CONCURRENCY_LIMIT - this.activeJobsCount;

      if (availableCapacity <= 0) {
        // At max concurrency; sleep and wait for active jobs to finish
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }

      try {
        const job = await claimNextJob(prisma);

        if (!job) {
          // No eligible jobs; sleep for poll interval
          await new Promise((r) => setTimeout(r, config.POLL_INTERVAL_MS));
          continue;
        }

        // Claimed job; execute in background
        this.activeJobsCount++;
        console.log(`[WORKER] Claimed job ${job.id}. Active jobs: ${this.activeJobsCount}/${config.CONCURRENCY_LIMIT}`);
        this.executeJob(job).finally(() => {
          this.activeJobsCount--;
          console.log(`[WORKER] Finished job ${job.id}. Active jobs: ${this.activeJobsCount}/${config.CONCURRENCY_LIMIT}`);
        });
      } catch (err) {
        console.error('Error claiming job in polling loop:', err);
        await new Promise((r) => setTimeout(r, config.POLL_INTERVAL_MS));
      }
    }
  }

  private async executeJob(job: any): Promise<void> {
    try {
      const result = await processEmailJob(job, this.provider, prisma);
      if (result.classification === 'system_level') {
        this.pause();
      }
    } catch (err) {
      console.error(`Unexpected failure executing job ${job.id}:`, err);
    }
  }

  public stop(): void {
    this.isRunning = false;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    console.log('🛑 Worker stopped.');
  }
}

if (require.main === module) {
  const worker = new Worker();
  worker.start().catch((err) => {
    console.error('Fatal worker crash:', err);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    worker.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    worker.stop();
    process.exit(0);
  });
}
