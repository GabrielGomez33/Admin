import path from 'path';
import dotenv from 'dotenv';

// Load .env BEFORE any other imports so env vars are available at module load time
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authRouter } from './routes/auth';
import { mirrorRouter } from './routes/mirror';
import { dinaRouter } from './routes/dina';
import { systemRouter } from './routes/system';
import { emailRouter } from './routes/email';
import { authMiddleware } from './middleware/auth';

const app = express();
const PORT = parseInt(process.env.ADMIN_PORT || '8446', 10);

// Security
app.use(helmet());
app.use(cors({
  origin: [
    'https://www.theundergroundrailroad.world',
    'https://theundergroundrailroad.world',
  ],
  credentials: true,
}));
// Raised limit accommodates base64 email attachments routed to the email API.
app.use(express.json({ limit: process.env.ADMIN_JSON_LIMIT || '12mb' }));

// Public routes
app.get('/admin/api/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});
app.use('/admin/api/auth', authRouter);

// Protected routes
app.use('/admin/api/system', authMiddleware, systemRouter);
app.use('/admin/api/mirror', authMiddleware, mirrorRouter);
app.use('/admin/api/dina', authMiddleware, dinaRouter);
app.use('/admin/api/email', authMiddleware, emailRouter);

// Start server
app.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  TUGRR Admin Portal API');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Port:     ${PORT}`);
  console.log(`  Env:      ${process.env.NODE_ENV || 'development'}`);
  console.log(`  Bound:    127.0.0.1 (local only)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});

// Graceful shutdown
const shutdown = (signal: string) => {
  console.log(`\n${signal} received, shutting down admin-server...`);
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
