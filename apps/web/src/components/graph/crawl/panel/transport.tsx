'use client';

// The walk's controls, over the stage rather than in the panel: they play the
// replay, not the search. Pause, from the start again, straight to the end,
// and follow the Sentinel again once the person has moved the camera.

import { Crosshair, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { Button } from 'react-aria-components';

import { cn } from '@/lib/utils';

import { GLASS } from '../../graph-preview';
import type { CrawlSnapshot } from '../crawl-snapshot';

import { FOCUS_RING } from './panel-ui';

export function Transport({
  snap,
  playing,
  onPlaying,
  onReplay,
  onSkip,
  onFollow,
  className,
  style,
}: {
  snap: CrawlSnapshot;
  playing: boolean;
  onPlaying(on: boolean): void;
  onReplay(): void;
  onSkip(): void;
  onFollow(): void;
  className?: string;
  style?: CSSProperties;
}) {
  const done = snap.state === 'done';
  return (
    <div
      role="group"
      aria-label="Replay"
      className={cn(GLASS, 'pointer-events-auto flex items-center gap-0.5 rounded-full p-1 shadow-2xl', className)}
      style={style}
    >
      <TransportButton
        label={playing && !done ? 'Pause' : 'Resume'}
        onPress={() => onPlaying(!playing)}
        isDisabled={done}
      >
        {playing && !done ? <Pause size={15} /> : <Play size={15} />}
      </TransportButton>
      <TransportButton label="Replay" onPress={onReplay}>
        <RotateCcw size={15} />
      </TransportButton>
      <TransportButton label="Skip to the end" onPress={onSkip} isDisabled={done}>
        <SkipForward size={15} />
      </TransportButton>
      <span aria-hidden className="mx-1 h-[18px] w-px bg-border" />
      <TransportButton
        label="Follow the Sentinel"
        onPress={onFollow}
        isDisabled={snap.following}
        hot={!snap.following}
      >
        <Crosshair size={15} />
      </TransportButton>
    </div>
  );
}

function TransportButton({
  label,
  onPress,
  isDisabled,
  hot = false,
  children,
}: {
  label: string;
  onPress(): void;
  isDisabled?: boolean;
  hot?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      aria-label={label}
      onPress={onPress}
      isDisabled={isDisabled}
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full text-fg-secondary hover:bg-bg-hover hover:text-fg-primary disabled:opacity-35',
        hot && 'bg-accent/15 text-accent-hover',
        FOCUS_RING,
      )}
    >
      {children}
    </Button>
  );
}
