import { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';

// ─── API (self-contained; mirrors App.tsx / AnalyticsPanel auth) ──────────────
// Supports GET + POST (provision/revoke) — the analytics panel is GET-only, so
// this keeps its own transport rather than sharing an inappropriate helper.

const API_BASE = '/admin/api';
const getToken = (): string | null => sessionStorage.getItem('admin_token');

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
  if (!res.ok || (body && body.success === false)) {
    throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  }
  return body as T;
}

// ─── Types (mirror mirror-server controllers/demoAccountController) ───────────

interface DemoAccount {
  userId: number;
  username: string;
  email: string;
  label: string | null;
  createdBy: string | null;
  createdAt: string;
  userExists?: boolean;
}
interface ProvisionedDemo extends DemoAccount {
  password: string;
  loginUrl: string;
}

// ─── Presentation helpers ─────────────────────────────────────────────────────

const card: CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 6,
  padding: 16, fontFamily: 'var(--font-mono)', marginBottom: 16,
};
const heading: CSSProperties = {
  color: 'var(--text-primary)', fontSize: 12, letterSpacing: '0.5px',
  textTransform: 'uppercase', margin: '0 0 12px',
};

// Copy-to-clipboard button that flashes "copied" on success. Falls back
// silently if the Clipboard API is unavailable (older browser / non-secure ctx).
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard unavailable — the value is selectable inline */ }
  }, [value]);
  return (
    <button
      onClick={copy}
      style={{
        background: 'none', border: '1px solid var(--border)', borderRadius: 3,
        color: copied ? 'var(--accent-green)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-mono)', fontSize: 10, padding: '2px 8px',
        cursor: 'pointer', marginLeft: 8,
      }}
    >{copied ? 'copied ✓' : 'copy'}</button>
  );
}

function CredRow({ label: lbl, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 0' }}>
      <span style={{ color: 'var(--text-muted)', width: 84, flexShrink: 0 }}>{lbl}</span>
      <span style={{ color: 'var(--accent-white, #fff)', userSelect: 'all', wordBreak: 'break-all' }}>{value}</span>
      <CopyButton value={value} />
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export default function DemoPanel() {
  const [accounts, setAccounts] = useState<DemoAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [label, setLabel] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState('');
  // The most recently provisioned account — credentials are shown ONCE here.
  const [justCreated, setJustCreated] = useState<ProvisionedDemo | null>(null);
  const [revoking, setRevoking] = useState<number | null>(null);

  const refresh = useCallback(() => {
    setListError('');
    api<{ success: boolean; data: DemoAccount[] }>('/demo/list')
      .then(d => { setAccounts(d.data || []); setLoading(false); })
      .catch(e => { setListError((e as Error).message); setLoading(false); });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const provision = useCallback(async () => {
    setProvisioning(true);
    setProvisionError('');
    setJustCreated(null);
    try {
      const d = await api<{ success: boolean; data: ProvisionedDemo }>('/demo/provision', {
        method: 'POST',
        body: JSON.stringify({ label: label.trim() || undefined }),
      });
      setJustCreated(d.data);
      setLabel('');
    } catch (e) {
      setProvisionError((e as Error).message || 'Provisioning failed');
    } finally {
      setProvisioning(false);
      refresh();
    }
  }, [label, refresh]);

  const revoke = useCallback(async (acct: DemoAccount) => {
    const ok = window.confirm(
      `Revoke demo account "${acct.username}" (${acct.email})?\n\n` +
      `This permanently deletes the user and all their data. This cannot be undone.`,
    );
    if (!ok) return;
    setRevoking(acct.userId);
    try {
      await api('/demo/revoke', { method: 'POST', body: JSON.stringify({ userId: acct.userId }) });
      // If the just-created card is for this account, clear it too.
      setJustCreated(jc => (jc && jc.userId === acct.userId ? null : jc));
    } catch (e) {
      window.alert(`Revoke failed: ${(e as Error).message}`);
    } finally {
      setRevoking(null);
      refresh();
    }
  }, [refresh]);

  return (
    <>
      {/* Provisioner */}
      <div style={card}>
        <h3 style={heading}>Provision Demo Account</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px', fontFamily: 'system-ui, sans-serif' }}>
          Mints a <strong>real, persistent, premium</strong> account you can hand to an interested
          client's testers. The account is email pre-verified (logs in immediately) and has
          premium enabled indefinitely. Credentials are shown <strong>once</strong>, right after
          creation — copy them then, they are never stored or logged in plaintext.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            disabled={provisioning}
            maxLength={120}
            placeholder="label (optional) — e.g. Acme Corp trial"
            style={{
              fontFamily: 'var(--font-mono)', fontSize: 13, padding: '8px 10px',
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              color: 'var(--text-primary)', borderRadius: 3, minWidth: 260, flex: 1,
            }}
          />
          <button
            className="nav-tab"
            onClick={provision}
            disabled={provisioning}
            style={{
              padding: '8px 18px', border: '1px solid var(--accent-green)', borderRadius: 4,
              color: provisioning ? 'var(--text-muted)' : 'var(--accent-green)',
              opacity: provisioning ? 0.6 : 1, cursor: provisioning ? 'default' : 'pointer',
            }}
          >{provisioning ? 'Provisioning…' : 'Provision demo account'}</button>
        </div>

        {provisionError && (
          <div style={{ color: 'var(--accent-red)', fontSize: 12, marginTop: 10, fontFamily: 'var(--font-mono)' }}>
            {provisionError}
          </div>
        )}

        {justCreated && (
          <div style={{ ...card, borderColor: 'var(--accent-yellow)', marginTop: 14, marginBottom: 0 }}>
            <div style={{ ...heading, color: 'var(--accent-yellow)' }}>
              New demo account — copy these credentials now
            </div>
            <div style={{ fontSize: 13, display: 'grid', gap: 2 }}>
              <CredRow label="login URL" value={justCreated.loginUrl} />
              <CredRow label="email" value={justCreated.email} />
              <CredRow label="username" value={justCreated.username} />
              <CredRow label="password" value={justCreated.password} />
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: 11, margin: '10px 0 0' }}>
              Shown here only — the password is never stored or logged. If you lose it, revoke
              this account and provision a new one. Premium is active immediately.
            </p>
          </div>
        )}
      </div>

      {/* Registry */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ ...heading, margin: 0 }}>Demo Accounts</h3>
          <button
            onClick={refresh}
            style={{
              background: 'none', border: '1px solid var(--border)', borderRadius: 3,
              color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 11,
              padding: '4px 10px', cursor: 'pointer',
            }}
          >Refresh</button>
        </div>

        {loading ? (
          <div className="pulse" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Loading…</div>
        ) : listError ? (
          <div style={{ color: 'var(--accent-red)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>{listError}</div>
        ) : accounts.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13, fontFamily: 'system-ui, sans-serif' }}>
            No demo accounts yet. Provision one above.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="process-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Label</th>
                  <th>Created by</th>
                  <th>Created</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(a => (
                  <tr key={a.userId}>
                    <td style={{ userSelect: 'all' }}>{a.username}</td>
                    <td style={{ userSelect: 'all' }}>{a.email}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{a.label || '—'}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{a.createdBy || '—'}</td>
                    <td style={{ color: 'var(--text-muted)', fontSize: 12 }}>{new Date(a.createdAt).toLocaleString()}</td>
                    <td style={{ color: a.userExists === false ? 'var(--accent-yellow)' : 'var(--accent-green)' }}>
                      {a.userExists === false ? 'user gone' : 'active'}
                    </td>
                    <td>
                      <button
                        onClick={() => revoke(a)}
                        disabled={revoking === a.userId}
                        style={{
                          background: 'none', border: '1px solid var(--accent-red)', borderRadius: 3,
                          color: 'var(--accent-red)', fontFamily: 'var(--font-mono)', fontSize: 11,
                          padding: '4px 10px', cursor: revoking === a.userId ? 'default' : 'pointer',
                          opacity: revoking === a.userId ? 0.6 : 1,
                        }}
                      >{revoking === a.userId ? 'Revoking…' : 'Revoke'}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
