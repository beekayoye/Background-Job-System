import { config } from './config';

/**
 * Computes exponential backoff delay with random jitter.
 * Formula: delay = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2^attempts) + random(0, JITTER_FACTOR * delay)
 *
 * @param attempts - Number of past execution attempts
 * @param baseMs - Base delay in milliseconds (defaults to config.BACKOFF_BASE_MS)
 * @param capMs - Maximum delay cap in milliseconds (defaults to config.BACKOFF_CAP_MS)
 * @param jitterFactor - Jitter factor proportion (defaults to config.JITTER_FACTOR)
 * @returns Computed retry delay in milliseconds
 */
export function computeBackoffDelay(
  attempts: number,
  baseMs: number = config.BACKOFF_BASE_MS,
  capMs: number = config.BACKOFF_CAP_MS,
  jitterFactor: number = config.JITTER_FACTOR
): number {
  const baseDelay = Math.min(capMs, baseMs * Math.pow(2, attempts));
  const jitter = Math.random() * (jitterFactor * baseDelay);
  return Math.round(baseDelay + jitter);
}
