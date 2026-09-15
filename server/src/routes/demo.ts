// ============================================================================
// ADMIN DEMO-ACCOUNT ROUTES  (mounted at /admin/api/demo, behind authMiddleware)
// ============================================================================
// Thin proxy to mirror-server's internal demo-account API. The operator is
// already authenticated by authMiddleware (JWT); we forward their identity to
// mirror-server (for audit) along with the shared internal secret, which lives
// ONLY on the server and never reaches the browser.
//
// Endpoints:
//   POST /provision  { label? }   -> mint one demo account, return creds ONCE
//   GET  /list                    -> list demo accounts (no credentials)
//   POST /revoke      { userId }   -> delete a demo account (guarded on mirror)
//
// The provision response carries a one-time password. We pass it straight
// through to the operator's browser and never log it here.
// ============================================================================

import { Router, Request, Response } from 'express';
import { mirrorDemoRequest } from '../services/mirrorDemoClient';

export const demoRouter = Router();

function operator(req: Request): string {
  return req.admin?.username || 'admin';
}

/** POST /provision — mint one demo account. Body: { label? } */
demoRouter.post('/provision', async (req: Request, res: Response) => {
  const rawLabel = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 120) : '';
  const label = rawLabel || null;
  // Optional recipient for the credential email; forwarded only when present so
  // the default (no email) is unchanged. mirror-server does the real validation.
  const deliverTo = typeof req.body?.deliverTo === 'string' && req.body.deliverTo.trim()
    ? req.body.deliverTo.trim().slice(0, 254) : undefined;
  try {
    const r = await mirrorDemoRequest('POST', '/provision', { label, deliverTo }, operator(req));
    res.status(r.status).json(r.body);
  } catch (err) {
    res.status(502).json({ success: false, error: `Demo upstream unavailable: ${(err as Error).message}` });
  }
});

/** GET /list — enumerate demo accounts (no credentials). */
demoRouter.get('/list', async (req: Request, res: Response) => {
  try {
    const r = await mirrorDemoRequest('GET', '/list', undefined, operator(req));
    res.status(r.status).json(r.body);
  } catch (err) {
    res.status(502).json({ success: false, error: `Demo upstream unavailable: ${(err as Error).message}` });
  }
});

/** POST /revoke — delete a demo account. Body: { userId } */
demoRouter.post('/revoke', async (req: Request, res: Response) => {
  const userId = Number(req.body?.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ success: false, error: 'A valid userId is required' });
    return;
  }
  try {
    const r = await mirrorDemoRequest('POST', '/revoke', { userId }, operator(req));
    res.status(r.status).json(r.body);
  } catch (err) {
    res.status(502).json({ success: false, error: `Demo upstream unavailable: ${(err as Error).message}` });
  }
});
