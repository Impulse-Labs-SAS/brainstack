'use client';

import Link from 'next/link';
import {
  FileText,
  KeyRound,
  LogOut,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { authFetch } from '@/lib/authApi';
import { trpc } from '@/lib/trpc';
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
        <UserFooter collapsed={collapsed} />
      </aside>
      <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

/**
 * Who is signed in, and the way out.
 *
 * Signing out used to live three clicks deep inside Settings › Account, which
 * is a fine place for it to also be and a bad place for it to only be: on a
 * shared machine the way out has to be in sight.
 */
function UserFooter({ collapsed }: { collapsed: boolean }) {
  const router = useRouter();
  const me = trpc.auth.me.useQuery();
  const [signingOut, setSigningOut] = useState(false);

  const user = me.data?.user;
  const label = user?.displayName?.trim() || user?.email || '';

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await authFetch('/auth/logout', { method: 'POST' });
    } catch {
      // The cookie is HttpOnly, so there is nothing to clean up here; land on
      // /login either way and let it sort the session out.
    }
    router.replace('/login');
  }, [router]);

  return (
    <div className="border-t border-border-subtle">
      <div className={cn('flex items-center', collapsed ? 'justify-center p-1.5' : 'gap-2 p-2')}>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-fg-secondary" title={label}>
              {label || '—'}
            </div>
            {user?.displayName && (
              <div className="truncate font-mono text-[11px] text-fg-muted" title={user.email}>
                {user.email}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={signingOut}
          title="Sign out"
          aria-label="Sign out"
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded',
            'text-fg-muted hover:bg-bg-elevated hover:text-danger',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <LogOut size={14} strokeWidth={1.75} />
        </button>
      </div>
      {!collapsed && (
        <div className="px-3 pb-2 font-mono text-[11px] text-fg-muted">v0.1.0 · pre-alpha</div>
      )}
    </div>
  );
}
