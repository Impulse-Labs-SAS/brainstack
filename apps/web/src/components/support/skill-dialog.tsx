'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { CopyBlock, DialogShell, PillTabs } from './dialog-shell';

const REPO = 'https://github.com/Impulse-Labs-SAS/brainstack';
const INSTRUCTIONS_URL = `${REPO}/blob/main/packages/skill/INSTRUCTIONS.md`;
const RAW_INSTRUCTIONS_URL =
  'https://raw.githubusercontent.com/Impulse-Labs-SAS/brainstack/main/packages/skill/INSTRUCTIONS.md';

type ClientId = 'claude' | 'claude-code' | 'cursor' | 'codex' | 'gemini' | 'other';

interface SkillGuide {
  id: ClientId;
  label: string;
  steps: string[];
  snippet?: string;
}

// Where each client expects standing instructions. The file is the same
// everywhere — INSTRUCTIONS.md already carries the frontmatter Claude reads.
const CLIENTS: SkillGuide[] = [
  {
    id: 'claude',
    label: 'Claude (web & desktop)',
    steps: [
      'Download INSTRUCTIONS.md and rename it to SKILL.md inside a folder called brainstack.',
      'Zip the folder, then upload it in Settings → Capabilities → Skills.',
    ],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    steps: ['Save it as a personal skill, available in every project:'],
    snippet: `mkdir -p ~/.claude/skills/brainstack\ncurl -fsSL ${RAW_INSTRUCTIONS_URL} \\\n  -o ~/.claude/skills/brainstack/SKILL.md`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    steps: ['Save it as a project rule:'],
    snippet: `mkdir -p .cursor/rules\ncurl -fsSL ${RAW_INSTRUCTIONS_URL} \\\n  -o .cursor/rules/brainstack.mdc`,
  },
  {
    id: 'codex',
    label: 'Codex',
    steps: ['Append it to AGENTS.md at the root of your project, or to ~/.codex/AGENTS.md:'],
    snippet: `curl -fsSL ${RAW_INSTRUCTIONS_URL} >> AGENTS.md`,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    steps: ['Append it to GEMINI.md in your project, or to ~/.gemini/GEMINI.md:'],
    snippet: `curl -fsSL ${RAW_INSTRUCTIONS_URL} >> GEMINI.md`,
  },
  {
    id: 'other',
    label: 'Other',
    steps: [
      'Paste the contents of INSTRUCTIONS.md into the client’s system prompt or custom instructions.',
    ],
  },
];

export function SkillDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [clientId, setClientId] = useState<ClientId>('claude');
  const client = CLIENTS.find((c) => c.id === clientId) ?? CLIENTS[0]!;

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      width="lg"
      title="BrainStack skill"
      subtitle="Teach your assistant how to use the brain well."
    >
      <p className="mb-4 text-xs leading-relaxed text-fg-secondary">
        The skill tells an assistant to search the brain before answering, ask before writing,
        and file notes with the right folders and wikilinks. Connected clients can already read
        it through the <code className="font-mono text-fg-primary">get_brainstack_guide</code>{' '}
        tool; installing it makes the assistant follow it from the first message.
      </p>

      <a
        href={INSTRUCTIONS_URL}
        target="_blank"
        rel="noreferrer"
        className="mb-5 inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-fg-primary hover:border-border-strong hover:bg-bg-elevated"
      >
        <ExternalLink size={12} />
        View INSTRUCTIONS.md
      </a>

      <div className="mb-1.5 font-mono text-[11px] text-fg-muted">install in</div>
      <PillTabs<ClientId> tabs={CLIENTS} value={clientId} onChange={setClientId} />

      <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-fg-secondary">
        {client.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {client.snippet && <CopyBlock text={client.snippet} />}
    </DialogShell>
  );
}
