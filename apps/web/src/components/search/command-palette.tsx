'use client';

// The quick switcher behind Ctrl/⌘ K and every "Search" button: jump to a
// note by typing part of it, walk the list with the arrow keys, or narrow to
// a tag (`#atlas`) or a property (`technologies:postgres`). Empty, it offers
// the notes opened last and a few actions, so opening it is already useful.

import { FilePlus, FileText, Hash, Network, Search } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { useSharingEnabled } from '@/lib/use-deployment';
import { useRecentNotes } from '@/lib/recent-notes';
import { splitSnippet } from '@/lib/search-snippet';
import { encodePath } from '@/lib/wikilinks-client';

interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
}

type SearchScope = 'mine' | 'shared' | 'all';
const SCOPE_KEY = 'brainstack:search-scope';

type Item =
  | { kind: 'group'; label: string }
  | {
      kind: 'go';
      key: string;
      href: string;
      title: string;
      detail: string;
      snippet?: string;
      shared?: boolean;
      icon: 'note' | 'create' | 'graph';
      run?: () => void | Promise<void>;
    };

const noteRoute = (path: string) => `/notes/${encodePath(path.replace(/\.md$/i, ''))}`;
const folderOf = (path: string) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? 'Vault' : path.slice(0, i);
};

/** `technologies:postgres` → a facet filter. A leading `#` is a tag instead. */
function parseFilter(q: string): { tag: string } | { key: string; value: string } | null {
  if (q.startsWith('#') && q.length > 1) return { tag: q.slice(1) };
  const m = q.match(/^([\w-]+):\s*(.+)$/);
  if (m) return { key: m[1]!, value: m[2]!.trim() };
  return null;
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i === -1) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-semibold text-accent-hover">
        {text.slice(i, i + q.length)}
      </mark>
      {text.slice(i + q.length)}
    </>
  );
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const recent = useRecentNotes().filter((r) => r.href !== pathname);
  const sharingEnabled = useSharingEnabled();
  const utils = trpc.useUtils();
  const createM = trpc.notes.create.useMutation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState(0);
  const [scope, setScope] = useState<SearchScope>('mine');

  useEffect(() => {
    try {
      const s = window.localStorage.getItem(SCOPE_KEY);
      if (s === 'shared' || s === 'all') setScope(s);
    } catch {
      // ignore
    }
  }, []);
  const pickScope = (s: SearchScope) => {
    setScope(s);
    try {
      window.localStorage.setItem(SCOPE_KEY, s);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setDebounced('');
    setSelected(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    const h = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(h);
  }, [query]);

  const me = trpc.auth.me.useQuery(undefined, { enabled: open });
  // Null while in flight: an empty string compares unequal to every owner id
  // and would mark your own notes as shared.
  const myId = me.data?.user?.id ?? null;

  const filter = parseFilter(debounced);
  const filterKey = JSON.stringify(filter);
  const search = trpc.search.query.useQuery(
    { query: debounced, limit: 20, scope: sharingEnabled ? scope : 'mine' },
    { enabled: open && debounced.length > 0 && !filter },
  );
  const filtered = trpc.notes.list.useQuery(
    filter && 'tag' in filter
      ? { tag: filter.tag, limit: 50 }
      : filter
        ? { facetKey: filter.key, facetValue: filter.value, limit: 50 }
        : undefined,
    { enabled: open && !!filter },
  );

  const createNote = async (name: string) => {
    const clean = name.replace(/\.md$/i, '').trim();
    if (!clean) return;
    const path = `${clean}.md`;
    try {
      await createM.mutateAsync({ path, content: `# ${clean.split('/').pop()}\n` });
      await Promise.all([utils.notes.tree.invalidate(), utils.notes.graph.invalidate()]);
    } catch {
      // Already there: opening it is what was asked for either way.
    }
    router.push(noteRoute(path));
  };

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    if (!debounced) {
      if (recent.length > 0) {
        out.push({ kind: 'group', label: 'Recent' });
        for (const r of recent.slice(0, 6)) {
          out.push({
            kind: 'go',
            key: `recent:${r.href}`,
            href: r.href,
            title: r.title,
            detail: folderOf(r.path),
            icon: 'note',
          });
        }
      }
      out.push({ kind: 'group', label: 'Actions' });
      out.push({
        kind: 'go',
        key: 'act:new',
        href: '',
        title: 'New note',
        detail: 'In the vault root',
        icon: 'create',
        run: async () => {
          const taken = new Set((utils.notes.tree.getData({ depth: 20 })?.children ?? []).map((c) => c.path));
          let n = 1;
          let name = 'Untitled';
          while (taken.has(`${name}.md`)) name = `Untitled ${++n}`;
          await createNote(name);
        },
      });
      out.push({
        kind: 'go',
        key: 'act:graph',
        href: '/graph',
        title: 'Open the graph',
        detail: '',
        icon: 'graph',
      });
      return out;
    }

    if (filter) {
      const label = 'tag' in filter ? `Notes tagged #${filter.tag}` : `${filter.key}: ${filter.value}`;
      out.push({ kind: 'group', label });
      for (const n of filtered.data ?? []) {
        out.push({
          kind: 'go',
          key: `f:${n.path}`,
          href: noteRoute(n.path),
          title: n.title,
          detail: folderOf(n.path),
          icon: 'note',
        });
      }
      return out;
    }

    const hits = search.data ?? [];
    if (hits.length > 0) out.push({ kind: 'group', label: 'Notes' });
    for (const hit of hits) {
      const shared = myId !== null && Boolean(hit.ownerId) && hit.ownerId !== myId;
      out.push({
        kind: 'go',
        key: `hit:${hit.ownerId ?? ''}:${hit.path}`,
        href: shared
          ? `/notes/shared/${encodeURIComponent(hit.ownerId!)}/${encodePath(hit.path.replace(/\.md$/i, ''))}`
          : noteRoute(hit.path),
        title: hit.title,
        detail: folderOf(hit.path),
        snippet: hit.snippet,
        shared,
        icon: 'note',
      });
    }
    const exact = hits.some((h) => h.title.toLowerCase() === debounced.toLowerCase());
    if (!exact && !search.isFetching) {
      out.push({ kind: 'group', label: 'Create' });
      out.push({
        kind: 'go',
        key: 'act:create',
        href: '',
        title: `Create “${debounced}”`,
        detail: 'Vault',
        icon: 'create',
        run: () => createNote(debounced),
      });
    }
    return out;
    // createNote only closes over stable hooks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced, recent, filterKey, filtered.data, search.data, search.isFetching, myId]);

  const selectable = items.filter((i): i is Extract<Item, { kind: 'go' }> => i.kind === 'go');

  useEffect(() => {
    setSelected(0);
  }, [debounced]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const run = async (item: Extract<Item, { kind: 'go' }>) => {
    onClose();
    if (item.run) await item.run();
    else router.push(item.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = selectable.length;
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' && n) {
      e.preventDefault();
      setSelected((s) => (s + 1) % n);
    } else if (e.key === 'ArrowUp' && n) {
      e.preventDefault();
      setSelected((s) => (s - 1 + n) % n);
    } else if (e.key === 'Enter' && selectable[selected]) {
      e.preventDefault();
      void run(selectable[selected]!);
    }
  };

  const searching = debounced.length > 0 && !filter;
  const loading = (searching && search.isFetching) || (!!filter && filtered.isFetching);
  let index = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-3 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        className="flex max-h-[70vh] w-[min(600px,100%)] flex-col overflow-hidden rounded-xl border border-border bg-bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border-subtle px-4">
          <Search size={16} className="shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a note, #tag or key:value…"
            aria-label="Search notes"
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-switcher-list"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-fg-primary outline-none placeholder:text-fg-muted"
          />
          {sharingEnabled && searching && (
            <div className="flex shrink-0 rounded-md border border-border bg-bg-elevated p-0.5 text-[11px]">
              {(['mine', 'shared', 'all'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => pickScope(s)}
                  className={cn(
                    'rounded px-2 py-0.5 capitalize',
                    scope === s ? 'bg-accent/20 text-fg-primary' : 'text-fg-muted hover:text-fg-secondary',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <div
          ref={listRef}
          id="quick-switcher-list"
          role="listbox"
          className="min-h-0 flex-1 overflow-y-auto p-1.5"
        >
          {items.map((item) => {
            if (item.kind === 'group') {
              return (
                <div
                  key={`g:${item.label}`}
                  className="px-2.5 pb-1 pt-2.5 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted"
                >
                  {item.label}
                </div>
              );
            }
            index += 1;
            const i = index;
            const Icon =
              item.icon === 'create' ? FilePlus : item.icon === 'graph' ? Network : FileText;
            return (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => i !== selected && setSelected(i)}
                onClick={() => void run(item)}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left',
                  i === selected ? 'bg-bg-elevated' : '',
                )}
              >
                <Icon size={15} strokeWidth={1.75} className="mt-0.5 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm text-fg-primary">
                      <Highlight text={item.title} query={searching ? debounced : ''} />
                    </span>
                    {item.shared && (
                      <span className="shrink-0 rounded border border-border-subtle px-1 font-mono text-[9px] uppercase text-fg-muted">
                        shared
                      </span>
                    )}
                  </span>
                  {item.snippet && (
                    <span className="mt-0.5 line-clamp-1 block text-xs text-fg-secondary [&_mark]:rounded [&_mark]:bg-accent/30 [&_mark]:px-0.5 [&_mark]:text-fg-primary">
                      {splitSnippet(item.snippet).map((part, n) =>
                        part.marked ? <mark key={n}>{part.text}</mark> : part.text,
                      )}
                    </span>
                  )}
                </span>
                {item.detail && (
                  <span className="mt-0.5 max-w-[40%] shrink-0 truncate font-mono text-[11px] text-fg-muted">
                    {item.detail}
                  </span>
                )}
              </button>
            );
          })}
          {debounced && selectable.length === 0 && !loading && (
            <div className="px-4 py-8 text-center text-sm text-fg-muted">
              {filter ? 'No notes match that filter.' : 'No results.'}
            </div>
          )}
          {loading && selectable.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-fg-muted">Searching…</div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-4 border-t border-border-subtle px-4 py-2 font-mono text-[11px] text-fg-muted">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto flex items-center gap-1">
            <Hash size={11} /> tag · key:value filters
          </span>
        </div>
      </div>
    </div>
  );
}
