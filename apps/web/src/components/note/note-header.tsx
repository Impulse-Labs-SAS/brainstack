'use client';

// The bar above a note: where it is (breadcrumbs), how to go back, whether it
// is saved, who else can see it, how to view it, and everything else in ⋯.

import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Eye,
  Lock,
  PanelLeft,
  PanelRight,
  Pencil,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { ViewMode } from '@/lib/use-view-mode';

export const REVEAL_FOLDER_EVENT = 'brainstack:reveal-folder';

export interface NoteMenuItem {
  label: string;
  icon: LucideIcon;
  run(): void;
  danger?: boolean;
}

interface NoteHeaderProps {
  title: string;
  /** Folders above the note, outermost first, each with its full path. */
  crumbs: Array<{ label: string; path: string }>;
  /** Shown instead of folder crumbs for a note somebody shared. */
  owner?: { name: string; color?: string } | null;
  status: { kind: 'saving' | 'saved' | 'idle' | 'readonly'; text: string };
  mode: ViewMode;
  onMode(m: ViewMode): void;
  readOnly?: boolean;
  share?: { count: number; folder: string; onOpen(): void } | null;
  connections: { open: boolean; count: number; summary: string; onToggle(): void };
  treeHidden: boolean;
  onToggleTree(): void;
  menu: NoteMenuItem[];
  mod: string;
}

function IconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string;
  onClick(): void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg-primary',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function NoteHeader({
  title,
  crumbs,
  owner,
  status,
  mode,
  onMode,
  readOnly,
  share,
  connections,
  treeHidden,
  onToggleTree,
  menu,
  mod,
}: NoteHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // What fits depends on the note column, not the window: the tree and the
  // connections panel take their share first. So the bar measures itself.
  const barRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(1024);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fits = (min: number) => width >= min;

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const modes: Array<[ViewMode, LucideIcon, string]> = [
    ['edit', Pencil, 'Edit'],
    ['preview', Eye, 'Preview'],
  ];

  return (
    <div ref={barRef} className="flex h-12 shrink-0 items-center gap-1 border-b border-border-subtle pl-10 pr-2 md:pl-2">
      <Link
        href="/notes"
        title="Back to notes"
        aria-label="Back to notes"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg-primary md:hidden"
      >
        <ChevronLeft size={16} />
      </Link>
      <IconButton
        label={`${treeHidden ? 'Show' : 'Hide'} the notes sidebar (${mod}+\\)`}
        onClick={onToggleTree}
        className="hidden md:grid"
      >
        <PanelLeft size={15} strokeWidth={1.75} />
      </IconButton>
      <span className={cn('items-center', fits(560) ? 'flex' : 'hidden')}>
        <IconButton label="Back (Alt+←)" onClick={() => window.history.back()}>
          <ChevronLeft size={15} />
        </IconButton>
        <IconButton label="Forward (Alt+→)" onClick={() => window.history.forward()}>
          <ChevronRight size={15} />
        </IconButton>
      </span>

      <nav aria-label="Breadcrumb" className="ml-1 flex min-w-0 flex-1 items-center gap-1 text-[13px]">
        {owner ? (
          <span
            className={cn('shrink-0 items-center gap-1.5 text-fg-secondary', fits(480) ? 'flex' : 'hidden')}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: owner.color ?? 'var(--fg-muted)' }}
            />
            {owner.name}
            <span className="text-fg-disabled">/</span>
          </span>
        ) : (
          crumbs.map((c) => (
            <span
              key={c.path}
              className={cn('shrink-0 items-center gap-1', fits(480) ? 'flex' : 'hidden')}
            >
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent(REVEAL_FOLDER_EVENT, { detail: c.path }))
                }
                title={`Show ${c.path} in the sidebar`}
                className="max-w-[160px] truncate rounded px-1 py-0.5 text-fg-muted hover:bg-bg-hover hover:text-fg-primary"
              >
                {c.label}
              </button>
              <span className="text-fg-disabled">/</span>
            </span>
          ))
        )}
        <span className="truncate px-1 font-medium text-fg-primary" title={title}>
          {title}
        </span>
      </nav>

      <span
        className={cn(
          'shrink-0 items-center gap-1.5 whitespace-nowrap px-1 font-mono text-[11px] text-fg-muted',
          fits(420) ? 'flex' : 'hidden',
        )}
        title={status.text}
        aria-live="polite"
      >
        {status.kind === 'readonly' ? (
          <Lock size={12} />
        ) : (
          <span
            aria-hidden
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              status.kind === 'saving' && 'animate-pulse bg-warning',
              status.kind === 'saved' && 'bg-success',
              status.kind === 'idle' && 'bg-fg-disabled',
            )}
          />
        )}
        {fits(640) && <span>{status.text}</span>}
      </span>

      {share && fits(420) && (
        <button
          type="button"
          onClick={share.onOpen}
          title={`“${share.folder}” is shared with ${share.count} ${share.count === 1 ? 'person' : 'people'}`}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent/15 px-2 text-xs font-medium text-accent-hover hover:bg-accent/25"
        >
          <Users size={13} />
          {fits(760) && <span>Shared</span>}
          {share.count}
        </button>
      )}

      <div
        role="group"
        aria-label="View mode"
        className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-bg-surface p-0.5"
      >
        {modes.map(([m, Icon, label]) => (
          <button
            key={m}
            type="button"
            onClick={() => onMode(m)}
            disabled={readOnly && m === 'edit'}
            aria-pressed={mode === m}
            title={readOnly && m === 'edit' ? 'Read only' : `${label} (${mod}+E)`}
            className={cn(
              'flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
              mode === m ? 'bg-bg-elevated text-fg-primary' : 'text-fg-muted hover:text-fg-primary',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            <Icon size={13} strokeWidth={1.75} />
            {fits(760) && <span>{label}</span>}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={connections.onToggle}
        aria-pressed={connections.open}
        title={`Connections (${mod}+.) · ${connections.summary}`}
        className={cn(
          'flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border px-2 text-xs font-medium',
          connections.open
            ? 'border-border-strong bg-bg-elevated text-fg-primary'
            : 'border-border text-fg-secondary hover:border-border-strong hover:text-fg-primary',
        )}
      >
        <PanelRight size={14} strokeWidth={1.75} />
        {fits(760) && <span>Connections</span>}
        <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent/15 px-1 font-mono text-[10.5px] text-accent-hover">
          {connections.count}
        </span>
      </button>

      {menu.length > 0 && (
        <div className="relative">
          <IconButton label="More actions" onClick={() => setMenuOpen((o) => !o)}>
            <Ellipsis size={15} />
          </IconButton>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-[60]" onClick={() => setMenuOpen(false)} />
              <div
                ref={menuRef}
                role="menu"
                className="absolute right-0 top-9 z-[61] w-[230px] rounded-lg border border-border bg-bg-elevated p-1 shadow-2xl"
                onKeyDown={(e) => {
                  const items = [
                    ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
                  ];
                  const i = items.indexOf(document.activeElement as HTMLButtonElement);
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    items[(i + 1) % items.length]?.focus();
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    items[(i - 1 + items.length) % items.length]?.focus();
                  }
                }}
              >
                {menu.map((item, i) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label}>
                      {item.danger && i > 0 && <div className="mx-0.5 my-1 h-px bg-border" />}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          item.run();
                        }}
                        className={cn(
                          'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none',
                          item.danger
                            ? 'text-red-400 hover:bg-red-500/10 focus-visible:bg-red-500/10'
                            : 'text-fg-secondary hover:bg-bg-hover hover:text-fg-primary focus-visible:bg-bg-hover focus-visible:text-fg-primary',
                        )}
                      >
                        <Icon size={14} strokeWidth={1.75} />
                        <span className="truncate">{item.label}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
