'use client';

// Who can see one folder of your vault. Invite by email or by link, change a
// member's permission, revoke access or a pending invitation. Mounted only
// where sharing exists (gated by the caller).
//
// The unit is the folder: everything under it is shared, including notes
// added later, and nothing outside it. The header says so, because "share"
// on its own reads as "share my vault".

import { Copy, Link as LinkIcon, Loader2, Mail, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface Props {
  folderPath: string;
  open: boolean;
  onClose(): void;
}

type Permission = 'read' | 'write';

const PERMISSION_LABEL: Record<Permission, string> = { read: 'Read only', write: 'Can edit' };

function initials(name: string): string {
  return name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

function PermissionSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: Permission;
  onChange(p: Permission): void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as Permission)}
      className="h-8 shrink-0 rounded-md border border-border bg-bg-base px-1.5 text-xs text-fg-primary outline-none focus:border-accent disabled:opacity-50"
    >
      <option value="read">{PERMISSION_LABEL.read}</option>
      <option value="write">{PERMISSION_LABEL.write}</option>
    </select>
  );
}

export function ShareFolderModal({ folderPath, open, onClose }: Props) {
  const utils = trpc.useUtils();
  const mySharesQ = trpc.sharing.listMyShares.useQuery(undefined, { enabled: open });
  const pendingQ = trpc.sharing.listPendingInvites.useQuery(undefined, { enabled: open });

  const inviteEmail = trpc.sharing.createInvite.useMutation({
    onSuccess: () => {
      void utils.sharing.listPendingInvites.invalidate();
    },
  });
  const inviteLink = trpc.sharing.createInvite.useMutation({
    onSuccess: () => {
      void utils.sharing.listPendingInvites.invalidate();
    },
  });
  const revokeShare = trpc.sharing.revoke.useMutation({
    onSuccess: () => {
      void utils.sharing.listMyShares.invalidate();
    },
  });
  // Re-granting to somebody who already has access updates the permission
  // rather than adding a second row, which is what makes this an edit.
  const setPermissionM = trpc.sharing.shareWithUser.useMutation({
    onSuccess: () => {
      void utils.sharing.listMyShares.invalidate();
    },
  });
  const revokeInvite = trpc.sharing.revokeInvite.useMutation({
    onSuccess: () => {
      void utils.sharing.listPendingInvites.invalidate();
    },
  });

  const [email, setEmail] = useState('');
  /** What a new invite will grant. Applies to both the email and the link. */
  const [permission, setPermission] = useState<Permission>('read');
  const [link, setLink] = useState<{ url: string; permission: Permission } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);

  const members = useMemo(
    () => (mySharesQ.data ?? []).filter((m) => m.folderPath === folderPath),
    [mySharesQ.data, folderPath],
  );
  const pending = useMemo(
    () => (pendingQ.data ?? []).filter((p) => p.folderPath === folderPath && p.mode === 'email'),
    [pendingQ.data, folderPath],
  );

  useEffect(() => {
    if (!open) return;
    setLink(null);
    setError(null);
    emailRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, folderPath, onClose]);

  if (!open) return null;

  const folderName = folderPath.split('/').pop() ?? folderPath;

  const sendEmail = async () => {
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) return;
    try {
      await inviteEmail.mutateAsync({
        folderPath,
        mode: 'email',
        inviteeEmail: trimmed,
        permission,
      });
      setEmail('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const generateLink = async () => {
    setError(null);
    try {
      const inv = await inviteLink.mutateAsync({ folderPath, mode: 'link', permission });
      if (inv && 'token' in inv && inv.token && inv.acceptUrl) {
        setLink({ url: inv.acceptUrl, permission });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard is refused outside https; the link stays selectable.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-[10vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-folder-title"
        className="grid w-[min(480px,100%)] gap-5 rounded-xl border border-border bg-bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="share-folder-title" className="text-base font-semibold text-fg-primary">
              Share “{folderName}”
            </h2>
            <p className="mt-1 text-sm text-fg-secondary">
              Only this folder and everything inside it, including notes added later. The rest of
              your vault stays private.
            </p>
            <p className="mt-1 truncate font-mono text-[11px] text-fg-muted">{folderPath}/</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-fg-muted hover:bg-bg-hover hover:text-fg-primary"
          >
            <X size={15} />
          </button>
        </div>

        <form
          className="flex flex-wrap gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void sendEmail();
          }}
        >
          <label className="sr-only" htmlFor="share-folder-email">
            Email to invite
          </label>
          <div className="relative min-w-[160px] flex-1">
            <Mail
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted"
            />
            <input
              id="share-folder-email"
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@company.com"
              autoComplete="off"
              className="h-8 w-full rounded-md border border-border bg-bg-base pl-8 pr-2.5 text-sm text-fg-primary outline-none focus:border-accent"
            />
          </div>
          <PermissionSelect value={permission} onChange={setPermission} label="Permission" />
          <button
            type="submit"
            disabled={inviteEmail.isPending || !email.trim()}
            className="flex h-8 items-center rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {inviteEmail.isPending ? <Loader2 size={13} className="animate-spin" /> : 'Invite'}
          </button>
        </form>

        {error && (
          <div className="rounded-md border border-red-700/40 bg-red-950/40 px-2.5 py-1.5 text-xs text-red-300">
            {error}
          </div>
        )}

        <div>
          <div className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
            People with access
          </div>
          <ul className="grid gap-0.5">
            {members.map((m) => {
              const name = m.displayName ?? m.email;
              return (
                <li key={m.shareId} className="flex items-center gap-2.5 py-1">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-bg-elevated font-mono text-[10px] font-semibold text-fg-secondary">
                    {initials(name)}
                  </span>
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate text-sm text-fg-primary">{name}</span>
                    {m.displayName && (
                      <span className="truncate font-mono text-[11px] text-fg-muted">
                        {m.email}
                      </span>
                    )}
                  </span>
                  <PermissionSelect
                    value={m.permission}
                    label={`Permission for ${name}`}
                    disabled={setPermissionM.isPending}
                    onChange={(value) => {
                      if (m.permission === value) return;
                      setError(null);
                      setPermissionM.mutate(
                        { folderPath, email: m.email, permission: value },
                        { onError: (e) => setError(e.message) },
                      );
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => revokeShare.mutate({ folderPath, sharedWithUserId: m.userId })}
                    title="Remove access"
                    aria-label={`Remove access for ${name}`}
                    className="rounded-md p-1.5 text-fg-muted hover:bg-red-950/40 hover:text-red-300"
                  >
                    <X size={13} />
                  </button>
                </li>
              );
            })}
            {pending.map((p) => (
              <li key={p.id} className="flex items-center gap-2.5 py-1">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-bg-elevated text-fg-muted">
                  <Mail size={12} />
                </span>
                <span className="grid min-w-0 flex-1">
                  <span className="truncate text-sm text-fg-primary">{p.inviteeEmail}</span>
                  <span className="font-mono text-[11px] text-fg-muted">
                    Invitation not accepted yet
                  </span>
                </span>
                <span className="rounded border border-amber-500/40 px-1.5 font-mono text-[10.5px] text-amber-400">
                  Pending
                </span>
                <button
                  type="button"
                  onClick={() => revokeInvite.mutate({ inviteId: p.id })}
                  title="Cancel invitation"
                  aria-label={`Cancel invitation for ${p.inviteeEmail}`}
                  className="rounded-md p-1.5 text-fg-muted hover:bg-red-950/40 hover:text-red-300"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
            {members.length === 0 && pending.length === 0 && (
              <li className="py-1 text-sm text-fg-muted">Not shared with anyone yet.</li>
            )}
          </ul>
        </div>

        <div>
          <div className="mb-2 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
            Invite link
          </div>
          <p className="mb-2.5 text-xs text-fg-secondary">
            Anyone signed in who opens it gets access with the permission chosen above, until you
            revoke it.
          </p>
          {link ? (
            <>
              <div className="flex gap-1.5">
                <input
                  readOnly
                  aria-label="Invite link"
                  value={link.url}
                  onFocus={(e) => e.target.select()}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-bg-base px-2.5 font-mono text-[11px] text-fg-secondary"
                />
                <button
                  type="button"
                  onClick={copyLink}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-3 text-sm text-fg-primary hover:border-border-strong"
                >
                  <Copy size={13} /> {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-fg-muted">
                Gives {PERMISSION_LABEL[link.permission].toLowerCase()} access.
              </p>
            </>
          ) : (
            <button
              type="button"
              onClick={generateLink}
              disabled={inviteLink.isPending}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-3 text-sm text-fg-primary',
                'hover:border-border-strong disabled:opacity-40',
              )}
            >
              <LinkIcon size={13} />
              {inviteLink.isPending ? 'Creating…' : 'Create link'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
