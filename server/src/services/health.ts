export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unreachable';
  latency: number;
  details: Record<string, any>;
  checkedAt: string;
}

const MIRROR_URL = process.env.MIRROR_HEALTH_URL || 'https://127.0.0.1:8444/mirror/api/health';
const DINA_URL = process.env.DINA_HEALTH_URL || 'https://127.0.0.1:8445/dina/api/v1/health';

async function fetchHealth(name: string, url: string): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      // Skip TLS verification for localhost self-signed certs
      ...(url.includes('127.0.0.1') ? {} : {}),
    });
    const latency = Date.now() - start;
    const data = await response.json();

    return {
      name,
      status: response.ok ? 'healthy' : 'degraded',
      latency,
      details: data,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      name,
      status: 'unreachable',
      latency: Date.now() - start,
      details: { error: (error as Error).message },
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function getMirrorHealth(): Promise<ServiceHealth> {
  return fetchHealth('mirror-server', MIRROR_URL);
}

export async function getDinaHealth(): Promise<ServiceHealth> {
  return fetchHealth('dina-server', DINA_URL);
}

export async function getAllHealth(): Promise<ServiceHealth[]> {
  const [mirror, dina] = await Promise.all([getMirrorHealth(), getDinaHealth()]);
  return [mirror, dina];
}
