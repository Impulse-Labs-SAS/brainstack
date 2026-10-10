'use client';

// The prompt exactly as Copy puts it on the clipboard, and the format it comes
// in: references for an assistant connected to BrainStack, full text for any
// other. The text is selectable, for when the browser will not copy.

import type { Ref } from 'react';
import { ToggleButton, ToggleButtonGroup } from 'react-aria-components';

import { cn } from '@/lib/utils';

import type { BriefFormat } from '../brief';

import { FOCUS_RING } from './panel-ui';
import type { BriefState } from './use-brief';

const HELP: Record<BriefFormat, string> = {
  refs: 'For Claude Code, Cursor or any assistant with BrainStack connected. It lists the notes; the assistant opens them itself.',
  full: 'For any chat, connected or not. The notes’ contents go in the prompt, so it is longer.',
};

export function PromptTab({
  format,
  onFormat,
  brief,
  textRef,
}: {
  format: BriefFormat;
  onFormat(format: BriefFormat): void;
  brief: BriefState;
  textRef: Ref<HTMLPreElement>;
}) {
  return (
    <div className="grid min-w-0 gap-3">
      <ToggleButtonGroup
        aria-label="Prompt format"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[format]}
        onSelectionChange={(keys) => {
          const next = [...keys][0] as BriefFormat | undefined;
          if (next) onFormat(next);
        }}
        className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-bg-surface p-[3px]"
      >
        {(['refs', 'full'] as const).map((f) => (
          <ToggleButton
            key={f}
            id={f}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[12.5px] text-fg-secondary hover:text-fg-primary',
              'selected:bg-bg-elevated selected:text-fg-primary selected:shadow-[inset_0_0_0_1px_var(--border-strong)]',
              FOCUS_RING,
            )}
          >
            {f === 'refs' ? 'References' : 'Full text'}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <p className="text-[12px] leading-[17px] text-fg-secondary">{HELP[format]}</p>
      <pre
        ref={textRef}
        tabIndex={0}
        role="region"
        aria-label="The prompt Copy prompt copies"
        className={cn(
          'min-w-0 select-text whitespace-pre-wrap break-words rounded-lg border border-border bg-bg-base p-2.5 font-mono text-[11.5px] leading-[17px] text-fg-body',
          FOCUS_RING,
        )}
      >
        {brief.text}
      </pre>
      <p className="font-mono text-[11px] tabular-nums text-fg-muted" aria-live="polite">
        {brief.reading > 0
          ? `Reading ${brief.reading} ${brief.reading === 1 ? 'note' : 'notes'}…`
          : `${brief.text.length.toLocaleString('en')} characters · ${brief.tokens}`}
      </p>
    </div>
  );
}
