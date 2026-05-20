'use client';

// Renders an attachment by mime. Pure src-driven — the bytes never pass
// through React state, they're fetched by the browser from the HTTP
// streaming endpoint. Text-shaped mimes are an exception: we fetch them so
// the existing CodeMirror viewer can render them with syntax highlight.

import { useEffect, useState } from 'react';

import { NoteEditor } from '@/components/editor/note-editor';
import { cn } from '@/lib/utils';

export interface AttachmentViewerProps {
  mime: string;
  src: string;
  /** Logical path — used for filename / fallback alt text. */
  path: string;
  className?: string;
}

export function AttachmentViewer({ mime, src, path, className }: AttachmentViewerProps) {
  const kind = mimeKind(mime, path);

  if (kind === 'image') {
    return (
      <div className={cn('flex h-full items-center justify-center bg-bg-base p-4', className)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={path}
          loading="lazy"
          className="max-h-full max-w-full rounded border border-border-subtle"
        />
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <iframe
        src={src}
        title={path}
        className={cn('h-full w-full bg-bg-base', className)}
      />
    );
  }

  if (kind === 'audio') {
    return (
      <div className={cn('flex h-full items-center justify-center p-6', className)}>
        <audio src={src} controls className="w-full max-w-xl" />
      </div>
    );
  }

  if (kind === 'video') {
    return (
      <div className={cn('flex h-full items-center justify-center bg-bg-base p-4', className)}>
        <video
          src={src}
          controls
          className="max-h-full max-w-full rounded border border-border-subtle"
        />
      </div>
    );
  }

  if (kind === 'text') {
    return <TextViewer src={src} mime={mime} className={className} />;
  }

  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-3 p-8', className)}>
      <div className="font-mono text-[12px] text-fg-muted">
        sin preview para <span className="text-fg-secondary">{mime || 'tipo desconocido'}</span>
      </div>
      <a
        href={`${src}?download=1`}
        className="rounded border border-border-default bg-bg-elevated px-3 py-1.5 text-sm text-fg-primary hover:bg-bg-hover"
      >
        Download
      </a>
    </div>
  );
}

function TextViewer({
  src,
  mime,
  className,
}: {
  src: string;
  mime: string;
  className?: string;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((txt) => {
        if (cancelled) return;
        if (mime.includes('json')) {
          try {
            setContent(JSON.stringify(JSON.parse(txt), null, 2));
            return;
          } catch {
            /* fall through */
          }
        }
        setContent(txt);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [src, mime]);

  if (error) {
    return (
      <div className={cn('p-4 font-mono text-[12px] text-red-300', className)}>{error}</div>
    );
  }
  if (content === null) {
    return (
      <div className={cn('p-4 font-mono text-[12px] text-fg-muted', className)}>cargando…</div>
    );
  }
  return (
    <div className={cn('h-full overflow-hidden', className)}>
      <NoteEditor value={content} readOnly />
    </div>
  );
}

type Kind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'other';

function mimeKind(mime: string, path: string): Kind {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (
    m.startsWith('text/') ||
    m === 'application/json' ||
    m === 'application/xml' ||
    m === 'application/x-yaml'
  ) {
    return 'text';
  }
  // Fallback by extension if mime is octet-stream.
  if (m === 'application/octet-stream' || m === '') {
    const ext = (path.split('.').pop() ?? '').toLowerCase();
    if (['txt', 'log', 'csv', 'tsv', 'md', 'yml', 'yaml', 'json', 'xml', 'ini', 'env'].includes(ext)) {
      return 'text';
    }
  }
  return 'other';
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
