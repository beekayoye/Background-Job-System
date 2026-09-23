import express from 'express';
import path from 'path';
import { config } from '../lib/config';
import { apiKeyAuth } from './middleware/auth';
import { jobsRouter } from './routes/jobs';

const app = express();

app.use(express.json());

// Serve static frontend files from /public without auth
app.use(express.static(path.join(__dirname, '../public')));

// Protect /api endpoints with fixed API key middleware
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
