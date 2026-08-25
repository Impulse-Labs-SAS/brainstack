'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authApi';
import { trpc } from '@/lib/trpc';

interface TotpStatus {
  enabled: boolean;
  remainingBackupCodes: number;
}

interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
}

export default function AccountSettingsPage() {
  const router = useRouter();
  const me = trpc.auth.me.useQuery();
  const [totpStatus, setTotpStatus] = useState<TotpStatus | null>(null);

  async function refreshTotp(): Promise<void> {
    try {
      const s = await authFetch<TotpStatus>('/auth/totp/status');
      setTotpStatus(s);
    } catch {
      setTotpStatus(null);
    }
  }

  useEffect(() => {
    void refreshTotp();
  }, []);

  const user = me.data?.user;

  return (
    <AppShell>
      <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-xs text-fg-muted">
        Settings · Account
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl space-y-8">
          <ProfileCard
            email={user?.email ?? null}
            displayName={user?.displayName ?? null}
            onSaved={() => me.refetch()}
          />

          <ChangePasswordCard hasPassword={Boolean(user?.hasPassword)} />

          <TwoFactorCard
            status={totpStatus}
            userEmail={user?.email ?? ''}
            onChanged={refreshTotp}
          />

          <GoogleCard hasGoogle={Boolean(user?.hasGoogle)} onChanged={() => me.refetch()} />

          <section>
            <h2 className="mb-2 text-base font-medium text-fg-primary">Session</h2>
            <Button
              intent="danger"
              size="sm"
              onPress={async () => {
                await authFetch('/auth/logout', { method: 'POST' });
                router.replace('/login');
              }}
            >
              Sign out
            </Button>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * Email is fixed — it identifies the account and every share is addressed to
 * it. The name is not, and until now there was nowhere to set it, so people
 * you shared a folder with saw your address and nothing else.
 */
function ProfileCard({
  email,
  displayName,
  onSaved,
}: {
  email: string | null;
  displayName: string | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(displayName ?? '');
  const [status, setStatus] = useState<{ ok?: boolean; error?: string } | null>(null);
  const update = trpc.auth.updateProfile.useMutation();

  // The query resolves after the first render, so the field has to pick the
  // name up when it lands — but only while untouched, or it would overwrite
  // what is being typed on every refetch.
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setName(displayName ?? '');
  }, [displayName, touched]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setStatus(null);
    try {
      await update.mutateAsync({ displayName: name });
      setTouched(false);
      setStatus({ ok: true });
      onSaved();
    } catch (err) {
      setStatus({ error: err instanceof Error ? err.message : 'failed' });
    }
  }

  return (
    <section>
      <h2 className="mb-2 text-base font-medium text-fg-primary">Profile</h2>
      <form
        onSubmit={submit}
        className="space-y-3 rounded border border-border bg-bg-surface p-4 text-sm"
      >
        <div>
          <label className="mb-1 block font-mono text-[11px] text-fg-muted">EMAIL</label>
          <div className="font-mono text-fg-primary">{email ?? '—'}</div>
        </div>
        <div>
          <label htmlFor="display-name" className="mb-1 block font-mono text-[11px] text-fg-muted">
            NAME
          </label>
          <Input
            id="display-name"
            value={name}
            maxLength={120}
            placeholder="Your name"
            autoComplete="name"
            onChange={(e) => {
              setTouched(true);
              setName(e.target.value);
              setStatus(null);
            }}
          />
          <p className="mt-1 text-xs text-fg-muted">
            Shown to the people you share folders with. Leave it empty to go by your email.
          </p>
        </div>
        {status?.error && <div className="text-xs text-danger">{status.error}</div>}
        {status?.ok && <div className="text-xs text-success">Profile updated.</div>}
        <Button
          intent="primary"
          type="submit"
          isDisabled={update.isPending || name.trim() === (displayName ?? '')}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </form>
    </section>
  );
}

function ChangePasswordCard({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<{ ok?: boolean; error?: string } | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setStatus(null);
    if (next !== confirm) {
      setStatus({ error: "passwords don't match" });
      return;
    }
    setPending(true);
    try {
      await authFetch('/auth/change-password', {
        method: 'POST',
        json: { currentPassword: current, newPassword: next },
      });
      setStatus({ ok: true });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setStatus({ error: err instanceof Error ? err.message : 'failed' });
    } finally {
      setPending(false);
    }
  }

  if (!hasPassword) {
    return (
      <section>
        <h2 className="mb-2 text-base font-medium text-fg-primary">Password</h2>
        <div className="rounded border border-border bg-bg-surface p-4 text-sm text-fg-secondary">
          No password is set on this account (Google sign-in only).
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-2 text-base font-medium text-fg-primary">Change password</h2>
      <form
        onSubmit={submit}
        className="space-y-3 rounded border border-border bg-bg-surface p-4 text-sm"
      >
        <div>
          <label className="mb-1 block font-mono text-[11px] text-fg-muted">CURRENT</label>
          <Input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[11px] text-fg-muted">NEW</label>
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block font-mono text-[11px] text-fg-muted">CONFIRM</label>
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        {status?.error && <div className="text-xs text-danger">{status.error}</div>}
        {status?.ok && <div className="text-xs text-success">Password updated.</div>}
        <Button intent="primary" type="submit" isDisabled={pending}>
          {pending ? 'Updating…' : 'Update'}
        </Button>
      </form>
    </section>
  );
}

function GoogleCard({ hasGoogle, onChanged }: { hasGoogle: boolean; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!hasGoogle) {
    return (
      <section>
        <h2 className="mb-2 text-base font-medium text-fg-primary">Google</h2>
        <div className="rounded border border-border bg-bg-surface p-4 text-sm text-fg-secondary">
          Google sign-in is not linked. Sign out and use &ldquo;Continue with Google&rdquo; once to
          link.
        </div>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-2 text-base font-medium text-fg-primary">Google</h2>
      <div className="rounded border border-border bg-bg-surface p-4 text-sm">
        <p className="mb-3 text-fg-secondary">Google sign-in is linked to this account.</p>
        <Button
          intent="danger"
          size="sm"
          onPress={async () => {
            setError(null);
            try {
              await authFetch('/auth/google/unlink', { method: 'POST' });
              onChanged();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'failed');
            }
          }}
        >
          Unlink Google
        </Button>
        {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      </div>
    </section>
  );
}

function TwoFactorCard({
  status,
  userEmail,
  onChanged,
}: {
  status: TotpStatus | null;
  userEmail: string;
  onChanged: () => void;
}) {
  const [enrolling, setEnrolling] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!status) {
    return (
      <section>
        <h2 className="mb-2 text-base font-medium text-fg-primary">Two-factor authentication</h2>
        <div className="rounded border border-border bg-bg-surface p-4 text-sm text-fg-muted">
          Loading…
        </div>
      </section>
    );
  }

  if (status.enabled) {
    return (
      <section>
        <h2 className="mb-2 text-base font-medium text-fg-primary">Two-factor authentication</h2>
        <div className="space-y-3 rounded border border-border bg-bg-surface p-4 text-sm">
          <p className="text-fg-secondary">
            2FA is enabled. {status.remainingBackupCodes} backup code(s) remaining.
          </p>
          <div>
            <label className="mb-1 block font-mono text-[11px] text-fg-muted">
              CODE (TOTP or backup)
            </label>
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" />
          </div>
          {error && <div className="text-xs text-danger">{error}</div>}
          <Button
            intent="danger"
            size="sm"
            isDisabled={!code}
            onPress={async () => {
              setError(null);
              try {
                await authFetch('/auth/totp/disable', { method: 'POST', json: { code } });
                setCode('');
                onChanged();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'failed');
              }
            }}
          >
            Disable 2FA
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="mb-2 text-base font-medium text-fg-primary">Two-factor authentication</h2>
      <div className="space-y-3 rounded border border-border bg-bg-surface p-4 text-sm">
        {!enrolling ? (
          <>
            <p className="text-fg-secondary">
              Add an authenticator app (1Password, Authy, Google Authenticator, …) for a second
              factor at login.
            </p>
            <Button
              intent="primary"
              size="sm"
              onPress={async () => {
                setError(null);
                try {
                  const result = await authFetch<TotpEnrollment>('/auth/totp/enroll', {
                    method: 'POST',
                  });
                  setEnrolling(result);
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'failed');
                }
              }}
            >
              Enable 2FA
            </Button>
            {error && <div className="text-xs text-danger">{error}</div>}
          </>
        ) : backupCodes ? (
          <>
            <p className="text-fg-secondary">
              2FA is enabled. Save these backup codes — each works once and they will not be shown
              again.
            </p>
            <ul className="grid grid-cols-2 gap-1 rounded bg-bg-base p-3 font-mono text-xs">
              {backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <Button
              intent="primary"
              size="sm"
              onPress={() => {
                setBackupCodes(null);
                setEnrolling(null);
                onChanged();
              }}
            >
              Done
            </Button>
          </>
        ) : (
          <>
            <p className="text-fg-secondary">
              Scan the URI below in your authenticator app, then enter the 6-digit code it shows.
            </p>
            <div className="rounded bg-bg-base p-3 font-mono text-xs">
              <div className="mb-2 break-all">{enrolling.otpauthUri}</div>
              <div className="text-fg-muted">
                Manual setup key: <span className="text-fg-primary">{enrolling.secret}</span>
                <br />
                Account: <span className="text-fg-primary">{userEmail}</span>
              </div>
            </div>
            <div>
              <label className="mb-1 block font-mono text-[11px] text-fg-muted">CODE</label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" />
            </div>
            {error && <div className="text-xs text-danger">{error}</div>}
            <div className="flex gap-2">
              <Button
                intent="primary"
                size="sm"
                isDisabled={!code}
                onPress={async () => {
                  setError(null);
                  try {
                    const result = await authFetch<{ backupCodes: string[] }>(
                      '/auth/totp/confirm',
                      { method: 'POST', json: { secret: enrolling.secret, code } },
                    );
                    setBackupCodes(result.backupCodes);
                    setCode('');
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'failed');
                  }
                }}
              >
                Confirm
              </Button>
              <Button intent="secondary" size="sm" onPress={() => setEnrolling(null)}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
