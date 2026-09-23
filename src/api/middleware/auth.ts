import { Request, Response, NextFunction } from 'express';
import { config } from '../../lib/config';

/**
 * Validates the fixed API key on incoming HTTP requests.
 * Header format: Authorization: Bearer <FIXED_API_KEY> or x-api-key: <FIXED_API_KEY>
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];

  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : (apiKeyHeader as string);

  if (!token || token !== config.FIXED_API_KEY) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    return;
  }

  next();
}
