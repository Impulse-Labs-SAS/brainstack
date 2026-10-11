'use client';

import { CheckCircle2, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { issueUrl, type ReportKind as Kind } from '@/lib/bug-report';
import { cn } from '@/lib/utils';
import { DialogShell } from './dialog-shell';

const KINDS: ReadonlyArray<{ id: Kind; label: string }> = [
  { id: 'bug', label: 'Something broke' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' },
];

export function BugReportDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [kind, setKind] = useState<Kind>('bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [status, setStatus] = useState<'idle' | 'opened'>('idle');

  // Every opening starts a fresh report.
  useEffect(() => {
    if (!open) return;
    setKind('bug');
    setSummary('');
    setDetails('');
    setStatus('idle');
  }, [open]);

  const canSend = summary.trim() !== '' && status === 'idle';

  const send = () => {
    if (!canSend) return;
    const url = issueUrl({
      kind,
      summary: summary.trim(),
      details: details.trim(),
      area: `/${window.location.pathname.split('/')[1] ?? ''}`,
      userAgent: navigator.userAgent,
    });
    window.open(url, '_blank', 'noopener,noreferrer');
    setStatus('opened');
  };

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Report a problem"
      subtitle="Tell us what went wrong or what you'd like to see."
    >
      {status === 'opened' ? (
        <div className="flex flex-col items-center py-6 text-center">
          <CheckCircle2 size={28} className="mb-3 text-success" />
          <div className="text-sm text-fg-primary">Finish it on GitHub</div>
          <div className="mt-1 text-xs text-fg-muted">
            The issue opened in a new tab, filled in. It is sent once you submit it there.
          </div>
          <button
            type="button"
            onClick={onClose}
            className="mt-5 rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated"
          >
            Close
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <div className="mb-3 flex gap-1 rounded border border-border bg-bg-elevated p-0.5">
            {KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => setKind(k.id)}
                className={cn(
                  'flex-1 rounded px-2 py-1 text-xs transition-colors duration-fast',
                  kind === k.id
                    ? 'bg-bg-surface text-fg-primary'
                    : 'text-fg-muted hover:text-fg-primary',
                )}
              >
                {k.label}
              </button>
            ))}
          </div>

          <label className="mb-1.5 block font-mono text-[11px] text-fg-muted" htmlFor="bug-summary">
            summary
          </label>
          <Input
            id="bug-summary"
            autoFocus
            value={summary}
            maxLength={140}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="e.g. Moving a folder lost its notes"
            className="mb-3"
          />

          <label className="mb-1.5 block font-mono text-[11px] text-fg-muted" htmlFor="bug-details">
            details <span className="text-fg-disabled">(optional)</span>
          </label>
          <textarea
            id="bug-details"
            value={details}
            rows={5}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="What did you do, what did you expect, and what happened instead?"
            className="w-full resize-y rounded-md border border-border bg-bg-surface px-2 py-1.5 text-sm text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
          />
          <p className="mt-1.5 text-[11px] text-fg-muted">
            This opens a public issue on GitHub for you to review and submit, with the part of the
            app you are in and your browser attached. Anyone can read it: leave out note names and
            anything private.
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSend}
              className="inline-flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-40"
            >
              <ExternalLink size={12} />
              Open on GitHub
            </button>
          </div>
        </form>
      )}
    </DialogShell>
  );
}
