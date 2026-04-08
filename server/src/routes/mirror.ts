import { Router } from 'express';
import { getMirrorHealth } from '../services/health';
import { getPM2Processes } from '../services/pm2';
import { tailLog } from '../services/logs';

export const mirrorRouter = Router();

// GET /admin/api/mirror/health — Mirror server health
mirrorRouter.get('/health', async (_req, res) => {
  try {
    const health = await getMirrorHealth();

    // Inject real dina-chat-worker PM2 status into features
    if (health.details && (health.details as Record<string, unknown>).features) {
      const features = (health.details as Record<string, Record<string, string>>).features;
      try {
        const processes = await getPM2Processes();
        const worker = processes.find(p => p.name === 'dina-chat-worker');
        features.dinaChatProcessor = worker
          ? (worker.status === 'online' ? 'healthy' : worker.status)
          : 'not_found';
      } catch {
        features.dinaChatProcessor = 'unknown';
      }
    }

    res.json(health);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch mirror health' });
  }
});

// GET /admin/api/mirror/logs — Mirror server logs
mirrorRouter.get('/logs', (req, res) => {
  const type = (req.query.type as string) || 'out';
  const lines = Math.min(parseInt(req.query.lines as string) || 100, 500);
  const filename = type === 'error' ? 'mirror-server-error.log' : 'mirror-server-out.log';
  const entries = tailLog(filename, lines);
  res.json({ service: 'mirror-server', type, entries });
});

// GET /admin/api/mirror/workers — All mirror worker logs
mirrorRouter.get('/workers', (_req, res) => {
  const workers = ['analysis-worker', 'dina-chat-worker', 'truthstream-worker', 'personal-analysis-worker'];
  const result = workers.map(name => ({
    name,
    errors: tailLog(`${name}-error.log`, 20),
    recent: tailLog(`${name}-out.log`, 10),
  }));
  res.json({ workers: result });
});
