import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import type { CSSProperties } from 'react';
import EmailPanel from './email/EmailPanel';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PM2Process {
  name: string;
  pid: number;
  status: string;
  cpu: number;
  memory: number;
  memoryMB: string;
  uptime: number;
  uptimeFormatted: string;
  restarts: number;
  user: string;
}

interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'unreachable';
  latency: number;
  details: Record<string, unknown>;
  checkedAt: string;
}

interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  uptime: string;
  uptimeSeconds: number;
  loadAverage: number[];
  memory: { total: string; used: string; free: string; usagePercent: number };
  cpu: { model: string; cores: number };
  disk: { total: string; used: string; available: string; usagePercent: number } | null;
}

interface GpuUsage {
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

interface GpuInferenceModel {
  name: string;
  gpuPercent: number;
  processor: string;
}

interface GpuInference {
  reachable: boolean;
  state: string;
  healthy: boolean;
  summary: string;
  loadedModels: GpuInferenceModel[];
}

interface GpuInfo {
  usage: GpuUsage;
  inference: GpuInference;
  checkedAt: string;
}

interface LogEntry {
  timestamp: string;
  line: string;
}

interface LogFile {
  name: string;
  service: string;
  type: 'out' | 'error' | 'combined';
  size: string;
  modified: string;
}

interface ErrorGroup {
  service: string;
  entries: LogEntry[];
}

interface OverviewData {
  processes: PM2Process[];
  system: SystemInfo;
  health: ServiceHealth[];
  gpu?: GpuInfo;
  errors: ErrorGroup[];
  logFiles: LogFile[];
  serverStartedAt: string;
  timestamp: string;
}

interface WorkerInfo {
  name: string;
  errors: LogEntry[];
  recent: LogEntry[];
}

// ─── API ─────────────────────────────────────────────────────────────────────

const API_BASE = '/admin/api';

function getToken(): string | null {
  return sessionStorage.getItem('admin_token');
}

function setToken(token: string): void {
  sessionStorage.setItem('admin_token', token);
}

function clearToken(): void {
  sessionStorage.removeItem('admin_token');
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Session expired');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }

  return res.json();
}

async function login(username: string, password: string): Promise<void> {
  const data = await api<{ token: string }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(data.token);
}

// ─── Login Screen ────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <form className="login-box" onSubmit={handleSubmit}>
        <div className="login-title">TUGRR ADMIN</div>
        <div className="input-group">
          <label>Username</label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className="input-group">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button className="btn" type="submit" disabled={loading || !username || !password}>
          {loading ? 'Authenticating...' : 'Access Portal'}
        </button>
        {error && <div className="error-msg">{error}</div>}
      </form>
    </div>
  );
}

// ─── Components ──────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const cls =
    status === 'online' || status === 'healthy' ? 'online' :
    status === 'stopped' || status === 'unhealthy' || status === 'errored' ? 'stopped' :
    status === 'degraded' || status === 'launching' ? 'degraded' :
    'unreachable';
  return <span className={`status-dot ${cls}`} />;
}

function ProgressBar({ percent }: { percent: number }) {
  const color = percent > 85 ? 'red' : percent > 60 ? 'yellow' : 'green';
  return (
    <div className="progress-bar">
      <div className={`progress-fill ${color}`} style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  );
}

// ─── Uptime Monitor ──────────────────────────────────────────────────────────

function UptimeMonitor({ processes, systemUptime, serverStartedAt }: {
  processes: PM2Process[];
  systemUptime: string;
  serverStartedAt: string;
}) {
  const maxUptime = Math.max(...processes.map(p => Date.now() - p.uptime), 1);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">Uptime Monitor</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
          System: {systemUptime}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="metric">
          <div className="metric-label">Admin Portal Since</div>
          <div className="metric-value sm">{new Date(serverStartedAt).toLocaleString()}</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {processes.map(p => {
          const elapsed = Date.now() - p.uptime;
          const pct = Math.min((elapsed / maxUptime) * 100, 100);
          const isHealthy = p.status === 'online';
          return (
            <div key={p.name} className="uptime-row">
              <StatusDot status={p.status} />
              <span className="uptime-name">{p.name}</span>
              <div style={{ flex: 1, position: 'relative' }}>
                <div className="progress-bar" style={{ height: 6 }}>
                  <div
                    className={`progress-fill ${isHealthy ? 'green' : 'red'}`}
                    style={{ width: `${pct}%`, height: '100%' }}
                  />
                </div>
              </div>
              <span className="uptime-time" style={{
                color: isHealthy ? 'var(--accent-green)' : 'var(--accent-red)',
              }}>{p.uptimeFormatted}</span>
              {p.restarts > 0 && (
                <span className="uptime-restarts" style={{
                  background: p.restarts > 5 ? 'rgba(255,51,85,0.15)' : 'rgba(255,204,0,0.15)',
                  color: p.restarts > 5 ? 'var(--accent-red)' : 'var(--accent-yellow)',
                }}>{p.restarts} restart{p.restarts !== 1 ? 's' : ''}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Service Architecture ────────────────────────────────────────────────────

function ServiceArchitecture({ health, processes }: { health: ServiceHealth[]; processes: PM2Process[] }) {
  const mirrorH = health.find(h => h.name === 'mirror-server');
  const dinaH = health.find(h => h.name === 'dina-server');
  const mirrorWorkers = processes.filter(p =>
    ['analysis-worker', 'dina-chat-worker', 'truthstream-worker', 'personal-analysis-worker', 'email-campaign-worker'].includes(p.name)
  );
  const onlineCount = processes.filter(p => p.status === 'online').length;
  const totalMem = processes.reduce((sum, p) => sum + p.memory, 0);
  const totalMemMB = (totalMem / 1024 / 1024).toFixed(0);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">Service Map</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
          {onlineCount}/{processes.length} online | {totalMemMB} MB total
        </span>
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.8, color: 'var(--text-secondary)', padding: '4px 0' }}>
        <div className="service-map-cols">
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>CORE SERVICES</div>
            <div>
              <StatusDot status={mirrorH?.status || 'unreachable'} />
              <span style={{ color: 'var(--text-primary)' }}>mirror-server</span>
              <span style={{ color: 'var(--text-muted)' }}> :8444</span>
              {mirrorH && <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>({mirrorH.latency}ms)</span>}
            </div>
            <div>
              <StatusDot status={dinaH?.status || 'unreachable'} />
              <span style={{ color: 'var(--text-primary)' }}>dina-server</span>
              <span style={{ color: 'var(--text-muted)' }}> :8445</span>
              {dinaH && <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>({dinaH.latency}ms)</span>}
            </div>
            <div>
              <StatusDot status="online" />
              <span style={{ color: 'var(--text-primary)' }}>admin-server</span>
              <span style={{ color: 'var(--text-muted)' }}> :8446</span>
            </div>
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>MIRROR WORKERS</div>
            {mirrorWorkers.length > 0 ? mirrorWorkers.map(w => (
              <div key={w.name}>
                <StatusDot status={w.status} />
                <span style={{ color: 'var(--text-primary)' }}>{w.name}</span>
                <span style={{ color: 'var(--text-muted)' }}> {w.memoryMB}</span>
              </div>
            )) : (
              <div style={{ color: 'var(--text-muted)' }}>No workers detected</div>
            )}
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: 10, letterSpacing: 1, marginBottom: 4 }}>DEPENDENCIES</div>
            <div>
              <StatusDot status={
                mirrorH?.details && (mirrorH.details as Record<string, unknown>).features &&
                ((mirrorH.details as Record<string, Record<string, string>>).features?.redis === 'connected') ? 'online' : 'degraded'
              } />
              <span style={{ color: 'var(--text-primary)' }}>Redis</span>
            </div>
            <div>
              <StatusDot status={mirrorH?.status === 'healthy' ? 'online' : 'degraded'} />
              <span style={{ color: 'var(--text-primary)' }}>MySQL</span>
            </div>
            <div>
              <StatusDot status={mirrorH?.status === 'healthy' ? 'online' : 'degraded'} />
              <span style={{ color: 'var(--text-primary)' }}>Apache</span>
              <span style={{ color: 'var(--text-muted)' }}> :443</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Log File Stats ──────────────────────────────────────────────────────────

function LogFileStats({ files }: { files: LogFile[] }) {
  if (!files.length) return null;

  const errorFiles = files.filter(f => f.type === 'error');
  const outFiles = files.filter(f => f.type === 'out');

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">Log File Stats</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>
          {files.length} files
        </span>
      </div>
      <div className="table-wrap">
        <table className="process-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Type</th>
              <th>Size</th>
              <th>Last Modified</th>
            </tr>
          </thead>
          <tbody>
            {[...errorFiles, ...outFiles].map(f => (
              <tr key={f.name}>
                <td>{f.service}</td>
                <td style={{ color: f.type === 'error' ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                  {f.type}
                </td>
                <td>{f.size}</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                  {new Date(f.modified).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Existing Components ─────────────────────────────────────────────────────

function ProcessTable({ processes }: { processes: PM2Process[] }) {
  if (!processes.length) {
    return <div className="card"><div className="card-header"><span className="card-title">Processes</span></div><span style={{ color: 'var(--text-muted)' }}>No PM2 processes found</span></div>;
  }
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">PM2 Processes</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{processes.length} running</span>
      </div>
      <div className="table-wrap">
        <table className="process-table">
          <thead>
            <tr>
              <th>Service</th>
              <th>Status</th>
              <th>CPU</th>
              <th>Memory</th>
              <th>Uptime</th>
              <th>Restarts</th>
              <th>PID</th>
            </tr>
          </thead>
          <tbody>
            {processes.map(p => (
              <tr key={p.name}>
                <td><StatusDot status={p.status} /> {p.name}</td>
                <td style={{ color: p.status === 'online' ? 'var(--accent-green)' : 'var(--accent-red)' }}>{p.status}</td>
                <td>{p.cpu}%</td>
                <td>{p.memoryMB}</td>
                <td>{p.uptimeFormatted}</td>
                <td style={{ color: p.restarts > 5 ? 'var(--accent-yellow)' : 'var(--text-primary)' }}>{p.restarts}</td>
                <td style={{ color: 'var(--text-muted)' }}>{p.pid}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HealthCards({ services }: { services: ServiceHealth[] }) {
  return (
    <div className="grid grid-2" style={{ marginBottom: 16 }}>
      {services.map(s => (
        <div className="card" key={s.name}>
          <div className="card-header">
            <span className="card-title">{s.name}</span>
            <StatusDot status={s.status} />
          </div>
          <div className="metric">
            <div className="metric-label">Status</div>
            <div className="metric-value sm" style={{
              color: s.status === 'healthy' ? 'var(--accent-green)' :
                     s.status === 'degraded' ? 'var(--accent-yellow)' :
                     s.status === 'unreachable' ? 'var(--text-muted)' : 'var(--accent-red)',
            }}>{s.status.toUpperCase()}</div>
          </div>
          <div className="metric">
            <div className="metric-label">Latency</div>
            <div className="metric-value sm">{s.latency}ms</div>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            Checked: {new Date(s.checkedAt).toLocaleTimeString()}
          </div>
        </div>
      ))}
    </div>
  );
}

function SystemVitals({ info }: { info: SystemInfo }) {
  return (
    <div className="grid grid-4" style={{ marginBottom: 16 }}>
      <div className="card">
        <div className="card-header"><span className="card-title">Host</span></div>
        <div className="metric"><div className="metric-label">Hostname</div><div className="metric-value sm">{info.hostname}</div></div>
        <div className="metric"><div className="metric-label">Platform</div><div className="metric-value sm" style={{ fontSize: 12 }}>{info.platform}</div></div>
        <div className="metric"><div className="metric-label">Node</div><div className="metric-value sm">{info.nodeVersion}</div></div>
      </div>
      <div className="card">
        <div className="card-header"><span className="card-title">CPU</span></div>
        <div className="metric"><div className="metric-label">Cores</div><div className="metric-value">{info.cpu.cores}</div></div>
        <div className="metric"><div className="metric-label">Load Avg (1/5/15)</div><div className="metric-value sm">{info.loadAverage.join(' / ')}</div></div>
      </div>
      <div className="card">
        <div className="card-header"><span className="card-title">Memory</span></div>
        <div className="metric"><div className="metric-label">Usage</div><div className="metric-value">{info.memory.usagePercent}%</div></div>
        <ProgressBar percent={info.memory.usagePercent} />
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{info.memory.used} / {info.memory.total}</div>
      </div>
      <div className="card">
        <div className="card-header"><span className="card-title">Disk</span></div>
        {info.disk ? (
          <>
            <div className="metric"><div className="metric-label">Usage</div><div className="metric-value">{info.disk.usagePercent}%</div></div>
            <ProgressBar percent={info.disk.usagePercent} />
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{info.disk.used} / {info.disk.total}</div>
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>Unavailable</span>
        )}
      </div>
    </div>
  );
}

function fmtMb(mb?: number): string {
  if (mb === undefined) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function GpuVitals({ gpu }: { gpu: GpuInfo }) {
  const u = gpu.usage;
  const inf = gpu.inference;

  // Header dot: red if the GPU itself is unavailable (driver issue), yellow if
  // Dina's inference has offloaded to CPU, green otherwise.
  const headerStatus = !u.available
    ? 'unhealthy'
    : inf.state === 'cpu' || inf.state === 'partial'
      ? 'degraded'
      : 'healthy';

  // Inference dot: green on GPU/idle, red on CPU/partial, grey otherwise.
  const infStatus =
    inf.state === 'gpu' || inf.state === 'idle'
      ? 'healthy'
      : inf.state === 'cpu' || inf.state === 'partial'
        ? 'unhealthy'
        : 'unreachable';

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">GPU</span>
        <StatusDot status={headerStatus} />
      </div>

      {u.available ? (
        <div className="grid grid-4">
          <div>
            <div className="metric"><div className="metric-label">Device</div><div className="metric-value sm" style={{ fontSize: 12 }}>{u.name || '—'}</div></div>
            <div className="metric"><div className="metric-label">Driver</div><div className="metric-value sm">{u.driverVersion || '—'}</div></div>
          </div>
          <div>
            <div className="metric"><div className="metric-label">VRAM</div><div className="metric-value">{u.memUsagePercent ?? 0}%</div></div>
            <ProgressBar percent={u.memUsagePercent ?? 0} />
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>{fmtMb(u.memUsedMb)} / {fmtMb(u.memTotalMb)}</div>
          </div>
          <div>
            <div className="metric"><div className="metric-label">Utilization</div><div className="metric-value">{u.utilizationPercent ?? 0}%</div></div>
            <ProgressBar percent={u.utilizationPercent ?? 0} />
          </div>
          <div>
            <div className="metric"><div className="metric-label">Temp</div><div className="metric-value sm">{u.temperatureC !== undefined ? `${u.temperatureC}°C` : '—'}</div></div>
            <div className="metric"><div className="metric-label">Power</div><div className="metric-value sm">{u.powerW !== undefined ? `${Math.round(u.powerW)}W` : '—'}{u.powerLimitW !== undefined ? ` / ${Math.round(u.powerLimitW)}W` : ''}</div></div>
          </div>
        </div>
      ) : (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent-red)' }}>
          GPU unavailable: {u.error}
          {/driver|nvml|mismatch/i.test(u.error || '') && (
            <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>
              Likely a driver/library version mismatch — reboot the host to resync (see GPU runbook).
            </div>
          )}
        </div>
      )}

      {/* Dina inference residency — is the LLM actually running on the GPU? */}
      <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="metric-label">Dina Inference</div>
        <div className="metric-value sm" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <StatusDot status={infStatus} />
          {inf.reachable ? inf.state.toUpperCase() : 'UNREACHABLE'}
        </div>
        {inf.summary && (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{inf.summary}</div>
        )}
        {inf.loadedModels.length > 0 && (
          <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {inf.loadedModels.map((m) => (
              <div key={m.name} style={{ display: 'flex', justifyContent: 'space-between', color: m.processor === 'gpu' ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                <span>{m.name}</span>
                <span>{m.gpuPercent}% GPU ({m.processor})</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorFeed({ errors }: { errors: ErrorGroup[] }) {
  const hasErrors = errors.some(g => g.entries.length > 0);
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">Recent Errors</span>
        {!hasErrors && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-green)' }}>All clear</span>}
      </div>
      {hasErrors ? (
        <div className="log-viewer" style={{ maxHeight: 250 }}>
          {errors.map(group =>
            group.entries.map((entry, i) => (
              <div className="log-line" key={`${group.service}-${i}`}>
                <span className="log-ts" style={{ fontSize: 10 }}>{entry.timestamp ? entry.timestamp.split(' ').pop() : '--'}</span>
                <span style={{ color: 'var(--accent-blue)', fontWeight: 600, flexShrink: 0, fontSize: 10 }}>{group.service}</span>
                <span className="log-msg error">{entry.line}</span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
          No errors reported across all services.
        </div>
      )}
    </div>
  );
}

function LogViewer({ title, entries, onRefresh }: { title: string; entries: LogEntry[]; onRefresh?: () => void }) {
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (viewerRef.current) {
      viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">{title}</span>
        {onRefresh && (
          <button onClick={onRefresh} style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 3,
            color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11,
            padding: '4px 10px', cursor: 'pointer',
          }}>
            Refresh
          </button>
        )}
      </div>
      <div className="log-viewer" ref={viewerRef}>
        {entries.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: '8px 0' }}>No log entries.</div>
        ) : (
          entries.map((entry, i) => (
            <div className="log-line" key={i}>
              <span className="log-ts">{entry.timestamp || '--'}</span>
              <span className={`log-msg${entry.line.toLowerCase().includes('error') ? ' error' : ''}`}>{entry.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function LogFileSelector({ onSelect }: { onSelect: (filename: string) => void }) {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [selected, setSelected] = useState('');

  useEffect(() => {
    api<{ files: LogFile[] }>('/system/logs').then(d => {
      setFiles(d.files);
      if (d.files.length > 0 && !selected) {
        setSelected(d.files[0].name);
        onSelect(d.files[0].name);
      }
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
      <select
        value={selected}
        onChange={e => { setSelected(e.target.value); onSelect(e.target.value); }}
        style={{
          background: 'var(--bg-primary)', color: 'var(--text-primary)',
          border: '1px solid var(--border)', borderRadius: 3, padding: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 12, outline: 'none',
        }}
      >
        {files.map(f => (
          <option key={f.name} value={f.name}>
            {f.service} ({f.type}) — {f.size}
          </option>
        ))}
      </select>
    </div>
  );
}

// ─── Tab Panels ──────────────────────────────────────────────────────────────

function SystemPanel() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [logFile, setLogFile] = useState('');
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);

  const fetchOverview = useCallback(() => {
    api<OverviewData>('/system/overview').then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { fetchOverview(); const id = setInterval(fetchOverview, 15000); return () => clearInterval(id); }, [fetchOverview]);

  const fetchLog = useCallback((filename: string) => {
    if (!filename) return;
    setLogFile(filename);
    api<{ entries: LogEntry[] }>(`/system/logs/${encodeURIComponent(filename)}?lines=200`).then(d => setLogEntries(d.entries)).catch(() => {});
  }, []);

  if (loading || !data) return <div className="pulse" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>Loading system data...</div>;

  return (
    <>
      <div className="refresh-bar">
        <span className="status-dot online" />
        <span className="refresh-text">Auto-refresh 15s — Last update: {new Date(data.timestamp).toLocaleTimeString()}</span>
      </div>
      <HealthCards services={data.health} />
      <UptimeMonitor
        processes={data.processes}
        systemUptime={data.system.uptime}
        serverStartedAt={data.serverStartedAt || data.timestamp}
      />
      <ServiceArchitecture health={data.health} processes={data.processes} />
      <SystemVitals info={data.system} />
      {data.gpu && <GpuVitals gpu={data.gpu} />}
      <ProcessTable processes={data.processes} />
      <div style={{ marginTop: 16 }} />
      <ErrorFeed errors={data.errors} />
      <LogFileStats files={data.logFiles || []} />
      <div className="card">
        <div className="card-header"><span className="card-title">Log Explorer</span></div>
        <LogFileSelector onSelect={fetchLog} />
        {logFile && <LogViewer title={logFile} entries={logEntries} onRefresh={() => fetchLog(logFile)} />}
      </div>
    </>
  );
}

// ─── Intake Simulation (Mirror tab) ────────────────────────────────────────────

interface SimStep { name: string; ok: boolean; severity: 'pass' | 'warn' | 'fail'; ms: number; detail: string; }
interface SimReport {
  runId: string;
  status: 'passed' | 'passed_with_warnings' | 'failed';
  dryRun: boolean;
  operator: string;
  simUserId: number | null;
  simUsername: string;
  simEmail: string;
  durationMs: number;
  cleanedUp: boolean;
  steps: SimStep[];
  warnings: string[];
  error: string | null;
  credentials: { email: string; username: string; password: string } | null;
  truthCard: { profile: boolean; goalCategory: string | null; reviewsSeeded: number; helperUserIds: number[]; analysisRequested: boolean } | null;
}

// The five self-tagged review tones the TruthStream questionnaire allows.
const REVIEW_TONES = [
  'Encouraging and supportive',
  'Honest but kind',
  'Direct and unfiltered',
  'Critical with constructive intent',
  'Tough love',
];

interface ReviewableUser {
  id: number; username: string; email: string;
  isSim: boolean; hasProfile: boolean; goalCategory: string | null;
}
interface TruthStreamReviewSummary {
  id: string; classification: string | null; classificationConfidence: number | null;
  qualityScore: number | null; completenessScore: number | null; depthScore: number | null;
  tone: string | null; snippet: string | null; createdAt: string | null;
}
interface ProfiledUser {
  id: number; username: string; email: string;
  isSim: boolean; goalCategory: string | null; reviewsReceived: number; hasReport: boolean;
}
interface ReviewBatchResult {
  revieweeId: number; revieweeIsSim: boolean; tone: string;
  results: { reviewerId: number; ok: boolean; reviewId: string | null; qualityScore: number | null; error?: string }[];
  succeeded: number; totalReceivedAfter: number; minReviewsForAnalysis: number; reportReady: boolean;
}
interface TruthStreamUserReport {
  hasProfile: boolean; minReviewsForAnalysis: number;
  profile: {
    displayAlias: string; goalCategory: string; isActive: boolean;
    totalReviewsReceived: number; totalReviewsGiven: number;
    reviewQualityScore: number | null; perceptionGapScore: number | null; profileCompleteness: number | null;
  } | null;
  receivedReviews: TruthStreamReviewSummary[];
  givenReviews: { id: string; revieweeId: number; classification: string | null; qualityScore: number | null; createdAt: string | null }[];
  analysis: {
    analysisType: string; reviewCountAtGeneration: number; perceptionGapScore: number | null;
    confidenceLevel: number | null; createdAt: string | null; summary: string | null;
  } | null;
  pendingJobs: { jobType: string; status: string; createdAt: string | null }[];
}

interface SimHealth {
  dbReachable?: boolean; jwtConfigured?: boolean; internalSecretConfigured?: boolean;
  runInFlight?: boolean; selfBaseUrl?: string; simEmailDomain?: string; iqItemSetVersion?: string;
}
interface SimRunRow {
  run_id: string; operator: string | null; status: string; dry_run: number;
  sim_user_id: number | null; sim_username: string | null; cleaned_up: number;
  duration_ms: number | null; started_at: string; error: string | null;
}

interface SimUserFiles { tier1: number; tier2: number; tier3: number; total: number; }
interface SimUser {
  id: number; username: string; email: string;
  createdAt: string | null; lastLogin: string | null;
  emailVerified: boolean; intakeCompleted: boolean; files: SimUserFiles;
}
interface PurgeVerification {
  userId: number; clean: boolean; usersRowPresent: boolean;
  dbResidue: { table: string; column: string; rows: number }[];
  dbTablesScanned: number;
  scanErrors: { table: string; column: string; error: string }[];
  storage: SimUserFiles; storageDirPresent: boolean | null; storageClean: boolean;
}
interface DeleteSimUserResult {
  deleted: boolean; userId: number; username: string; email: string;
  dinaNotified: boolean; dinaDetail?: string; verification: PurgeVerification;
}

// Map a run/step status to a StatusDot class (healthy=green, degraded=yellow, unhealthy=red).
const simStatusDot = (s: string): string =>
  s === 'passed' || s === 'pass' ? 'healthy'
  : s === 'failed' || s === 'fail' ? 'unhealthy'
  : 'degraded';

function IntakeSimulationCard({ onUsersChanged }: { onUsersChanged?: () => void }) {
  const [health, setHealth] = useState<SimHealth | null>(null);
  const [runs, setRuns] = useState<SimRunRow[]>([]);
  const [report, setReport] = useState<SimReport | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [skipCleanup, setSkipCleanup] = useState(false);
  const [simEmailLocal, setSimEmailLocal] = useState('');
  const [simPassword, setSimPassword] = useState('');
  const [makeTruthCard, setMakeTruthCard] = useState(false);
  const [reviewTone, setReviewTone] = useState(REVIEW_TONES[1]);

  const refresh = useCallback(() => {
    api<{ data: SimHealth }>('/mirror/simulation/health').then(d => setHealth(d.data)).catch(() => {});
    api<{ data: SimRunRow[] }>('/mirror/simulation/runs?limit=8').then(d => setRuns(d.data || [])).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const run = useCallback(async () => {
    setRunning(true); setNote(''); setReport(null);
    try {
      const d = await api<{ success: boolean; data: SimReport }>('/mirror/simulation/run', {
        method: 'POST',
        body: JSON.stringify({
          dryRun,
          skipCleanup,
          // Custom credentials + TruthStream card only apply to a kept test user.
          ...(skipCleanup && simEmailLocal ? { emailLocalPart: simEmailLocal } : {}),
          ...(skipCleanup && simPassword ? { password: simPassword } : {}),
          ...(skipCleanup && makeTruthCard ? { truthCard: true, reviewTone } : {}),
        }),
      });
      setReport(d.data);
    } catch (e) {
      setNote((e as Error).message || 'Simulation failed to start');
    } finally {
      setRunning(false);
      refresh();
      onUsersChanged?.();
    }
  }, [dryRun, skipCleanup, simEmailLocal, simPassword, makeTruthCard, reviewTone, refresh, onUsersChanged]);

  const sweep = useCallback(async () => {
    setNote('');
    try {
      const d = await api<{ data: { scanned: number; purged: number } }>('/mirror/simulation/cleanup', {
        method: 'POST', body: JSON.stringify({}),
      });
      setNote(`Sweep complete — scanned ${d.data.scanned}, purged ${d.data.purged}.`);
    } catch (e) {
      setNote((e as Error).message || 'Sweep failed');
    } finally {
      refresh();
      onUsersChanged?.();
    }
  }, [refresh, onUsersChanged]);

  const ready = !!(health?.dbReachable && health?.internalSecretConfigured && health?.jwtConfigured);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">Intake Simulation</span>
        {report && <StatusDot status={simStatusDot(report.status)} />}
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
        Runs a real end-to-end intake against a throwaway, clearly-marked sim user
        (register → upload photo + voice → store intake → verify folders, files &amp; DB
        → decrypt read-back), then deletes every trace. Confirms the intake pipeline is
        healthy without clicking through the whole flow.
      </p>

      {health && (
        <div className="metric-row" style={{ marginBottom: 12 }}>
          <div className="metric"><div className="metric-label">DB</div><div className="metric-value sm" style={{ color: health.dbReachable ? 'var(--accent-green)' : 'var(--accent-red)' }}>{health.dbReachable ? 'reachable' : 'down'}</div></div>
          <div className="metric"><div className="metric-label">Internal secret</div><div className="metric-value sm" style={{ color: health.internalSecretConfigured ? 'var(--accent-green)' : 'var(--accent-red)' }}>{health.internalSecretConfigured ? 'set' : 'missing'}</div></div>
          <div className="metric"><div className="metric-label">JWT</div><div className="metric-value sm" style={{ color: health.jwtConfigured ? 'var(--accent-green)' : 'var(--accent-red)' }}>{health.jwtConfigured ? 'set' : 'missing'}</div></div>
          <div className="metric"><div className="metric-label">State</div><div className="metric-value sm">{health.runInFlight ? 'running…' : 'idle'}</div></div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <button
          className="nav-tab"
          onClick={run}
          disabled={running || !ready}
          style={{ padding: '8px 18px', border: '1px solid var(--accent-green)', borderRadius: 4, color: running || !ready ? 'var(--text-muted)' : 'var(--accent-green)', opacity: running || !ready ? 0.6 : 1 }}
        >{running ? 'Running…' : 'Run Simulation'}</button>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} disabled={running} />
          Dry run (readiness only)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={skipCleanup} onChange={e => setSkipCleanup(e.target.checked)} disabled={running} />
          Keep sim user (debug)
        </label>

        <button className="nav-tab" onClick={sweep} disabled={running} style={{ padding: '8px 14px', fontSize: 11, marginLeft: 'auto' }}>
          Sweep orphans
        </button>
      </div>

      {/* Custom credentials for a kept test user. The domain is fixed to the
          reserved sim domain server-side; you choose the memorable local part. */}
      {skipCleanup && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Test login:</span>
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            <input
              type="text" value={simEmailLocal} onChange={e => setSimEmailLocal(e.target.value)} disabled={running}
              placeholder="email name (optional)"
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '6px 8px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 3, width: 170 }}
            />
            <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 12, marginLeft: 4 }}>@{health?.simEmailDomain || 'simulation.mirror.invalid'}</span>
          </span>
          <input
            type="text" value={simPassword} onChange={e => setSimPassword(e.target.value)} disabled={running}
            placeholder="password (optional, blank = random)"
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '6px 8px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 3, minWidth: 260 }}
          />
        </div>
      )}

      {/* TruthStream report card for a kept user (profile + seeded reviews + report). */}
      {skipCleanup && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={makeTruthCard} onChange={e => setMakeTruthCard(e.target.checked)} disabled={running} />
            Also create TruthStream report card
          </label>
          {makeTruthCard && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
              tone:
              <select value={reviewTone} onChange={e => setReviewTone(e.target.value)} disabled={running}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '5px 8px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 3 }}>
                {REVIEW_TONES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <span style={{ color: 'var(--text-muted)' }}>(profile + 5 seeded reviews + analysis report)</span>
            </span>
          )}
        </div>
      )}

      {!ready && health && (
        <div style={{ color: 'var(--accent-yellow)', fontSize: 12, marginBottom: 8 }}>
          Not ready — check DB connectivity and that MIRROR_INTERNAL_SECRET / JWT_SECRET are configured on mirror-server.
        </div>
      )}
      {note && <div style={{ color: 'var(--accent-yellow)', fontSize: 12, marginBottom: 8, fontFamily: 'var(--font-mono)' }}>{note}</div>}

      {report && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 8 }}>
            <span>Result: <strong style={{ color: report.status === 'failed' ? 'var(--accent-red)' : report.status === 'passed' ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>{report.status.replace(/_/g, ' ').toUpperCase()}</strong></span>
            <span style={{ color: 'var(--text-muted)' }}>{report.durationMs} ms</span>
            <span style={{ color: 'var(--text-muted)' }}>user: {report.simUsername}{report.simUserId ? ` (#${report.simUserId})` : ''}</span>
            <span style={{ color: report.cleanedUp ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>{report.cleanedUp ? 'cleaned up ✓' : 'NOT cleaned up'}</span>
          </div>

          {report.credentials && (
            <div className="card" style={{ marginBottom: 12, borderColor: 'var(--accent-yellow)' }}>
              <div className="card-header"><span className="card-title">Test user credentials — log in with these</span></div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, display: 'grid', gap: 4 }}>
                <div><span style={{ color: 'var(--text-muted)' }}>email&nbsp;&nbsp;&nbsp;</span> <span style={{ color: 'var(--accent-white)', userSelect: 'all' }}>{report.credentials.email}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>username</span> <span style={{ color: 'var(--accent-white)', userSelect: 'all' }}>{report.credentials.username}</span></div>
                <div><span style={{ color: 'var(--text-muted)' }}>password</span> <span style={{ color: 'var(--accent-white)', userSelect: 'all' }}>{report.credentials.password}</span></div>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '8px 0 0' }}>
                Shown here only — never stored in run history or logs. The account is kept (email-verified, intake complete) until you Sweep orphans.
              </p>
            </div>
          )}

          {report.truthCard && (
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="card-header"><span className="card-title">TruthStream report card</span></div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                profile created (goal: {report.truthCard.goalCategory || '—'}) · {report.truthCard.reviewsSeeded} reviews seeded from helper sim users · analysis report {report.truthCard.analysisRequested ? 'requested (async — generated by the TruthStream worker)' : 'not requested'}
              </div>
              {report.truthCard.helperUserIds.length > 0 && (
                <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '6px 0 0' }}>
                  Helper reviewer sim users #{report.truthCard.helperUserIds.join(', #')} were created and appear in Test Users (sweepable like any sim user).
                </p>
              )}
            </div>
          )}

          <div className="table-wrap">
            <table className="process-table">
              <thead><tr><th>Step</th><th>Result</th><th>ms</th><th>Detail</th></tr></thead>
              <tbody>
                {report.steps.map((s, i) => (
                  <tr key={i}>
                    <td><StatusDot status={simStatusDot(s.severity)} />{s.name}</td>
                    <td style={{ color: s.severity === 'fail' ? 'var(--accent-red)' : s.severity === 'warn' ? 'var(--accent-yellow)' : 'var(--accent-green)' }}>{s.severity}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{s.ms}</td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.warnings.length > 0 && (
            <ul style={{ color: 'var(--accent-yellow)', fontSize: 12, margin: '8px 0 0', paddingLeft: 18 }}>
              {report.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          {report.error && <div style={{ color: 'var(--accent-red)', fontSize: 12, marginTop: 8, fontFamily: 'var(--font-mono)' }}>Error: {report.error}</div>}
        </div>
      )}

      {runs.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="card-header" style={{ marginBottom: 8 }}><span className="card-title">Recent Runs</span></div>
          <div className="table-wrap">
            <table className="process-table">
              <thead><tr><th>When</th><th>Status</th><th>Operator</th><th>ms</th><th>Clean</th></tr></thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.run_id}>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{new Date(r.started_at).toLocaleString()}</td>
                    <td><StatusDot status={simStatusDot(r.status)} />{r.status}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{r.operator || '--'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{r.duration_ms ?? '--'}</td>
                    <td style={{ color: r.cleaned_up ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>{r.cleaned_up ? '✓' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// Renders one purge/footprint verification (used for both inspect and delete).
function VerificationDetail({ v, deleted }: { v: PurgeVerification; deleted: boolean }) {
  const headline = deleted
    ? (v.clean ? 'TRULY DELETED ✓ — no trace in DB or on disk' : 'DELETED — but residue was found below')
    : (v.clean ? 'No data found for this user' : 'Current data footprint');
  const color = v.clean ? 'var(--accent-green)' : (deleted ? 'var(--accent-red)' : 'var(--text-secondary)');
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6 }}>
      <div style={{ color, fontWeight: 600, marginBottom: 4 }}>{headline}</div>
      <div style={{ color: 'var(--text-muted)' }}>
        users row: <span style={{ color: v.usersRowPresent ? 'var(--accent-yellow)' : 'var(--accent-green)' }}>{v.usersRowPresent ? 'present' : 'gone'}</span>
        {' · '}DB columns scanned: {v.dbTablesScanned}
        {' · '}storage dir: <span style={{ color: v.storageDirPresent ? 'var(--accent-yellow)' : 'var(--accent-green)' }}>{v.storageDirPresent === null ? 'unknown' : v.storageDirPresent ? 'present' : 'gone'}</span>
        {' · '}files t1/t2/t3: {v.storage.tier1}/{v.storage.tier2}/{v.storage.tier3}
      </div>
      {v.dbResidue.length > 0 && (
        <div style={{ color: 'var(--accent-red)', marginTop: 4 }}>
          residual rows:
          {v.dbResidue.map((r, i) => <div key={i}>&nbsp;&nbsp;• {r.table}.{r.column} = {r.rows}</div>)}
        </div>
      )}
      {v.scanErrors.length > 0 && (
        <div style={{ color: 'var(--accent-yellow)', marginTop: 4 }}>
          scan warnings:
          {v.scanErrors.map((r, i) => <div key={i}>&nbsp;&nbsp;• {r.table}.{r.column}: {r.error}</div>)}
        </div>
      )}
    </div>
  );
}

function CredentialsBox({ c }: { c: { email: string; username: string; password: string } }) {
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginBottom: 6 }}>
      <span style={{ color: 'var(--accent-yellow)' }}>New login →</span>{' '}
      <span style={{ userSelect: 'all', color: 'var(--accent-white)' }}>{c.email}</span>
      {'  /  '}
      <span style={{ userSelect: 'all', color: 'var(--accent-white)' }}>{c.password}</span>
    </div>
  );
}

// Colour for a Dina review classification.
function classColor(c: string | null): string {
  switch (c) {
    case 'constructive': return 'var(--accent-green)';
    case 'affirming': return 'var(--accent-blue)';
    case 'raw_truth': return 'var(--accent-yellow)';
    case 'hostile': return 'var(--accent-red)';
    default: return 'var(--text-muted)';
  }
}

// The user's TruthStream report card + reviews + analysis, for the Inspect view.
function TruthStreamDetail({ r }: { r: TruthStreamUserReport }) {
  if (!r.hasProfile || !r.profile) {
    return <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>No TruthStream profile.</div>;
  }
  const p = r.profile;
  const generating = r.pendingJobs.some(j => j.jobType === 'generate_analysis');
  const classifying = r.pendingJobs.filter(j => j.jobType === 'classify_review').length;
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.6, marginTop: 8 }}>
      <div style={{ color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 4 }}>TruthStream report card</div>
      <div style={{ color: 'var(--text-muted)' }}>
        alias <span style={{ color: 'var(--accent-white)' }}>{p.displayAlias}</span> · goal {p.goalCategory} · {p.isActive ? 'active' : 'inactive'}
        {' · '}received {p.totalReviewsReceived} · given {p.totalReviewsGiven}
        {p.profileCompleteness != null ? ` · completeness ${p.profileCompleteness}` : ''}
      </div>

      <div style={{ marginTop: 6 }}>
        report:{' '}
        {r.analysis ? (
          <span style={{ color: 'var(--accent-green)' }}>
            {r.analysis.analysisType} generated from {r.analysis.reviewCountAtGeneration} reviews
            {r.analysis.confidenceLevel != null ? ` (confidence ${r.analysis.confidenceLevel})` : ''}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>
            not generated yet — needs {r.minReviewsForAnalysis} received reviews, has {p.totalReviewsReceived}
            {generating ? ' · generating…' : ''}
          </span>
        )}
      </div>
      {r.analysis?.summary && (
        <div style={{ color: 'var(--text-muted)', marginTop: 2, whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto' }}>{r.analysis.summary}</div>
      )}

      <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>
        Received reviews ({r.receivedReviews.length}){classifying > 0 ? <span style={{ color: 'var(--accent-yellow)' }}> · {classifying} classifying…</span> : null}
      </div>
      {r.receivedReviews.map(rv => (
        <div key={rv.id}>
          &nbsp;&nbsp;• <span style={{ color: classColor(rv.classification) }}>{rv.classification || 'classification pending'}</span>
          {rv.classificationConfidence != null ? ` (${rv.classificationConfidence})` : ''}
          {' · '}q{rv.qualityScore ?? '—'} · tone {rv.tone || '—'}
          {rv.snippet ? <span style={{ color: 'var(--text-muted)' }}> — “{rv.snippet}”</span> : null}
        </div>
      ))}

      {r.givenReviews.length > 0 && (
        <>
          <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>Given reviews ({r.givenReviews.length})</div>
          {r.givenReviews.map(gv => (
            <div key={gv.id}>&nbsp;&nbsp;• → user #{gv.revieweeId} · <span style={{ color: classColor(gv.classification) }}>{gv.classification || 'pending'}</span> · q{gv.qualityScore ?? '—'}</div>
          ))}
        </>
      )}
    </div>
  );
}

const tuBtn: CSSProperties = { padding: '4px 10px', fontSize: 11, marginRight: 6 };

// Manage kept simulation users: log in as them (reset password), inspect their
// data footprint, and delete them with a proof that nothing remains.
function TestUsersPanel({ refreshKey }: { refreshKey: number }) {
  const [users, setUsers] = useState<SimUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [verify, setVerify] = useState<Record<number, PurgeVerification>>({});
  const [tsReport, setTsReport] = useState<Record<number, TruthStreamUserReport>>({});
  const [creds, setCreds] = useState<Record<number, { email: string; username: string; password: string }>>({});
  const [deletions, setDeletions] = useState<Record<number, DeleteSimUserResult>>({});

  const load = useCallback(() => {
    setLoading(true);
    api<{ data: SimUser[] }>('/mirror/simulation/users')
      .then(d => setUsers(d.data || []))
      .catch(e => setNote((e as Error).message || 'Failed to load test users'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load, refreshKey]);

  const inspect = useCallback(async (id: number) => {
    setBusyId(id); setNote('');
    try {
      // Footprint (purge proof) + TruthStream report card, in parallel. The
      // TruthStream read is best-effort — a missing report shouldn't block Inspect.
      const [v, ts] = await Promise.all([
        api<{ data: PurgeVerification }>(`/mirror/simulation/users/${id}/verify`),
        api<{ data: TruthStreamUserReport }>(`/mirror/simulation/users/${id}/truthstream`).catch(() => null),
      ]);
      setVerify(prev => ({ ...prev, [id]: v.data }));
      if (ts && ts.data) setTsReport(prev => ({ ...prev, [id]: ts.data }));
    } catch (e) { setNote((e as Error).message || 'Inspect failed'); }
    finally { setBusyId(null); }
  }, []);

  const resetPw = useCallback(async (id: number) => {
    const pw = window.prompt('New password for this test user (leave blank = strong random; min 8 chars to set your own):', '');
    if (pw === null) return; // cancelled
    setBusyId(id); setNote('');
    try {
      const d = await api<{ data: { email: string; username: string; password: string } }>(
        `/mirror/simulation/users/${id}/reset-password`,
        { method: 'POST', body: JSON.stringify({ password: pw || undefined }) },
      );
      setCreds(c => ({ ...c, [id]: d.data }));
    } catch (e) { setNote((e as Error).message || 'Password reset failed'); }
    finally { setBusyId(null); }
  }, []);

  const del = useCallback(async (id: number, email: string) => {
    if (!window.confirm(`Permanently delete test user ${email} (#${id})?\n\nThis runs the full account-deletion teardown (database rows + stored files + Dina purge) and then verifies that nothing remains.`)) return;
    setBusyId(id); setNote('');
    try {
      const d = await api<{ data: DeleteSimUserResult }>(`/mirror/simulation/users/${id}`, { method: 'DELETE' });
      setDeletions(r => ({ ...r, [id]: d.data }));
      setVerify(v => { const n = { ...v }; delete n[id]; return n; });
      setTsReport(t => { const n = { ...t }; delete n[id]; return n; });
      setCreds(c => { const n = { ...c }; delete n[id]; return n; });
      setNote(d.data.verification.clean
        ? `User #${id} deleted and verified — nothing remains.`
        : `User #${id} deleted, but residual data was found — see Deletion results.`);
      load();
    } catch (e) { setNote((e as Error).message || 'Delete failed'); }
    finally { setBusyId(null); }
  }, [load]);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">Test Users — kept simulations</span>
        <button className="nav-tab" onClick={load} disabled={loading} style={{ padding: '6px 12px', fontSize: 11 }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {note && <div style={{ color: 'var(--accent-yellow)', fontSize: 12, marginBottom: 8, fontFamily: 'var(--font-mono)' }}>{note}</div>}

      {users.length === 0 && !loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: 0 }}>
          No kept test users. Run a simulation with “Keep sim user (debug)” checked to create one.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="process-table">
            <thead><tr>
              <th>ID</th><th>Email / Username</th><th>Created</th><th>Flags</th><th>Files t1/t2/t3</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {users.map(u => (
                <Fragment key={u.id}>
                  <tr>
                    <td>#{u.id}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      <div style={{ color: 'var(--accent-white)', userSelect: 'all' }}>{u.email}</div>
                      <div style={{ color: 'var(--text-muted)' }}>{u.username}</div>
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.createdAt ? new Date(u.createdAt).toLocaleString() : '--'}</td>
                    <td style={{ fontSize: 11 }}>
                      <span style={{ color: u.emailVerified ? 'var(--accent-green)' : 'var(--text-muted)' }}>{u.emailVerified ? 'verified' : 'unverified'}</span>
                      {' · '}
                      <span style={{ color: u.intakeCompleted ? 'var(--accent-green)' : 'var(--text-muted)' }}>{u.intakeCompleted ? 'intake✓' : 'no intake'}</span>
                    </td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{u.files.tier1}/{u.files.tier2}/{u.files.tier3}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="nav-tab" style={tuBtn} disabled={busyId === u.id} onClick={() => inspect(u.id)}>Inspect</button>
                      <button className="nav-tab" style={tuBtn} disabled={busyId === u.id} onClick={() => resetPw(u.id)}>Reset PW</button>
                      <button className="nav-tab" style={{ ...tuBtn, color: 'var(--accent-red)', borderColor: 'var(--accent-red)' }} disabled={busyId === u.id} onClick={() => del(u.id, u.email)}>Delete</button>
                    </td>
                  </tr>
                  {(creds[u.id] || verify[u.id] || tsReport[u.id]) && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--bg-secondary)' }}>
                        {creds[u.id] && <CredentialsBox c={creds[u.id]} />}
                        {verify[u.id] && <VerificationDetail v={verify[u.id]} deleted={false} />}
                        {tsReport[u.id] && <TruthStreamDetail r={tsReport[u.id]} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {Object.keys(deletions).length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>Deletion results (proof of teardown)</div>
          {Object.values(deletions).sort((a, b) => b.userId - a.userId).map(r => (
            <div key={r.userId} className="card" style={{ marginBottom: 8, borderColor: r.verification.clean ? 'var(--accent-green)' : 'var(--accent-red)' }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>
                #{r.userId}{' '}
                {r.email && <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>{r.email}</span>}
                {' · '}Dina purge: <span style={{ color: r.dinaNotified ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>{r.dinaNotified ? 'acknowledged' : `not confirmed${r.dinaDetail ? ` (${r.dinaDetail})` : ''}`}</span>
              </div>
              <VerificationDetail v={r.verification} deleted={true} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Simulate TruthStream reviews: one or more sim reviewers review a chosen user.
function ReviewRunnerPanel({ refreshKey }: { refreshKey: number }) {
  const [reviewers, setReviewers] = useState<ReviewableUser[]>([]);
  const [reviewees, setReviewees] = useState<ProfiledUser[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [addHelpers, setAddHelpers] = useState('0');
  const [revieweeId, setRevieweeId] = useState('');
  const [tone, setTone] = useState(REVIEW_TONES[1]);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ReviewBatchResult | null>(null);

  const load = useCallback(() => {
    api<{ data: ReviewableUser[] }>('/mirror/simulation/reviewable-users').then(d => setReviewers(d.data || [])).catch(e => setNote((e as Error).message || 'Failed to load reviewers'));
    api<{ data: ProfiledUser[] }>('/mirror/simulation/users-with-profile').then(d => setReviewees(d.data || [])).catch(e => setNote((e as Error).message || 'Failed to load reviewees'));
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  const toggle = (id: number) => setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const run = useCallback(async () => {
    const reviewee = reviewees.find(u => u.id === Number(revieweeId));
    const helpers = Math.max(0, Math.min(10, parseInt(addHelpers, 10) || 0));
    if (!reviewee) { setNote('Pick a reviewee (a user with a TruthStream report).'); return; }
    const reviewerIds = Array.from(selected).filter(id => id !== reviewee.id);
    if (reviewerIds.length === 0 && helpers === 0) { setNote('Select at least one reviewer, or add helper reviewers.'); return; }
    if (!reviewee.isSim && !window.confirm(`⚠ ${reviewee.email} (#${reviewee.id}) is a REAL user, not a sim account.\n\nThis writes ${reviewerIds.length + helpers} real review(s) to their account (received-review stats, Dina classification/analysis, possible notification) and is NOT auto-sweepable for a real user.\n\nProceed?`)) return;
    setRunning(true); setNote(''); setResult(null);
    try {
      const d = await api<{ data: ReviewBatchResult }>('/mirror/simulation/reviews/run-batch', {
        method: 'POST', body: JSON.stringify({ revieweeId: reviewee.id, reviewerIds, addHelpers: helpers, tone }),
      });
      setResult(d.data);
    } catch (e) { setNote((e as Error).message || 'Review batch failed'); }
    finally { setRunning(false); load(); }
  }, [reviewees, revieweeId, selected, addHelpers, tone, load]);

  const selStyle: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 12, padding: '6px 8px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: 3 };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-header">
        <span className="card-title">Review Runner — simulate TruthStream reviews</span>
        <button className="nav-tab" onClick={load} disabled={running} style={{ padding: '6px 12px', fontSize: 11 }}>Refresh</button>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 0 }}>
        One or more sim reviewers review a chosen user through the real start/complete pipeline. Reviewers are always sim accounts; the reviewee can be any user with a TruthStream report (sim or real). A user needs ≥5 received reviews before the mirror report can generate.
      </p>

      <div style={{ display: 'grid', gap: 12 }}>
        {/* Reviewee — picked from the list of users that have a TruthStream report */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
          <span style={{ width: 90 }}>Reviewee</span>
          <select value={revieweeId} onChange={e => setRevieweeId(e.target.value)} disabled={running} style={{ ...selStyle, minWidth: 380 }}>
            <option value="">— pick a user with a TruthStream report —</option>
            {reviewees.map(u => (
              <option key={u.id} value={u.id}>#{u.id} {u.email} {u.isSim ? '[sim]' : '[REAL]'} · {u.reviewsReceived} received{u.hasReport ? ' · report✓' : ''}</option>
            ))}
          </select>
        </label>

        {/* Reviewers — multi-select sim users + optional fresh helpers */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
          <span style={{ width: 90, paddingTop: 6 }}>Reviewers</span>
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 3, minWidth: 380 }}>
              {reviewers.length === 0 ? (
                <div style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: 11 }}>No sim users yet — run a simulation (Keep) to create some, or just add helper reviewers below.</div>
              ) : reviewers.map(u => (
                <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 11, borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggle(u.id)} disabled={running} />
                  #{u.id} {u.email}{u.hasProfile ? ' ✓profile' : ''}
                </label>
              ))}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>{selected.size} selected · + auto-add</span>
              <input type="number" min={0} max={10} value={addHelpers} onChange={e => setAddHelpers(e.target.value)} disabled={running} style={{ ...selStyle, width: 64 }} />
              <span style={{ color: 'var(--text-muted)' }}>fresh helper reviewers</span>
            </label>
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
          <span style={{ width: 90 }}>Tone</span>
          <select value={tone} onChange={e => setTone(e.target.value)} disabled={running} style={selStyle}>
            {REVIEW_TONES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>

        <div>
          <button className="nav-tab" onClick={run} disabled={running}
            style={{ padding: '8px 18px', border: '1px solid var(--accent-green)', borderRadius: 4, color: running ? 'var(--text-muted)' : 'var(--accent-green)' }}>
            {running ? 'Running…' : 'Run Reviews'}
          </button>
        </div>
      </div>

      {note && <div style={{ color: 'var(--accent-yellow)', fontSize: 12, marginTop: 8, fontFamily: 'var(--font-mono)' }}>{note}</div>}

      {result && (
        <div className="card" style={{ marginTop: 12, borderColor: result.succeeded > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, display: 'grid', gap: 3 }}>
            <div style={{ color: result.succeeded > 0 ? 'var(--accent-green)' : 'var(--accent-red)', fontWeight: 600 }}>
              {result.succeeded}/{result.results.length} reviews submitted to reviewee #{result.revieweeId} {result.revieweeIsSim ? <span style={{ color: 'var(--accent-green)' }}>(sim)</span> : <span style={{ color: 'var(--accent-red)' }}>(REAL USER)</span>}
            </div>
            <div style={{ color: 'var(--text-muted)' }}>tone: {result.tone}</div>
            <div style={{ color: result.reportReady ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
              received reviews: {result.totalReceivedAfter} / {result.minReviewsForAnalysis} needed — {result.reportReady ? 'report can generate ✓' : 'need more before the report can generate'}
            </div>
            {result.results.map((r, i) => (
              <div key={i} style={{ color: r.ok ? 'var(--text-muted)' : 'var(--accent-red)' }}>
                &nbsp;&nbsp;• reviewer {r.reviewerId > 0 ? `#${r.reviewerId}` : '(helper)'}: {r.ok ? `ok · q${r.qualityScore ?? '—'}` : `failed — ${r.error || 'unknown'}`}
              </div>
            ))}
            <div style={{ color: 'var(--text-muted)' }}>classification + report run asynchronously (TruthStream worker + Dina). Use Inspect on the reviewee to watch them populate.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function MirrorPanel() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logType, setLogType] = useState<'out' | 'error'>('out');
  // Bumped whenever a simulation run/sweep may have changed the kept-user set,
  // so the Test Users panel re-fetches without the operator clicking Refresh.
  const [simUsersRefresh, setSimUsersRefresh] = useState(0);

  const fetchAll = useCallback(() => {
    api<ServiceHealth>('/mirror/health').then(setHealth).catch(() => {});
    api<{ workers: WorkerInfo[] }>('/mirror/workers').then(d => setWorkers(d.workers)).catch(() => {});
  }, []);

  const fetchLogs = useCallback((type: 'out' | 'error') => {
    setLogType(type);
    api<{ entries: LogEntry[] }>(`/mirror/logs?type=${type}&lines=200`).then(d => setLogs(d.entries)).catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); fetchLogs('out'); const id = setInterval(fetchAll, 20000); return () => clearInterval(id); }, [fetchAll, fetchLogs]);

  // Extract features from health details
  const features = health?.details ? (health.details as Record<string, unknown>).features as Record<string, string> | undefined : undefined;

  return (
    <>
      {health && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Mirror Server Health</span>
            <StatusDot status={health.status} />
          </div>
          <div className="metric-row">
            <div className="metric">
              <div className="metric-label">Status</div>
              <div className="metric-value sm" style={{
                color: health.status === 'healthy' ? 'var(--accent-green)' : 'var(--accent-red)',
              }}>{health.status.toUpperCase()}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Latency</div>
              <div className="metric-value sm">{health.latency}ms</div>
            </div>
            <div className="metric">
              <div className="metric-label">Version</div>
              <div className="metric-value sm">{(health.details as Record<string, string>)?.version || '--'}</div>
            </div>
          </div>
        </div>
      )}

      <IntakeSimulationCard onUsersChanged={() => setSimUsersRefresh(k => k + 1)} />

      <TestUsersPanel refreshKey={simUsersRefresh} />

      <ReviewRunnerPanel refreshKey={simUsersRefresh} />

      {features && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Feature Status</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {Object.entries(features).filter(([, v]) => typeof v === 'string').map(([key, val]) => {
              const isGreen = ['enabled', 'connected', 'paypal_active', 'healthy', 'online'].includes(val);
              const isRed = ['disabled', 'disconnected', 'unhealthy', 'stopped', 'errored', 'not_found'].includes(val);
              return (
                <div key={key} style={{
                  padding: '4px 10px', borderRadius: 3,
                  border: '1px solid var(--border)',
                  background: isGreen ? 'rgba(0,255,136,0.08)' : isRed ? 'rgba(255,51,85,0.08)' : 'transparent',
                }}>
                  <span style={{ color: 'var(--text-muted)' }}>{key}: </span>
                  <span style={{
                    color: isGreen ? 'var(--accent-green)' : isRed ? 'var(--accent-red)' : 'var(--text-secondary)',
                  }}>{val}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {workers.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Queue Workers</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{workers.length} workers</span>
          </div>
          <div className="table-wrap">
            <table className="process-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Recent Errors</th>
                  <th>Latest Output</th>
                </tr>
              </thead>
              <tbody>
                {workers.map(w => (
                  <tr key={w.name}>
                    <td>
                      <StatusDot status={w.errors.length > 0 ? 'degraded' : 'online'} />
                      {w.name}
                    </td>
                    <td style={{ color: w.errors.length > 0 ? 'var(--accent-red)' : 'var(--accent-green)' }}>
                      {w.errors.length > 0 ? `${w.errors.length} errors` : 'None'}
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {w.recent.length > 0 ? w.recent[w.recent.length - 1].line : 'No output'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Mirror Logs</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`nav-tab${logType === 'out' ? ' active' : ''}`}
              onClick={() => fetchLogs('out')}
              style={{ padding: '4px 12px', fontSize: 11 }}
            >stdout</button>
            <button
              className={`nav-tab${logType === 'error' ? ' active' : ''}`}
              onClick={() => fetchLogs('error')}
              style={{ padding: '4px 12px', fontSize: 11 }}
            >stderr</button>
          </div>
        </div>
        <LogViewer title={`mirror-server-${logType}.log`} entries={logs} onRefresh={() => fetchLogs(logType)} />
      </div>
    </>
  );
}

function DinaPanel() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logType, setLogType] = useState<'out' | 'error'>('out');

  const fetchHealth = useCallback(() => {
    api<ServiceHealth>('/dina/health').then(setHealth).catch(() => {});
  }, []);

  const fetchLogs = useCallback((type: 'out' | 'error') => {
    setLogType(type);
    api<{ entries: LogEntry[] }>(`/dina/logs?type=${type}&lines=200`).then(d => setLogs(d.entries)).catch(() => {});
  }, []);

  useEffect(() => { fetchHealth(); fetchLogs('out'); const id = setInterval(fetchHealth, 20000); return () => clearInterval(id); }, [fetchHealth, fetchLogs]);

  return (
    <>
      {health && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">DINA Server Health</span>
            <StatusDot status={health.status} />
          </div>
          <div className="metric-row">
            <div className="metric">
              <div className="metric-label">Status</div>
              <div className="metric-value sm" style={{
                color: health.status === 'healthy' ? 'var(--accent-green)' : 'var(--accent-red)',
              }}>{health.status.toUpperCase()}</div>
            </div>
            <div className="metric">
              <div className="metric-label">Latency</div>
              <div className="metric-value sm">{health.latency}ms</div>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">DINA Logs</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`nav-tab${logType === 'out' ? ' active' : ''}`}
              onClick={() => fetchLogs('out')}
              style={{ padding: '4px 12px', fontSize: 11 }}
            >stdout</button>
            <button
              className={`nav-tab${logType === 'error' ? ' active' : ''}`}
              onClick={() => fetchLogs('error')}
              style={{ padding: '4px 12px', fontSize: 11 }}
            >stderr</button>
          </div>
        </div>
        <LogViewer title={`dina-server-${logType}.log`} entries={logs} onRefresh={() => fetchLogs(logType)} />
      </div>
    </>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

type Tab = 'system' | 'mirror' | 'dina' | 'email';

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getToken());
  const [activeTab, setActiveTab] = useState<Tab>('system');

  const handleLogout = () => {
    clearToken();
    setAuthenticated(false);
  };

  if (!authenticated) {
    return <LoginScreen onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <div className="app">
      <div className="header">
        <div className="header-title">TUGRR // ADMIN PORTAL</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span className="header-meta">{new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
          <button onClick={handleLogout} style={{
            background: 'none', border: '1px solid var(--border)', borderRadius: 3,
            color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11,
            padding: '4px 12px', cursor: 'pointer', letterSpacing: '0.5px',
          }}>
            LOGOUT
          </button>
        </div>
      </div>
      <div className="nav">
        {(['system', 'mirror', 'dina', 'email'] as Tab[]).map(tab => (
          <button
            key={tab}
            className={`nav-tab${activeTab === tab ? ' active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'system' ? 'System Overview' : tab === 'mirror' ? 'Mirror Server' : tab === 'dina' ? 'DINA Server' : 'Email'}
          </button>
        ))}
      </div>
      <div className="content">
        {activeTab === 'system' && <SystemPanel />}
        {activeTab === 'mirror' && <MirrorPanel />}
        {activeTab === 'dina' && <DinaPanel />}
        {activeTab === 'email' && <EmailPanel />}
      </div>
    </div>
  );
}
