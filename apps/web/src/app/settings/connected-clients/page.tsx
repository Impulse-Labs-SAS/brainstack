'use client';

// The AI clients this account let in through BrainStack's own OAuth (the
// "Allow" screen an MCP host opens), and the way to cut one off. Before this
// page the only way to revoke one was to hold its token — which only the
// client, or whoever had taken it, did.

import { AppShell } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export default function ConnectedClientsPage() {
  const list = trpc.connectedClients.list.useQuery();
  const disconnect = trpc.connectedClients.disconnect.useMutation({
    onSuccess: () => list.refetch(),
  });

  return (
    <AppShell>
      <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-xs text-fg-muted">
        Settings · Connected AI clients
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl">
          <p className="mb-4 max-w-xl text-xs text-fg-muted">
            Apps you allowed to use your notes when they asked through BrainStack&apos;s sign-in
            screen. Each can read and change every note you can, until you disconnect it here. An
            app you do not recognise, or one sending its access somewhere you did not expect,
            should go.
          </p>
          {list.error && <p className="text-sm text-red-300">{list.error.message}</p>}
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase text-fg-muted">
              <tr>
                <th className="py-2">Name</th>
                <th className="py-2">Sends access to</th>
                <th className="py-2">Connected</th>
                <th className="py-2">Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(list.data ?? []).map((client) => (
                <tr key={client.clientId} className="border-t border-border-subtle">
                  <td className="py-2 text-fg-primary">{client.name}</td>
                  <td className="py-2 font-mono text-xs text-fg-secondary">
                    {client.redirectTargets.join(', ')}
                  </td>
                  <td className="py-2 text-fg-secondary">{day(client.connectedAt)}</td>
                  <td className="py-2 text-fg-secondary">
                    {client.lastUsedAt ? day(client.lastUsedAt) : '—'}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      intent="danger"
                      size="sm"
                      isDisabled={disconnect.isPending}
                      onPress={() => disconnect.mutate({ clientId: client.clientId })}
                    >
                      Disconnect
                    </Button>
                  </td>
                </tr>
              ))}
              {list.data && list.data.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-fg-muted">
                    No AI clients connected.
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
