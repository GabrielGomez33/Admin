import { Router, Request, Response } from 'express';
import { mirrorRequest } from '../services/mirrorEmailClient';

export const emailRouter = Router();

// Recipient count above which a send/schedule must be explicitly confirmed.
const CONFIRM_THRESHOLD = parseInt(process.env.ADMIN_EMAIL_CONFIRM_THRESHOLD || '500', 10);

function operator(req: Request): string {
  return req.admin?.username || 'admin';
}

// Relay a mirror API response straight back to the client.
function relay(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

async function forward(req: Request, res: Response, method: string, path: string, body?: unknown): Promise<void> {
  try {
    const result = await mirrorRequest(method, path, body, operator(req));
    relay(res, result.status, result.body);
  } catch (err) {
    res.status(502).json({ success: false, error: `Mirror email API unreachable: ${(err as Error).message}` });
  }
}

// ---------------------------------------------------------------------------
// Simple per-process rate limit for expensive/abusable actions (test + send).
// ---------------------------------------------------------------------------
const lastAction = new Map<string, number>();
function rateLimited(key: string, minIntervalMs: number): boolean {
  const now = Date.now();
  const prev = lastAction.get(key) || 0;
  if (now - prev < minIntervalMs) return true;
  lastAction.set(key, now);
  return false;
}

// ---------------------------------------------------------------------------
// Read-only proxies
// ---------------------------------------------------------------------------
emailRouter.get('/health', (req, res) => forward(req, res, 'GET', '/health'));

emailRouter.get('/users/search', (req, res) => {
  const q = encodeURIComponent(String(req.query.q || ''));
  const limit = encodeURIComponent(String(req.query.limit || '20'));
  return forward(req, res, 'GET', `/users/search?q=${q}&limit=${limit}`);
});

// Read-only view of the marketing waitlist (counts-by-status + a page of rows),
// so the operator can see the list and target it as a campaign audience.
emailRouter.get('/waitlist', (req, res) => {
  const status = encodeURIComponent(String(req.query.status || ''));
  const limit = encodeURIComponent(String(req.query.limit || '100'));
  const offset = encodeURIComponent(String(req.query.offset || '0'));
  return forward(req, res, 'GET', `/waitlist?status=${status}&limit=${limit}&offset=${offset}`);
});

emailRouter.post('/preview-audience', (req, res) => forward(req, res, 'POST', '/preview-audience', req.body));
emailRouter.post('/preview', (req, res) => forward(req, res, 'POST', '/preview', req.body));

emailRouter.get('/campaigns', (req, res) => {
  const limit = encodeURIComponent(String(req.query.limit || '50'));
  return forward(req, res, 'GET', `/campaigns?limit=${limit}`);
});
emailRouter.get('/campaigns/:id', (req, res) => {
  const id = encodeURIComponent(req.params.id);
  return forward(req, res, 'GET', `/campaigns/${id}`);
});

// ---------------------------------------------------------------------------
// Send a test to a single address
// ---------------------------------------------------------------------------
emailRouter.post('/test', (req, res) => {
  if (rateLimited(`test:${operator(req)}`, 2000)) {
    res.status(429).json({ success: false, error: 'Slow down — wait a moment before sending another test' });
    return;
  }
  return forward(req, res, 'POST', '/test', req.body);
});

// ---------------------------------------------------------------------------
// Large-send confirmation gate (server-enforced).
// Returns true if it already responded (caller should stop).
// ---------------------------------------------------------------------------
async function requireConfirmation(req: Request, res: Response, audience: unknown): Promise<boolean> {
  try {
    const preview = await mirrorRequest('POST', '/preview-audience', { audience }, operator(req));
    if (preview.status !== 200 || !preview.body?.success) {
      // Let the downstream create call surface the real validation error.
      return false;
    }
    const total = Number(preview.body.total || 0);
    const suppressed = Number(preview.body.suppressed || 0);
    const sendable = Math.max(0, total - suppressed);

    if (sendable > CONFIRM_THRESHOLD) {
      const confirmed = req.body?.confirmed === true;
      const acknowledged = Number(req.body?.acknowledgedRecipients);
      if (!confirmed || acknowledged !== sendable) {
        res.status(412).json({
          success: false,
          requiresConfirmation: true,
          recipients: sendable,
          threshold: CONFIRM_THRESHOLD,
          error: `This will email ${sendable} recipients. Confirm to proceed.`,
        });
        return true;
      }
    }
  } catch {
    // If preview fails we don't block; the create/send call will validate.
  }
  return false;
}

// ---------------------------------------------------------------------------
// Create / send / schedule a campaign
// ---------------------------------------------------------------------------
emailRouter.post('/campaigns', async (req, res) => {
  const action = String(req.body?.action || 'draft');

  if ((action === 'send' || action === 'schedule')) {
    if (rateLimited(`send:${operator(req)}`, 3000)) {
      res.status(429).json({ success: false, error: 'Slow down — a send was just initiated' });
      return;
    }
    const blocked = await requireConfirmation(req, res, req.body?.audience);
    if (blocked) return;
  }

  return forward(req, res, 'POST', '/campaigns', req.body);
});

// Start an existing draft immediately (with confirmation gate).
emailRouter.post('/campaigns/:id/send', async (req, res) => {
  if (rateLimited(`send:${operator(req)}`, 3000)) {
    res.status(429).json({ success: false, error: 'Slow down — a send was just initiated' });
    return;
  }
  const id = encodeURIComponent(req.params.id);

  // Fetch the campaign to learn its audience for the confirmation gate.
  try {
    const campaign = await mirrorRequest('GET', `/campaigns/${id}`, undefined, operator(req));
    const audience = campaign.body?.campaign?.audience_filter;
    if (audience) {
      const blocked = await requireConfirmation(req, res, audience);
      if (blocked) return;
    }
  } catch {
    // fall through — the send call will validate
  }

  return forward(req, res, 'POST', `/campaigns/${id}/send`, {});
});

emailRouter.post('/campaigns/:id/cancel', (req, res) => {
  const id = encodeURIComponent(req.params.id);
  return forward(req, res, 'POST', `/campaigns/${id}/cancel`, {});
});
