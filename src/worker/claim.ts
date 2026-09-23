import { PrismaClient, Job } from '@prisma/client';

/**
 * Atomically claims the next eligible pending job for processing.
 *
 * CRITICAL ARCHITECTURAL CONTRACT:
 * Uses PostgreSQL's `FOR UPDATE SKIP LOCKED` inside a subquery to guarantee that
 * exactly one worker process claims each eligible job with zero race conditions.
 *
 * Never replace this statement with findFirst() + update().
 *
 * @param prisma - Prisma client instance
 * @returns The claimed Job record in processing status, or null if no eligible jobs exist.
 */
export async function claimNextJob(prisma: PrismaClient): Promise<Job | null> {
  const result = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
    SET status = 'processing', "startedAt" = now()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status = 'pending' AND "runAt" <= now()
      ORDER BY "runAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *;
  `;

  return result.length > 0 ? result[0] : null;
}
