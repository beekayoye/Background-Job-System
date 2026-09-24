import { config } from '../../lib/config';

export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  from: string;
  idempotencyKey?: string;
}

export interface SendEmailResult {
  messageId: string;
  timestamp: string;
  rawResponse?: unknown;
}

export interface EmailProvider {
  send(params: SendEmailParams): Promise<SendEmailResult>;
}

/**
 * Resend Email Provider Adapter.
 *
 * Implements transactional email dispatch through the official Resend API (https://api.resend.com/emails).
 * Automatically maps authentication errors (401/403), validation errors (400/422),
 * and rate limits (429) to classified Error instances.
 */
export class ResendEmailProvider implements EmailProvider {
  private apiKey: string;
  private timeoutMs: number;

  constructor(apiKey: string = config.EMAIL_API_KEY, timeoutMs: number = config.EMAIL_API_TIMEOUT_MS) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    // Basic recipient syntax check before network call
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(params.to)) {
      const err = new Error(`Recipient address "${params.to}" is invalid`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(params.idempotencyKey ? { 'X-Entity-Ref-ID': params.idempotencyKey } : {}),
        },
        body: JSON.stringify({
          from: params.from,
          to: [params.to],
          subject: params.subject,
          text: params.body,
          html: `<div style="font-family: sans-serif; line-height: 1.5; color: #333;">${params.body.replace(/\n/g, '<br>')}</div>`,
        }),
        signal: controller.signal,
      });

      const responseData = (await response.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
        statusCode?: number;
        name?: string;
      };

      if (!response.ok) {
        const error = new Error(
          responseData?.message || `Resend API error: HTTP ${response.status} ${response.statusText}`
        ) as Error & { statusCode?: number; rawResponse?: unknown };
        error.statusCode = response.status;
        error.rawResponse = responseData;
        throw error;
      }

      if (!responseData?.id || typeof responseData.id !== 'string') {
        throw new Error('Resend response did not contain a valid email ID');
      }

      return {
        messageId: responseData.id,
        timestamp: new Date().toISOString(),
        rawResponse: responseData,
      };
    } catch (err: unknown) {
      const fetchErr = err as Error & { name?: string; statusCode?: number };
      if (fetchErr.name === 'AbortError') {
        const timeoutError = new Error(`Resend API request timed out after ${this.timeoutMs}ms`) as Error & { statusCode?: number };
        timeoutError.statusCode = 504;
        throw timeoutError;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Sandbox/Mock Email Provider Adapter.
 *
 * Implements the EmailProvider interface to allow end-to-end testing without external network dependencies.
 * Supports configurable simulation triggers in payload/subject for testing failure paths and worker crashes.
 */
export class MockEmailProvider implements EmailProvider {
  private shouldFailWithCode: number | null = null;

  constructor(failureCode: number | null = null) {
    this.shouldFailWithCode = failureCode;
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    // Basic recipient syntax check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(params.to)) {
      const err = new Error(`Recipient address "${params.to}" is invalid`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    // Explicit constructor error override
    if (this.shouldFailWithCode) {
      const err = new Error(`Simulated email provider HTTP error: ${this.shouldFailWithCode}`) as Error & { statusCode?: number };
      err.statusCode = this.shouldFailWithCode;
      throw err;
    }

    // Payload-driven simulation triggers for end-to-end testing
    if (params.subject?.includes('SIMULATE_500') || params.to?.includes('fail500')) {
      const err = new Error('Simulated email provider 500 Server Error (transient outage)') as Error & { statusCode?: number };
      err.statusCode = 500;
      throw err;
    }

    if (params.subject?.includes('SIMULATE_401')) {
      const err = new Error('Simulated email provider 401 Unauthorized (invalid API key)') as Error & { statusCode?: number };
      err.statusCode = 401;
      throw err;
    }

    // Simulate in-flight duration (long delay for crash recovery test, normal for standard calls)
    if (params.subject?.includes('SLOW_SEND')) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return {
      messageId: `mock_msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: new Date().toISOString(),
      rawResponse: { status: 'accepted' },
    };
  }
}
