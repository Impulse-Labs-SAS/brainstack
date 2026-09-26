'use client';

import { CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { DialogShell } from './dialog-shell';

type Kind = 'bug' | 'idea' | 'other';

export interface BugReport {
  kind: Kind;
  summary: string;
  details: string;
  /** Where the user was when they opened the dialog. */
  page: string;
  userAgent: string;
}

/**
 * Where a report goes.
 *
 * TODO: not wired to the server yet — nothing is sent or stored. Replace the
 * body with the real call (tRPC mutation or endpoint) once it exists.
 */
async function submitBugReport(report: BugReport): Promise<void> {
  console.warn('[bug-report] not connected yet; report was not sent', report);
}

const KINDS: ReadonlyArray<{ id: Kind; label: string }> = [
  { id: 'bug', label: 'Something broke' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' },
];

export function BugReportDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [kind, setKind] = useState<Kind>('bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');

  // Every opening starts a fresh report.
  useEffect(() => {
    if (!open) return;
    setKind('bug');
    setSummary('');
    setDetails('');
    setStatus('idle');
  }, [open]);

  const canSend = summary.trim() !== '' && status === 'idle';

  const send = async () => {
    if (!canSend) return;
    setStatus('sending');
    await submitBugReport({
      kind,
      summary: summary.trim(),
      details: details.trim(),
      page: window.location.pathname,
      userAgent: navigator.userAgent,
    });
    setStatus('sent');
  };

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Report a problem"
      subtitle="Tell us what went wrong or what you'd like to see."
    >
      {status === 'sent' ? (
        <div className="flex flex-col items-center py-6 text-center">
          <CheckCircle2 size={28} className="mb-3 text-success" />
          <div className="text-sm text-fg-primary">Thanks for the report</div>
          <div className="mt-1 text-xs text-fg-muted">It helps us make BrainStack better.</div>
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
            void send();
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
            The page you are on and your browser are attached to help us reproduce it.
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
              {status === 'sending' && <Loader2 size={12} className="animate-spin" />}
              Send report
            </button>
          </div>
        </form>
      )}
    </DialogShell>
  );
}
