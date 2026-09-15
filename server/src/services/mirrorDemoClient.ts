// ============================================================================
// MIRROR DEMO-ACCOUNT CLIENT
// ============================================================================
// Server-to-server client for mirror-server's internal admin demo-account API
// (/mirror/api/admin/demo/*). The admin-server has already authenticated the
// human operator (JWT); this layer forwards the request to mirror-server over
// localhost, attaching the shared internal secret and the operator identity for
// audit logging on the mirror side.
//
// Mirrors services/mirrorSimulationClient.ts exactly (same trust model, same
// dependency-free http/https transport, same loopback-only TLS relaxation) —
// it simply targets a different base path. Kept as a separate module so the two
// internal APIs can evolve independently. Provisioning creates a real user
// (dirs + keys + hashed pw), so it uses the same generous timeout as the sim.
// ============================================================================

import http from 'http';
import https from 'https';
import { URL } from 'url';

const BASE = process.env.MIRROR_DEMO_API_BASE || 'https://127.0.0.1:8444/mirror/api/admin/demo';
const SECRET = process.env.MIRROR_INTERNAL_SECRET || '';
const TIMEOUT_MS = parseInt(process.env.MIRROR_DEMO_TIMEOUT_MS || '120000', 10);

export interface MirrorApiResponse<T = any> {
  status: number;
  body: T;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * Make a JSON request to the mirror demo-account API.
 * @param method   HTTP method
 * @param path     Path appended to BASE, e.g. '/provision', '/list', '/revoke'
 * @param body     Optional JSON body
 * @param operator Admin username forwarded for audit logging on the mirror side
 */
export function mirrorDemoRequest<T = any>(
  method: string,
  path: string,
  body: unknown,
  operator: string,
): Promise<MirrorApiResponse<T>> {
  return new Promise((resolve, reject) => {
    if (!SECRET) {
      reject(new Error('MIRROR_INTERNAL_SECRET is not configured on admin-server'));
      return;
    }

    let url: URL;
    try {
      url = new URL(BASE + path);
    } catch {
      reject(new Error('Invalid MIRROR_DEMO_API_BASE'));
      return;
    }

    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const payload = body !== undefined && body !== null ? Buffer.from(JSON.stringify(body)) : undefined;

    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': SECRET,
        'x-admin-user': operator,
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
      timeout: TIMEOUT_MS,
    };

    // Relax TLS only for loopback self-signed certs.
    if (isHttps) {
      (options as https.RequestOptions).rejectUnauthorized = !isLoopback(url.hostname);
    }

    const req = transport.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: any = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode || 502, body: parsed });
      });
    });

    req.on('timeout', () => { req.destroy(new Error('mirror demo API request timed out')); });
    req.on('error', (err) => reject(err));

    if (payload) req.write(payload);
    req.end();
  });
}
