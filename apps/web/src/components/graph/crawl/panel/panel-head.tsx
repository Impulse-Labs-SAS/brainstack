'use client';

// The top of the Sentinel panel: what was asked, to edit and search again or
// to leave for a new search at the prompt; the recent searches, an
// assistant's among them, behind the clock; and the view's options behind the
// dots.

import { Bot, ChevronLeft, Clock, MoreHorizontal, Pencil, Plus, Search, User } from 'lucide-react';
import type { KeyboardEvent, ReactNode, Ref } from 'react';
import {
  Button,
  Dialog,
  DialogTrigger,
  Popover,
  Switch,
  TextArea,
  TextField,
} from 'react-aria-components';

import { cn } from '@/lib/utils';

import { GLASS } from '../../graph-preview';
import { ago, madeBy, type RecentCrawl } from '../crawl-history';

import { Eyebrow, FOCUS_RING, IconButton } from './panel-ui';

export interface HistoryProps {
  items: readonly RecentCrawl[] | undefined;
  now: number;
  /** Searches played in this browser: an assistant's are new until then. */
  seen: ReadonlySet<string>;
  activeId: string | null;
  /** The server keeps a history at all. */
  enabled: boolean;
  onOpen(id: string): void;
}

/** Recent searches the panel lists; the prompt shows fewer. */
const RECENT_SHOWN = 8;

const POPOVER = cn(GLASS, 'w-[300px] max-w-[calc(100vw-1.5rem)] rounded-lg p-1.5 text-sm shadow-2xl outline-none');

export function PanelHead({
  question,
  editing,
  draft,
  busy,
  onDraft,
  onEdit,
  onCancelEdit,
  onRun,
  onNew,
  history,
  sentinelOn,
  onSentinel,
  trail,
  onCollapse,
  status,
  error,
  headingRef,
}: {
  /** Takes focus as the walk begins: the prompt the caret was in has gone inert. */
  headingRef: Ref<HTMLHeadingElement>;
  question: string;
  editing: boolean;
  draft: string;
  /** A search on its way: Search again waits. */
  busy: boolean;
  onDraft(text: string): void;
  onEdit(): void;
  onCancelEdit(): void;
  onRun(): void;
  onNew(): void;
  history: HistoryProps;
  sentinelOn: boolean;
  onSentinel(on: boolean): void;
  /** Why the walk shows as a trail of light, or null where the Sentinel runs. */
  trail: string | null;
  /** On a wide screen, folds the panel to a strip. */
  onCollapse?: () => void;
  status?: ReactNode;
  error: string | null;
}) {
  const fresh = (history.items ?? []).some((c) => c.source === 'assistant' && !history.seen.has(c.id));
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onRun();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancelEdit();
    }
  };

  return (
    <div className="grid gap-2.5 border-b border-border-subtle p-3">
      <div className="flex items-center justify-between">
        <h2 ref={headingRef} tabIndex={-1} className="outline-none">
          <Eyebrow>Sentinel</Eyebrow>
        </h2>
        <div className="flex gap-0.5">
          <DialogTrigger>
            <Button aria-label="Recent searches" className={cn('relative flex h-7 w-7 items-center justify-center rounded-md text-fg-secondary hover:bg-bg-hover hover:text-fg-primary pressed:bg-bg-hover', FOCUS_RING)}>
              <Clock size={15} aria-hidden />
              {fresh && (
                <span aria-label="(new)" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </Button>
            <Popover placement="bottom end" offset={6} className={POPOVER}>
              <Dialog aria-label="Recent searches" className="outline-none">
                {({ close }) => (
                  <RecentList
                    history={history}
                    onOpen={(id) => {
                      close();
                      history.onOpen(id);
                    }}
                  />
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
          <DialogTrigger>
            <Button aria-label="Sentinel options" className={cn('flex h-7 w-7 items-center justify-center rounded-md text-fg-secondary hover:bg-bg-hover hover:text-fg-primary pressed:bg-bg-hover', FOCUS_RING)}>
              <MoreHorizontal size={15} aria-hidden />
            </Button>
            <Popover placement="bottom end" offset={6} className={POPOVER}>
              <Dialog aria-label="Sentinel options" className="grid gap-1 outline-none">
                <Switch
                  isSelected={sentinelOn}
                  onChange={onSentinel}
                  className="group flex cursor-pointer items-center justify-between gap-3 rounded-md p-2 outline-none hover:bg-bg-hover"
                >
                  <span className="grid">
                    <span className="text-[13px] text-fg-primary">Show the Sentinel</span>
                    <span className="text-[11.5px] leading-4 text-fg-muted">
                      Off, the walk shows as light alone.
                    </span>
                  </span>
                  <span className="relative h-5 w-9 shrink-0 rounded-full bg-bg-hover transition-colors group-selected:bg-accent group-focus-visible:ring-2 group-focus-visible:ring-accent/40">
                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-fg-primary transition-transform group-selected:translate-x-4" />
                  </span>
                </Switch>
                {trail && (
                  <p className="px-2 pb-1.5 text-[11.5px] leading-4 text-fg-muted">
                    The Sentinel cannot run here ({trail}), so the walk shows as a trail of light.
                  </p>
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
          {onCollapse && (
            <IconButton label="Fold the panel" onPress={onCollapse}>
              <ChevronLeft size={15} aria-hidden />
            </IconButton>
          )}
        </div>
      </div>

      {editing ? (
        <>
          <TextField value={draft} onChange={onDraft} aria-label="Your question" autoFocus className="grid">
            <TextArea
              rows={3}
              onKeyDown={onKeyDown}
              className="w-full resize-y rounded-md border border-accent bg-bg-base px-2.5 py-2 text-[13px] leading-5 text-fg-primary outline-none"
            />
          </TextField>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onPress={onRun}
              isDisabled={!draft.trim() || busy}
              className={cn('flex h-7 items-center gap-1.5 rounded-md bg-accent px-2.5 text-[12.5px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40', FOCUS_RING)}
            >
              <Search size={13} aria-hidden />
              {busy ? 'Searching…' : 'Search again'}
            </Button>
            <Button onPress={onCancelEdit} className={cn('text-[12px] text-fg-secondary hover:text-fg-primary', FOCUS_RING)}>
              Cancel
            </Button>
            <span className="ml-auto font-mono text-[10.5px] text-fg-muted">Ctrl+Enter</span>
          </div>
        </>
      ) : (
        <>
          <p className="line-clamp-3 break-words text-[13.5px] leading-5 text-fg-primary" title={question}>
            {question || '—'}
          </p>
          {/* New search outranks editing — a way out to a fresh question — but stays an
              outline: Copy prompt is the panel's one filled action. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button onPress={onEdit} className={cn('flex items-center gap-1.5 text-[12px] text-fg-secondary hover:text-fg-primary', FOCUS_RING)}>
              <Pencil size={12} aria-hidden />
              Edit question
            </Button>
            <Button
              onPress={onNew}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md border border-border-strong px-2.5 text-[12.5px] font-medium text-fg-primary',
                'hover:border-fg-muted hover:bg-bg-hover pressed:bg-bg-elevated',
                FOCUS_RING,
              )}
            >
              <Plus size={13} aria-hidden />
              New search
            </Button>
          </div>
        </>
      )}
      {status}
      {error && <p className="text-[12.5px] text-danger">{error}</p>}
    </div>
  );
}

function RecentList({ history, onOpen }: { history: HistoryProps; onOpen(id: string): void }) {
  const items = history.items ?? [];
  return (
    <div className="grid gap-0.5">
      <span className="px-2 pb-0.5 pt-1.5">
        <Eyebrow>Recent searches</Eyebrow>
      </span>
      {items.length === 0 && (
        <p className="px-2 py-1.5 text-[12.5px] text-fg-muted">No searches yet.</p>
      )}
      <ul className="grid max-h-[min(360px,60vh)] gap-0.5 overflow-y-auto">
        {items.slice(0, RECENT_SHOWN).map((c) => {
          const isNew = c.source === 'assistant' && !history.seen.has(c.id);
          return (
            <li key={c.id}>
              <Button
                onPress={() => onOpen(c.id)}
                aria-current={c.id === history.activeId ? 'true' : undefined}
                className={cn(
                  'grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-bg-hover',
                  c.id === history.activeId && 'bg-accent/10',
                  FOCUS_RING,
                )}
              >
                <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-muted">
                  {c.source === 'assistant' ? <Bot size={12} aria-hidden /> : <User size={12} aria-hidden />}
                  <span className="truncate">{madeBy(c)}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0">{ago(c.createdAt, history.now)}</span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0 tabular-nums">
                    {c.notes} {c.notes === 1 ? 'note' : 'notes'}
                  </span>
                  {isNew && (
                    <span className="ml-auto shrink-0 rounded bg-accent/15 px-1 text-[9.5px] uppercase tracking-wider text-accent-hover">
                      new
                    </span>
                  )}
                </span>
                <span className="line-clamp-2 break-words text-[12.5px] leading-[17px] text-fg-primary">
                  {c.prompt}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="px-2 pb-1.5 pt-1 text-[11.5px] leading-4 text-fg-muted">
        {history.enabled
          ? 'What your assistants search over MCP shows up here too.'
          : 'Search history is off on this server: assistants’ searches are not kept.'}
      </p>
    </div>
  );
}
