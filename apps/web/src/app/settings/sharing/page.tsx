'use client';

import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';

/*
 * The decisions about sharing that only a signed-in person can make.
 *
 * An assistant asks to share instead of sharing: it reads notes other people
 * wrote, so "share this with x@y" may not be the user's own idea. Its requests
 * wait here. So do the folders other people shared with you — a share arrives
 * without being asked for, so it can be left, and its sender refused.
 */
export default function SharingSettingsPage() {
  const utils = trpc.useUtils();
  const requests = trpc.sharing.listShareRequests.useQuery();
  const sharedWithMe = trpc.sharing.listSharedWithMe.useQuery();
  const blocked = trpc.sharing.listBlocked.useQuery();

  const refresh = (): void => {
    void utils.sharing.listShareRequests.invalidate();
    void utils.sharing.listSharedWithMe.invalidate();
    void utils.sharing.listBlocked.invalidate();
    void utils.sharing.listMyShares.invalidate();
    void utils.notes.tree.invalidate();
  };
  const approve = trpc.sharing.approveShareRequest.useMutation({ onSuccess: refresh });
  const reject = trpc.sharing.rejectShareRequest.useMutation({ onSuccess: refresh });
  const leave = trpc.sharing.leave.useMutation({ onSuccess: refresh });
  const unblock = trpc.sharing.unblock.useMutation({ onSuccess: refresh });

  const busy = approve.isPending || reject.isPending || leave.isPending || unblock.isPending;
  const error = approve.error ?? reject.error ?? leave.error ?? unblock.error;

  return (
    <AppShell>
      <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-xs text-fg-muted">
        Settings · Sharing
      </div>
      <div className="flex-1 space-y-8 overflow-y-auto p-6 text-sm">
        {error && <div className="max-w-3xl text-xs text-danger">{error.message}</div>}

        <section className="max-w-3xl">
          <h2 className="mb-1 text-base font-medium text-fg-primary">Waiting for your approval</h2>
          <p className="mb-3 text-xs text-fg-muted">
            Shares an assistant asked for. Nothing is shared until you approve it; approving gives
            that address access to the folder and everything under it.
          </p>
          <ul className="divide-y divide-border-subtle rounded border border-border">
            {(requests.data ?? []).map((r) => (
              <li key={r.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg-primary">
                    <span className="font-mono">{r.folderPath}</span> → {r.email}
                  </div>
                  <div className="text-xs text-fg-muted">
                    {r.permission === 'write' ? 'Read and write' : 'Read only'}
                    {r.requestedBy ? ` · asked by ${r.requestedBy}` : ''} ·{' '}
                    {new Date(r.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button size="sm" isDisabled={busy} onPress={() => reject.mutate({ id: r.id })}>
                  Decline
                </Button>
                <Button
                  size="sm"
                  intent="primary"
                  isDisabled={busy}
                  onPress={() => approve.mutate({ id: r.id })}
                >
                  Approve
                </Button>
              </li>
            ))}
            {requests.data?.length === 0 && (
              <li className="p-3 text-xs text-fg-muted">Nothing is waiting.</li>
            )}
          </ul>
        </section>

        <section className="max-w-3xl">
          <h2 className="mb-1 text-base font-medium text-fg-primary">Shared with you</h2>
          <p className="mb-3 text-xs text-fg-muted">
            Folders other people shared with you. Leave one to remove it from your tree; block the
            person to refuse anything else they share.
          </p>
          <ul className="divide-y divide-border-subtle rounded border border-border">
            {(sharedWithMe.data ?? []).map((s) => (
              <li key={`${s.ownerId}/${s.folderPath}`} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-fg-primary">{s.folderPath}</div>
                  <div className="text-xs text-fg-muted">
                    From {s.ownerDisplayName ?? s.ownerEmail} ·{' '}
                    {s.permission === 'write' ? 'read and write' : 'read only'}
                  </div>
                </div>
                <Button
                  size="sm"
                  isDisabled={busy}
                  onPress={() => leave.mutate({ ownerId: s.ownerId, folderPath: s.folderPath })}
                >
                  Leave
                </Button>
                <Button
                  size="sm"
                  intent="danger"
                  isDisabled={busy}
                  onPress={() =>
                    leave.mutate({ ownerId: s.ownerId, folderPath: s.folderPath, block: true })
                  }
                >
                  Leave and block
                </Button>
              </li>
            ))}
            {sharedWithMe.data?.length === 0 && (
              <li className="p-3 text-xs text-fg-muted">Nobody has shared a folder with you.</li>
            )}
          </ul>
        </section>

        <section className="max-w-3xl">
          <h2 className="mb-1 text-base font-medium text-fg-primary">Blocked</h2>
          <p className="mb-3 text-xs text-fg-muted">People whose shares you refuse.</p>
          <ul className="divide-y divide-border-subtle rounded border border-border">
            {(blocked.data ?? []).map((b) => (
              <li key={b.ownerId} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1 truncate text-fg-primary">
                  {b.displayName ?? b.email}
                  {b.displayName && <span className="ml-2 text-xs text-fg-muted">{b.email}</span>}
                </div>
                <Button size="sm" isDisabled={busy} onPress={() => unblock.mutate({ ownerId: b.ownerId })}>
                  Unblock
                </Button>
              </li>
            ))}
            {blocked.data?.length === 0 && (
              <li className="p-3 text-xs text-fg-muted">You have not blocked anyone.</li>
            )}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
