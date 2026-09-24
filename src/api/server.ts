import express from 'express';
import path from 'path';
import { config } from '../lib/config';
import { apiKeyAuth } from './middleware/auth';
import { jobsRouter } from './routes/jobs';

const app = express();

app.use(express.json());

// Serve static frontend files from /public without auth
app.use(express.static(path.join(__dirname, '../public')));

// Serve design system CSS tokens bundle
app.use('/tokens.css', express.static(path.join(__dirname, '../../dist/tokens.css')));

// Public demo session token for the embedded browser UI (no secrets committed in static HTML/JS)
app.get('/api/session', (_req, res) => {
  res.json({
    token: config.FIXED_API_KEY,
    provider: config.EMAIL_API_KEY && config.EMAIL_API_KEY.startsWith('re_') ? 'Resend' : 'Mock',
    fromAddress: config.EMAIL_FROM_ADDRESS,
  });
});

// Protect all other /api endpoints with fixed API key middleware
app.use('/api', apiKeyAuth);
app.use('/api/jobs', jobsRouter);

const PORT = config.API_PORT;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 API server running at http://localhost:${PORT}`);
    console.log(`Protected API routes require Authorization header or x-api-key.`);
  });
}

export { app };
