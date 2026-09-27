'use client';

import Link from 'next/link';
import {
  Bug,
  FileText,
  KeyRound,
  LogOut,
  Menu,
  Network,
  Plug,
  Search,
  Settings,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { authFetch } from '@/lib/authApi';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { CommandPalette } from '@/components/search/command-palette';
import { BugReportDialog } from '@/components/support/bug-report-dialog';
import { ConnectMcpDialog } from '@/components/support/connect-mcp-dialog';
import { SkillDialog } from '@/components/support/skill-dialog';

const links = [
  { href: '/notes', label: 'Notes', icon: FileText },
  { href: '/graph', label: 'Graph', icon: Network },
  { href: '/settings/api-keys', label: 'API keys', icon: KeyRound },
  { href: '/settings', label: 'Settings', icon: Settings },
];

/** The nav entry a path belongs to: the longest href it starts with. */
function activeHref(pathname: string): string | undefined {
  return links
    .filter((l) => pathname === l.href || pathname.startsWith(`${l.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

/** Opens the quick switcher, for buttons that live outside the shell. */
const PaletteContext = createContext<() => void>(() => {});
export const useOpenPalette = (): (() => void) => useContext(PaletteContext);

/** The platform's modifier key, for shortcut hints. */
export function useModKey(): string {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setMod('⌘');
  }, []);
  return mod;
}

/**
 * A label that shows beside a rail icon on hover or keyboard focus. The rail
 * is 48px wide, so the icon alone has to be enough to find, and the label is
 * what confirms it.
 */
function RailTip({ children }: { children: ReactNode }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap',
        'rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg-primary shadow-lg',
        'opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100',
        'hidden md:block',
      )}
    >
      {children}
    </span>
  );
}

const railItem = (active = false) =>
  cn(
    'group relative flex h-9 items-center rounded-lg text-sm transition-colors duration-fast',
    // Rail on md+, a labelled list in the phone drawer.
    'w-full gap-2.5 px-2.5 md:w-9 md:justify-center md:gap-0 md:px-0',
    active
      ? 'bg-bg-elevated text-fg-primary'
      : 'text-fg-muted hover:bg-bg-hover hover:text-fg-primary',
  );

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const mod = useModKey();
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * Only on phones. The nav slides in over the content instead of taking a
   * share of it — and closes on the way out, because a link that leaves the
   * drawer open covers what it navigated to.
   */
  const [navOpen, setNavOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

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
    <PaletteContext.Provider value={openPalette}>
      <div className="flex h-screen w-full">
        {navOpen && (
          <div
            onClick={() => setNavOpen(false)}
            className="fixed inset-0 z-30 bg-black/50 md:hidden"
            aria-hidden
          />
        )}
        {/*
          The app's own navigation is four places, so on md+ it is a 48px rail
          of icons rather than a 224px column: what the notes screen needs room
          for is the tree and the note.
        */}
        <aside
          className={cn(
            'flex flex-col border-r border-border-subtle bg-bg-surface',
            'fixed inset-y-0 left-0 z-40 w-56 transition-transform duration-150',
            'md:static md:z-auto md:w-12 md:translate-x-0 md:items-center',
            navOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex h-12 w-full items-center px-4 md:justify-center md:px-0">
            <span
              aria-hidden
              className="grid h-7 w-7 place-items-center rounded-lg border border-accent/45 bg-accent/15 font-mono text-[13px] font-bold text-accent-hover"
            >
              B
            </span>
            <span className="ml-2.5 font-mono text-sm font-medium text-fg-primary md:sr-only">
              BrainStack
            </span>
          </div>
          <nav className="flex w-full flex-1 flex-col gap-1 p-2 md:items-center md:px-0 md:py-1.5">
            {links.map((link) => {
              // The most specific match wins: /settings/api-keys is "API keys",
              // not also "Settings".
              const active = link.href === activeHref(pathname);
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  onClick={() => setNavOpen(false)}
                  href={link.href}
                  aria-label={link.label}
                  aria-current={active ? 'page' : undefined}
                  className={railItem(active)}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  <span className="md:hidden">{link.label}</span>
                  <RailTip>{link.label}</RailTip>
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setNavOpen(false);
                openPalette();
              }}
              aria-label="Search"
              className={railItem()}
            >
              <Search size={16} strokeWidth={1.75} />
              <span className="md:hidden">Search</span>
              <RailTip>
                Search <span className="ml-1 font-mono text-fg-muted">{mod} K</span>
              </RailTip>
            </button>
          </nav>
          <HelpActions />
          <UserFooter />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            title="Menu"
            aria-label="Menu"
            className={cn(
              'absolute left-2 top-3 z-20 flex h-6 w-6 items-center justify-center rounded',
              'text-fg-muted hover:bg-bg-elevated hover:text-fg-primary md:hidden',
              navOpen && 'hidden',
            )}
          >
            <Menu size={16} />
          </button>
          {children}
        </main>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </PaletteContext.Provider>
  );
}

type HelpDialog = 'connect' | 'skill' | 'bug';

const helpActions: ReadonlyArray<{ id: HelpDialog; label: string; icon: LucideIcon }> = [
  { id: 'connect', label: 'Connect AI', icon: Plug },
  { id: 'skill', label: 'Skill', icon: Sparkles },
  { id: 'bug', label: 'Report a bug', icon: Bug },
];

/**
 * Getting an assistant onto the brain, and telling us when something breaks.
 * They open dialogs rather than pages so nobody loses the note they were on.
 */
function HelpActions() {
  const [openDialog, setOpenDialog] = useState<HelpDialog | null>(null);
  const close = useCallback(() => setOpenDialog(null), []);

  return (
    <>
      <div className="flex w-full flex-col gap-1 border-t border-border-subtle p-2 md:items-center md:px-0 md:py-1.5">
        {helpActions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              onClick={() => setOpenDialog(action.id)}
              aria-label={action.label}
              className={railItem()}
            >
              <Icon size={16} strokeWidth={1.75} />
              <span className="md:hidden">{action.label}</span>
              <RailTip>{action.label}</RailTip>
            </button>
          );
        })}
      </div>
      <ConnectMcpDialog open={openDialog === 'connect'} onClose={close} />
      <SkillDialog open={openDialog === 'skill'} onClose={close} />
      <BugReportDialog open={openDialog === 'bug'} onClose={close} />
    </>
  );
}

function initials(label: string): string {
  const parts = label.split(/[\s@._-]+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/**
 * Who is signed in, and the way out.
 *
 * Signing out used to live three clicks deep inside Settings › Account, which
 * is a fine place for it to also be and a bad place for it to only be: on a
 * shared machine the way out has to be in sight.
 */
function UserFooter() {
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
    <div className="flex w-full items-center gap-2 border-t border-border-subtle p-2 md:flex-col md:gap-1 md:px-0 md:py-2">
      <span
        className="group relative grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/20 font-mono text-[10px] font-semibold text-accent-hover"
        tabIndex={0}
        aria-label={label ? `Signed in as ${label}` : 'Signed in'}
      >
        {label ? initials(label) : '·'}
        <RailTip>
          <span className="block">{label || '—'}</span>
          {user?.displayName && (
            <span className="block font-mono text-[11px] text-fg-muted">{user.email}</span>
          )}
          <span className="block font-mono text-[11px] text-fg-muted">v0.1.0 · pre-alpha</span>
        </RailTip>
      </span>
      <div className="min-w-0 flex-1 md:hidden">
        <div className="truncate text-xs text-fg-secondary" title={label}>
          {label || '—'}
        </div>
        <div className="font-mono text-[11px] text-fg-muted">v0.1.0 · pre-alpha</div>
      </div>
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={signingOut}
        aria-label="Sign out"
        className={cn(
          'group relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          'text-fg-muted hover:bg-bg-hover hover:text-danger',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        <LogOut size={14} strokeWidth={1.75} />
        <RailTip>Sign out</RailTip>
      </button>
    </div>
  );
}
