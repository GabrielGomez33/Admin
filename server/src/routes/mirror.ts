import { Router, Request } from 'express';
import { getMirrorHealth } from '../services/health';
import { getPM2Processes } from '../services/pm2';
import { tailLog } from '../services/logs';
import { mirrorSimRequest } from '../services/mirrorSimulationClient';

export const mirrorRouter = Router();

// Operator identity for audit — set by authMiddleware after JWT verification.
function operatorOf(req: Request): string {
  return req.admin?.username || 'admin';
}

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
  const workers = ['analysis-worker', 'dina-chat-worker', 'truthstream-worker', 'personal-analysis-worker', 'email-campaign-worker'];
  const result = workers.map(name => ({
    name,
    errors: tailLog(`${name}-error.log`, 20),
    recent: tailLog(`${name}-out.log`, 10),
  }));
  res.json({ workers: result });
});

// ============================================================================
// INTAKE SIMULATION (proxied to mirror-server's internal admin API)
// ----------------------------------------------------------------------------
// The human operator is already authenticated by admin-server's authMiddleware.
// These handlers forward the request to mirror-server over localhost with the
// shared internal secret + the operator's username (mirrorSimRequest), and
// relay mirror-server's status code + JSON body straight back to the client.
// ============================================================================

// GET /admin/api/mirror/simulation/health — readiness of the simulation tool
mirrorRouter.get('/simulation/health', async (req, res) => {
  try {
    const r = await mirrorSimRequest('GET', '/health', undefined, operatorOf(req));
    res.status(r.status).json(r.body);
  } catch (error) {
    res.status(502).json({ success: false, error: (error as Error).message || 'Failed to reach simulation API' });
  }
});

// POST /admin/api/mirror/simulation/run — run a full intake simulation
mirrorRouter.post('/simulation/run', async (req, res) => {
  try {
    const body = {
      dryRun: req.body?.dryRun === true,
      skipCleanup: req.body?.skipCleanup === true,
      label: typeof req.body?.label === 'string' ? req.body.label : undefined,
      // Optional credentials for a kept test user (only used when skipCleanup).
      password: typeof req.body?.password === 'string' && req.body.password.length > 0 ? req.body.password : undefined,
      emailLocalPart: typeof req.body?.emailLocalPart === 'string' && req.body.emailLocalPart.length > 0 ? req.body.emailLocalPart : undefined,
    };
    const r = await mirrorSimRequest('POST', '/intake/run', body, operatorOf(req));
    res.status(r.status).json(r.body);
  } catch (error) {
    res.status(502).json({ success: false, error: (error as Error).message || 'Failed to run intake simulation' });
  }
});

// GET /admin/api/mirror/simulation/runs — recent run history
mirrorRouter.get('/simulation/runs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const r = await mirrorSimRequest('GET', `/intake/runs?limit=${limit}`, undefined, operatorOf(req));
    res.status(r.status).json(r.body);
  } catch (error) {
    res.status(502).json({ success: false, error: (error as Error).message || 'Failed to list simulation runs' });
  }
});

// GET /admin/api/mirror/simulation/runs/:id — a single run report
mirrorRouter.get('/simulation/runs/:id', async (req, res) => {
  try {
    const r = await mirrorSimRequest('GET', `/intake/runs/${encodeURIComponent(req.params.id)}`, undefined, operatorOf(req));
    res.status(r.status).json(r.body);
  } catch (error) {
    res.status(502).json({ success: false, error: (error as Error).message || 'Failed to fetch simulation run' });
  }
});

// POST /admin/api/mirror/simulation/cleanup — sweep orphaned simulation users
mirrorRouter.post('/simulation/cleanup', async (req, res) => {
  try {
    const body = { maxAgeMinutes: Number.isFinite(req.body?.maxAgeMinutes) ? Number(req.body.maxAgeMinutes) : 0 };
    const r = await mirrorSimRequest('POST', '/intake/cleanup', body, operatorOf(req));
    res.status(r.status).json(r.body);
  } catch (error) {
    res.status(502).json({ success: false, error: (error as Error).message || 'Failed to sweep simulation users' });
  }
});
