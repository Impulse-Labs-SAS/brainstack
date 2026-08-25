// Justd-style button on top of react-aria-components. Stays close to the
// reference so we can copy more components later without divergence.

'use client';

import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import { tv, type VariantProps } from 'tailwind-variants';

import { cn } from '@/lib/utils';

const button = tv({
  base: cn(
    'inline-flex items-center justify-center gap-2 rounded-md border text-sm font-medium',
    'transition-colors duration-fast ease-default',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
    'disabled:pointer-events-none disabled:opacity-50',
  ),
  variants: {
    intent: {
      primary: cn(
        'bg-accent border-accent text-accent-fg',
        'hover:bg-accent-hover hover:border-accent-hover',
      ),
      secondary: cn(
        'bg-bg-elevated border-border text-fg-primary',
        'hover:bg-bg-hover hover:border-border-strong',
      ),
      ghost: cn(
        'bg-transparent border-transparent text-fg-secondary',
        'hover:bg-bg-elevated hover:text-fg-primary',
      ),
      danger: cn('bg-bg-elevated border-border text-danger', 'hover:bg-bg-hover'),
    },
    size: {
      sm: 'h-7 px-2 text-xs',
      md: 'h-8 px-3 text-sm',
      lg: 'h-10 px-4 text-base',
      icon: 'h-8 w-8',
    },
  },
  defaultVariants: { intent: 'secondary', size: 'md' },
});

export interface ButtonProps extends AriaButtonProps, VariantProps<typeof button> {
  className?: string;
}

export function Button({ className, intent, size, ...props }: ButtonProps) {
  return <AriaButton {...props} className={button({ intent, size, className })} />;
}
