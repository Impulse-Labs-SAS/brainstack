'use client';

// A note's frontmatter, shown as properties instead of YAML: one row per key,
// tags and facet values as chips that open every note sharing them. The same
// block heads the note in Edit (inside CodeMirror) and in Preview.
//
// Links are plain anchors that hand the route to `onNavigate`, because inside
// the editor this renders in a React root of its own, outside Next's router.

import {
  AtSign,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Layers,
  List,
  Tag,
  Type,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/** Keys that describe how a note is shown, not what it is about: plain text, no link. */
const PLAIN_KEYS = new Set(['title', 'aliases', 'cssclasses', 'created', 'updated', 'modified', 'date']);

const KEY_ICONS: Record<string, LucideIcon> = {
  tags: Tag,
  created: CalendarDays,
  updated: CalendarDays,
  modified: CalendarDays,
  date: CalendarDays,
  aliases: AtSign,
  title: Type,
  status: CircleCheck,
  technologies: Layers,
};

const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

function formatDate(value: string): string {
  const d = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const tagRoute = (tag: string) => `/notes/tag/${encodeURIComponent(tag)}`;
export const facetRoute = (key: string, value: string) =>
  `/notes/facet/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;

const chip =
  'inline-flex h-[22px] items-center rounded-full border border-border bg-bg-elevated px-2 font-mono text-[11.5px] text-fg-secondary';

export interface PropertiesBlockProps {
  frontmatter: Record<string, unknown>;
  open: boolean;
  onToggle(): void;
  onNavigate(href: string): void;
  /** Offered in Edit only: switches the block to the raw YAML it came from. */
  onEditYaml?(): void;
  className?: string;
}

export function PropertiesBlock({
  frontmatter,
  open,
  onToggle,
  onNavigate,
  onEditYaml,
  className,
}: PropertiesBlockProps) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;

  const link = (href: string, label: string, isTag = false) => (
    <a
      key={href}
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate(href);
      }}
      className={cn(chip, 'transition-colors hover:border-accent/60 hover:text-fg-primary')}
    >
      {isTag && <span className="text-fg-muted">#</span>}
      {label}
    </a>
  );

  return (
    <section
      aria-label="Properties"
      className={cn('border-y border-border-subtle py-1.5 font-sans', className)}
    >
      <div className="flex h-7 items-center justify-between">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted hover:text-fg-secondary"
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Properties <span className="text-fg-disabled">{entries.length}</span>
        </button>
        {open && onEditYaml && (
          <button
            type="button"
            onClick={onEditYaml}
            className="rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg-primary"
          >
            Edit as YAML
          </button>
        )}
      </div>
      {open && (
        <dl className="mb-1 mt-0.5 grid gap-0.5">
          {entries.map(([key, value]) => {
            const Icon = KEY_ICONS[key] ?? List;
            const values = Array.isArray(value) ? value.map(scalar) : [scalar(value)];
            const plain = PLAIN_KEYS.has(key);
            return (
              <div
                key={key}
                className="grid grid-cols-1 gap-1 py-1 sm:grid-cols-[150px_1fr] sm:gap-3"
              >
                <dt className="flex h-6 items-center gap-1.5 text-[13px] text-fg-muted">
                  <Icon size={13} strokeWidth={1.75} />
                  <span className="truncate">{key}</span>
                </dt>
                <dd className="flex min-h-6 flex-wrap items-center gap-1.5 text-[13.5px] text-fg-secondary">
                  {values.map((v, i) => {
                    if (v === '') return null;
                    if (key === 'tags') return link(tagRoute(v), v, true);
                    if (DATE.test(v)) return <span key={i}>{formatDate(v)}</span>;
                    if (plain) {
                      return Array.isArray(value) ? (
                        <span key={i} className={chip}>
                          {v}
                        </span>
                      ) : (
                        <span key={i}>{v}</span>
                      );
                    }
                    return link(facetRoute(key, v), v);
                  })}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}

const OPEN_KEY = 'brainstack:properties-open';

export function readPropertiesOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writePropertiesOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // ignore
  }
}
