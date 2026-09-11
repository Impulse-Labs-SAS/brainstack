'use client';

// A row of clickable chips, on react-aria-components' TagGroup — the first
// real use of it beyond ui/button.tsx. Used for both tags and one facet
// key's values; the caller supplies the href each chip should navigate to.

import Link from 'next/link';
import { Tag, TagGroup, TagList, type TagGroupProps } from 'react-aria-components';

import { cn } from '@/lib/utils';

export interface Chip {
  label: string;
  href: string;
}

export interface TagFacetChipsProps extends Omit<TagGroupProps, 'children'> {
  chips: readonly Chip[];
}

export function TagFacetChips({ chips, className, ...rest }: TagFacetChipsProps) {
  if (chips.length === 0) return null;
  return (
    <TagGroup {...rest} className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <TagList className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <Tag key={chip.href} id={chip.href} textValue={chip.label} className="outline-none">
            <Link
              href={chip.href}
              className={cn(
                'inline-flex items-center rounded-full border border-border-subtle bg-bg-elevated px-2 py-0.5',
                'font-mono text-[11px] text-fg-secondary transition-colors duration-fast',
                'hover:border-accent/50 hover:text-fg-primary',
              )}
            >
              {chip.label}
            </Link>
          </Tag>
        ))}
      </TagList>
    </TagGroup>
  );
}
