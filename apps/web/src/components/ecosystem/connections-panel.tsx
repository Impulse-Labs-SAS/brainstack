'use client';

// The Connections panel: everything around the open note, on the right, out
// of the way of the text. Four tabs:
//
// - Links: notes that link here (with the line that cites this one) and the
//   notes this one links to. A link to a note that does not exist yet says so
//   and offers to create it.
// - Related: notes sharing a tag or property with this one, with what they
//   share. They are not links, and the panel says so — mixing the two is what
//   got the old mini-graph removed.
// - Mentions: places where a note's title appears as plain text, with a
//   button to turn them into links.
// - Outline: this note's headings.
//
// Purely props-driven, so the shared-note page can show only what it has.

import {
  ArrowDownLeft,
  ArrowUpRight,
  AtSign,
  CirclePlus,
  Link2,
  Orbit,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import type { OutlineHeading } from '@/lib/outline';
import { attachmentPathToRoute, notePathToRoute } from '@/lib/wikilinks-client';

export interface ConnectionLink {
  sourcePath?: string;
  targetPath: string;
  /** 'note' | 'attachment' | 'unresolved' — a plain string on the wire. */
  targetType: string;
  alias: string | null;
  /** The line of the source note the link sits in (backlinks only). */
  snippet?: string;
  /** Title of the note on the other end, when it is a note. */
  title?: string;
}

export type RelatedReason =
  | { kind: 'tag'; tag: string }
  | { kind: 'facet'; key: string; value: string };

export interface RelatedNote {
  path: string;
  title: string;
  ownerId: string | null;
  score: number;
  reasons?: RelatedReason[];
}

/** One note on the other side of an unlinked mention. */
export interface MentionRow {
  path: string;
  title: string;
  text: string;
  count: number;
  snippet: string;
}

export type MentionDirection = 'incoming' | 'outgoing';

type Tab = 'links' | 'related' | 'mentions' | 'outline';

export interface ConnectionsPanelProps {
  /** Vault path of the open note, to highlight where a backlink cites it. */
  currentPath: string;
  /** Absent hides the part: the shared-note page does not have them. */
  backlinks?: readonly ConnectionLink[];
  outboundLinks: readonly ConnectionLink[];
  related?: readonly RelatedNote[];
  mentions?: { incoming: readonly MentionRow[]; outgoing: readonly MentionRow[] };
  outline: readonly OutlineHeading[];
  onLinkMention?: (direction: MentionDirection, path: string) => void;
  /** `direction:path` of the mention being linked right now. */
  linkingMention?: string | null;
  /**
   * Why linking inside the open note is not possible right now — unsaved
   * edits would be overwritten by the rewrite. Null when it is fine.
   */
  outgoingBlockedReason?: string | null;
  /** Creates the note an unresolved link points at. */
  onCreate?(target: string): void;
  onJump(heading: OutlineHeading): void;
  onClose(): void;
  /** How routes are built for notes in this panel (the shared page overrides it). */
  routeFor?(path: string): string;
  className?: string;
}

const TAB_KEY = 'brainstack:connections-tab';

const folderLabel = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? 'Vault' : path.slice(0, i);
};
const baseName = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '');

/**
 * A backlink's line, with the link back to this note marked and the other
 * links shown as their label. Markdown emphasis is dropped: this is a quote.
 */
function Snippet({ text, currentPath }: { text: string; currentPath: string }) {
  const here = currentPath.replace(/\.md$/i, '').toLowerCase();
  const hereBase = baseName(currentPath).toLowerCase();
  const parts: ReactNode[] = [];
  const re = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const clean = (s: string) => s.replace(/\*\*|__|`/g, '');
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(clean(text.slice(last, m.index)));
    const target = m[1]!.trim().replace(/\.md$/i, '').toLowerCase();
    const label = m[2] ?? m[1]!;
    const isHere = target === here || target === hereBase || here.endsWith(`/${target}`);
    parts.push(
      isHere ? (
        <mark key={m.index} className="rounded-sm bg-accent/20 px-0.5 text-fg-primary">
          {label}
        </mark>
      ) : (
        <span key={m.index} className="text-accent-hover">
          {label}
        </span>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(clean(text.slice(last)));
  return <>{parts}</>;
}

function SectionHead({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-center justify-between px-1 pb-2 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
      <span>{children}</span>
      {count !== undefined && <span>{count}</span>}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-1 pb-2.5 text-xs leading-[17px] text-fg-muted">{children}</p>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-1 text-[12.5px] leading-[18px] text-fg-muted">{children}</p>;
}

function ItemBody({ title, path }: { title: string; path: string }) {
  return (
    <span className="grid min-w-0 flex-1">
      <span className="text-[13px] leading-[18px] text-fg-primary">{title}</span>
      <span className="truncate font-mono text-[10.5px] leading-[15px] text-fg-muted">
        {folderLabel(path)}
      </span>
    </span>
  );
}

const itemClass =
  'flex w-full items-start gap-2 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-bg-hover';

export function ConnectionsPanel({
  currentPath,
  backlinks,
  outboundLinks,
  related,
  mentions,
  outline,
  onLinkMention,
  linkingMention = null,
  outgoingBlockedReason = null,
  onCreate,
  onJump,
  onClose,
  routeFor = notePathToRoute,
  className,
}: ConnectionsPanelProps) {
  const [tab, setTab] = useState<Tab>('links');
  useEffect(() => {
    try {
      const t = window.localStorage.getItem(TAB_KEY);
      if (t === 'links' || t === 'related' || t === 'mentions' || t === 'outline') setTab(t);
    } catch {
      // ignore
    }
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    try {
      window.localStorage.setItem(TAB_KEY, t);
    } catch {
      // ignore
    }
  };

  // One row per target: a note linked three times is one place to go.
  const outgoing = (() => {
    const byTarget = new Map<string, ConnectionLink & { count: number }>();
    for (const l of outboundLinks) {
      const prev = byTarget.get(l.targetPath);
      if (prev) prev.count += 1;
      else byTarget.set(l.targetPath, { ...l, count: 1 });
    }
    return [...byTarget.values()].sort(
      (a, b) => Number(a.targetType === 'unresolved') - Number(b.targetType === 'unresolved'),
    );
  })();

  // One card per source note, with the lines that cite this one.
  const incoming = (() => {
    const bySource = new Map<string, { path: string; title: string; snippets: string[] }>();
    for (const l of backlinks ?? []) {
      const path = l.sourcePath ?? '';
      const entry = bySource.get(path) ?? { path, title: l.title ?? baseName(path), snippets: [] };
      if (l.snippet && !entry.snippets.includes(l.snippet)) entry.snippets.push(l.snippet);
      bySource.set(path, entry);
    }
    return [...bySource.values()];
  })();

  const mentionCount = (mentions?.incoming.length ?? 0) + (mentions?.outgoing.length ?? 0);
  const tabs: Array<{ id: Tab; label: string; count: number; dot?: boolean }> = [
    { id: 'links', label: 'Links', count: incoming.length + outgoing.length },
    ...(related ? [{ id: 'related' as const, label: 'Related', count: related.length }] : []),
    ...(mentions
      ? [{ id: 'mentions' as const, label: 'Mentions', count: mentionCount, dot: mentionCount > 0 }]
      : []),
    { id: 'outline', label: 'Outline', count: outline.length },
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : 'links';

  const mentionList = (rows: readonly MentionRow[], direction: MentionDirection) => (
    <div className="grid gap-1.5">
      {rows.map((row) => {
        const busy = linkingMention === `${direction}:${row.path}`;
        const blocked = direction === 'outgoing' ? outgoingBlockedReason : null;
        return (
          <div key={row.path} className="rounded-lg border border-border-subtle bg-bg-base px-3 py-2.5">
            <Link
              href={routeFor(row.path)}
              className="flex items-start gap-2 text-[13px] font-medium text-fg-primary hover:underline hover:decoration-border-strong hover:underline-offset-[3px]"
            >
              <AtSign size={13} className="mt-0.5 shrink-0 text-fg-muted" />
              {row.title}
            </Link>
            <p className="ml-[21px] mt-1.5 text-[12.5px] leading-[19px] text-fg-secondary">
              {row.snippet}
            </p>
            <div className="ml-[21px] mt-2 flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[10.5px] text-fg-muted">
                {folderLabel(row.path)}
                {row.count > 1 && ` · ×${row.count}`}
              </span>
              {onLinkMention && (
                <button
                  type="button"
                  disabled={busy || !!blocked}
                  title={
                    blocked ??
                    (row.count > 1
                      ? `Turn all ${row.count} mentions into links`
                      : 'Turn this mention into a link')
                  }
                  onClick={() => onLinkMention(direction, row.path)}
                  className="h-[22px] shrink-0 rounded-md border border-border bg-bg-elevated px-2 text-[11.5px] font-medium text-fg-primary hover:border-accent/70 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? 'Linking…' : row.count > 1 ? `Link all ${row.count}` : 'Link'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <aside aria-label="Connections" className={cn('flex min-h-0 flex-col bg-bg-surface', className)}>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle pl-4 pr-2">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-fg-primary">
          <Link2 size={14} className="text-fg-muted" /> Connections
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          aria-label="Close connections"
          className="grid h-7 w-7 place-items-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg-primary"
        >
          <X size={14} />
        </button>
      </div>
      <div role="tablist" className="flex shrink-0 gap-0.5 border-b border-border-subtle px-2.5 pt-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active === t.id}
            onClick={() => pick(t.id)}
            className={cn(
              '-mb-px flex h-[30px] items-center gap-1.5 whitespace-nowrap border-b-2 px-1.5 text-[12.5px] font-medium',
              active === t.id
                ? 'border-accent text-fg-primary'
                : 'border-transparent text-fg-muted hover:text-fg-primary',
            )}
          >
            {t.label}
            <span className="font-mono text-[10.5px] text-fg-muted">{t.count}</span>
            {t.dot && (
              <span className="h-1.5 w-1.5 rounded-full bg-accent-hover" title="Can be linked" />
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 pb-8 pt-3.5">
        {active === 'links' && (
          <>
            {backlinks && (
              <section>
                <SectionHead count={incoming.length}>Backlinks</SectionHead>
                {incoming.length === 0 ? (
                  <Empty>No notes link here yet.</Empty>
                ) : (
                  <div className="grid gap-1.5">
                    {incoming.map((b) => (
                      <Link
                        key={b.path}
                        href={routeFor(b.path)}
                        className="block rounded-lg border border-border-subtle bg-bg-base px-3 py-2.5 transition-colors hover:border-border-strong"
                      >
                        <span className="flex items-start gap-2 text-[13px] font-medium leading-[18px] text-fg-primary">
                          <ArrowDownLeft size={13} className="mt-0.5 shrink-0 text-fg-muted" />
                          {b.title}
                        </span>
                        <span className="ml-[21px] block truncate font-mono text-[10.5px] text-fg-muted">
                          {folderLabel(b.path)}
                        </span>
                        {b.snippets.slice(0, 2).map((s) => (
                          <span
                            key={s}
                            className="ml-[21px] mt-1.5 block text-[12.5px] leading-[19px] text-fg-secondary"
                          >
                            <Snippet text={s} currentPath={currentPath} />
                          </span>
                        ))}
                      </Link>
                    ))}
                  </div>
                )}
              </section>
            )}
            <section>
              <SectionHead count={outgoing.length}>Outgoing links</SectionHead>
              {outgoing.length === 0 ? (
                <Empty>This note doesn’t link anywhere yet. Type [[ to add a link.</Empty>
              ) : (
                <div className="grid gap-0.5">
                  {outgoing.map((l) => {
                    if (l.targetType === 'unresolved') {
                      const label = l.alias ?? baseName(l.targetPath);
                      return (
                        <div key={l.targetPath} className={cn(itemClass, 'hover:bg-transparent')}>
                          <CirclePlus size={14} className="mt-0.5 shrink-0 text-fg-muted" />
                          <span className="grid min-w-0 flex-1">
                            <span className="text-[13px] leading-[18px] text-fg-secondary">
                              {baseName(l.targetPath)}
                            </span>
                            <span className="font-mono text-[10.5px] text-fg-muted">
                              Not created yet{l.count > 1 && ` · linked ×${l.count}`}
                            </span>
                          </span>
                          {onCreate && (
                            <button
                              type="button"
                              onClick={() => onCreate(l.targetPath)}
                              title={`Create ${label}`}
                              className="h-[22px] shrink-0 rounded-md border border-border bg-bg-elevated px-2 text-[11.5px] font-medium text-fg-primary hover:border-accent/70"
                            >
                              Create
                            </button>
                          )}
                        </div>
                      );
                    }
                    const href =
                      l.targetType === 'attachment'
                        ? attachmentPathToRoute(l.targetPath)
                        : routeFor(l.targetPath);
                    return (
                      <Link key={l.targetPath} href={href} className={itemClass}>
                        <ArrowUpRight size={14} className="mt-0.5 shrink-0 text-fg-muted" />
                        <ItemBody title={l.title ?? baseName(l.targetPath)} path={l.targetPath} />
                        {l.count > 1 && (
                          <span className="mt-0.5 font-mono text-[10.5px] text-fg-muted">×{l.count}</span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}

        {active === 'related' && related && (
          <section>
            <Note>Notes that share a tag or property with this one. They aren’t linked to it.</Note>
            {related.length === 0 ? (
              <Empty>No related notes.</Empty>
            ) : (
              <div className="grid gap-0.5">
                {related.map((r) => {
                  const first = r.reasons?.[0];
                  const why = first ? (first.kind === 'tag' ? `#${first.tag}` : first.value) : null;
                  const all = (r.reasons ?? [])
                    .map((x) => (x.kind === 'tag' ? `#${x.tag}` : `${x.key}: ${x.value}`))
                    .join(', ');
                  return (
                    <Link
                      key={`${r.ownerId ?? ''}:${r.path}`}
                      href={routeFor(r.path)}
                      className={itemClass}
                      title={all ? `Shares ${all}` : undefined}
                    >
                      <Orbit size={14} className="mt-0.5 shrink-0 text-fg-muted" />
                      <ItemBody title={r.title} path={r.path} />
                      {why && (
                        <span className="mt-px max-w-[120px] shrink-0 truncate rounded border border-border px-1.5 font-mono text-[10.5px] leading-4 text-fg-muted">
                          {why}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {active === 'mentions' && mentions && (
          <section>
            <Note>Places where a note’s title appears as plain text, without a [[link]].</Note>
            {mentionCount === 0 ? (
              <Empty>No unlinked mentions.</Empty>
            ) : (
              <div className="grid gap-4">
                {mentions.incoming.length > 0 && (
                  <div>
                    <SectionHead count={mentions.incoming.length}>Mention this note</SectionHead>
                    {mentionList(mentions.incoming, 'incoming')}
                  </div>
                )}
                {mentions.outgoing.length > 0 && (
                  <div>
                    <SectionHead count={mentions.outgoing.length}>Mentioned here</SectionHead>
                    {mentionList(mentions.outgoing, 'outgoing')}
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {active === 'outline' && (
          <section>
            {outline.length === 0 ? (
              <Empty>This note has no headings.</Empty>
            ) : (
              <div className="grid gap-px">
                {outline.map((h) => (
                  <button
                    key={`${h.line}:${h.text}`}
                    type="button"
                    onClick={() => onJump(h)}
                    style={{ paddingLeft: 8 + (h.level - 1) * 14 }}
                    className="rounded-md py-1.5 pr-2 text-left text-[13px] text-fg-secondary hover:bg-bg-hover hover:text-fg-primary"
                  >
                    {h.text}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
