'use client';

// Search on the graph page: the field, how many it found and which one you are
// on, the list of results and the filters. What a search finds is decided in
// lib/graph-search.ts; how the graph shows it, in the controller and the
// renderers. This file only asks and lists.
//
// The field is a combobox over the results: ↓/↑ and Enter/Shift+Enter walk
// through them and the camera follows; pointing at one in the list lights it
// in the graph.

import { ChevronDown, ChevronUp, Scan, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Button, Dialog, DialogTrigger, Popover, ToggleButton, ToggleButtonGroup } from 'react-aria-components';

import { Kbd } from '@/components/ui/kbd';
import { colorOf, fold, type GraphModel, type GraphNode } from '@/lib/graph-model';
import {
  DEFAULT_FILTERS,
  SEARCH_FIELDS,
  activeFilterCount,
  kindOf,
  matchRange,
  projectOptions,
  tagOptions,
  type EditedWithin,
  type FilterOption,
  type LinkFilter,
  type SearchField,
  type SearchFilters,
  type SearchKind,
} from '@/lib/graph-search';
import { cn } from '@/lib/utils';

import { Heading, Row } from './graph-layers';
import { GLASS, edited } from './graph-preview';

/** Results drawn in the list; past this, refining says more than scrolling. */
const LISTED = 60;

const FIELD_LABEL: Record<SearchField, string> = { title: 'Titles', project: 'Projects', path: 'Folders', tags: 'Tags' };
const KIND_LABEL: Record<SearchKind, string> = { note: 'Notes', index: 'Indexes (MOC)', topic: 'Topics' };
const EDITED_OPTIONS: Array<{ id: EditedWithin; label: string; chip: string }> = [
  { id: 'any', label: 'Any time', chip: '' },
  { id: 'week', label: 'Week', chip: 'Edited this week' },
  { id: 'month', label: 'Month', chip: 'Edited this month' },
  { id: 'quarter', label: '3 months', chip: 'Edited in 3 months' },
];
const LINK_OPTIONS: Array<{ id: LinkFilter; label: string; chip: string }> = [
  { id: 'any', label: 'Any', chip: '' },
  { id: 'orphans', label: 'No links', chip: 'No links' },
  { id: 'hubs', label: 'Hubs', chip: 'Hubs' },
];

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

interface GraphSearchProps {
  model: GraphModel;
  query: string;
  onQueryChange(query: string): void;
  filters: SearchFilters;
  onFiltersChange(filters: SearchFilters): void;
  /** Best first; null when nothing is being searched. */
  matches: GraphNode[] | null;
  /** The match the camera is on, if the selection is one. */
  current: GraphNode | null;
  onGo(node: GraphNode): void;
  onPreview(node: GraphNode | null): void;
  onFrame(): void;
  inputRef: RefObject<HTMLInputElement | null>;
}

export function GraphSearch({ model, query, onQueryChange, filters, onFiltersChange, matches, current, onGo, onPreview, onFrame, inputRef }: GraphSearchProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const index = current && matches ? matches.indexOf(current) : -1;
  const count = matches?.length ?? 0;
  const showList = open && matches !== null;

  // Going to a result closes the list: it would cover the note the camera
  // flies to. The counter and the arrows keep walking; typing or a click reopens it.
  const go = (node: GraphNode) => {
    setOpen(false);
    onPreview(null);
    onGo(node);
  };
  const step = (delta: 1 | -1) => {
    if (!matches?.length) return;
    const next = index < 0 ? (delta > 0 ? 0 : matches.length - 1) : (index + delta + matches.length) % matches.length;
    go(matches[next]!);
  };

  // Keep the result the camera is on visible in the list.
  useEffect(() => {
    if (index >= 0) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index, listId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter that commits an IME composition is typing, not a request to move.
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' && e.altKey) {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault();
      step(e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // First Escape closes the list, the next clears the search.
      if (showList) setOpen(false);
      else if (query) onQueryChange('');
      else e.currentTarget.blur();
    }
  };

  return (
    <>
      <div className="pointer-events-auto relative">
        <div className={cn(GLASS, 'flex h-9 items-center gap-1.5 rounded-lg pl-2.5 pr-1.5 focus-within:border-border-strong')}>
          <Search size={14} aria-hidden className="shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search notes"
            aria-expanded={showList && count > 0}
            aria-controls={showList && count > 0 ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={showList && index >= 0 && index < LISTED ? `${listId}-${index}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="Search notes…"
            onChange={(e) => {
              onQueryChange(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onBlur={() => {
              setOpen(false);
              onPreview(null);
            }}
            onKeyDown={onKeyDown}
            className="w-28 bg-transparent text-sm text-fg-primary outline-none placeholder:text-fg-muted md:w-44"
          />
          {matches !== null && (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-fg-muted" aria-hidden>
              {count === 0 ? 'none' : index >= 0 ? `${index + 1}/${count}` : count}
            </span>
          )}
          {matches !== null && (
            // Walking with the list closed, this is what says where you are.
            <span aria-live="polite" className="sr-only">
              {count === 0 ? 'No results' : current && index >= 0 ? `${current.label}, ${index + 1} of ${count}` : `${count} ${count === 1 ? 'result' : 'results'}`}
            </span>
          )}
          {count > 0 && (
            <span className="flex shrink-0 items-center">
              <IconButton label="Previous result" onPress={() => step(-1)}>
                <ChevronUp size={14} />
              </IconButton>
              <IconButton label="Next result" onPress={() => step(1)}>
                <ChevronDown size={14} />
              </IconButton>
            </span>
          )}
          {query ? (
            <IconButton
              label="Clear search"
              onPress={() => {
                onQueryChange('');
                inputRef.current?.focus();
              }}
            >
              <X size={12} />
            </IconButton>
          ) : (
            <Kbd className="mr-1 hidden md:inline-flex">/</Kbd>
          )}
        </div>

        {showList && (
          <Results
            id={listId}
            model={model}
            query={query}
            matches={matches}
            index={index}
            filtering={activeFilterCount(filters) > 0}
            onGo={go}
            onPreview={onPreview}
            onFrame={() => {
              setOpen(false);
              onFrame();
            }}
            onClearFilters={() => onFiltersChange({ ...DEFAULT_FILTERS, fields: filters.fields })}
          />
        )}
      </div>

      <FiltersMenu model={model} filters={filters} onChange={onFiltersChange} />
    </>
  );
}

function Results({
  id,
  model,
  query,
  matches,
  index,
  filtering,
  onGo,
  onPreview,
  onFrame,
  onClearFilters,
}: {
  id: string;
  model: GraphModel;
  query: string;
  matches: GraphNode[];
  index: number;
  filtering: boolean;
  onGo(node: GraphNode): void;
  onPreview(node: GraphNode | null): void;
  onFrame(): void;
  onClearFilters(): void;
}) {
  return (
    // Pressing in the list must not take focus from the field: the list closes on blur.
    <div
      onMouseDown={(e) => e.preventDefault()}
      className={cn(GLASS, 'absolute left-0 top-full z-30 mt-1.5 flex max-h-[min(440px,60vh)] w-[min(360px,calc(100vw-1.5rem))] flex-col rounded-lg text-sm shadow-2xl')}
    >
      <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <span className="flex-1 font-mono text-[11px] uppercase tracking-wider text-fg-muted">
          {matches.length} {matches.length === 1 ? 'result' : 'results'}
        </span>
        {matches.length > 1 && (
          <Button
            onPress={onFrame}
            preventFocusOnPress
            className={cn('flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-fg-secondary hover:bg-bg-hover hover:text-fg-primary', FOCUS_RING)}
          >
            <Scan size={12} aria-hidden />
            Frame all
          </Button>
        )}
      </div>
      {matches.length === 0 ? (
        <div className="grid gap-2 px-3 py-4 text-fg-secondary">
          <span>No notes match{filtering ? ' with these filters' : ''}.</span>
          {filtering && (
            <Button onPress={onClearFilters} preventFocusOnPress className={cn('justify-self-start rounded text-xs text-accent hover:underline', FOCUS_RING)}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <ul id={id} role="listbox" aria-label="Search results" className="min-h-0 flex-1 overflow-y-auto p-1" onMouseLeave={() => onPreview(null)}>
          {matches.slice(0, LISTED).map((n, i) => (
            <li
              key={n.id}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => onPreview(n)}
              onClick={() => onGo(n)}
              className={cn('flex cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 hover:bg-bg-hover', i === index && 'bg-bg-elevated shadow-[inset_0_0_0_1px_var(--border-strong)]')}
            >
              <NodeGlyph node={n} color={colorOf(model, n).hue} />
              <span className="grid min-w-0 flex-1">
                <span className="truncate text-fg-primary">
                  <Highlighted text={n.label} query={query} />
                </span>
                <span className="truncate font-mono text-[11px] text-fg-muted">
                  {n.kind === 'topic' ? `topic · ${n.carriers} notes` : `${n.project?.label ?? ''} · ${edited(n.updatedAt)}`}
                </span>
              </span>
            </li>
          ))}
          {matches.length > LISTED && (
            <li role="presentation" className="px-2 py-1.5 text-xs text-fg-muted">
              {matches.length - LISTED} more in the graph. Add a word or a filter to narrow it.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function NodeGlyph({ node, color }: { node: GraphNode; color: string }) {
  const kind = kindOf(node);
  return (
    <span aria-hidden className="mt-[5px] flex h-2.5 w-2.5 shrink-0 items-center justify-center">
      {kind === 'topic' ? (
        <span className="text-[11px] leading-none" style={{ color }}>
          ⬡
        </span>
      ) : (
        <span
          className={cn('h-2 w-2', kind === 'index' ? 'rounded-[2px]' : 'rounded-full', node.foreign && 'border-2 bg-transparent')}
          style={node.foreign ? { borderColor: color } : { background: color, boxShadow: `0 0 6px ${color}` }}
        />
      )}
    </span>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const range = matchRange(text, query);
  if (!range) return <>{text}</>;
  return (
    <>
      {text.slice(0, range[0])}
      <mark className="px-0">{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  );
}

function FiltersMenu({ model, filters, onChange }: { model: GraphModel; filters: SearchFilters; onChange(filters: SearchFilters): void }) {
  const active = activeFilterCount(filters);
  const projects = useMemo(() => projectOptions(model.nodes), [model]);
  const tags = useMemo(() => tagOptions(model.nodes), [model]);
  const hasTopics = model.nodes.some((n) => n.kind === 'topic');
  const kinds: SearchKind[] = hasTopics || filters.kinds.includes('topic') ? ['note', 'index', 'topic'] : ['note', 'index'];
  const changed = active > 0 || filters.fields.length !== SEARCH_FIELDS.length;

  const toggle = <T,>(list: T[], item: T, on: boolean) => (on ? [...list, item] : list.filter((x) => x !== item));

  return (
    <DialogTrigger>
      <Button
        className={cn(
          GLASS,
          'pointer-events-auto flex h-9 items-center gap-2 rounded-lg px-3 text-sm text-fg-primary',
          'hover:bg-bg-hover pressed:bg-bg-elevated',
          FOCUS_RING,
        )}
      >
        <SlidersHorizontal size={14} aria-hidden />
        <span className="max-md:sr-only">Filters</span>
        {active > 0 && (
          <span aria-label={`(${active} active)`} className="min-w-[18px] rounded-full bg-accent px-1 text-center font-mono text-[10.5px] leading-[18px] text-accent-fg">
            {active}
          </span>
        )}
      </Button>
      <Popover placement="bottom start" offset={6} className={cn(GLASS, 'max-h-[min(560px,75vh)] w-[300px] overflow-y-auto rounded-lg p-2 text-sm shadow-2xl outline-none')}>
        <Dialog aria-label="Search filters" className="outline-none">
          <Heading>Search in</Heading>
          {SEARCH_FIELDS.map((field) => (
            <Row
              key={field}
              isSelected={filters.fields.includes(field)}
              // The query has to be looked for somewhere.
              isDisabled={filters.fields.length === 1 && filters.fields[0] === field}
              onChange={(on) => onChange({ ...filters, fields: SEARCH_FIELDS.filter((f) => (f === field ? on : filters.fields.includes(f))) })}
              glyph={null}
            >
              {FIELD_LABEL[field]}
            </Row>
          ))}

          <Divider />
          <Heading>Edited</Heading>
          <Segmented label="Edited" options={EDITED_OPTIONS} value={filters.edited} onChange={(edited) => onChange({ ...filters, edited })} />

          <Divider />
          <Heading>Type</Heading>
          {kinds.map((kind) => (
            <Row key={kind} isSelected={filters.kinds.includes(kind)} onChange={(on) => onChange({ ...filters, kinds: toggle(filters.kinds, kind, on) })} glyph={null}>
              {KIND_LABEL[kind]}
            </Row>
          ))}

          <Divider />
          <Heading>Links</Heading>
          <Segmented label="Links" options={LINK_OPTIONS} value={filters.links} onChange={(links) => onChange({ ...filters, links })} />

          {projects.length > 1 && (
            <>
              <Divider />
              <OptionList
                title="Projects"
                options={projects}
                selected={filters.projects}
                onChange={(ids) => onChange({ ...filters, projects: ids })}
              />
            </>
          )}
          {tags.length > 0 && (
            <>
              <Divider />
              <OptionList title="Tags" options={tags} selected={filters.tags} onChange={(ids) => onChange({ ...filters, tags: ids })} />
            </>
          )}

          {changed && (
            <>
              <Divider />
              <Button onPress={() => onChange(DEFAULT_FILTERS)} className={cn('w-full rounded px-1.5 py-1 text-left text-xs text-fg-secondary hover:bg-bg-hover hover:text-fg-primary', FOCUS_RING)}>
                Reset filters
              </Button>
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

const Divider = () => <div className="my-1 h-px bg-border-subtle" />;

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange(value: T): void;
}) {
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const next = [...keys][0] as T | undefined;
        if (next) onChange(next);
      }}
      className="mx-1.5 mb-1 flex gap-0.5 rounded-md border border-border-subtle p-[2px]"
    >
      {options.map((o) => (
        <ToggleButton
          key={o.id}
          id={o.id}
          className={cn(
            'flex-1 rounded px-1.5 py-1 text-xs text-fg-secondary hover:text-fg-primary',
            'selected:bg-bg-elevated selected:text-fg-primary selected:shadow-[inset_0_0_0_1px_var(--border-strong)]',
            FOCUS_RING,
          )}
        >
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/** A checklist of projects or tags, with a filter of its own once it gets long. */
function OptionList({ title, options, selected, onChange }: { title: string; options: FilterOption[]; selected: string[]; onChange(ids: string[]): void }) {
  const [find, setFind] = useState('');
  const q = fold(find.trim());
  // What is ticked stays listed whatever the filter, so it can be unticked.
  const shown = options.filter((o) => !q || fold(o.label).includes(q) || selected.includes(o.id));
  return (
    <>
      <Heading>
        {title}
        {selected.length > 0 && ` · ${selected.length}`}
      </Heading>
      {options.length > 8 && (
        <input
          type="text"
          aria-label={`Filter ${title.toLowerCase()}`}
          placeholder={`Find ${title.toLowerCase()}…`}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          className="mx-1.5 mb-1 w-[calc(100%-0.75rem)] rounded border border-border-subtle bg-transparent px-2 py-1 text-xs text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-strong"
        />
      )}
      {/* `relative` keeps each checkbox's visually hidden input inside this
          scroller. Without it they are positioned against the popover, at
          their unscrolled place, and a long list stretches the popover's
          scroll area with empty space. */}
      <div className="relative max-h-40 overflow-y-auto">
        {shown.map((o) => (
          <Row
            key={o.id}
            isSelected={selected.includes(o.id)}
            onChange={(on) => onChange(on ? [...selected, o.id] : selected.filter((id) => id !== o.id))}
            glyph={null}
            trailing={<span className="font-mono text-[11px] text-fg-muted">{o.count}</span>}
          >
            {o.label}
          </Row>
        ))}
        {!shown.length && <p className="px-1.5 py-1 text-xs text-fg-muted">Nothing matches.</p>}
      </div>
    </>
  );
}

/** The filters in force, each removable on its own; under the toolbar, where the graph starts. */
export function FilterChips({ model, filters, onChange }: { model: GraphModel; filters: SearchFilters; onChange(filters: SearchFilters): void }) {
  const chips: Array<{ key: string; label: string; clear: SearchFilters }> = [];
  if (filters.edited !== 'any') {
    chips.push({ key: 'edited', label: EDITED_OPTIONS.find((o) => o.id === filters.edited)!.chip, clear: { ...filters, edited: 'any' } });
  }
  if (filters.kinds.length) {
    chips.push({ key: 'kinds', label: filters.kinds.map((k) => KIND_LABEL[k]).join(', '), clear: { ...filters, kinds: [] } });
  }
  if (filters.links !== 'any') {
    chips.push({ key: 'links', label: LINK_OPTIONS.find((o) => o.id === filters.links)!.chip, clear: { ...filters, links: 'any' } });
  }
  if (filters.projects.length) {
    const first = model.projects.find((p) => p.id === filters.projects[0])?.label ?? 'project';
    const label = filters.projects.length === 1 ? `Project: ${first}` : `${filters.projects.length} projects`;
    chips.push({ key: 'projects', label, clear: { ...filters, projects: [] } });
  }
  if (filters.tags.length) {
    chips.push({ key: 'tags', label: filters.tags.length === 1 ? `Tag: ${filters.tags[0]}` : `${filters.tags.length} tags`, clear: { ...filters, tags: [] } });
  }
  if (!chips.length) return null;
  return (
    <ul aria-label="Active filters" className="pointer-events-auto flex basis-full flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <li key={c.key} className={cn(GLASS, 'flex h-7 items-center gap-1 rounded-full pl-2.5 pr-1 text-xs text-fg-primary')}>
          <span className="max-w-[220px] truncate">{c.label}</span>
          <IconButton label={`Remove filter: ${c.label}`} onPress={() => onChange(c.clear)}>
            <X size={11} />
          </IconButton>
        </li>
      ))}
      {chips.length > 1 && (
        <li>
          <Button
            onPress={() => onChange({ ...DEFAULT_FILTERS, fields: filters.fields })}
            className={cn('rounded px-1.5 text-xs text-fg-secondary hover:text-fg-primary', FOCUS_RING)}
          >
            Clear all
          </Button>
        </li>
      )}
    </ul>
  );
}

// Buttons beside the field leave focus in it: moving it would close the list.
function IconButton({ label, onPress, children }: { label: string; onPress(): void; children: ReactNode }) {
  return (
    <Button aria-label={label} onPress={onPress} preventFocusOnPress className={cn('rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg-primary', FOCUS_RING)}>
      {children}
    </Button>
  );
}
