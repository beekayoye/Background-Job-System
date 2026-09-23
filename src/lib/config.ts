import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  DATABASE_URL: string;
  API_PORT: number;
  FIXED_API_KEY: string;
  MAX_ATTEMPTS: number;
  BACKOFF_BASE_MS: number;
  BACKOFF_CAP_MS: number;
  JITTER_FACTOR: number;
  CONCURRENCY_LIMIT: number;
  STUCK_JOB_TIMEOUT_MS: number;
  POLL_INTERVAL_MS: number;
  EMAIL_API_KEY: string;
  EMAIL_API_TIMEOUT_MS: number;
  EMAIL_FROM_ADDRESS: string;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = Number(val);
  if (isNaN(parsed)) {
    throw new Error(`Invalid numeric configuration value for environment variable: ${key}=${val}`);
  }
  return parsed;
}

function getEnvString(key: string, defaultValue?: string): string {
  const val = process.env[key];
  if (!val) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

/**
 * Validates and exports all configuration variables from process.env.
 * Fails fast at startup if any required variable is missing.
 */
export const config: AppConfig = {
  DATABASE_URL: getEnvString('DATABASE_URL', 'postgresql://postgres:postgres@localhost:5432/job_system_db?schema=public'),
  API_PORT: getEnvNumber('API_PORT', 3000),
  FIXED_API_KEY: getEnvString('FIXED_API_KEY', 'demo-secret-api-key'),
  MAX_ATTEMPTS: getEnvNumber('MAX_ATTEMPTS', 5),
  BACKOFF_BASE_MS: getEnvNumber('BACKOFF_BASE_MS', 30000),
  BACKOFF_CAP_MS: getEnvNumber('BACKOFF_CAP_MS', 300000),
  JITTER_FACTOR: getEnvNumber('JITTER_FACTOR', 0.2),
  CONCURRENCY_LIMIT: getEnvNumber('CONCURRENCY_LIMIT', 5),
  STUCK_JOB_TIMEOUT_MS: getEnvNumber('STUCK_JOB_TIMEOUT_MS', 300000),
  POLL_INTERVAL_MS: getEnvNumber('POLL_INTERVAL_MS', 1000),
  EMAIL_API_KEY: getEnvString('EMAIL_API_KEY', 'placeholder_email_api_key'),
  EMAIL_API_TIMEOUT_MS: getEnvNumber('EMAIL_API_TIMEOUT_MS', 10000),
  EMAIL_FROM_ADDRESS: getEnvString('EMAIL_FROM_ADDRESS', 'no-reply@example.com'),
};
