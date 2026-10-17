'use client';

// The panel a click opens beside the graph: a note with where it is filed, its first lines and
// every connection it has, a topic with the notes that carry it, or the path between two notes.
// The graph stays on screen; opening the note is one more click, or Enter.

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button as AriaButton, type PressEvent } from 'react-aria-components';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { colorOf, foreignOwner, type EdgeKind, type GraphModel, type GraphNode } from '@/lib/graph-model';
import { connectionGroups, crumbsOf, type Crumb } from '@/lib/graph-sheet';
import { excerpt } from '@/lib/note-excerpt';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import type { Selection } from './graph-controller';

export const GLASS = 'glass border border-border-subtle backdrop-blur-md';
/**
 * The controls that float over the graph's canvas — the views, zoom, the
 * replay — as glass the scene shows through: a lighter tint, a deeper blur
 * that keeps the colour behind it, a lit top edge and a soft drop shadow, so
 * they sit in the space rather than on top of it as flat panels.
 */
export const FLOAT_GLASS = 'float-glass border backdrop-blur-xl backdrop-saturate-150';

const KIND_LABEL: Record<EdgeKind, string> = { link: 'link', structure: 'index', affinity: 'shared topic', topic: 'topic' };
/** Past this many connections the sheet offers a filter. */
const FILTER_FROM = 8;
/** Rows a group shows before "Show all": a hub's hundreds would bury the groups after it. */
const GROUP_SHOWN = 20;
/** A note's first lines are kept this long: walking with the arrows reads nothing twice. */
const EXCERPT_STALE_MS = 30_000;
const CRUMB_ACTION: Record<Crumb['kind'], string> = { vault: 'the vault', project: 'the project', folder: 'the folder' };
/**
 * The sheet's heading: where a pick made from the keyboard leaves focus (graph-view), so the new
 * title is read out and Tab goes on from it. Not in the tab order; the ring shows only then.
 */
const HEADING_FOCUS = 'rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
export function edited(updatedAt: number): string {
  const days = Math.round((updatedAt - Date.now()) / 86_400_000);
  if (days > -14) return `edited ${relative.format(days, 'day')}`;
  if (days > -60) return `edited ${relative.format(Math.round(days / 7), 'week')}`;
  if (days > -365) return `edited ${relative.format(Math.round(days / 30), 'month')}`;
  return `edited ${relative.format(Math.round(days / 365), 'year')}`;
}
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });

function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />;
}

function KindGlyph({ kind }: { kind: EdgeKind }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block w-3 shrink-0 border-t',
        kind === 'link' && 'border-fg-secondary',
        kind === 'structure' && 'border-fg-muted',
        kind === 'topic' && 'border-fg-muted',
        kind === 'affinity' && 'border-t-2 border-dotted border-fg-secondary',
      )}
    />
  );
}

interface GraphPreviewProps {
  selection: Selection;
  model: GraphModel;
  /** A connection or a step of the path, with the press that picked it: focus follows a keyboard's. */
  onSelect(node: GraphNode, e: PressEvent): void;
  onOpen(node: GraphNode): void;
  /** Trace a path from the note; without it (line art, for now) the button is not offered. */
  onPathFrom?(node: GraphNode): void;
  /** Back to what was selected before: offered while `selection.back` names it. */
  onBack(e: PressEvent): void;
  /** A step up from the note — its folder, project or vault — brought into view. */
  onFrame(notes: readonly GraphNode[]): void;
  onClose(): void;
  /** Read each note's first lines from the server: off where the vault is invented (the bench). */
  excerpts: boolean;
  /** Which keys walk a note's links: the arrows, or in line art (whose arrows move on the map) the brackets. */
  walk?: 'arrows' | 'brackets';
}

export function GraphPreview({ selection, model, onSelect, onOpen, onPathFrom, onBack, onFrame, onClose, excerpts, walk = 'arrows' }: GraphPreviewProps) {
  return (
    <aside
      data-graph-chrome
      data-graph-sheet
      aria-label={selection.kind === 'path' ? 'Path between notes' : 'Note preview'}
      className={cn(
        GLASS,
        'absolute z-20 flex flex-col gap-2.5 overflow-y-auto rounded-lg p-3.5 text-sm',
        'inset-x-2 bottom-2 max-h-[52%] md:inset-x-auto md:bottom-auto md:right-3 md:top-14 md:max-h-[calc(100%-11rem)] md:w-[310px]',
      )}
    >
      {/*
        What a screen reader hears when the selection changes: its name, not the whole sheet. The
        sheet itself is not live: its lists run long, grow with "Show all" and change with the
        filter, and the note's first lines arrive after it.
      */}
      <p role="status" className="sr-only">
        {selection.kind === 'path'
          ? `Path between ${selection.path.nodes[0]?.label ?? ''} and ${selection.path.nodes.at(-1)?.label ?? ''}`
          : selection.node.label}
      </p>
      {selection.kind === 'path' ? (
        <PathBody selection={selection} model={model} onSelect={onSelect} onBack={onBack} onClose={onClose} />
      ) : (
        <NodeBody
          node={selection.node}
          back={selection.back}
          model={model}
          excerpts={excerpts}
          walk={walk}
          onSelect={onSelect}
          onOpen={onOpen}
          onPathFrom={onPathFrom}
          onBack={onBack}
          onFrame={onFrame}
          onClose={onClose}
        />
      )}
    </aside>
  );
}

function Header({
  children,
  heading = false,
  back,
  onBack,
  onClose,
}: {
  children: ReactNode;
  /** This line is the sheet's heading: a path has no title of its own. */
  heading?: boolean;
  back?: string;
  onBack(e: PressEvent): void;
  onClose(): void;
}) {
  const Title = heading ? 'h3' : 'div';
  return (
    <div className="flex items-center justify-between gap-2">
      {back && (
        // The title goes on a wrapper: react-aria's Button drops one of its own.
        <span title={`Back to ${back}`} className="flex shrink-0">
          <AriaButton
            onPress={onBack}
            aria-label={`Back to ${back}`}
            className="flex items-center gap-0.5 rounded p-1 text-xs text-fg-tertiary outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 touch:h-11 touch:min-w-11 touch:justify-center"
          >
            <ChevronLeft size={14} aria-hidden />
            Back
          </AriaButton>
        </span>
      )}
      <Title
        tabIndex={heading ? -1 : undefined}
        className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-xs text-fg-secondary', heading && cn('truncate', HEADING_FOCUS))}
      >
        {children}
      </Title>
      <AriaButton onPress={onClose} aria-label="Close preview" className="rounded p-1 text-fg-muted outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 touch:flex touch:h-11 touch:w-11 touch:items-center touch:justify-center">
        <X size={14} />
      </AriaButton>
    </div>
  );
}

function NodeBody({
  node,
  back,
  model,
  excerpts,
  walk,
  onSelect,
  onOpen,
  onPathFrom,
  onBack,
  onFrame,
  onClose,
}: {
  node: GraphNode;
  back?: string;
  model: GraphModel;
  excerpts: boolean;
  walk: 'arrows' | 'brackets';
  onSelect(node: GraphNode, e: PressEvent): void;
  onOpen(node: GraphNode): void;
  onPathFrom?(node: GraphNode): void;
  onBack(e: PressEvent): void;
  onFrame(notes: readonly GraphNode[]): void;
  onClose(): void;
}) {
  const topic = node.kind === 'topic';
  return (
    <>
      <Header back={back} onBack={onBack} onClose={onClose}>
        <Crumbs node={node} model={model} onFrame={onFrame} />
      </Header>
      <h3 tabIndex={-1} className={cn('text-lg font-semibold leading-tight tracking-tight text-fg-primary', HEADING_FOCUS)}>
        {node.label}
      </h3>
      {topic ? (
        <p className="text-xs text-fg-secondary">Carried by {node.carriers} notes in your vault</p>
      ) : (
        <>
          {excerpts && <NoteExcerpt node={node} />}
          <p className="text-xs text-fg-secondary">
            Created {dateFormat.format(node.createdAt)} · {edited(node.updatedAt)}
          </p>
          {node.topics.length > 0 && (
            <ul className="flex flex-wrap gap-1" aria-label="Topics">
              {node.topics.slice(0, 8).map((t) => (
                <li key={t} className="rounded-full border border-border-subtle bg-bg-elevated px-2 font-mono text-[11px] text-fg-secondary">
                  {t}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {/* Above the connections, which may run long: what you came to do stays in reach. */}
      <div className="flex flex-wrap gap-1.5">
        {!topic && (
          <Button intent="primary" size="sm" className="touch:h-11" onPress={() => onOpen(node)}>
            Open note <Kbd className="h-4 border-white/25 bg-white/15 text-white">↵</Kbd>
          </Button>
        )}
        {onPathFrom && (
          <Button size="sm" className="touch:h-11" onPress={() => onPathFrom(node)}>
            Path from here
          </Button>
        )}
      </div>
      {/* Keyed by the note: the filter and what was shown in full belong to the note they were for. */}
      <Connections key={node.id} node={node} model={model} onSelect={onSelect} />
      <p className="text-[11px] text-fg-tertiary">{walk === 'brackets' ? '] and [ walk its links' : 'Arrows walk its links'}{back ? ' · Backspace goes back' : ''} · Esc closes</p>
    </>
  );
}

/** Where the note is filed, from its vault down: each step brings the notes under it into view. */
function Crumbs({ node, model, onFrame }: { node: GraphNode; model: GraphModel; onFrame(notes: readonly GraphNode[]): void }) {
  const crumbs = useMemo(() => crumbsOf(model, node), [model, node]);
  return (
    <nav aria-label="Where it is filed" className="flex min-w-0 items-center gap-1">
      <Swatch color={colorOf(model, node).hue} />
      <ol className="flex min-w-0 flex-wrap items-center gap-y-0.5">
        {crumbs.map((c, i) => (
          // The title on the item: react-aria's Button drops one of its own, and a long name is cut.
          <li key={`${c.kind}:${i}`} title={c.label} className="flex min-w-0 items-center">
            {i > 0 && <ChevronRight size={11} aria-hidden className="shrink-0 text-fg-muted" />}
            <AriaButton
              onPress={() => onFrame(c.notes)}
              aria-label={`Show ${CRUMB_ACTION[c.kind]} ${c.label} on the graph`}
              className="max-w-[9rem] truncate rounded px-1 py-0.5 text-left text-xs text-fg-secondary outline-none hover:bg-bg-hover hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 touch:min-h-11"
            >
              {c.label}
            </AriaButton>
          </li>
        ))}
        {node.kind === 'topic' && <li className="pl-1 text-xs text-fg-tertiary">· topic</li>}
      </ol>
    </nav>
  );
}

/** The note's first lines, read when it is picked: through the sharing service, as every read is. */
function NoteExcerpt({ node }: { node: GraphNode }) {
  const owner = foreignOwner(node);
  const options = { staleTime: EXCERPT_STALE_MS, retry: false };
  // Someone else's note through the same query its own page reads it with, which that page
  // refreshes when it saves: read another way, an edit there left these lines stale.
  const own = trpc.notes.get.useQuery({ path: node.path }, { ...options, enabled: !owner });
  const shared = trpc.notes.getForOwner.useQuery(
    { ownerId: owner ?? '', path: node.path },
    { ...options, enabled: !!owner },
  );
  const note = owner ? shared : own;
  // A note that cannot be read here says nothing more: its title and dates are still there.
  if (note.isError) return null;
  const text = note.data ? excerpt(note.data.body) : '';
  return (
    // While it is read, as tall as the lines it may bring: the buttons below do not jump mid-tap.
    <p
      className={cn(
        'line-clamp-4 text-[12.5px] leading-[19px] text-fg-secondary [overflow-wrap:anywhere]',
        note.isPending && 'min-h-[76px]',
      )}
    >
      {note.isPending ? (
        <span className="text-fg-tertiary">Reading the note…</span>
      ) : (
        text || <span className="text-fg-tertiary">Empty note.</span>
      )}
    </p>
  );
}

/** Every connection, grouped by kind, with a filter once there are more than a few. */
function Connections({ node, model, onSelect }: { node: GraphNode; model: GraphModel; onSelect(node: GraphNode, e: PressEvent): void }) {
  const [query, setQuery] = useState('');
  const [full, setFull] = useState<ReadonlySet<string>>(new Set());
  const total = model.adjacency.get(node)?.length ?? 0;
  const groups = useMemo(() => connectionGroups(model, node, query), [model, node, query]);
  const filtering = query.trim() !== '';
  const matched = useMemo(() => new Set(groups.flatMap((g) => g.items.map((i) => i.node))).size, [groups]);
  const topic = node.kind === 'topic';
  // "Show all" goes as it is pressed, and focus would go with it, out of the stage, where no key
  // reaches the graph: it lands on the first row it revealed instead.
  const listRef = useRef<HTMLDivElement | null>(null);
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    const key = revealed.current;
    if (!key) return;
    revealed.current = null;
    listRef.current?.querySelector<HTMLElement>(`[data-group="${key}"] li:nth-child(${GROUP_SHOWN + 1}) button`)?.focus();
  });
  return (
    <div ref={listRef} className="contents">
      <div className="border-t border-border-subtle pt-2 font-mono text-[11px] uppercase tracking-wider text-fg-tertiary">
        {topic ? 'Notes' : 'Connections'} <span className="text-fg-secondary">{total}</span>
      </div>
      {total > FILTER_FROM && (
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Escape empties the filter first; with nothing in it, the sheet's own Escape is next
            // (graph-view lets it through from here). Not while an IME is composing: it is its.
            if (e.key !== 'Escape' || e.nativeEvent.isComposing || !query) return;
            setQuery('');
            e.preventDefault();
            e.stopPropagation();
          }}
          placeholder={topic ? 'Filter its notes' : 'Filter connections'}
          aria-label={topic ? 'Filter its notes' : 'Filter connections'}
          className="h-8 bg-bg-elevated text-xs placeholder:text-fg-tertiary touch:h-11"
        />
      )}
      <p role="status" className="sr-only">
        {filtering ? `${matched} of ${total} ${topic ? 'notes' : 'connections'} match` : ''}
      </p>
      {groups.map((g) => {
        const shown = filtering || full.has(g.key) ? g.items : g.items.slice(0, GROUP_SHOWN);
        return (
          <div key={g.key} data-group={g.key} className="grid gap-px">
            <h4 className="px-1.5 pt-1 font-mono text-[10.5px] uppercase tracking-wider text-fg-tertiary">
              {g.label} <span className="text-fg-secondary">{g.items.length}</span>
            </h4>
            <ul className="grid gap-px">
              {shown.map(({ node: other, edge }) => (
                <li key={`${other.id}:${edge.kind}:${edge.source === node ? 'out' : 'in'}`}>
                  <AriaButton
                    onPress={(e) => onSelect(other, e)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/40 touch:min-h-11"
                  >
                    <KindGlyph kind={edge.kind} />
                    <span className="min-w-0 flex-1 truncate text-fg-primary">{other.label}</span>
                    <span className="max-w-[40%] shrink-0 truncate text-[11px] text-fg-tertiary">
                      {edge.kind === 'affinity'
                        ? edge.shared.slice(0, 2).join(', ')
                        : other.vault !== node.vault
                          ? (model.vaults.find((v) => v.id === other.vault)?.label ?? '')
                          : ''}
                    </span>
                  </AriaButton>
                </li>
              ))}
            </ul>
            {shown.length < g.items.length && (
              <AriaButton
                onPress={() => {
                  revealed.current = g.key;
                  setFull(new Set(full).add(g.key));
                }}
                className="justify-self-start rounded px-1.5 py-1 text-xs text-fg-tertiary outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40 touch:min-h-11"
              >
                Show all {g.items.length}
              </AriaButton>
            )}
          </div>
        );
      })}
      {filtering && !groups.length && (
        <p className="px-1.5 text-xs text-fg-tertiary [overflow-wrap:anywhere]">
          No connection’s title has “{query.trim()}” in it.
        </p>
      )}
    </div>
  );
}

function PathBody({
  selection,
  model,
  onSelect,
  onBack,
  onClose,
}: {
  selection: Extract<Selection, { kind: 'path' }>;
  model: GraphModel;
  onSelect(node: GraphNode, e: PressEvent): void;
  onBack(e: PressEvent): void;
  onClose(): void;
}) {
  const { path } = selection;
  const hops = path.edges.length;
  return (
    <>
      <Header heading back={selection.back} onBack={onBack} onClose={onClose}>
        How they connect · {hops} {hops === 1 ? 'hop' : 'hops'}
      </Header>
      <ol className="grid gap-px">
        {path.nodes.map((node, i) => {
          const edge = path.edges[i - 1];
          return (
            <li key={node.id}>
              {edge && (
                <span className="block pl-6 font-mono text-[11px] text-fg-tertiary">
                  {KIND_LABEL[edge.kind]}
                  {edge.shared.length ? `: ${edge.shared.slice(0, 2).join(', ')}` : ''}
                </span>
              )}
              <AriaButton
                onPress={(e) => onSelect(node, e)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/40 touch:min-h-11"
              >
                <Swatch color={colorOf(model, node).hue} />
                <span className="min-w-0 flex-1 truncate text-fg-primary">{node.label}</span>
                <span className="shrink-0 text-[11px] text-fg-tertiary">{node.kind === 'topic' ? 'topic' : node.project?.label}</span>
              </AriaButton>
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] text-fg-tertiary">
        {path.implicit ? 'Goes through a shared topic somewhere: nobody linked the whole way.' : 'Only links people wrote.'} Shift+click
        another note for another path.
      </p>
    </>
  );
}
