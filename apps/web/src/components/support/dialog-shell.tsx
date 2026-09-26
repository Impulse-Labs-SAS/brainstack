'use client';

import { Check, Copy, X } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

interface DialogShellProps {
  open: boolean;
  title: string;
  subtitle?: string;
  width?: 'md' | 'lg';
  onClose(): void;
  children: ReactNode;
}

/** Overlay, panel and header shared by the sidebar's help dialogs. */
export function DialogShell({
  open,
  title,
  subtitle,
  width = 'md',
  onClose,
  children,
}: DialogShellProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Portalled to <body>: the sidebar that opens these is translated for the
  // mobile drawer, and a transformed ancestor becomes the containing block of
  // anything `fixed` inside it — the overlay would cover the sidebar only.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'flex max-h-[85vh] flex-col rounded-lg border border-border bg-bg-surface shadow-2xl',
          width === 'lg' ? 'w-[min(640px,92vw)]' : 'w-[min(480px,92vw)]',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <div className="text-sm font-medium text-fg-primary">{title}</div>
            {subtitle && <div className="mt-0.5 text-xs text-fg-muted">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
          >
            <X size={14} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A block of text to paste somewhere else, with a copy button. */
export function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The clipboard API needs a secure context; the text is still selectable.
    }
  }, [text]);

  return (
    <div className="group relative">
      <pre className="overflow-x-auto whitespace-pre rounded border border-border-subtle bg-bg-base p-3 pr-10 font-mono text-[11px] leading-relaxed text-fg-primary">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        title={copied ? 'Copied' : 'Copy'}
        aria-label="Copy to clipboard"
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
      >
        {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      </button>
    </div>
  );
}

/** Row of pill tabs, used to pick a client. */
export function PillTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange(id: T): void;
}) {
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn(
            'rounded border px-2 py-1 text-xs transition-colors duration-fast',
            value === tab.id
              ? 'border-accent bg-accent/10 text-fg-primary'
              : 'border-border-subtle text-fg-secondary hover:border-border-strong hover:text-fg-primary',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
