'use client';

import { useState } from 'react';

import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';

export default function ApiKeysPage() {
  const list = trpc.apiKeys.list.useQuery();
  const create = trpc.apiKeys.create.useMutation({ onSuccess: () => list.refetch() });
  const revoke = trpc.apiKeys.revoke.useMutation({ onSuccess: () => list.refetch() });

  const [name, setName] = useState('');
  const [justCreated, setJustCreated] = useState<string | null>(null);

  return (
    <AppShell>
      <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-xs text-fg-muted">
        Settings · API keys
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-6 max-w-xl">
          <h2 className="mb-1 text-base font-medium text-fg-primary">Create a new API key</h2>
          <p className="mb-3 text-xs text-fg-muted">
            Use API keys to connect MCP clients (Claude Code, Claude Chat, Cursor, ...) to your
            BrainStack. Each key is shown once — copy it now.
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Code · laptop"
              className="max-w-xs"
            />
            <Button
              intent="primary"
              isDisabled={!name.trim() || create.isPending}
              onPress={async () => {
                const result = await create.mutateAsync({ name: name.trim() });
                setJustCreated(result.token);
                setName('');
              }}
            >
              Generate
            </Button>
          </div>
          {justCreated && (
            <div className="mt-4 rounded-md border border-warning bg-bg-elevated p-3 text-xs">
              <div className="mb-1 font-mono text-warning">SAVE THIS — IT WONT BE SHOWN AGAIN</div>
              <code className="block break-all rounded bg-bg-base p-2 font-mono text-fg-primary">
                {justCreated}
              </code>
            </div>
          )}
        </div>

        <div className="max-w-3xl">
          <h2 className="mb-2 text-base font-medium text-fg-primary">Existing keys</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase text-fg-muted">
              <tr>
                <th className="py-2">Name</th>
                <th className="py-2 font-mono">Prefix</th>
                <th className="py-2">Created</th>
                <th className="py-2">Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((key) => (
                <tr
                  key={key.id}
                  className="border-t border-border-subtle"
                  // A revoked key is history, not a key. Dimming the whole row
                  // is what tells them apart at a glance — before this, the only
                  // difference was a missing button, which reads as broken.
                  data-revoked={key.revokedAt ? 'true' : undefined}
                >
                  <td className="py-2 text-fg-primary">
                    <span className={key.revokedAt ? 'text-fg-muted line-through' : undefined}>
                      {key.name}
                    </span>
                  </td>
                  <td className="py-2 font-mono text-fg-secondary">{key.prefix}…</td>
                  <td className="py-2 text-fg-secondary">
                    {new Date(key.createdAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="py-2 text-fg-secondary">
                    {key.lastUsedAt
                      ? new Date(key.lastUsedAt).toISOString().slice(0, 10)
                      : '—'}
                  </td>
                  <td className="py-2 text-right">
                    {key.revokedAt ? (
                      <span className="font-mono text-[11px] text-fg-muted">
                        revoked {new Date(key.revokedAt).toISOString().slice(0, 10)}
                      </span>
                    ) : (
                      <Button
                        intent="danger"
                        size="sm"
                        isDisabled={revoke.isPending}
                        onPress={() => revoke.mutate({ id: key.id })}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {list.data && list.data.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-fg-muted">
                    No keys yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
