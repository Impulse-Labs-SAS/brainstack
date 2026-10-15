'use client';

// The panel a click opens beside the graph: a note with its connections, a
// topic with the notes that carry it, or the path between two notes. The
// graph stays on screen; opening the note is one more click, or Enter.

import { ChevronLeft, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button as AriaButton, type PressEvent } from 'react-aria-components';

import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { colorOf, type EdgeKind, type GraphModel, type GraphNode } from '@/lib/graph-model';
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
const KIND_RANK: Record<EdgeKind, number> = { link: 0, structure: 1, topic: 2, affinity: 3 };
const MAX_LISTED = 12;
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
  onPathFrom(node: GraphNode): void;
  /** Back to what was selected before: offered while `selection.back` names it. */
  onBack(e: PressEvent): void;
  onClose(): void;
}

export function GraphPreview({ selection, model, onSelect, onOpen, onPathFrom, onBack, onClose }: GraphPreviewProps) {
  return (
    <aside
      data-graph-chrome
      data-graph-sheet
      aria-live="polite"
      aria-label={selection.kind === 'path' ? 'Path between notes' : 'Note preview'}
      className={cn(
        GLASS,
        'absolute z-20 flex flex-col gap-2.5 overflow-y-auto rounded-lg p-3.5 text-sm',
        'inset-x-2 bottom-2 max-h-[52%] md:inset-x-auto md:bottom-auto md:right-3 md:top-14 md:max-h-[calc(100%-11rem)] md:w-[310px]',
      )}
    >
      {selection.kind === 'path' ? (
        <PathBody selection={selection} model={model} onSelect={onSelect} onBack={onBack} onClose={onClose} />
      ) : (
        <NodeBody node={selection.node} back={selection.back} model={model} onSelect={onSelect} onOpen={onOpen} onPathFrom={onPathFrom} onBack={onBack} onClose={onClose} />
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
  const Title = heading ? 'h3' : 'span';
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
        className={cn('flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs text-fg-secondary', heading && HEADING_FOCUS)}
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
  onSelect,
  onOpen,
  onPathFrom,
  onBack,
  onClose,
}: {
  node: GraphNode;
  back?: string;
  model: GraphModel;
  onSelect(node: GraphNode, e: PressEvent): void;
  onOpen(node: GraphNode): void;
  onPathFrom(node: GraphNode): void;
  onBack(e: PressEvent): void;
  onClose(): void;
}) {
  const vault = model.vaults.find((v) => v.id === node.vault);
  const neighbours = [...(model.adjacency.get(node) ?? [])].sort(
    (a, b) => KIND_RANK[a.edge.kind] - KIND_RANK[b.edge.kind] || b.node.size - a.node.size,
  );
  const topic = node.kind === 'topic';
  return (
    <>
      <Header back={back} onBack={onBack} onClose={onClose}>
        <Swatch color={colorOf(model, node).hue} />
        <span className="truncate">
          {vault?.label}
          {topic ? ' · topic' : node.project ? ` · ${node.project.label}` : ''}
        </span>
      </Header>
      <h3 tabIndex={-1} className={cn('text-lg font-semibold leading-tight tracking-tight text-fg-primary', HEADING_FOCUS)}>
        {node.label}
      </h3>
      {topic ? (
        <p className="text-xs text-fg-secondary">Carried by {node.carriers} notes in your vault</p>
      ) : (
        <>
          <p className="break-all font-mono text-[11px] text-fg-tertiary">{node.path}</p>
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
      <div className="border-t border-border-subtle pt-2 font-mono text-[11px] uppercase tracking-wider text-fg-tertiary">
        {topic ? 'Notes' : 'Connections'} <span className="text-fg-secondary">{neighbours.length}</span>
      </div>
      <ul className="grid gap-px">
        {neighbours.slice(0, MAX_LISTED).map(({ node: other, edge }) => (
          <li key={`${other.id}:${edge.kind}`}>
            <AriaButton
              onPress={(e) => onSelect(other, e)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/40 touch:min-h-11"
            >
              <KindGlyph kind={edge.kind} />
              <span className="min-w-0 flex-1 truncate text-fg-primary">{other.label}</span>
              <span className="shrink-0 text-[11px] text-fg-tertiary">
                {KIND_LABEL[edge.kind]}
                {other.vault !== node.vault ? ` · ${model.vaults.find((v) => v.id === other.vault)?.label ?? ''}` : ''}
              </span>
            </AriaButton>
          </li>
        ))}
      </ul>
      {neighbours.length > MAX_LISTED && <p className="pl-1.5 text-xs text-fg-tertiary">and {neighbours.length - MAX_LISTED} more</p>}
      <div className="flex flex-wrap gap-1.5">
        {!topic && (
          <Button intent="primary" size="sm" className="touch:h-11" onPress={() => onOpen(node)}>
            Open note <Kbd className="h-4 border-white/25 bg-white/15 text-white">↵</Kbd>
          </Button>
        )}
        <Button size="sm" className="touch:h-11" onPress={() => onPathFrom(node)}>
          Path from here
        </Button>
      </div>
      <p className="text-[11px] text-fg-tertiary">Arrows walk its links{back ? ' · Backspace goes back' : ''} · Esc closes</p>
    </>
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
