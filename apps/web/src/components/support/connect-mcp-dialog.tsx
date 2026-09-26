'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { apiBase } from '@/lib/server-url';
import { CopyBlock, DialogShell, PillTabs } from './dialog-shell';

type ClientId = 'claude-ai' | 'claude-code' | 'cursor' | 'vscode' | 'codex' | 'gemini' | 'other';

interface ClientGuide {
  id: ClientId;
  label: string;
  steps: string[];
  snippet?: (url: string) => string;
}

// Every client below speaks remote MCP over HTTP and signs in through
// BrainStack's own OAuth provider, so none of them needs an API key unless
// it cannot do OAuth — that is what the "Other" tab is for.
const CLIENTS: ClientGuide[] = [
  {
    id: 'claude-ai',
    label: 'Claude (web & desktop)',
    steps: [
      'Open Settings → Connectors and choose "Add custom connector".',
      'Name it BrainStack and paste the server URL.',
      'Click Connect and sign in to BrainStack when asked.',
    ],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    steps: [
      'Run this in a terminal.',
      'Inside Claude Code, run /mcp and pick brainstack to sign in.',
    ],
    snippet: (url) => `claude mcp add --transport http brainstack ${url}`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    steps: [
      'Add this to ~/.cursor/mcp.json (or .cursor/mcp.json in a project).',
      'Open Cursor Settings → MCP and click "Login" next to brainstack.',
    ],
    snippet: (url) =>
      JSON.stringify({ mcpServers: { brainstack: { url } } }, null, 2),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    steps: [
      'Add this to .vscode/mcp.json, or run "MCP: Add Server" from the command palette.',
      'Start the server from the file and sign in when prompted.',
    ],
    snippet: (url) =>
      JSON.stringify({ servers: { brainstack: { type: 'http', url } } }, null, 2),
  },
  {
    id: 'codex',
    label: 'Codex',
    steps: [
      'Add this to ~/.codex/config.toml.',
      'Run `codex mcp login brainstack` to sign in.',
    ],
    snippet: (url) => `[mcp_servers.brainstack]\nurl = "${url}"`,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    steps: [
      'Add this to ~/.gemini/settings.json.',
      'Inside Gemini CLI, run /mcp auth brainstack to sign in.',
    ],
    snippet: (url) =>
      JSON.stringify({ mcpServers: { brainstack: { httpUrl: url } } }, null, 2),
  },
  {
    id: 'other',
    label: 'Other',
    steps: [
      'Any client that supports remote MCP over HTTP can connect with the server URL.',
      'If it cannot sign in with OAuth, create an API key and send it as a Bearer token.',
    ],
    snippet: (url) =>
      JSON.stringify(
        {
          mcpServers: {
            brainstack: { url, headers: { Authorization: 'Bearer <your-api-key>' } },
          },
        },
        null,
        2,
      ),
  },
];

export function ConnectMcpDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [clientId, setClientId] = useState<ClientId>('claude-ai');
  // Computed on open, not at import: the URL depends on window.location.
  const mcpUrl = useMemo(() => (open ? `${apiBase()}/mcp` : ''), [open]);
  const client = CLIENTS.find((c) => c.id === clientId) ?? CLIENTS[0]!;

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      width="lg"
      title="Connect an AI assistant"
      subtitle="Give Claude, Cursor, Codex and other MCP clients access to your brain."
    >
      <div className="mb-1.5 font-mono text-[11px] text-fg-muted">server url</div>
      <div className="mb-5">
        <CopyBlock text={mcpUrl} />
      </div>

      <div className="mb-1.5 font-mono text-[11px] text-fg-muted">client</div>
      <PillTabs<ClientId> tabs={CLIENTS} value={clientId} onChange={setClientId} />

      <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-fg-secondary">
        {client.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {client.snippet && <CopyBlock text={client.snippet(mcpUrl)} />}

      <p className="mt-5 text-xs text-fg-muted">
        Need a token instead of signing in?{' '}
        <Link href="/settings/api-keys" onClick={onClose} className="text-accent hover:underline">
          Create an API key
        </Link>
        .
      </p>
    </DialogShell>
  );
}
