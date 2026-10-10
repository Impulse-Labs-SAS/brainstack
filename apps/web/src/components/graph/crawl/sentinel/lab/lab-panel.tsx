'use client';

// The lab's stand-in for Crawl's side panel: what was asked, how the walk is
// going, and "New search", which takes the scene back to the prompt. Crawl's
// own panel comes with the integration; this one is only enough to judge the
// transition by — it slides in from the left (lil-gui has the right) as the
// prompt leaves, and out again on the way back.
//
// It slides by transform, from the level the stage writes (`--crawl-panel`),
// never by opacity: an ancestor with an opacity below 1 is a backdrop root,
// and the glass's blur would sample nothing while it moves. Its height is its
// content's, so the lab's notes at the bottom left stay in view.
//
// When it comes in, focus moves to its heading — the prompt went inert under
// the person's caret — and a polite live region says what is being crawled.
// The region sits outside the panel: inside an inert one it would not speak.

import { Search } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from 'react-aria-components';

import { cn } from '@/lib/utils';

import { GLASS } from '../../../graph-preview';
import type { CrawlSnapshot } from '../../crawl-snapshot';

export interface LabPanelProps {
  /** The crawl is the scene, or is becoming it. */
  shown: boolean;
  /** What the crawl on screen was asked. */
  asked: string;
  snapshot: CrawlSnapshot | null;
  /** There is a prompt to go back to: false on the brain stand-in. */
  canGoBack: boolean;
  onNewSearch(): void;
}

export function LabPanel({ shown, asked, snapshot, canGoBack, onNewSearch }: LabPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (shown) heading.current?.focus({ preventScroll: true });
  }, [shown]);

  const found = snapshot
    ? snapshot.found.named + snapshot.found.linked + snapshot.found.decision
    : 0;

  return (
    <>
      <aside
        aria-label="Crawl"
        inert={!shown}
        aria-hidden={!shown}
        className={cn(GLASS, 'absolute left-4 top-4 z-10 grid w-[280px] gap-2.5 rounded-lg p-3')}
        style={{ transform: 'translateX(calc((var(--crawl-panel, 0) - 1) * 120%))' }}
      >
        <h2
          ref={heading}
          tabIndex={-1}
          className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted outline-none"
        >
          Crawl
        </h2>
        <p className="line-clamp-3 text-[13px] leading-5 text-fg-primary">{asked || '—'}</p>
        <p className="font-mono text-[11.5px] text-fg-muted">
          {snapshot?.state ?? 'idle'} · {found} found · {snapshot?.threads ?? 0}{' '}
          {snapshot?.threads === 1 ? 'thread' : 'threads'}
        </p>
        <Button
          onPress={onNewSearch}
          isDisabled={!canGoBack}
          className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
        >
          <Search size={14} aria-hidden />
          New search
        </Button>
        {!canGoBack && (
          <p className="text-[11.5px] leading-4 text-fg-muted">
            The brain stand-in has no prompt: pick a space to go back to it.
          </p>
        )}
      </aside>
      <span aria-live="polite" className="sr-only">
        {shown && asked ? `Crawling your brain: ${asked}` : ''}
      </span>
    </>
  );
}
