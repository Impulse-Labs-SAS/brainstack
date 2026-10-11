'use client';

// Two small dialogs, on react-aria-components' Modal and Dialog: focus moves
// in and stays in, Escape and the overlay cancel, and the screen reader hears
// a dialog. The confirm dialog used to listen for Enter on the whole window,
// so Enter on its own Cancel button confirmed first — on the dialog that asks
// before a drag hands notes to another owner.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';

import { Button } from './button';
import { Input } from './input';

function Shell({
  open,
  onCancel,
  role,
  children,
}: {
  open: boolean;
  onCancel(): void;
  role?: 'dialog' | 'alertdialog';
  children: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onCancel();
      }}
      isDismissable
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[18vh]"
    >
      <Modal className="w-[min(420px,90vw)] rounded-lg border border-border bg-bg-surface p-4 shadow-2xl">
        <Dialog role={role} className="outline-none">
          {children}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

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

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Shell open={open} onCancel={onCancel}>
      <Heading slot="title" className="mb-3 text-sm font-medium text-fg-primary">
        {title}
      </Heading>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {label && <div className="mb-1.5 font-mono text-[11px] text-fg-muted">{label}</div>}
        <Input
          ref={inputRef}
          autoFocus
          aria-label={label ?? title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onPress={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            intent={danger ? 'danger' : 'primary'}
            isDisabled={!value.trim()}
          >
            {okLabel}
          </Button>
        </div>
      </form>
    </Shell>
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
  return (
    <Shell open={open} onCancel={onCancel} role="alertdialog">
      <Heading slot="title" className="mb-2 text-sm font-medium text-fg-primary">
        {title}
      </Heading>
      {message && (
        <div className="mb-1 whitespace-pre-line break-words font-mono text-[12px] text-fg-secondary">
          {message}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {/* Focus starts on Cancel: Enter, pressed without reading, keeps things as they are. */}
        <Button size="sm" autoFocus onPress={onCancel}>
          Cancel
        </Button>
        <Button size="sm" intent={danger ? 'danger' : 'primary'} onPress={onConfirm}>
          {okLabel}
        </Button>
      </div>
    </Shell>
  );
}
