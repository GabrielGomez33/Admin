import { Router } from 'express';
import { getPM2Processes } from '../services/pm2';
import { getSystemInfo } from '../services/system';
import { listLogFiles, tailLog, getRecentErrors } from '../services/logs';
import { getAllHealth } from '../services/health';

export const systemRouter = Router();

// GET /admin/api/system/overview — Full system dashboard data in one call
systemRouter.get('/overview', async (_req, res) => {
  try {
    const [processes, system, health, errors] = await Promise.all([
      getPM2Processes(),
      getSystemInfo(),
      getAllHealth(),
      Promise.resolve(getRecentErrors(20)),
    ]);

    const logFiles = listLogFiles();

    res.json({
      processes,
      system,
      health,
      errors,
      logFiles,
      serverStartedAt: startedAt,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system overview' });
  }
});

// Admin server boot timestamp (for uptime tracking)
const startedAt = new Date().toISOString();

// GET /admin/api/system/processes — PM2 process list
systemRouter.get('/processes', async (_req, res) => {
  try {
    const processes = await getPM2Processes();
    res.json({ processes });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch processes' });
  }
});

// GET /admin/api/system/info — OS/hardware info
systemRouter.get('/info', async (_req, res) => {
  try {
    const info = await getSystemInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch system info' });
  }
});

// GET /admin/api/system/health — Aggregated health from all services
systemRouter.get('/health', async (_req, res) => {
  try {
    const health = await getAllHealth();
    res.json({ services: health });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch health data' });
  }
});

// GET /admin/api/system/logs — List all log files
systemRouter.get('/logs', (_req, res) => {
  const files = listLogFiles();
  res.json({ files });
});

// GET /admin/api/system/logs/:filename — Tail a specific log file
systemRouter.get('/logs/:filename', (req, res) => {
  const lines = parseInt(req.query.lines as string) || 100;
  const capped = Math.min(lines, 500);
  const entries = tailLog(req.params.filename, capped);
  res.json({ filename: req.params.filename, lines: capped, entries });
});

// GET /admin/api/system/errors — Recent errors across all services
systemRouter.get('/errors', (_req, res) => {
  const errors = getRecentErrors(50);
  res.json({ errors });
});
