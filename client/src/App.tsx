import { useState, useEffect, useCallback, useRef } from 'react';
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

// Map a run/step status to a StatusDot class (healthy=green, degraded=yellow, unhealthy=red).
const simStatusDot = (s: string): string =>
  s === 'passed' || s === 'pass' ? 'healthy'
  : s === 'failed' || s === 'fail' ? 'unhealthy'
  : 'degraded';

function IntakeSimulationCard() {
  const [health, setHealth] = useState<SimHealth | null>(null);
  const [runs, setRuns] = useState<SimRunRow[]>([]);
  const [report, setReport] = useState<SimReport | null>(null);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [skipCleanup, setSkipCleanup] = useState(false);
  const [simEmailLocal, setSimEmailLocal] = useState('');
  const [simPassword, setSimPassword] = useState('');

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
          // Custom credentials only apply to a kept test user.
          ...(skipCleanup && simEmailLocal ? { emailLocalPart: simEmailLocal } : {}),
          ...(skipCleanup && simPassword ? { password: simPassword } : {}),
        }),
      });
      setReport(d.data);
    } catch (e) {
      setNote((e as Error).message || 'Simulation failed to start');
    } finally {
      setRunning(false);
      refresh();
    }
  }, [dryRun, skipCleanup, simEmailLocal, simPassword, refresh]);

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
    }
  }, [refresh]);

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

function MirrorPanel() {
  const [health, setHealth] = useState<ServiceHealth | null>(null);
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logType, setLogType] = useState<'out' | 'error'>('out');

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

      <IntakeSimulationCard />

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
