'use client';

// The "Ecosystem" strip at the foot of a note: tags, facets, backlinks,
// outbound links, and notes related by shared tag/facet — replacing the old
// backlinks-only side panel. Purely props-driven (no fetching of its own) so
// the shared-note page can reuse it with only `outboundLinks` filled in.

import Link from 'next/link';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { attachmentPathToRoute, notePathToRoute } from '@/lib/wikilinks-client';
import { groupFacetsByKey, linkLabel, type FacetRow } from '@/lib/ecosystem';

import { TagFacetChips, type Chip } from './tag-facet-chips';

export interface EcosystemLink {
  sourcePath?: string;
  targetPath: string;
  /** 'note' | 'attachment' | 'unresolved' — a plain string on the wire. */
  targetType: string;
  linkKind?: string;
  alias: string | null;
}

export interface RelatedNote {
  path: string;
  title: string;
  ownerId: string | null;
  score: number;
}

export interface EcosystemSectionProps {
  /** Frontmatter `tags`, shown as chips linking to /notes/tag/<tag>. */
  tags?: readonly string[];
  facets?: readonly FacetRow[];
  backlinks?: readonly EcosystemLink[];
  outboundLinks?: readonly EcosystemLink[];
  related?: readonly RelatedNote[];
  className?: string;
}

function tagRoute(tag: string): string {
  return `/notes/tag/${encodeURIComponent(tag)}`;
}

function facetRoute(key: string, value: string): string {
  return `/notes/facet/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
}

function hrefFor(path: string, type: string): string | null {
  if (type === 'unresolved') return null;
  return type === 'attachment' ? attachmentPathToRoute(path) : notePathToRoute(path);
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-fg-muted">
        {title}
        {typeof count === 'number' ? ` · ${count}` : ''}
      </div>
      {children}
    </div>
  );
}

function LinkList({ links, direction }: { links: readonly EcosystemLink[]; direction: 'in' | 'out' }) {
  if (links.length === 0) {
    return <div className="text-xs text-fg-muted">Nada todavía.</div>;
  }
  return (
    <ul className="space-y-0.5">
      {links.map((link, i) => {
        const key = `${direction}-${link.sourcePath ?? ''}-${link.targetPath}-${i}`;
        const href = hrefFor(link.targetPath, link.targetType);
        const label = linkLabel(link, direction);
        if (!href) {
          return (
            <li key={key} className="truncate text-xs text-fg-muted line-through" title="sin resolver">
              {label}
            </li>
          );
        }
        return (
          <li key={key}>
            <Link
              href={href}
              className="block truncate rounded px-1 py-0.5 text-xs text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary"
            >
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export function EcosystemSection({
  tags = [],
  facets = [],
  backlinks = [],
  outboundLinks = [],
  related = [],
  className,
}: EcosystemSectionProps) {
  const facetGroups = groupFacetsByKey(facets);
  const hasAnything =
    tags.length > 0 ||
    facetGroups.length > 0 ||
    backlinks.length > 0 ||
    outboundLinks.length > 0 ||
    related.length > 0;

  if (!hasAnything) return null;

  const tagChips: Chip[] = tags.map((t) => ({ label: t, href: tagRoute(t) }));

  return (
    <div className={cn('border-t border-border-subtle bg-bg-surface/60 px-4 py-3', className)}>
      <div className="mb-2 font-mono text-[11px] text-fg-muted">ecosistema</div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {(tagChips.length > 0 || facetGroups.length > 0) && (
          <Section title="Tags & facetas">
            <div className="space-y-2">
              {tagChips.length > 0 && <TagFacetChips aria-label="Tags" chips={tagChips} />}
              {facetGroups.map((group) => (
                <div key={group.key}>
                  <div className="mb-1 font-mono text-[10px] text-fg-muted">{group.key}</div>
                  <TagFacetChips
                    aria-label={group.key}
                    chips={group.values.map((v) => ({ label: v, href: facetRoute(group.key, v) }))}
                  />
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title="Backlinks" count={backlinks.length}>
          <LinkList links={backlinks} direction="in" />
        </Section>

        <Section title="Enlaces salientes" count={outboundLinks.length}>
          <LinkList links={outboundLinks} direction="out" />
        </Section>

        <Section title="Relacionadas" count={related.length}>
          {related.length === 0 ? (
            <div className="text-xs text-fg-muted">Nada todavía.</div>
          ) : (
            <ul className="space-y-0.5">
              {related.map((r) => (
                <li key={r.path}>
                  <Link
                    href={notePathToRoute(r.path)}
                    className="block truncate rounded px-1 py-0.5 text-xs text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary"
                  >
                    {r.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
