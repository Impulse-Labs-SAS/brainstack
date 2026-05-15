'use client';

import Link from 'next/link';
import { Search, Inbox, Settings, FileText, KeyRound } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { type ReactNode } from 'react';

import { cn } from '@/lib/utils';

const links = [
  { href: '/', label: 'Inbox', icon: Inbox },
  { href: '/notes', label: 'Notes', icon: FileText },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/settings/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex h-screen w-full">
      <aside className="flex w-56 flex-col border-r border-border-subtle bg-bg-surface">
        <div className="flex h-12 items-center border-b border-border-subtle px-4 font-mono text-sm font-medium text-fg-primary">
          BrainStack
        </div>
        <nav className="flex-1 overflow-y-auto p-2">
          {links.map((link) => {
            const active =
              link.href === '/'
                ? pathname === '/'
                : pathname.startsWith(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'mb-1 flex h-8 items-center gap-2 rounded px-2 text-sm transition-colors duration-fast',
                  active
                    ? 'bg-bg-elevated text-fg-primary'
                    : 'text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary',
                )}
              >
                <Icon size={14} strokeWidth={1.75} />
                <span>{link.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border-subtle p-3 font-mono text-[11px] text-fg-muted">
          v0.1.0 · pre-alpha
        </div>
      </aside>
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
    </div>
  );
}
