import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../../lib/prisma';

export const jobsRouter = Router();

/**
 * POST /api/jobs
 * Enqueues a new background job with idempotency protection.
 * Returns 202 on new job creation, 200 on duplicate idempotency key.
 */
jobsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const { type, payload, idempotencyKey: clientKey } = req.body;

    if (!type || typeof type !== 'string') {
      res.status(400).json({ error: 'Field "type" is required and must be a string' });
      return;
    }

    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Field "payload" is required and must be an object' });
      return;
    }

    // Server-generates UUID if client omits idempotencyKey
    const idempotencyKey = clientKey && typeof clientKey === 'string' && clientKey.trim() !== ''
      ? clientKey.trim()
      : uuidv4();

    // Check for existing idempotencyKey
    const existingJob = await prisma.job.findUnique({
      where: { idempotencyKey },
    });

    if (existingJob) {
      // Duplicate idempotencyKey returns HTTP 200 with existing job data
      res.status(200).json(existingJob);
      return;
    }

    // Insert new pending job
    const newJob = await prisma.job.create({
      data: {
        type,
        payload,
        idempotencyKey,
        status: 'pending',
      },
    });

    // HTTP 202 with job id; performs no synchronous work
    res.status(202).json({ id: newJob.id, status: newJob.status, idempotencyKey: newJob.idempotencyKey });
  } catch (err: unknown) {
    // Handle database unique constraint race conditions if two identical keys insert simultaneously
    const prismaError = err as { code?: string };
    if (prismaError.code === 'P2002') {
      const existing = await prisma.job.findUnique({
        where: { idempotencyKey: req.body.idempotencyKey },
      });
      if (existing) {
        res.status(200).json(existing);
        return;
      }
    }
    console.error('Error creating job:', err);
    res.status(500).json({ error: 'Internal server error while enqueuing job' });
  }
});

/**
 * GET /api/jobs/dead
 * Lists all jobs in dead status with full payload and error history.
 */
jobsRouter.get('/dead', async (_req: Request, res: Response) => {
  try {
    const deadJobs = await prisma.job.findMany({
      where: { status: 'dead' },
      orderBy: { updatedAt: 'desc' },
    });
    res.status(200).json(deadJobs);
  } catch (err) {
    console.error('Error fetching dead jobs:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/jobs/:id
 * Fetches status, attempts, error message, and timestamps for a specific job.
 */
jobsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const job = await prisma.job.findUnique({
      where: { id },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    res.status(200).json(job);
  } catch (err) {
    console.error('Error fetching job by id:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/jobs/:id/retry
 * Resets a dead job back to pending status for manual recovery.
 */
jobsRouter.post('/:id/retry', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const job = await prisma.job.findUnique({
      where: { id },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    if (job.status !== 'dead') {
      res.status(400).json({ error: `Cannot retry job in status "${job.status}"; only "dead" jobs can be retried` });
      return;
    }

    const resetJob = await prisma.job.update({
      where: { id },
      data: {
        status: 'pending',
        attempts: 0,
        lastError: null,
        runAt: new Date(),
        startedAt: null,
        finishedAt: null,
      },
    });

    res.status(200).json(resetJob);
  } catch (err) {
    console.error('Error retrying dead job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
