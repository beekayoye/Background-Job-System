import { Job, PrismaClient } from '@prisma/client';
import { EmailProvider } from './provider';
import { computeBackoffDelay } from '../../lib/backoff';
import { config } from '../../lib/config';

export interface EmailPayload {
  to: string;
  subject: string;
  body: string;
}

export type FailureClassification = 'retryable' | 'permanent' | 'system_level';

export interface ProcessJobResult {
  success: boolean;
  classification?: FailureClassification;
  error?: string;
}

/**
 * Classifies an error into retryable, permanent, or system-level failure categories.
 */
export function classifyEmailError(err: unknown): { classification: FailureClassification; message: string } {
  const errorObj = err as { statusCode?: number; code?: string; message?: string };
  const message = errorObj?.message || 'Unknown email dispatch error';
  const statusCode = errorObj?.statusCode;

  // System-level credential failures (401/403)
  if (statusCode === 401 || statusCode === 403) {
    return { classification: 'system_level', message };
  }

  // Permanent failures (400 bad request, recipient invalid)
  if (statusCode === 400 || message.toLowerCase().includes('invalid') || message.toLowerCase().includes('malformed')) {
    return { classification: 'permanent', message };
  }

  // Default: Retryable (network timeout, 429 rate limits, 5xx server errors)
  return { classification: 'retryable', message };
}

/**
 * Handles transactional email job execution, error classification, and state transitions.
 */
export async function processEmailJob(
  job: Job,
  provider: EmailProvider,
  prisma: PrismaClient
): Promise<ProcessJobResult> {
  const payload = job.payload as unknown as EmailPayload;

  try {
    const sendResult = await provider.send({
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      from: config.EMAIL_FROM_ADDRESS,
      idempotencyKey: job.idempotencyKey,
    });

    // Mark succeeded and record result JSON immediately to narrow the crash window
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        finishedAt: new Date(),
        result: {
          messageId: sendResult.messageId,
          timestamp: sendResult.timestamp,
        },
      },
    });

    return { success: true };
  } catch (err) {
    const { classification, message } = classifyEmailError(err);
    const nextAttempts = job.attempts + 1;

    if (classification === 'system_level') {
      console.error(`🚨 CRITICAL SYSTEM ALERT: Email provider authentication failed (401/403): ${message}`);
      // Do not dead-letter; leave job for retry once credentials are fixed
      return { success: false, classification, error: message };
    }

    if (classification === 'permanent' || nextAttempts >= job.maxAttempts) {
      // Transition immediately to dead
      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'dead',
          attempts: nextAttempts,
          lastError: message,
          finishedAt: new Date(),
        },
      });
      return { success: false, classification, error: message };
    }

    // Retryable failure with exponential backoff & jitter
    const delayMs = computeBackoffDelay(nextAttempts, config.BACKOFF_BASE_MS, config.BACKOFF_CAP_MS, config.JITTER_FACTOR);
    const nextRunAt = new Date(Date.now() + delayMs);

    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'pending',
        attempts: nextAttempts,
        lastError: message,
        runAt: nextRunAt,
      },
    });

    return { success: false, classification, error: message };
  }
}
