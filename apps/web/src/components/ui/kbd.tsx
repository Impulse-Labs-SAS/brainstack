import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface KbdProps {
  children: ReactNode;
  className?: string;
}

export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-[20px] items-center justify-center rounded',
        'border border-border bg-bg-elevated px-1.5 font-mono text-[11px] text-fg-secondary',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
