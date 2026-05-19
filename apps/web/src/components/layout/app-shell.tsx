'use client';

import Link from 'next/link';
import {
  FileText,
  KeyRound,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { CommandPalette } from '@/components/search/command-palette';

const links = [
  { href: '/notes', label: 'Notes', icon: FileText },
  { href: '/graph', label: 'Graph', icon: Network },
  { href: '/settings/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const COLLAPSED_KEY = 'brainstack:sidebar-collapsed';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_KEY);
      if (raw === '1') setCollapsed(true);
    } catch {
      // ignore
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen w-full">
      <aside
        className={cn(
          'flex flex-col border-r border-border-subtle bg-bg-surface transition-[width] duration-150',
          collapsed ? 'w-12' : 'w-56',
        )}
      >
        <div
          className={cn(
            'flex h-12 items-center border-b border-border-subtle font-mono text-sm font-medium text-fg-primary',
            collapsed ? 'justify-center px-0' : 'justify-between px-4',
          )}
        >
          {!collapsed && <span>BrainStack</span>}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
          >
            {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
          </button>
        </div>
        <nav className={cn('flex-1 overflow-y-auto', collapsed ? 'p-1.5' : 'p-2')}>
          {links.map((link) => {
            const active = pathname.startsWith(link.href);
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                title={collapsed ? link.label : undefined}
                className={cn(
                  'mb-1 flex h-8 items-center rounded text-sm transition-colors duration-fast',
                  collapsed ? 'justify-center px-0' : 'gap-2 px-2',
                  active
                    ? 'bg-bg-elevated text-fg-primary'
                    : 'text-fg-secondary hover:bg-bg-elevated hover:text-fg-primary',
                )}
              >
                <Icon size={14} strokeWidth={1.75} />
                {!collapsed && <span>{link.label}</span>}
              </Link>
            );
          })}
        </nav>
        {!collapsed && (
          <div className="border-t border-border-subtle p-3 font-mono text-[11px] text-fg-muted">
            v0.1.0 · pre-alpha
          </div>
        )}
      </aside>
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
