'use client';

// How the search went, for whoever wants to look under it: what the walk
// counted, its log, and the answer an assistant receives over MCP, as it
// receives it.

import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from 'react-aria-components';

import { cn } from '@/lib/utils';

import type { Answer } from '../answer';
import { CRAWL_COLORS } from '../crawl-colors';
import type { CrawlSnapshot } from '../crawl-snapshot';

import { Eyebrow, FOCUS_RING } from './panel-ui';

const VERB_COLOR: Record<CrawlSnapshot['log'][number]['kind'], string> = {
  named: CRAWL_COLORS.named,
  linked: CRAWL_COLORS.linked,
  decision: CRAWL_COLORS.decision,
  ask: CRAWL_COLORS.ask,
  walk: 'var(--fg-muted)',
  done: 'var(--fg-primary)',
};

export function ActivityTab({
  snap,
  answer,
  raw,
}: {
  snap: CrawlSnapshot | null;
  answer: Answer;
  /** What gather_context returned, and whether it is whole (a search run here) or as the history kept it. */
  raw: { json: unknown; whole: boolean };
}) {
  const [showRaw, setShowRaw] = useState(false);
  const { resolved, total } = answer.coverage;
  return (
    <div className="grid min-w-0 gap-4">
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-mono text-[11.5px] text-fg-muted">
        <dt>threads walked</dt>
        <dd className="text-right tabular-nums text-fg-primary">{snap?.threads ?? 0}</dd>
        <dt>references resolved</dt>
        <dd className="text-right tabular-nums text-fg-primary">
          {resolved} of {total}
        </dd>
        <dt>left out by the budget</dt>
        <dd className="text-right tabular-nums text-fg-primary">{answer.leftOutCount}</dd>
        {snap && snap.offGraph > 0 && (
          <>
            <dt>hidden by a layer</dt>
            <dd className="text-right tabular-nums text-fg-primary">{snap.offGraph}</dd>
          </>
        )}
      </dl>

      {snap && snap.log.length > 0 && (
        <section className="grid gap-1.5" aria-label="Log">
          <Eyebrow>Log</Eyebrow>
          <ol className="grid gap-px font-mono text-[11px] leading-[17px]">
            {snap.log.map((l, i) => (
              <li
                key={`${l.t}-${i}`}
                className="grid grid-cols-[40px_64px_minmax(0,1fr)] gap-1.5 whitespace-nowrap"
              >
                <span className="tabular-nums text-fg-disabled">{l.t.toFixed(1)}s</span>
                <span style={{ color: VERB_COLOR[l.kind] }}>{l.verb}</span>
                <span className="truncate text-fg-secondary">{l.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="grid min-w-0 gap-1.5 border-t border-border-subtle pt-3">
        <Button
          onPress={() => setShowRaw(!showRaw)}
          aria-expanded={showRaw}
          className={cn('flex items-center gap-1.5 text-left text-[12px] text-fg-secondary hover:text-fg-primary', FOCUS_RING)}
        >
          <ChevronRight size={12} aria-hidden className={cn('transition-transform', showRaw && 'rotate-90')} />
          Raw response (JSON)
        </Button>
        {showRaw && (
          <>
            <p className="text-[11.5px] leading-4 text-fg-muted">
              {raw.whole
                ? 'What gather_context returned, as an assistant receives it over MCP.'
                : 'From the history, which keeps no note bodies: they are missing here.'}
            </p>
            <pre className="max-h-72 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-base p-2 font-mono text-[10.5px] leading-[15px] text-fg-secondary">
              {JSON.stringify(raw.json, null, 2)}
            </pre>
          </>
        )}
      </section>
    </div>
  );
}
