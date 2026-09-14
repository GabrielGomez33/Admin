import { useState, useEffect, useCallback } from 'react';

// ─── API (self-contained; mirrors App.tsx / EmailPanel auth) ──────────────────

const API_BASE = '/admin/api';
const getToken = (): string | null => sessionStorage.getItem('admin_token');

async function api<T>(path: string): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401) {
    sessionStorage.removeItem('admin_token');
    window.location.reload();
    throw new Error('Session expired');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body && body.success === false)) {
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return body as T;
}

// ─── Types (mirror services/conversionAnalytics.FunnelAnalytics) ──────────────

interface StepMetric {
  stage: string; order: number; sessionsReaching: number;
  sessionsLostFromPrev: number | null; stepConversionPct: number | null;
  stepDropoffPct: number | null; cumulativeConversionPct: number | null;
}
interface Milestone { key: string; label: string; fromStage: string; toStage: string; fromSessions: number; toSessions: number; ratePct: number | null; }
interface BiggestDrop { fromStage: string; toStage: string; sessionsLost: number; dropoffPct: number | null; }
interface SourceRow { source: string; sessions: number; signups: number; aha: number; core: number; premium: number; signupRatePct: number | null; premiumRatePct: number | null; }
interface TrendPoint { day: string; landing: number; signups: number; aha: number; premium: number; }
interface FunnelAnalytics {
  sinceDays: number; generatedAt: string; totalSessions: number;
  metrics: { entrySessions: number; steps: StepMetric[]; milestones: Milestone[]; biggestDrop: BiggestDrop | null; overallConversionPct: number | null; };
  sources: SourceRow[];
  trend: TrendPoint[];
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  landing_view: 'Landing viewed',
  signup_view: 'Signup viewed',
  signup_completed: 'Signup completed',
  entry_started: 'Entry started',
  entry_first_value: 'First value (aha)',
  dashboard_view: 'Dashboard viewed',
  mymirror_view: 'MyMirror viewed',
  core_started: 'Core started',
  core_completed: 'Core completed',
  premium_view: 'Premium viewed',
  premium_activated: 'Premium activated',
};
const label = (stage: string): string => STAGE_LABELS[stage] || stage;
const pct = (v: number | null | undefined): string => (v == null ? '—' : `${v}%`);
const num = (n: number): string => n.toLocaleString('en-US');

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6,
  padding: 16, fontFamily: 'var(--font-mono)',
};
const heading: React.CSSProperties = { color: 'var(--text-primary)', fontSize: 12, letterSpacing: '0.5px', textTransform: 'uppercase', margin: '0 0 12px' };

// ─── Trend line chart (inline SVG, no deps, theme-aware) ──────────────────────

function TrendChart({ trend }: { trend: TrendPoint[] }) {
  const W = 720, H = 180, padL = 40, padR = 12, padT = 12, padB = 24;
  const series: Array<{ key: keyof Omit<TrendPoint, 'day'>; color: string; name: string }> = [
    { key: 'landing', color: 'var(--text-muted)', name: 'Landing' },
    { key: 'signups', color: 'var(--accent-blue)', name: 'Signups' },
    { key: 'aha', color: 'var(--accent-yellow)', name: 'First value' },
    { key: 'premium', color: 'var(--accent-green)', name: 'Premium' },
  ];
  const max = Math.max(1, ...trend.flatMap((p) => [p.landing, p.signups, p.aha, p.premium]));
  const n = trend.length;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i * (W - padL - padR)) / (n - 1));
  const y = (v: number) => padT + (1 - v / max) * (H - padT - padB);
  const path = (key: keyof Omit<TrendPoint, 'day'>) =>
    trend.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 8, flexWrap: 'wrap' }}>
        {series.map((s) => (
          <span key={s.key} style={{ color: 'var(--text-secondary)', fontSize: 10 }}>
            <span style={{ display: 'inline-block', width: 10, height: 2, background: s.color, marginRight: 6, verticalAlign: 'middle' }} />{s.name}
          </span>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Daily funnel-stage sessions trend">
          {/* y gridlines */}
          {[0, 0.5, 1].map((f) => {
            const gy = padT + f * (H - padT - padB);
            return (
              <g key={f}>
                <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke="var(--border)" strokeWidth="1" />
                <text x={padL - 6} y={gy + 3} textAnchor="end" fill="var(--text-muted)" fontSize="9">{Math.round(max * (1 - f))}</text>
              </g>
            );
          })}
          {series.map((s) => (
            <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth="1.75" />
          ))}
          {/* x endpoints */}
          {n > 0 && (
            <>
              <text x={padL} y={H - 8} textAnchor="start" fill="var(--text-muted)" fontSize="9">{trend[0].day.slice(5)}</text>
              <text x={W - padR} y={H - 8} textAnchor="end" fill="var(--text-muted)" fontSize="9">{trend[n - 1].day.slice(5)}</text>
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

// ─── Funnel bars ──────────────────────────────────────────────────────────────

function FunnelBars({ steps, entry, bump }: { steps: StepMetric[]; entry: number; bump: BiggestDrop | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Column header so each number's meaning is explicit */}
      <div style={{ display: 'grid', gridTemplateColumns: '150px 1fr 66px 120px', gap: 10, alignItems: 'center', color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        <span>Stage</span>
        <span>Sessions reaching</span>
        <span style={{ textAlign: 'right' }}>Cum %</span>
        <span style={{ textAlign: 'right' }}>Step · drop</span>
      </div>
      {steps.map((s) => {
        const wpct = entry > 0 ? (s.sessionsReaching / entry) * 100 : 0;
        const isBumpTo = bump && bump.toStage === s.stage;
        return (
          <div key={s.stage} style={{ display: 'grid', gridTemplateColumns: '150px 1fr 66px 120px', gap: 10, alignItems: 'center' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={label(s.stage)}>
              {label(s.stage)}
            </span>
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 3, height: 22, position: 'relative', border: '1px solid var(--border)', overflow: 'hidden' }}>
              <div style={{
                position: 'absolute', top: 0, left: 0,
                width: `${Math.max(wpct, s.sessionsReaching > 0 ? 2 : 0)}%`, height: '100%',
                background: isBumpTo ? 'var(--accent-red)' : 'var(--accent-blue)', opacity: isBumpTo ? 0.85 : 0.6,
                borderRadius: 3, transition: 'width 0.3s',
              }} />
              {/* count sits over the track (always legible regardless of fill width) */}
              <span style={{ position: 'absolute', left: 8, top: 0, lineHeight: '22px', fontSize: 11, color: 'var(--text-primary)', fontWeight: 600 }}>
                {num(s.sessionsReaching)}
              </span>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' }}>{pct(s.cumulativeConversionPct)}</span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right' }}>
              {s.order === 0 ? 'entry' : (
                <>{pct(s.stepConversionPct)}{' · '}
                  <span style={{ color: isBumpTo ? 'var(--accent-red)' : 'var(--text-muted)', fontWeight: isBumpTo ? 700 : 400 }}>−{pct(s.stepDropoffPct)}</span>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

const WINDOWS = [30, 90, 180];

export default function AnalyticsPanel() {
  const [sinceDays, setSinceDays] = useState(30);
  const [data, setData] = useState<FunnelAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      const body = await api<{ success: boolean; data: FunnelAnalytics }>(`/analytics/insights?sinceDays=${days}`);
      setData(body.data);
    } catch (e) {
      setError((e as Error).message || 'Failed to load analytics');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(sinceDays); }, [sinceDays, load]);

  const m = data?.metrics;
  const hasData = !!data && data.totalSessions > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>Window:</span>
        {WINDOWS.map((w) => (
          <button key={w} className={`nav-tab${sinceDays === w ? ' active' : ''}`} onClick={() => setSinceDays(w)} style={{ padding: '4px 12px', fontSize: 11 }}>
            {w}d
          </button>
        ))}
        <button className="nav-tab" onClick={() => load(sinceDays)} disabled={loading} style={{ padding: '4px 12px', fontSize: 11, marginLeft: 'auto' }}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ ...card, borderColor: 'var(--accent-red)', color: 'var(--accent-red)', fontSize: 12 }}>
          Analytics unavailable: {error}
        </div>
      )}

      {!error && loading && !data && (
        <div style={{ ...card, color: 'var(--text-muted)', fontSize: 12 }}>Loading funnel analytics…</div>
      )}

      {!error && data && !hasData && (
        <div style={{ ...card, color: 'var(--text-muted)', fontSize: 12 }}>
          No funnel events in the last {data.sinceDays} days yet. Once visitors hit the instrumented pages, the funnel will populate here.
        </div>
      )}

      {!error && data && hasData && m && (
        <>
          {/* KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <div style={card}>
              <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>Sessions ({data.sinceDays}d)</div>
              <div style={{ color: 'var(--text-primary)', fontSize: 26, marginTop: 4 }}>{num(data.totalSessions)}</div>
            </div>
            <div style={card}>
              <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>Overall conversion</div>
              <div style={{ color: 'var(--accent-green)', fontSize: 26, marginTop: 4 }}>{pct(m.overallConversionPct)}</div>
              <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>landing → premium</div>
            </div>
            <div style={{ ...card, borderColor: m.biggestDrop ? 'var(--accent-red)' : 'var(--border)' }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase' }}>Biggest drop-off</div>
              {m.biggestDrop ? (
                <>
                  <div style={{ color: 'var(--accent-red)', fontSize: 15, marginTop: 4 }}>−{pct(m.biggestDrop.dropoffPct)}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 10 }}>
                    {label(m.biggestDrop.fromStage)} → {label(m.biggestDrop.toStage)} ({num(m.biggestDrop.sessionsLost)} lost)
                  </div>
                </>
              ) : <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>—</div>}
            </div>
          </div>

          {/* Milestones */}
          <div style={card}>
            <h3 style={heading}>Key conversion milestones</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              {m.milestones.map((ml) => (
                <div key={ml.key}>
                  <div style={{ color: 'var(--accent-blue)', fontSize: 20 }}>{pct(ml.ratePct)}</div>
                  <div style={{ color: 'var(--text-secondary)', fontSize: 10 }}>{ml.label}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>{num(ml.toSessions)} / {num(ml.fromSessions)}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Funnel */}
          <div style={card}>
            <h3 style={heading}>Funnel — sessions reaching each stage (cumulative % of entry · step drop-off)</h3>
            <FunnelBars steps={m.steps} entry={m.entrySessions} bump={m.biggestDrop} />
          </div>

          {/* Sources */}
          <div style={card}>
            <h3 style={heading}>Traffic sources (by session volume)</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
                    <th style={{ padding: '4px 8px' }}>Source</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right' }}>Sessions</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right' }}>Signups</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right' }}>Signup %</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right' }}>Premium</th>
                    <th style={{ padding: '4px 8px', textAlign: 'right' }}>Premium %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sources.map((s) => (
                    <tr key={s.source} style={{ borderTop: '1px solid var(--border)', color: 'var(--text-secondary)' }}>
                      <td style={{ padding: '4px 8px', color: 'var(--text-primary)' }}>{s.source}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>{num(s.sessions)}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>{num(s.signups)}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--accent-blue)' }}>{pct(s.signupRatePct)}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right' }}>{num(s.premium)}</td>
                      <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--accent-green)' }}>{pct(s.premiumRatePct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Trend */}
          <div style={card}>
            <h3 style={heading}>Daily trend</h3>
            <TrendChart trend={data.trend} />
          </div>

          <div style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
            Aggregate + anonymous (session counts only, no personal data). Generated {data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—'}.
          </div>
        </>
      )}
    </div>
  );
}
