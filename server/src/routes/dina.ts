import { Router } from 'express';
import { getDinaHealth } from '../services/health';
import { tailLog } from '../services/logs';

export const dinaRouter = Router();

// GET /admin/api/dina/health — DINA server health
dinaRouter.get('/health', async (_req, res) => {
  try {
    const health = await getDinaHealth();
    res.json(health);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch DINA health' });
  }
});

// GET /admin/api/dina/logs — DINA server logs
dinaRouter.get('/logs', (req, res) => {
  const type = (req.query.type as string) || 'out';
  const lines = Math.min(parseInt(req.query.lines as string) || 100, 500);
  const filename = type === 'error' ? 'dina-server-error.log' : 'dina-server-out.log';
  const entries = tailLog(filename, lines);
  res.json({ service: 'dina-server', type, entries });
});
