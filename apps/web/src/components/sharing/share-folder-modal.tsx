'use client';

// Modal de gestión de sharing para una carpeta. Lista miembros actuales,
// permite invitar por email o generar un link compartible y revocar
// invitaciones pendientes. Sólo se monta en hosted (gated por el caller).

import { Copy, Link as LinkIcon, Loader2, Mail, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface Props {
  folderPath: string;
  open: boolean;
  onClose(): void;
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
  const revokeInvite = trpc.sharing.revokeInvite.useMutation({
    onSuccess: () => {
      void utils.sharing.listPendingInvites.invalidate();
    },
  });

  const [email, setEmail] = useState('');
  /** What a new invite will grant. Applies to both the email and the link. */
  const [permission, setPermission] = useState<'read' | 'write'>('read');
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = useMemo(
    () => (mySharesQ.data ?? []).filter((m) => m.folderPath === folderPath),
    [mySharesQ.data, folderPath],
  );
  const pending = useMemo(
    () => (pendingQ.data ?? []).filter((p) => p.folderPath === folderPath && p.mode === 'email'),
    [pendingQ.data, folderPath],
  );

  if (!open) return null;

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
      if (inv && 'token' in inv && inv.token) {
        setLinkToken(inv.acceptUrl);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyLink = async () => {
    if (!linkToken) return;
    try {
      await navigator.clipboard.writeText(linkToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard puede fallar fuera de https */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-[min(520px,92vw)] rounded-lg border border-border bg-bg-surface p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-sm font-medium text-fg-primary">Compartir carpeta</div>
            <div className="mt-0.5 font-mono text-[11px] text-fg-muted">{folderPath}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
          >
            <X size={14} />
          </button>
        </div>

        {/* Permiso: gobierna tanto la invitación por email como el link */}
        <div className="mb-3">
          <div className="mb-1.5 font-mono text-[11px] text-fg-muted">permiso</div>
          <div className="flex gap-1 rounded border border-border bg-bg-elevated p-0.5">
            {(
              [
                ['read', 'sólo lectura', 'Puede leer todo lo que haya en la carpeta.'],
                ['write', 'lectura y escritura', 'Además puede crear y editar notas acá.'],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                title={hint}
                onClick={() => setPermission(value)}
                className={cn(
                  'flex-1 rounded px-2 py-1 font-mono text-[11px] transition-colors',
                  permission === value
                    ? 'bg-accent/20 text-fg-primary'
                    : 'text-fg-muted hover:text-fg-secondary',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Invitar por email */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
            <Mail size={11} /> invitar por email
          </div>
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="persona@ejemplo.com"
              className="flex-1 rounded border border-border bg-bg-elevated px-2.5 py-1.5 text-xs text-fg-primary outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={sendEmail}
              disabled={inviteEmail.isPending || !email.trim()}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-40"
            >
              {inviteEmail.isPending ? <Loader2 size={12} className="animate-spin" /> : 'Invitar'}
            </button>
          </div>
        </div>

        {/* Link compartible */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] text-fg-muted">
            <LinkIcon size={11} /> link compartible
          </div>
          {linkToken ? (
            <div className="flex gap-2">
              <input
                readOnly
                value={linkToken}
                className="flex-1 rounded border border-border bg-bg-elevated px-2.5 py-1.5 font-mono text-[11px] text-fg-secondary"
              />
              <button
                type="button"
                onClick={copyLink}
                className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated"
              >
                <Copy size={12} /> {copied ? '¡copiado!' : 'copiar'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={generateLink}
              disabled={inviteLink.isPending}
              className="rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated disabled:opacity-40"
            >
              {inviteLink.isPending ? 'Generando…' : 'Generar link'}
            </button>
          )}
        </div>

        {error && (
          <div className="mb-3 rounded border border-red-700/40 bg-red-950/40 px-2.5 py-1.5 font-mono text-[11px] text-red-300">
            {error}
          </div>
        )}

        {/* Miembros */}
        {members.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 font-mono text-[11px] text-fg-muted">
              con acceso ({members.length})
            </div>
            <ul className="divide-y divide-border-subtle rounded border border-border">
              {members.map((m) => (
                <li key={m.shareId} className="flex items-center justify-between px-2.5 py-1.5">
                  <div className="min-w-0">
                    <div className="truncate text-xs text-fg-primary">
                      {m.displayName ?? m.email}
                    </div>
                    {m.displayName && (
                      <div className="truncate font-mono text-[10px] text-fg-muted">{m.email}</div>
                    )}
                  </div>
                  <span
                    title={
                      m.permission === 'write'
                        ? 'Puede crear y editar notas en esta carpeta'
                        : 'Sólo puede leer'
                    }
                    className="ml-2 shrink-0 rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[9px] uppercase text-fg-muted"
                  >
                    {m.permission === 'write' ? 'escritura' : 'lectura'}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      revokeShare.mutate({
                        folderPath,
                        sharedWithUserId: m.userId,
                      })
                    }
                    title="Revocar acceso"
                    className="rounded p-1 text-fg-muted hover:bg-red-950/40 hover:text-red-300"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Invitaciones pendientes (email mode) */}
        {pending.length > 0 && (
          <div className="mb-3">
            <div className="mb-1.5 font-mono text-[11px] text-fg-muted">
              invitaciones pendientes ({pending.length})
            </div>
            <ul className="divide-y divide-border-subtle rounded border border-border">
              {pending.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-2.5 py-1.5">
                  <div className="min-w-0 text-xs text-fg-secondary">
                    <span className="truncate">{p.inviteeEmail}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => revokeInvite.mutate({ inviteId: p.id })}
                    title="Revocar invitación"
                    className={cn(
                      'rounded p-1 text-fg-muted hover:bg-red-950/40 hover:text-red-300',
                    )}
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {members.length === 0 && pending.length === 0 && (
          <div className="rounded border border-dashed border-border-subtle px-3 py-4 text-center font-mono text-[11px] text-fg-muted">
            Aún no compartiste esta carpeta con nadie.
          </div>
        )}
      </div>
    </div>
  );
}
