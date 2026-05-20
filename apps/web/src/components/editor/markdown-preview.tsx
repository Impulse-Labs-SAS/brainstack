'use client';

// Render markdown to HTML for the preview/split modes. Uses react-markdown
// + GFM + raw HTML, with a custom remark plugin that turns Obsidian
// wikilinks into nodes our `components` override can resolve to internal
// routes or attachment embeds. We deliberately do NOT pull
// github-markdown-css — it fights with our dark tokens. Styles come from
// Tailwind utilities on each element.

import 'highlight.js/styles/github-dark.css';

import Link from 'next/link';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { useMemo } from 'react';

import { remarkWikilinks } from '@/lib/remark-wikilinks';
import { cn } from '@/lib/utils';
import type { ResolvedAttachment } from '@/lib/wikilinks-client';

export interface MarkdownPreviewProps {
  body: string;
  frontmatter?: Record<string, unknown>;
  resolveLink(target: string): { href: string; resolved: boolean };
  resolveEmbed(target: string):
    | ResolvedAttachment
    | { kind: 'note'; path: string }
    | null;
  className?: string;
}

export function MarkdownPreview({
  body,
  frontmatter,
  resolveLink,
  resolveEmbed,
  className,
}: MarkdownPreviewProps) {
  const components = useMemo<Components>(
    () => ({
      a({ href, children, ...rest }) {
        const raw = href ?? '';
        if (raw.startsWith('wikilink://')) {
          const target = decodeURI(raw.slice('wikilink://'.length));
          const { href: dest, resolved } = resolveLink(target);
          return (
            <Link
              href={dest}
              className={cn(
                'underline decoration-dotted underline-offset-2',
                resolved
                  ? 'text-accent hover:text-accent-hover'
                  : 'text-fg-muted hover:text-fg-secondary',
              )}
              data-wikilink={target}
              data-resolved={resolved ? 'true' : 'false'}
            >
              {children}
            </Link>
          );
        }
        if (raw.startsWith('embed://')) {
          // shouldn't happen — embeds become images upstream — but be safe.
          return <span>{children}</span>;
        }
        const isExternal = /^[a-z][a-z0-9+.-]*:/i.test(raw);
        return (
          <a
            href={raw}
            target={isExternal ? '_blank' : undefined}
            rel={isExternal ? 'noreferrer' : undefined}
            className="text-accent underline decoration-dotted underline-offset-2 hover:text-accent-hover"
            {...rest}
          >
            {children}
          </a>
        );
      },
      img({ src, alt, ...rest }) {
        const raw = typeof src === 'string' ? src : '';
        if (raw.startsWith('embed://')) {
          const target = decodeURI(raw.slice('embed://'.length));
          const resolved = resolveEmbed(target);
          if (!resolved) {
            return (
              <span className="inline-flex items-center gap-1 rounded border border-border-subtle bg-bg-elevated px-2 py-0.5 font-mono text-[11px] text-fg-muted">
                📎 {target} (no encontrado)
              </span>
            );
          }
          if ('src' in resolved) {
            if (resolved.kind === 'image') {
              return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={resolved.src}
                  alt={alt ?? resolved.path}
                  loading="lazy"
                  className="my-2 max-h-[70vh] max-w-full rounded border border-border-subtle"
                />
              );
            }
            if (resolved.kind === 'video') {
              return (
                <video
                  src={resolved.src}
                  controls
                  className="my-2 max-h-[70vh] max-w-full rounded border border-border-subtle"
                />
              );
            }
            if (resolved.kind === 'audio') {
              return (
                <audio src={resolved.src} controls className="my-2 w-full" />
              );
            }
            if (resolved.kind === 'pdf') {
              return (
                <iframe
                  src={resolved.src}
                  className="my-2 h-[60vh] w-full rounded border border-border-subtle"
                  title={alt ?? resolved.path}
                />
              );
            }
            return (
              <a
                href={resolved.src}
                className="inline-flex items-center gap-1 rounded border border-border-subtle bg-bg-elevated px-2 py-0.5 font-mono text-[11px] text-accent hover:bg-bg-hover"
              >
                📎 {resolved.path}
              </a>
            );
          }
          // Note embed → just link.
          return (
            <Link
              href={`/notes/${resolved.path.replace(/\.md$/i, '')}`}
              className="font-mono text-[12px] text-accent underline decoration-dotted"
            >
              ↪ {resolved.path}
            </Link>
          );
        }
        if (!raw) return null;
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={raw}
            alt={alt ?? ''}
            loading="lazy"
            className="my-2 max-h-[70vh] max-w-full rounded border border-border-subtle"
            {...rest}
          />
        );
      },
      h1: ({ children }) => (
        <h1 className="mt-6 mb-3 text-2xl font-semibold text-fg-primary">{children}</h1>
      ),
      h2: ({ children }) => (
        <h2 className="mt-5 mb-2 text-xl font-semibold text-fg-primary">{children}</h2>
      ),
      h3: ({ children }) => (
        <h3 className="mt-4 mb-2 text-lg font-semibold text-fg-primary">{children}</h3>
      ),
      h4: ({ children }) => (
        <h4 className="mt-3 mb-2 text-base font-semibold text-fg-primary">{children}</h4>
      ),
      p: ({ children }) => (
        <p className="my-2 leading-6 text-fg-primary">{children}</p>
      ),
      ul: ({ children }) => (
        <ul className="my-2 ml-5 list-disc space-y-1 text-fg-primary">{children}</ul>
      ),
      ol: ({ children }) => (
        <ol className="my-2 ml-5 list-decimal space-y-1 text-fg-primary">{children}</ol>
      ),
      li: ({ children }) => <li className="leading-6">{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="my-3 border-l-2 border-accent/60 bg-bg-elevated/40 px-3 py-1 text-fg-secondary">
          {children}
        </blockquote>
      ),
      hr: () => <hr className="my-4 border-border-subtle" />,
      table: ({ children }) => (
        <div className="my-3 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">{children}</table>
        </div>
      ),
      th: ({ children }) => (
        <th className="border border-border-subtle bg-bg-elevated px-2 py-1 text-left font-medium text-fg-primary">
          {children}
        </th>
      ),
      td: ({ children }) => (
        <td className="border border-border-subtle px-2 py-1 text-fg-secondary">{children}</td>
      ),
      code({ className: cls, children, ...rest }) {
        const isBlock = (rest as { node?: { position?: { start: { line: number }; end: { line: number } } } })
          .node?.position && (cls ?? '').includes('language-');
        if (isBlock) {
          return (
            <code className={cn(cls, 'font-mono text-[12.5px]')}>{children}</code>
          );
        }
        return (
          <code className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[12.5px] text-fg-primary">
            {children}
          </code>
        );
      },
      pre: ({ children }) => (
        <pre className="my-3 overflow-x-auto rounded border border-border-subtle bg-bg-elevated p-3 font-mono text-[12.5px] leading-5">
          {children}
        </pre>
      ),
    }),
    [resolveLink, resolveEmbed],
  );

  const hasFm = frontmatter && Object.keys(frontmatter).length > 0;

  return (
    <div className={cn('h-full overflow-y-auto px-6 py-5', className)}>
      {hasFm && (
        <details className="mb-4 rounded border border-border-subtle bg-bg-elevated/40 px-3 py-1 text-[12px]">
          <summary className="cursor-pointer select-none font-mono text-fg-muted">
            frontmatter ({Object.keys(frontmatter!).length})
          </summary>
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11.5px]">
            {Object.entries(frontmatter!).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-fg-muted">{k}</dt>
                <dd className="text-fg-secondary">{formatValue(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {body.trim() === '' ? (
        <div className="font-mono text-[12px] text-fg-muted">Empty note</div>
      ) : (
        <div className="max-w-3xl">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkWikilinks]}
            rehypePlugins={[rehypeRaw, rehypeHighlight]}
            components={components}
          >
            {body}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
