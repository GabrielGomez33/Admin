import { useState, useEffect, useCallback, useRef } from 'react';

// ─── API (self-contained; mirrors App.tsx auth) ───────────────────────────────

const API_BASE = '/admin/api';

function getToken(): string | null {
  return sessionStorage.getItem('admin_token');
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
    sessionStorage.removeItem('admin_token');
    window.location.reload();
    throw new Error('Session expired');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((body as { error?: string }).error || `Request failed (${res.status})`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body as T;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

type BlockType = 'heading' | 'paragraph' | 'button' | 'image' | 'divider';

interface Block {
  type: BlockType;
  text?: string;
  url?: string;
  alt?: string;
}

interface Attachment {
  filename: string;
  content: string; // base64 (no data: prefix)
  contentType?: string;
}

type AudienceMode = 'all' | 'filter' | 'specific';
type AudienceSource = 'users' | 'waitlist';

interface AudienceFilter {
  /** Which population this campaign targets. Absent = 'users' (back-compat). */
  source?: AudienceSource;
  mode: AudienceMode;
  // users-source selectors
  verifiedOnly?: boolean;
  intakeCompleted?: boolean;
  role?: string | null;
  registeredAfter?: string;
  registeredBefore?: string;
  activeSince?: string;
  excludeLocked?: boolean;
  userIds?: number[];
  // waitlist-source selectors
  waitlistStatuses?: string[];
  waitlistSource?: string | null;
}

// Waitlist lifecycle statuses eligible to receive an invitation campaign.
const WAITLIST_SUBSCRIBABLE = ['pending', 'confirmed', 'invited'];

interface WaitlistData {
  total: number;
  counts: Record<string, number>;
  rows: { id: number; email: string; source: string; status: string; created_at: string }[];
}

interface UserHit {
  id: number;
  username: string;
  email: string;
  email_verified?: number;
}

interface Campaign {
  id: number;
  title: string;
  subject: string;
  status: string;
  scheduled_at: string | null;
  created_by: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  dry_run: number;
  created_at: string;
  completed_at: string | null;
  last_error: string | null;
}

interface AudiencePreview {
  total: number;
  suppressed: number;
  sample: { username: string; email: string }[];
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const NEW_BLOCK: Record<BlockType, Block> = {
  heading: { type: 'heading', text: '' },
  paragraph: { type: 'paragraph', text: '' },
  button: { type: 'button', text: '', url: '' },
  image: { type: 'image', url: '', alt: '' },
  divider: { type: 'divider' },
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: 'var(--bg-primary)',
  border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text-primary)',
  fontFamily: 'var(--font-sans)', fontSize: 13, outline: 'none',
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontFamily: 'var(--font-mono)', fontSize: 11,
  textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', marginBottom: 6,
};
const smallBtn: React.CSSProperties = {
  background: 'none', border: '1px solid var(--border)', borderRadius: 3,
  color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11,
  padding: '4px 10px', cursor: 'pointer',
};

// ─── Block editor ────────────────────────────────────────────────────────────

function BlockEditor({ blocks, onChange }: { blocks: Block[]; onChange: (b: Block[]) => void }) {
  const update = (i: number, patch: Partial<Block>) => {
    const next = blocks.map((b, idx) => (idx === i ? { ...b, ...patch } : b));
    onChange(next);
  };
  const remove = (i: number) => onChange(blocks.filter((_, idx) => idx !== i));
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const add = (type: BlockType) => onChange([...blocks, { ...NEW_BLOCK[type] }]);

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {blocks.map((b, i) => (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 4, padding: 10, background: 'var(--bg-primary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--accent-blue)', textTransform: 'uppercase', letterSpacing: 1 }}>{b.type}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                <button style={smallBtn} onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                <button style={smallBtn} onClick={() => move(i, 1)} disabled={i === blocks.length - 1}>↓</button>
                <button style={{ ...smallBtn, color: 'var(--accent-red)' }} onClick={() => remove(i)}>✕</button>
              </div>
            </div>
            {(b.type === 'heading' || b.type === 'paragraph') && (
              <textarea
                value={b.text || ''}
                onChange={e => update(i, { text: e.target.value })}
                placeholder={b.type === 'heading' ? 'Heading text' : 'Paragraph text — supports {{username}} and {{email}}'}
                rows={b.type === 'heading' ? 1 : 3}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            )}
            {b.type === 'button' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={b.text || ''} onChange={e => update(i, { text: e.target.value })} placeholder="Button label" style={inputStyle} />
                <input value={b.url || ''} onChange={e => update(i, { url: e.target.value })} placeholder="https://..." style={inputStyle} />
              </div>
            )}
            {b.type === 'image' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={b.url || ''} onChange={e => update(i, { url: e.target.value })} placeholder="Image URL (https://...)" style={inputStyle} />
                <input value={b.alt || ''} onChange={e => update(i, { alt: e.target.value })} placeholder="Alt text" style={inputStyle} />
              </div>
            )}
            {b.type === 'divider' && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>— horizontal rule —</div>
            )}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        {(['heading', 'paragraph', 'button', 'image', 'divider'] as BlockType[]).map(t => (
          <button key={t} style={smallBtn} onClick={() => add(t)}>+ {t}</button>
        ))}
      </div>
    </div>
  );
}

// ─── Audience selector ─────────────────────────────────────────────────────────

function AudienceSelector({ audience, onChange }: { audience: AudienceFilter; onChange: (a: AudienceFilter) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<UserHit[]>([]);
  const [selected, setSelected] = useState<UserHit[]>([]);
  const [waitlist, setWaitlist] = useState<WaitlistData | null>(null);
  const set = (patch: Partial<AudienceFilter>) => onChange({ ...audience, ...patch });
  const source: AudienceSource = audience.source === 'waitlist' ? 'waitlist' : 'users';

  const search = useCallback(async (q: string) => {
    if (q.trim().length < 2) { setHits([]); return; }
    try {
      const data = await api<{ users: UserHit[] }>(`/email/users/search?q=${encodeURIComponent(q)}`);
      setHits(data.users || []);
    } catch { setHits([]); }
  }, []);

  useEffect(() => {
    const id = setTimeout(() => search(query), 350);
    return () => clearTimeout(id);
  }, [query, search]);

  // Load waitlist composition (counts + a few recent rows) when that source is
  // active, so the operator can see who they're about to invite.
  useEffect(() => {
    if (source !== 'waitlist') return;
    let cancelled = false;
    api<WaitlistData & { success: boolean }>('/email/waitlist?limit=8')
      .then(d => { if (!cancelled) setWaitlist({ total: d.total, counts: d.counts, rows: d.rows }); })
      .catch(() => { if (!cancelled) setWaitlist(null); });
    return () => { cancelled = true; };
  }, [source]);

  const addUser = (u: UserHit) => {
    if (selected.some(s => s.id === u.id)) return;
    const next = [...selected, u];
    setSelected(next);
    set({ userIds: next.map(s => s.id) });
  };
  const removeUser = (id: number) => {
    const next = selected.filter(s => s.id !== id);
    setSelected(next);
    set({ userIds: next.map(s => s.id) });
  };

  // Switching source resets to that source's safe defaults so stale user-only
  // or waitlist-only selectors never leak across.
  const switchSource = (s: AudienceSource) => {
    if (s === source) return;
    if (s === 'waitlist') onChange({ source: 'waitlist', mode: 'all', waitlistStatuses: [...WAITLIST_SUBSCRIBABLE] });
    else onChange({ source: 'users', mode: 'all', verifiedOnly: true, excludeLocked: true });
  };

  const activeStatuses = Array.isArray(audience.waitlistStatuses) && audience.waitlistStatuses.length
    ? audience.waitlistStatuses
    : WAITLIST_SUBSCRIBABLE;
  const toggleStatus = (st: string) => {
    const next = activeStatuses.includes(st)
      ? activeStatuses.filter(x => x !== st)
      : [...activeStatuses, st];
    set({ waitlistStatuses: next });
  };

  return (
    <div>
      {/* Source toggle — registered users vs the marketing waitlist. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {(['users', 'waitlist'] as AudienceSource[]).map(s => (
          <button
            key={s}
            className={`nav-tab${source === s ? ' active' : ''}`}
            style={{ padding: '4px 14px', fontSize: 11 }}
            onClick={() => switchSource(s)}
          >{s === 'users' ? 'Registered users' : 'Waitlist'}</button>
        ))}
      </div>

      {source === 'waitlist' ? (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.6 }}>
            These are people who joined the <strong style={{ color: 'var(--text-secondary)' }}>waitlist</strong> — not account holders.
            They receive an invitation, and their footer accurately says "you joined the Mirror waitlist."
            Unsubscribed &amp; already-converted signups are never included.
          </div>

          <label style={labelStyle}>Include statuses</label>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 14 }}>
            {WAITLIST_SUBSCRIBABLE.map(st => (
              <label key={st} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={activeStatuses.includes(st)} onChange={() => toggleStatus(st)} />
                {st}{waitlist ? <span style={{ color: 'var(--text-muted)' }}> ({waitlist.counts[st] || 0})</span> : null}
              </label>
            ))}
          </div>

          <label style={labelStyle}>Signup source (optional)</label>
          <input
            style={inputStyle}
            value={audience.waitlistSource || ''}
            placeholder="e.g. landing (blank = any)"
            onChange={e => set({ waitlistSource: e.target.value || null })}
          />

          {waitlist && (
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
              <strong style={{ color: 'var(--text-secondary)' }}>{waitlist.total}</strong> total on the waitlist
              {waitlist.rows.length > 0 && <> · recent: {waitlist.rows.slice(0, 5).map(r => r.email).join(', ')}</>}
            </div>
          )}
        </div>
      ) : (
      <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['all', 'filter', 'specific'] as AudienceMode[]).map(m => (
          <button
            key={m}
            className={`nav-tab${audience.mode === m ? ' active' : ''}`}
            style={{ padding: '4px 12px', fontSize: 11 }}
            onClick={() => set({ mode: m })}
          >{m === 'all' ? 'All users' : m === 'filter' ? 'Filtered' : 'Specific users'}</button>
        ))}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={audience.verifiedOnly !== false} onChange={e => set({ verifiedOnly: e.target.checked })} />
        Verified emails only (recommended)
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={audience.excludeLocked !== false} onChange={e => set({ excludeLocked: e.target.checked })} />
        Exclude locked accounts
      </label>

      {audience.mode === 'filter' && (
        <div className="grid grid-2" style={{ marginTop: 8 }}>
          <div>
            <label style={labelStyle}>Intake completed</label>
            <select
              style={inputStyle}
              value={audience.intakeCompleted === undefined ? '' : audience.intakeCompleted ? 'yes' : 'no'}
              onChange={e => set({ intakeCompleted: e.target.value === '' ? undefined : e.target.value === 'yes' })}
            >
              <option value="">Any</option>
              <option value="yes">Completed</option>
              <option value="no">Not completed</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <input style={inputStyle} value={audience.role || ''} placeholder="e.g. admin (blank = any)" onChange={e => set({ role: e.target.value || null })} />
          </div>
          <div>
            <label style={labelStyle}>Registered after</label>
            <input style={inputStyle} type="date" value={audience.registeredAfter || ''} onChange={e => set({ registeredAfter: e.target.value || undefined })} />
          </div>
          <div>
            <label style={labelStyle}>Registered before</label>
            <input style={inputStyle} type="date" value={audience.registeredBefore || ''} onChange={e => set({ registeredBefore: e.target.value || undefined })} />
          </div>
          <div>
            <label style={labelStyle}>Active since (last login)</label>
            <input style={inputStyle} type="date" value={audience.activeSince || ''} onChange={e => set({ activeSince: e.target.value || undefined })} />
          </div>
        </div>
      )}

      {audience.mode === 'specific' && (
        <div style={{ marginTop: 8 }}>
          <label style={labelStyle}>Search users</label>
          <input style={inputStyle} value={query} placeholder="username or email (min 2 chars)" onChange={e => setQuery(e.target.value)} />
          {hits.length > 0 && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 3, marginTop: 4, maxHeight: 160, overflowY: 'auto' }}>
              {hits.map(u => (
                <div key={u.id} onClick={() => addUser(u)} style={{ padding: '6px 10px', cursor: 'pointer', fontSize: 12, borderBottom: '1px solid var(--border)' }}>
                  {u.username} <span style={{ color: 'var(--text-muted)' }}>· {u.email}{u.email_verified ? '' : ' (unverified)'}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {selected.map(u => (
              <span key={u.id} style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 10px', fontSize: 12 }}>
                {u.username} <span style={{ cursor: 'pointer', color: 'var(--accent-red)' }} onClick={() => removeUser(u.id)}>✕</span>
              </span>
            ))}
            {selected.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>No users selected yet.</span>}
          </div>
        </div>
      )}
      </div>
      )}
    </div>
  );
}

// ─── Confirm modal ─────────────────────────────────────────────────────────────

function ConfirmModal({ recipients, onCancel, onConfirm }: { recipients: number; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState('');
  const expected = String(recipients);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="card" style={{ width: 420 }}>
        <div className="card-header"><span className="card-title">Confirm large send</span></div>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.6 }}>
          You're about to email <strong style={{ color: 'var(--accent-white)' }}>{recipients}</strong> recipients.
          Type the recipient count <strong>{expected}</strong> below to confirm.
        </p>
        <input style={{ ...inputStyle, marginTop: 8 }} value={typed} onChange={e => setTyped(e.target.value)} placeholder={expected} autoFocus />
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button style={{ ...smallBtn, flex: 1 }} onClick={onCancel}>Cancel</button>
          <button
            style={{ ...smallBtn, flex: 1, background: 'var(--accent-red)', color: '#fff', borderColor: 'var(--accent-red)', opacity: typed === expected ? 1 : 0.4 }}
            disabled={typed !== expected}
            onClick={onConfirm}
          >Send to {recipients}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Campaign history ──────────────────────────────────────────────────────────

function statusColor(s: string): string {
  if (s === 'sent') return 'var(--accent-green)';
  if (s === 'sending' || s === 'scheduled') return 'var(--accent-yellow)';
  if (s === 'failed') return 'var(--accent-red)';
  return 'var(--text-muted)';
}

function CampaignHistory({ refreshKey }: { refreshKey: number }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<{ campaigns: Campaign[] }>('/email/campaigns').then(d => setCampaigns(d.campaigns || [])).catch(() => {});
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, [load, refreshKey]);

  const cancel = async (id: number) => {
    setMsg('');
    try { await api(`/email/campaigns/${id}/cancel`, { method: 'POST' }); load(); }
    catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Campaign History</span>
        <button style={smallBtn} onClick={load}>Refresh</button>
      </div>
      {msg && <div className="error-msg" style={{ textAlign: 'left' }}>{msg}</div>}
      <div className="table-wrap">
        <table className="process-table">
          <thead>
            <tr><th>Title</th><th>Status</th><th>Recipients</th><th>Sent</th><th>Failed</th><th>Skipped</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            {campaigns.length === 0 && <tr><td colSpan={8} style={{ color: 'var(--text-muted)' }}>No campaigns yet.</td></tr>}
            {campaigns.map(c => (
              <tr key={c.id}>
                <td>{c.title}{c.dry_run ? <span style={{ color: 'var(--accent-blue)', fontSize: 10 }}> [dry]</span> : null}</td>
                <td style={{ color: statusColor(c.status) }}>{c.status}{c.scheduled_at && c.status === 'scheduled' ? ` (${new Date(c.scheduled_at).toLocaleString()})` : ''}</td>
                <td>{c.total_recipients}</td>
                <td style={{ color: 'var(--accent-green)' }}>{c.sent_count}</td>
                <td style={{ color: c.failed_count > 0 ? 'var(--accent-red)' : 'var(--text-muted)' }}>{c.failed_count}</td>
                <td style={{ color: 'var(--text-muted)' }}>{c.skipped_count}</td>
                <td style={{ color: 'var(--text-muted)', fontSize: 11 }}>{new Date(c.created_at).toLocaleString()}</td>
                <td>{(c.status === 'draft' || c.status === 'scheduled') && <button style={{ ...smallBtn, color: 'var(--accent-red)' }} onClick={() => cancel(c.id)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export default function EmailPanel() {
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([{ type: 'heading', text: '' }, { type: 'paragraph', text: '' }]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [audience, setAudience] = useState<AudienceFilter>({ mode: 'all', verifiedOnly: true, excludeLocked: true });
  const [dryRun, setDryRun] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<'now' | 'schedule'>('now');
  const [scheduledAt, setScheduledAt] = useState('');

  const [previewHtml, setPreviewHtml] = useState('');
  const [audiencePreview, setAudiencePreview] = useState<AudiencePreview | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const pendingSend = useRef<(() => Promise<void>) | null>(null);

  // Debounced live preview.
  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        const data = await api<{ html: string }>('/email/preview', {
          // Send the audience so the footer/consent line matches the target
          // (waitlist invitation vs account holder) — not a users-only preview.
          method: 'POST', body: JSON.stringify({ subject, blocks, audience }),
        });
        setPreviewHtml(data.html);
      } catch { /* preview is best-effort */ }
    }, 500);
    return () => clearTimeout(id);
  }, [subject, blocks, audience]);

  // Live recipient preview — auto-refreshes (debounced) whenever the audience
  // changes, so the operator always sees exactly who the email will go to
  // without clicking anything. Asks for a real list (up to 50), not 5 names.
  useEffect(() => {
    const id = setTimeout(async () => {
      try {
        const data = await api<AudiencePreview & { success: boolean }>('/email/preview-audience', {
          method: 'POST', body: JSON.stringify({ audience, sampleLimit: 50 }),
        });
        setAudiencePreview({ total: data.total, suppressed: data.suppressed, sample: data.sample });
      } catch { setAudiencePreview(null); }
    }, 500);
    return () => clearTimeout(id);
  }, [audience]);

  const flash = (kind: 'ok' | 'err', text: string) => { setMsg({ kind, text }); setTimeout(() => setMsg(null), 6000); };

  const onFile = async (file: File) => {
    const total = attachments.reduce((s, a) => s + (a.content.length * 3) / 4, 0) + file.size;
    if (total > MAX_ATTACHMENT_BYTES) { flash('err', 'Attachments exceed 5MB limit'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      setAttachments(a => [...a, { filename: file.name, content: base64, contentType: file.type || undefined }]);
    };
    reader.readAsDataURL(file);
  };

  const sendTest = async () => {
    if (!testEmail) { flash('err', 'Enter a test email address'); return; }
    setBusy(true); setMsg(null);
    try {
      await api('/email/test', { method: 'POST', body: JSON.stringify({ title, subject, blocks, attachments, dryRun, testEmail, audience }) });
      flash('ok', `Test sent to ${testEmail}`);
    } catch (e) { flash('err', (e as Error).message); }
    finally { setBusy(false); }
  };

  const submit = async (action: 'draft' | 'send' | 'schedule', confirmation?: { confirmed: boolean; acknowledgedRecipients: number }) => {
    setBusy(true); setMsg(null);
    const payload: any = { title, subject, blocks, attachments, audience, dryRun, action };
    if (action === 'schedule') payload.scheduledAt = new Date(scheduledAt).toISOString();
    if (confirmation) { payload.confirmed = confirmation.confirmed; payload.acknowledgedRecipients = confirmation.acknowledgedRecipients; }
    try {
      const res = await api<{ campaignId: number; action: string }>('/email/campaigns', { method: 'POST', body: JSON.stringify(payload) });
      flash('ok', action === 'draft' ? `Draft saved (#${res.campaignId})` : action === 'schedule' ? `Scheduled (#${res.campaignId})` : `Sending started (#${res.campaignId})`);
      setRefreshKey(k => k + 1);
    } catch (e) {
      const body = (e as any).body;
      if ((e as any).status === 412 && body?.requiresConfirmation) {
        // Stash the retry and open the confirm modal.
        pendingSend.current = () => submit(action, { confirmed: true, acknowledgedRecipients: body.recipients });
        setConfirm(body.recipients);
      } else {
        flash('err', (e as Error).message);
      }
    } finally { setBusy(false); }
  };

  const onAction = (action: 'draft' | 'send' | 'schedule') => {
    if (action === 'schedule' && !scheduledAt) { flash('err', 'Pick a date/time to schedule'); return; }
    submit(action);
  };

  return (
    <>
      {confirm !== null && (
        <ConfirmModal
          recipients={confirm}
          onCancel={() => { setConfirm(null); pendingSend.current = null; }}
          onConfirm={async () => { const fn = pendingSend.current; setConfirm(null); pendingSend.current = null; if (fn) await fn(); }}
        />
      )}

      <div className="grid grid-2" style={{ marginBottom: 16, alignItems: 'start' }}>
        {/* ── Composer ── */}
        <div className="card">
          <div className="card-header"><span className="card-title">Compose</span></div>

          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Campaign title (internal)</label>
            <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. March product update" />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Subject line</label>
            <input style={inputStyle} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject — supports {{username}}" />
          </div>

          <label style={labelStyle}>Content blocks</label>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Merge tags: <code>{'{{username}}'}</code>, <code>{'{{email}}'}</code>. An unsubscribe link + footer are added automatically.
          </div>
          <BlockEditor blocks={blocks} onChange={setBlocks} />

          <div style={{ marginTop: 16 }}>
            <label style={labelStyle}>Attachments (optional, max 5MB total)</label>
            <input type="file" onChange={e => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }} style={{ fontSize: 12, color: 'var(--text-secondary)' }} />
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              Attached files are sent with the email — they don't appear in the body preview. To show an image inside the email, add an <strong>image block</strong> with its URL.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {attachments.map((a, i) => {
                const kb = Math.max(1, Math.round((a.content.length * 3 / 4) / 1024));
                return (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--bg-hover)', border: '1px solid var(--border)', borderRadius: 3, padding: '3px 8px', fontSize: 11 }}>
                    <span style={{ color: 'var(--accent-green)', fontWeight: 700 }}>✓</span>
                    <span style={{ color: 'var(--text-primary)' }}>{a.filename}</span>
                    <span style={{ color: 'var(--text-muted)' }}>· {kb} KB · attached</span>
                    <button
                      title="Remove attachment"
                      onClick={() => setAttachments(att => att.filter((_, idx) => idx !== i))}
                      style={{ marginLeft: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-red)', fontSize: 11, padding: 0 }}
                    >remove</button>
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── Live preview ── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Live Preview</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-muted)' }}>{subject || '(no subject)'}</span>
          </div>
          <iframe
            title="email-preview"
            sandbox=""
            srcDoc={previewHtml || '<div style="color:#666;font-family:sans-serif;padding:20px;">Start composing to see a preview…</div>'}
            style={{ width: '100%', height: 480, border: '1px solid var(--border)', borderRadius: 4, background: '#0a0a0f' }}
          />
        </div>
      </div>

      {/* ── Audience ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header"><span className="card-title">Audience</span></div>
        <AudienceSelector audience={audience} onChange={setAudience} />

        {/* Live recipient list — updates automatically as filters change. */}
        <div style={{ marginTop: 14 }}>
          {audiencePreview ? (
            <>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                <strong style={{ color: 'var(--accent-green)' }}>{Math.max(0, audiencePreview.total - audiencePreview.suppressed)}</strong> will receive this
                {audiencePreview.suppressed > 0 && <span style={{ color: 'var(--text-muted)' }}> · {audiencePreview.suppressed} suppressed (won't send)</span>}
                {audiencePreview.total > audiencePreview.sample.length && <span style={{ color: 'var(--text-muted)' }}> · showing {audiencePreview.sample.length} of {audiencePreview.total}</span>}
              </div>
              <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-primary)' }}>
                {audiencePreview.sample.length === 0 ? (
                  <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>No recipients match this audience.</div>
                ) : audiencePreview.sample.map((r, i) => (
                  <div
                    key={r.email + i}
                    style={{
                      display: 'flex', justifyContent: 'space-between', gap: 12,
                      padding: '6px 12px', fontSize: 12,
                      borderBottom: i < audiencePreview.sample.length - 1 ? '1px solid var(--border)' : 'none',
                      background: i % 2 ? 'transparent' : 'var(--bg-hover)',
                    }}
                  >
                    <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.username}</span>
                    <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.email}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Adjust the audience to see who this goes to…</span>
          )}
        </div>
      </div>

      {/* ── Send controls ── */}
      <div className="card">
        <div className="card-header"><span className="card-title">Send</span></div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
          Dry run (compose &amp; record, but don't actually deliver)
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          <div style={{ flex: '1 1 240px' }}>
            <label style={labelStyle}>Send a test to</label>
            <input style={inputStyle} value={testEmail} onChange={e => setTestEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <button style={smallBtn} onClick={sendTest} disabled={busy}>Send test</button>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          {(['now', 'schedule'] as const).map(m => (
            <button key={m} className={`nav-tab${scheduleMode === m ? ' active' : ''}`} style={{ padding: '4px 12px', fontSize: 11 }} onClick={() => setScheduleMode(m)}>
              {m === 'now' ? 'Send now' : 'Schedule'}
            </button>
          ))}
          {scheduleMode === 'schedule' && (
            <input style={{ ...inputStyle, width: 'auto' }} type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} />
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button style={smallBtn} onClick={() => onAction('draft')} disabled={busy}>Save draft</button>
          {scheduleMode === 'schedule'
            ? <button className="btn" style={{ width: 'auto', padding: '8px 20px' }} onClick={() => onAction('schedule')} disabled={busy}>Schedule</button>
            : <button className="btn" style={{ width: 'auto', padding: '8px 20px' }} onClick={() => onAction('send')} disabled={busy}>{dryRun ? 'Start dry run' : 'Send now'}</button>}
        </div>

        {msg && <div className={msg.kind === 'ok' ? 'refresh-text' : 'error-msg'} style={{ textAlign: 'left', marginTop: 12, color: msg.kind === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)' }}>{msg.text}</div>}
      </div>

      <div style={{ marginTop: 16 }}>
        <CampaignHistory refreshKey={refreshKey} />
      </div>
    </>
  );
}
