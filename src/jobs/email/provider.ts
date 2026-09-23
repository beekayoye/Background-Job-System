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
 * Default Sandbox/Mock Email Provider Adapter.
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
