'use client';

import { useEffect, useRef, useState } from 'react';

import { Input } from './input';
import { cn } from '@/lib/utils';

interface PromptModalProps {
  open: boolean;
  title: string;
  label?: string;
  defaultValue?: string;
  okLabel?: string;
  danger?: boolean;
  onCancel(): void;
  onConfirm(value: string): void;
}

export function PromptModal({
  open,
  title,
  label,
  defaultValue = '',
  okLabel = 'OK',
  danger,
  onCancel,
  onConfirm,
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      const h = setTimeout(() => inputRef.current?.select(), 0);
      return () => clearTimeout(h);
    }
  }, [open, defaultValue]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]"
      onClick={onCancel}
    >
      <div
        className="w-[min(420px,90vw)] rounded-lg border border-border bg-bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-sm font-medium text-fg-primary">{title}</div>
        {label && <div className="mb-1.5 font-mono text-[11px] text-fg-muted">{label}</div>}
        <Input
          ref={inputRef}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!value.trim()}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-40',
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-accent hover:bg-accent/90',
            )}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message?: string;
  okLabel?: string;
  danger?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmModal({
  open,
  title,
  message,
  okLabel = 'OK',
  danger,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]"
      onClick={onCancel}
    >
      <div
        className="w-[min(420px,90vw)] rounded-lg border border-border bg-bg-surface p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 text-sm font-medium text-fg-primary">{title}</div>
        {message && (
          <div className="mb-1 break-words font-mono text-[12px] text-fg-secondary">{message}</div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1.5 text-xs text-fg-secondary hover:bg-bg-elevated"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              'rounded px-3 py-1.5 text-xs font-medium text-white transition-colors',
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-accent hover:bg-accent/90',
            )}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
