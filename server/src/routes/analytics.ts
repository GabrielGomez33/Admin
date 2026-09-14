// ============================================================================
// ADMIN ANALYTICS ROUTES  (mounted at /admin/api/analytics, behind authMiddleware)
// ============================================================================
// Thin, read-only proxy to mirror-server's internal analytics API. The operator
// is already authenticated by authMiddleware (JWT); we forward their identity to
// mirror-server (for audit) along with the shared internal secret, which lives
// ONLY on the server and never reaches the browser. Aggregate + anonymous data.
// ============================================================================

import { Router, Request, Response } from 'express';
import { analyticsGet } from '../services/mirrorAnalyticsClient';

export const analyticsRouter = Router();

function operator(req: Request): string {
  return req.admin?.username || 'admin';
}

/** GET /insights?sinceDays=30 — full funnel analytics (drop-off, conversion, sources, trend). */
analyticsRouter.get('/insights', async (req: Request, res: Response) => {
  const sinceDays = Math.min(365, Math.max(1, parseInt(String(req.query.sinceDays ?? '30'), 10) || 30));
  try {
    const r = await analyticsGet(`/insights?sinceDays=${sinceDays}`, operator(req));
    res.status(r.status).json(r.body);
  } catch (err) {
    res.status(502).json({ success: false, error: `Analytics upstream unavailable: ${(err as Error).message}` });
  }
});

/** GET /compliance — the live, drift-proof compliance record (pass-through). */
analyticsRouter.get('/compliance', async (req: Request, res: Response) => {
  try {
    const r = await analyticsGet('/compliance', operator(req));
    res.status(r.status).json(r.body);
  } catch (err) {
    res.status(502).json({ success: false, error: `Analytics upstream unavailable: ${(err as Error).message}` });
  }
});
