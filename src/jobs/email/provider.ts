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
 * In a production integration, this adapter can be replaced or extended with SendGrid, Postmark, AWS SES, or Resend.
 */
export class MockEmailProvider implements EmailProvider {
  private shouldFailWithCode: number | null = null;

  constructor(failureCode: number | null = null) {
    this.shouldFailWithCode = failureCode;
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    // Basic email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(params.to)) {
      const err = new Error(`Recipient address "${params.to}" is invalid`) as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    if (this.shouldFailWithCode) {
      const err = new Error(`Simulated email provider HTTP error: ${this.shouldFailWithCode}`) as Error & { statusCode?: number };
      err.statusCode = this.shouldFailWithCode;
      throw err;
    }

    // Simulate network latency (50-150ms)
    await new Promise((resolve) => setTimeout(resolve, 50));

    return {
      messageId: `mock_msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      timestamp: new Date().toISOString(),
      rawResponse: { status: 'accepted' },
    };
  }
}
