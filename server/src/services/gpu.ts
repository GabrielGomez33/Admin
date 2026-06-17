// server/src/services/gpu.ts
// ============================================================================
// GPU monitoring service
// ============================================================================
// Two independent sources, merged:
//   1. LOCAL nvidia-smi  → real-time "current usage" (VRAM, utilization, temp,
//      power) for the GPU on this host. If nvidia-smi fails (e.g. the NVIDIA
//      driver/library version mismatch that caused the original outage), that
//      error is surfaced directly — it's the canonical root-cause signal.
//   2. DINA status endpoint → inference "health": is Dina's LLM actually running
//      on the GPU, or has it silently fallen back to CPU? (from gpuMonitor,
//      exposed at /dina/api/v1/status .modules.llm_system.gpu)
//
// Both are best-effort and never throw; the dashboard renders whatever is
// available.
// ============================================================================

import https from 'https';
import http from 'http';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface GpuUsage {
  available: boolean;
  error?: string;
  name?: string;
  driverVersion?: string;
  memTotalMb?: number;
  memUsedMb?: number;
  memFreeMb?: number;
  memUsagePercent?: number;
  utilizationPercent?: number;
  temperatureC?: number;
  powerW?: number;
  powerLimitW?: number;
}

export interface GpuInferenceModel {
  name: string;
  gpuPercent: number;
  processor: string; // 'gpu' | 'cpu' | 'split'
}

export interface GpuInference {
  reachable: boolean;
  state: string; // 'gpu' | 'partial' | 'cpu' | 'idle' | 'unreachable' | 'unknown'
  healthy: boolean;
  summary: string;
  loadedModels: GpuInferenceModel[];
}

export interface GpuInfo {
  usage: GpuUsage;
  inference: GpuInference;
  checkedAt: string;
}

const DINA_STATUS_URL =
  process.env.DINA_STATUS_URL || 'https://127.0.0.1:8445/dina/api/v1/status';
const DINA_SERVICE_KEY = process.env.DINA_SERVICE_KEY || process.env.DINA_API_KEY || '';

// ── Source 1: local nvidia-smi ───────────────────────────────────────────────

async function getGpuUsage(): Promise<GpuUsage> {
  try {
    const fields =
      'name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit';
    const { stdout } = await execAsync(
      `nvidia-smi --query-gpu=${fields} --format=csv,noheader,nounits`,
      { timeout: 5000 }
    );

    const line = stdout.trim().split('\n')[0] || '';
    const p = line.split(',').map((s) => s.trim());
    const num = (v: string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };

    const memTotalMb = num(p[2]);
    const memUsedMb = num(p[3]);
    const memUsagePercent =
      memTotalMb && memUsedMb !== undefined && memTotalMb > 0
        ? Math.round((memUsedMb / memTotalMb) * 100)
        : undefined;

    return {
      available: true,
      name: p[0] || undefined,
      driverVersion: p[1] || undefined,
      memTotalMb,
      memUsedMb,
      memFreeMb: num(p[4]),
      memUsagePercent,
      utilizationPercent: num(p[5]),
      temperatureC: num(p[6]),
      powerW: num(p[7]),
      powerLimitW: num(p[8]),
    };
  } catch (error: unknown) {
    // nvidia-smi missing OR (critically) "Failed to initialize NVML:
    // Driver/library version mismatch" — surface the first line verbatim.
    const e = error as { stderr?: string; message?: string };
    const raw = (e?.stderr || e?.message || String(error)).toString().trim();
    return { available: false, error: raw.split('\n')[0] || 'nvidia-smi unavailable' };
  }
}

// ── Source 2: dina status endpoint (inference residency) ─────────────────────

function fetchJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https:');
    const mod = isHttps ? https : http;
    const opts: https.RequestOptions = { timeout: timeoutMs };
    // dina runs HTTPS with a localhost self-signed cert.
    if (isHttps) (opts as { rejectUnauthorized?: boolean }).rejectUnauthorized = false;
    if (DINA_SERVICE_KEY) opts.headers = { Authorization: `Bearer ${DINA_SERVICE_KEY}` };

    const req = mod.get(url, opts, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function getGpuInference(): Promise<GpuInference> {
  try {
    const data = await fetchJson(DINA_STATUS_URL, 5000);
    // /status → .modules.llm_system.gpu ; /mirror/status → .gpu
    const gpu = data?.modules?.llm_system?.gpu ?? data?.gpu ?? data?.data?.gpu;
    if (!gpu) {
      return {
        reachable: true,
        state: 'unknown',
        healthy: false,
        summary: 'dina reachable but no GPU field in status payload',
        loadedModels: [],
      };
    }
    return {
      reachable: true,
      state: String(gpu.state || 'unknown'),
      healthy: !!gpu.healthy,
      summary: String(gpu.summary || ''),
      loadedModels: Array.isArray(gpu.loadedModels)
        ? gpu.loadedModels.map((m: any) => ({
            name: String(m?.name ?? 'unknown'),
            gpuPercent: Number(m?.gpuPercent) || 0,
            processor: String(m?.processor ?? ''),
          }))
        : [],
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      state: 'unreachable',
      healthy: false,
      summary: `dina status unreachable: ${msg}`,
      loadedModels: [],
    };
  }
}

// ── Merged ───────────────────────────────────────────────────────────────────

export async function getGpuInfo(): Promise<GpuInfo> {
  const [usage, inference] = await Promise.all([getGpuUsage(), getGpuInference()]);
  return { usage, inference, checkedAt: new Date().toISOString() };
}
