'use client';

// The small pieces the Sentinel panel is built from, in one place so the
// column on a wide screen and the sheet on a phone look alike.

import { Check, Copy, LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from 'react-aria-components';

import { cn } from '@/lib/utils';

import { CRAWL_COLORS } from '../crawl-colors';
import type { ReachKind } from '../crawl-plan';

export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn('font-mono text-[10.5px] uppercase tracking-wider text-fg-muted', className)}
    >
      {children}
    </span>
  );
}

/** A note's colour on the stage: why it was found, or a reference left to ask about. */
export function Dot({ kind, dim = false }: { kind: ReachKind | 'ask'; dim?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-[7px] w-[7px] shrink-0 rounded-full', dim && 'opacity-35')}
      style={{ background: CRAWL_COLORS[kind] }}
    />
  );
}

export function IconButton({
  label,
  onPress,
  children,
  isDisabled,
  className,
}: {
  label: string;
  onPress(): void;
  children: ReactNode;
  isDisabled?: boolean;
  className?: string;
}) {
  return (
    <Button
      aria-label={label}
      onPress={onPress}
      isDisabled={isDisabled}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-fg-secondary hover:bg-bg-hover hover:text-fg-primary disabled:opacity-40',
        FOCUS_RING,
        className,
      )}
    >
      {children}
    </Button>
  );
}

export type CopyState = 'ready' | 'reading' | 'copied';

/** The panel's one action: the prompt onto the clipboard. */
export function CopyButton({
  state,
  onPress,
  className,
}: {
  state: CopyState;
  onPress(): void;
  className?: string;
}) {
  return (
    <Button
      onPress={onPress}
      isDisabled={state === 'reading'}
      className={cn(
        'flex h-9 items-center justify-center gap-2 rounded-md px-3.5 text-[13px] font-medium transition-colors disabled:opacity-60',
        state === 'copied'
          ? 'bg-[rgba(34,197,94,0.14)] text-success shadow-[inset_0_0_0_1px_rgba(34,197,94,0.4)]'
          : 'bg-accent text-accent-fg hover:bg-accent-hover',
        FOCUS_RING,
        className,
      )}
    >
      {state === 'copied' ? (
        <Check size={15} aria-hidden />
      ) : state === 'reading' ? (
        <LoaderCircle size={15} aria-hidden className="animate-spin motion-reduce:animate-none" />
      ) : (
        <Copy size={15} aria-hidden />
      )}
      {state === 'copied' ? 'Copied' : state === 'reading' ? 'Reading notes…' : 'Copy prompt'}
    </Button>
  );
}

/** A box ticked, crossed or half: the look of every checkbox in the panel. */
export function Tick({ on, half = false }: { on: boolean; half?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border',
        on
          ? 'border-accent bg-accent text-accent-fg'
          : half
            ? 'border-accent bg-accent/15'
            : 'border-border-strong',
        'group-focus-visible:ring-2 group-focus-visible:ring-accent/40',
      )}
    >
      {on && <Check size={11} strokeWidth={3} />}
      {!on && half && <span className="h-0.5 w-2 rounded-full bg-accent-hover" />}
    </span>
  );
}
