// ============================================================================
// MIRROR ANALYTICS CLIENT
// ============================================================================
// Server-to-server client for mirror-server's internal admin analytics API
// (/mirror/api/admin/analytics/*). The admin-server has already authenticated
// the human operator (JWT); this layer forwards a READ-ONLY request to
// mirror-server over localhost, attaching the shared internal secret and the
// operator identity for audit logging on the mirror side.
//
// Read-only by design: analytics is aggregate + anonymous, so there is nothing
// to mutate here. Mirrors mirrorEmailClient's dependency-free http/https
// transport (TLS verification relaxed ONLY for loopback self-signed certs).
// ============================================================================

import http from 'http';
import https from 'https';
import { URL } from 'url';

const BASE =
  process.env.MIRROR_ANALYTICS_API_BASE ||
  process.env.MIRROR_ADMIN_API_BASE?.replace(/\/email\/?$/, '/analytics') ||
  'https://127.0.0.1:8444/mirror/api/admin/analytics';
const SECRET = process.env.MIRROR_INTERNAL_SECRET || '';
const TIMEOUT_MS = parseInt(process.env.MIRROR_API_TIMEOUT_MS || '20000', 10);

export interface MirrorApiResponse<T = unknown> {
  status: number;
  body: T;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * GET a JSON resource from the mirror admin analytics API.
 * @param path     Path appended to BASE, e.g. '/insights?sinceDays=30'
 * @param operator Admin username, forwarded for audit logging on the mirror side
 */
export function analyticsGet<T = unknown>(path: string, operator: string): Promise<MirrorApiResponse<T>> {
  return new Promise((resolve, reject) => {
    if (!SECRET) {
      reject(new Error('MIRROR_INTERNAL_SECRET is not configured on admin-server'));
      return;
    }

    let url: URL;
    try {
      url = new URL(BASE + path);
    } catch {
      reject(new Error('Invalid MIRROR_ANALYTICS_API_BASE'));
      return;
    }

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options: https.RequestOptions = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'x-internal-secret': SECRET,
        'x-admin-user': operator,
      },
      timeout: TIMEOUT_MS,
    };

    // Relax TLS only for loopback self-signed certs; never off-box.
    if (isHttps) {
      (options as https.RequestOptions).rejectUnauthorized = !isLoopback(url.hostname);
    }

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode || 502, body: parsed as T });
      });
    });

    req.on('timeout', () => { req.destroy(new Error('mirror analytics request timed out')); });
    req.on('error', (err) => reject(err));
    req.end();
  });
}
