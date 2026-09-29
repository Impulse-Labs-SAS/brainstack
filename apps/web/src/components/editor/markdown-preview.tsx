'use client';

// Render markdown to HTML for the preview/split modes. Uses react-markdown
// + GFM + raw HTML, with a custom remark plugin that turns Obsidian
// wikilinks into nodes our `components` override can resolve to internal
// routes or attachment embeds. We deliberately do NOT pull
// github-markdown-css — it fights with our dark tokens. Styles come from
// Tailwind utilities on each element.

import 'highlight.js/styles/github-dark.css';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useState } from 'react';

import {
  PropertiesBlock,
  readPropertiesOpen,
  writePropertiesOpen,
} from '@/components/note/properties-block';
import { LinkPeek, usePeek } from '@/components/note/link-peek';
import { noteSanitizeSchema } from '@/lib/markdown-sanitize';
import { remarkWikilinks } from '@/lib/remark-wikilinks';
import { cn } from '@/lib/utils';
import type { ResolvedAttachment } from '@/lib/wikilinks-client';

export interface MarkdownPreviewProps {
  body: string;
  frontmatter?: Record<string, unknown>;
  /** `path` is the vault path of a resolved note, for the hover preview. */
  resolveLink(target: string): { href: string; resolved: boolean; path?: string };
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
  const router = useRouter();
  const peek = usePeek();
  const [propsOpen, setPropsOpen] = useState(true);
  useEffect(() => setPropsOpen(readPropertiesOpen()), []);

  const components = useMemo<Components>(
    () => ({
      a({ href, children, ...rest }) {
        const raw = href ?? '';
        if (raw.startsWith('wikilink://')) {
          const target = decodeURI(raw.slice('wikilink://'.length));
          const { href: dest, resolved, path } = resolveLink(target);
          return (
            <Link
              href={dest}
              onMouseEnter={(e) =>
                peek.show({ label: target.split('#')[0]!, path: resolved ? (path ?? null) : null }, e.currentTarget)
              }
              onMouseLeave={peek.hide}
              onClick={peek.close}
              className={cn(
                'rounded-sm underline underline-offset-[3px]',
                resolved
                  ? 'text-accent-hover decoration-accent-hover/40 hover:bg-accent/10'
                  : 'text-fg-secondary decoration-dashed decoration-fg-muted hover:text-fg-primary',
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
                📎 {target} (not found)
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
        <h1 className="mb-4 mt-8 text-[28px] font-semibold leading-9 tracking-tight text-fg-primary [text-wrap:balance] first:mt-0">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="mb-2 mt-8 text-[19px] font-semibold leading-7 text-fg-primary">{children}</h2>
      ),
      h3: ({ children }) => (
        <h3 className="mb-1.5 mt-6 text-base font-semibold text-fg-primary">{children}</h3>
      ),
      h4: ({ children }) => (
        <h4 className="mt-3 mb-2 text-base font-semibold text-fg-primary">{children}</h4>
      ),
      p: ({ children }) => (
        <p className="my-3 text-[15px] leading-[1.75] text-fg-body">{children}</p>
      ),
      ul: ({ children }) => (
        <ul className="my-3 ml-5 list-disc space-y-1 text-[15px] text-fg-body marker:text-fg-muted">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="my-3 ml-5 list-decimal space-y-1 text-[15px] text-fg-body marker:text-fg-muted">
          {children}
        </ol>
      ),
      li: ({ children }) => <li className="leading-[1.75]">{children}</li>,
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
    // `peek` exposes stable callbacks over refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolveLink, resolveEmbed],
  );

  return (
    <div className={cn('h-full overflow-y-auto', className)} onScroll={peek.close}>
      <div className="mx-auto max-w-[calc(72ch+48px)] px-6 pb-28 pt-8">
        {frontmatter && (
          <PropertiesBlock
            frontmatter={frontmatter}
            open={propsOpen}
            onToggle={() => {
              writePropertiesOpen(!propsOpen);
              setPropsOpen(!propsOpen);
            }}
            onNavigate={(href) => router.push(href)}
            className="mb-6"
          />
        )}
        {body.trim() === '' ? (
          <div className="text-sm text-fg-muted">Empty note.</div>
        ) : (
          <div data-preview-body>
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkWikilinks]}
              // Sanitise after the raw HTML is parsed and before highlighting,
              // which adds classes the allowlist would otherwise strip.
              rehypePlugins={[rehypeRaw, [rehypeSanitize, noteSanitizeSchema], rehypeHighlight]}
              components={components}
              urlTransform={urlTransform}
            >
              {body}
            </ReactMarkdown>
          </div>
        )}
      </div>
      <LinkPeek target={peek.target} onEnter={peek.keep} onLeave={peek.hide} />
    </div>
  );
}

// El sanitizador default de react-markdown strippea cualquier protocolo
// que no esté en su whitelist (http/https/mailto/etc.), y eso incluye
// nuestros esquemas internos `wikilink://` y `embed://` — sin esto los
// component overrides reciben href/src vacío y los wikilinks/embeds no
// se renderizan. Como esos URLs los construye nuestro propio plugin
// remark y no contenido de usuario, dejarlos pasar es seguro; el resto
// sigue por el sanitizador estándar para bloquear javascript:/data:.
function urlTransform(url: string): string {
  if (url.startsWith('wikilink://') || url.startsWith('embed://')) return url;
  return defaultUrlTransform(url);
}
