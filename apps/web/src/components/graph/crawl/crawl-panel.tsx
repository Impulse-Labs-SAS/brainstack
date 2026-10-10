'use client';

// The Sentinel view's chrome: the prompt at the centre and the side panel. The
// walk itself runs in CrawlPlugin, outside React, on a stage of its own or, where
// that cannot run, as a trail of light over the brain; this component makes the
// plugin, hands it to the controller, and hears from it only when something a
// person would see changes (`SentinelUi`, `CrawlSnapshot`).
//
// It opens on the prompt: one line to ask, the Sentinel clinging to the frame
// round it, the recent searches under it — an assistant's marked new until it
// is played in this browser, and never started by itself. A send, or a recent
// touched, takes the view into the walk and brings the side panel in; "New
// search" there takes it back. The side panel keeps every option it had before
// the prompt came: its own field, Pause, Replay and Follow, the Sentinel
// switch, the recent searches, and what was found, left to ask, handed over and
// walked. It is reworked on its own later; here it changes only as far as the
// prompt needs.
//
// The plugin writes the scene's levels on one element (`chrome`), ancestor of
// both the prompt and the panel, as CSS variables, every frame, without React:
// the prompt fades by them and the panel slides by them. That element has no
// opacity of its own — an ancestor with opacity below 1 is a backdrop root, and
// the glass's blur would sample nothing. The live region sits outside the
// panel: inside an inert one it would not speak.

import { Bot, Crosshair, Pause, Play, RotateCcw, Search, User } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Switch, TextArea, TextField } from 'react-aria-components';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import type { GraphController } from '../graph-controller';
import { GLASS } from '../graph-preview';

import { CRAWL_COLORS } from './crawl-colors';
import { ago, madeBy } from './crawl-history';
import type { CrawlResult } from './crawl-plan';
import { CrawlPlugin, type SentinelUi } from './crawl-plugin';
import type { CrawlSnapshot } from './crawl-snapshot';
import { CrawlPrompt } from './prompt/crawl-prompt';
import { addSeen, promptRecents, readSeen, writeSeen } from './prompt/recents';
import { readSentinelPref, writeSentinelPref } from './sentinel-pref';

/** How often the recent searches are asked for while the view is open. */
const POLL_MS = 4_000;
/** Recent searches the side panel lists; the prompt shows fewer (`RECENT_MOST`). */
const RECENT_SHOWN = 8;

/** Until the plugin's first word: the prompt, inert, the stage on its way. */
const STARTING: SentinelUi = {
  scene: 'prompt',
  interactive: false,
  focus: 0,
  status: 'starting',
  failure: null,
};

const GONE = 'That search is no longer kept.';
/** A search back from the server with the view already elsewhere: nothing could take it. */
const NOT_NOW = 'The Sentinel could not take that search just now. Try again.';

const VERB_COLOR: Record<CrawlSnapshot['log'][number]['kind'], string> = {
  named: CRAWL_COLORS.named,
  linked: CRAWL_COLORS.linked,
  decision: CRAWL_COLORS.decision,
  ask: CRAWL_COLORS.ask,
  walk: 'var(--fg-muted)',
  done: 'var(--fg-primary)',
};

/** The browser's store, or null where touching it throws (a sandboxed frame, blocked storage). */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

type From = 'prompt' | 'panel';

export function CrawlPanel({
  controller,
  reduceMotion,
}: {
  controller: GraphController;
  reduceMotion: boolean;
}) {
  const chrome = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pluginRef = useRef<CrawlPlugin | null>(null);
  /** A send or a recent on its way: one at a time, or two would race to play. */
  const busy = useRef(false);

  const [ui, setUi] = useState<SentinelUi>(STARTING);
  const [snap, setSnap] = useState<CrawlSnapshot | null>(null);
  const [text, setText] = useState('');
  const [sentinelOn, setSentinelOn] = useState(() => readSentinelPref(storage()));
  const [playing, setPlaying] = useState(true);
  const [asked, setAsked] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** The last of the plugin's focus requests the prompt was let answer (see the effect below). */
  const [promptFocus, setPromptFocus] = useState(0);
  /** What the assistant was handed, as the panel last saw it. */
  const [response, setResponse] = useState<{ json: unknown; whole: boolean } | null>(null);
  /** Searches played in this browser: an assistant's reads new until it is one of them. */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => readSeen(storage()));
  const seenAtStart = useRef(seen);

  const gather = trpc.notes.gatherContext.useMutation();
  const utils = trpc.useUtils();
  // Polled, so a search an assistant makes over MCP shows up without a reload.
  // React Query pauses the interval while the tab is hidden.
  const recent = trpc.crawls.list.useQuery(undefined, { refetchInterval: POLL_MS });

  // One plugin per controller, for as long as the view is open. Not remade when
  // reduced motion changes: that would throw a WebGL context away.
  useEffect(() => {
    const promptBox = box.current;
    const root = chrome.current;
    if (!promptBox || !root) return;
    const plugin = new CrawlPlugin({
      still: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      sentinel: readSentinelPref(storage()),
      onSnapshot: setSnap,
      onUi: setUi,
    });
    plugin.attach({ box: promptBox, chrome: root });
    pluginRef.current = plugin;
    controller.setPlugin(plugin);
    return () => {
      // Detached first: the controller leaves stage mode while the stage still exists.
      controller.setPlugin(null);
      plugin.dispose();
      if (pluginRef.current === plugin) pluginRef.current = null;
    };
  }, [controller]);

  useEffect(() => {
    pluginRef.current?.setReducedMotion(reduceMotion);
  }, [reduceMotion]);

  // Into the walk, focus goes to the panel's heading: the prompt went inert under the caret.
  useEffect(() => {
    if (ui.scene === 'crawl') heading.current?.focus({ preventScroll: true });
  }, [ui.scene]);

  // The plugin asks for the prompt's focus each time it takes text again — the
  // first time a second or two after the page loads. Taken only from nowhere,
  // from the stage, or from this chrome (the panel that just went inert): never
  // from the layers menu or anything else the person moved to meanwhile.
  useEffect(() => {
    if (ui.focus === 0) return;
    const active = document.activeElement;
    const root = chrome.current;
    const free =
      !active ||
      active === document.body ||
      !!root?.contains(active) ||
      (active instanceof HTMLCanvasElement && !!root?.parentElement?.contains(active));
    if (free) setPromptFocus(ui.focus);
  }, [ui.focus]);

  useEffect(() => {
    if (seen !== seenAtStart.current) writeSeen(storage(), seen);
  }, [seen]);

  const remember = (id: string) =>
    setSeen((prev) => {
      const next = new Set(prev);
      addSeen(next, id);
      return next;
    });

  const failed = (from: From, message: string) => {
    if (from === 'prompt') setPromptError(message);
    else setPanelError(message);
  };

  /** Plays what came back; false if the view could not take it (left, or on its way elsewhere). */
  const play = (plugin: CrawlPlugin, result: CrawlResult, prompt: string): boolean => {
    if (pluginRef.current !== plugin || !plugin.play(result, prompt)) return false;
    // The plugin plays from here: a pause left from the last walk is gone.
    setPlaying(true);
    setAsked(prompt);
    return true;
  };

  const run = async (raw: string, from: From) => {
    const plugin = pluginRef.current;
    const prompt = raw.trim();
    if (!plugin || !prompt || busy.current) return;
    busy.current = true;
    setPromptError(null);
    setPanelError(null);
    setOpenError(null);
    try {
      const result = await gather.mutateAsync({ text: prompt, depth: 1 });
      // The id is the panel's, not part of what an assistant receives.
      const { crawlId, ...handedOver } = result;
      void utils.crawls.list.invalidate();
      if (!play(plugin, result, prompt)) {
        failed(from, NOT_NOW);
        return;
      }
      setResponse({ json: handedOver, whole: true });
      setActiveId(crawlId);
      if (crawlId) remember(crawlId);
    } catch (error) {
      failed(from, error instanceof Error ? error.message : String(error));
    } finally {
      busy.current = false;
    }
  };

  const openRecent = async (id: string, from: From) => {
    const plugin = pluginRef.current;
    if (!plugin || busy.current) return;
    busy.current = true;
    setOpening(true);
    setPromptError(null);
    setPanelError(null);
    setOpenError(null);
    try {
      let kept: Awaited<ReturnType<typeof utils.crawls.get.fetch>>;
      try {
        kept = await utils.crawls.get.fetch({ id });
      } catch {
        if (from === 'prompt') setPromptError(GONE);
        else setOpenError(GONE);
        return;
      }
      if (!play(plugin, kept.replay, kept.prompt)) {
        failed(from, NOT_NOW);
        return;
      }
      setResponse({ json: kept.replay, whole: false });
      setActiveId(id);
      remember(id);
    } finally {
      busy.current = false;
      setOpening(false);
    }
  };

  const newSearch = () => {
    if (!pluginRef.current?.newSearch()) return;
    // The way back runs on the walk's clock, so the plugin resumes it.
    setPlaying(true);
    setPromptError(null);
  };

  const toggleSentinel = (on: boolean) => {
    setSentinelOn(on);
    pluginRef.current?.setSentinel(on);
    writeSentinelPref(storage(), on);
  };

  const items = recent.data?.items;
  const now = recent.data?.now;
  const recents = useMemo(
    () => (items ? promptRecents(items, seen, now ?? Date.now()) : []),
    [items, seen, now],
  );

  const inCrawl = ui.scene === 'crawl';
  const total = snap ? snap.found.named + snap.found.linked + snap.found.decision : 0;
  const refs = total + (snap?.asks.length ?? 0);

  return (
    <div ref={chrome} className="pointer-events-none absolute inset-0 z-10">
      <CrawlPrompt
        boxRef={box}
        shown
        recents={recents}
        interactive={ui.interactive}
        focusKey={promptFocus}
        pending={gather.isPending || opening}
        error={promptError}
        onSubmit={(t) => void run(t, 'prompt')}
        onRecent={(id) => void openRecent(id, 'prompt')}
      />

      <aside
        aria-label="Sentinel"
        inert={!inCrawl}
        aria-hidden={!inCrawl}
        className={cn(
          GLASS,
          'pointer-events-auto absolute inset-x-3 top-16 z-10 flex max-h-[45%] flex-col gap-3 overflow-y-auto rounded-lg p-3 text-sm md:inset-x-auto md:left-3 md:max-h-[calc(100%-12.5rem)] md:w-[320px]',
        )}
        style={{ transform: 'translateX(calc((var(--crawl-panel, 0) - 1) * 120%))' }}
      >
        <div className="grid gap-2">
          <h2
            ref={heading}
            tabIndex={-1}
            className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted outline-none"
          >
            Sentinel
          </h2>
          <p className="line-clamp-3 text-[13px] leading-5 text-fg-primary">{asked || '—'}</p>
          <Button
            onPress={newSearch}
            className="flex h-8 items-center justify-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          >
            <Search size={14} aria-hidden />
            New search
          </Button>
        </div>

        <TextField
          value={text}
          onChange={setText}
          aria-label="Prompt"
          className="grid gap-1.5 border-t border-border-subtle pt-3"
        >
          <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
            Try a prompt
          </span>
          <TextArea
            rows={4}
            placeholder="Paste what you would ask an assistant. The Sentinel walks your notes to find what it refers to."
            className="w-full resize-y rounded-md border border-border-default bg-bg-surface px-2.5 py-2 text-[13px] leading-5 text-fg-primary outline-none placeholder:text-fg-muted focus:border-accent"
          />
        </TextField>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onPress={() => void run(text, 'panel')}
            isDisabled={!text.trim() || gather.isPending || opening}
            className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
          >
            <Search size={14} aria-hidden />
            {gather.isPending ? 'Searching…' : 'Search'}
          </Button>
          {snap && snap.state !== 'idle' && (
            <>
              <IconButton
                label={playing ? 'Pause' : 'Resume'}
                onPress={() => {
                  const next = !playing;
                  setPlaying(next);
                  pluginRef.current?.setPlaying(next);
                }}
              >
                {playing ? <Pause size={14} /> : <Play size={14} />}
              </IconButton>
              <IconButton
                label="Replay"
                onPress={() => {
                  pluginRef.current?.replay();
                  setPlaying(true);
                  pluginRef.current?.setPlaying(true);
                }}
              >
                <RotateCcw size={14} />
              </IconButton>
              {!snap.following && (
                <IconButton
                  label="Follow the Sentinel"
                  onPress={() => pluginRef.current?.followAgain()}
                >
                  <Crosshair size={14} />
                </IconButton>
              )}
            </>
          )}
        </div>
        {panelError && <p className="text-[12.5px] text-danger">{panelError}</p>}

        <Switch
          isSelected={sentinelOn}
          onChange={toggleSentinel}
          className="group flex cursor-pointer items-center justify-between gap-3 outline-none"
        >
          <span className="grid">
            <span className="text-[13px] text-fg-primary">Sentinel</span>
            <span className="text-[11.5px] leading-4 text-fg-muted">
              Off, the walk shows as light alone.
            </span>
          </span>
          <span className="relative h-5 w-9 shrink-0 rounded-full bg-bg-hover transition-colors group-selected:bg-accent group-focus-visible:ring-2 group-focus-visible:ring-accent/40">
            <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-fg-primary transition-transform group-selected:translate-x-4" />
          </span>
        </Switch>
        {ui.status === 'trail' && (
          <p className="text-[11.5px] leading-4 text-fg-muted">
            The Sentinel cannot run here ({ui.failure ?? 'it did not start'}), so the walk shows as
            a trail of light.
          </p>
        )}

        {recent.data && !recent.data.enabled && (
          <p className="text-[11.5px] leading-4 text-fg-muted">
            Search history is off on this server: assistants’ searches are not kept.
          </p>
        )}
        {items && items.length > 0 && (
          <div className="grid gap-1.5 border-t border-border-subtle pt-3">
            <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
              Recent
            </span>
            <ul className="grid max-h-56 gap-1 overflow-y-auto">
              {items.slice(0, RECENT_SHOWN).map((c) => (
                <li key={c.id}>
                  <Button
                    onPress={() => void openRecent(c.id, 'panel')}
                    aria-current={c.id === activeId ? 'true' : undefined}
                    className={cn(
                      'grid w-full gap-0.5 rounded-md border px-2 py-1.5 text-left outline-none hover:bg-bg-hover focus-visible:ring-2 focus-visible:ring-accent/40',
                      c.id === activeId ? 'border-accent/60 bg-accent/10' : 'border-border-subtle',
                    )}
                  >
                    <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-fg-muted">
                      {c.source === 'assistant' ? (
                        <Bot size={12} aria-hidden />
                      ) : (
                        <User size={12} aria-hidden />
                      )}
                      <span className="truncate">{madeBy(c)}</span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">{ago(c.createdAt, now ?? c.createdAt)}</span>
                      <span aria-hidden>·</span>
                      <span className="shrink-0 tabular-nums">
                        {c.notes} {c.notes === 1 ? 'note' : 'notes'}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-[12.5px] leading-[17px] text-fg-primary">
                      {c.prompt}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
            {openError && <p className="text-[12px] text-danger">{openError}</p>}
          </div>
        )}

        {snap && snap.state !== 'idle' && (
          <>
            <div className="grid gap-1 border-t border-border-subtle pt-3">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
                  Found
                </span>
                <span className="font-mono text-[11px] text-fg-muted">
                  {['reading the prompt', 'following links', 'context ready'][snap.phase]}
                </span>
              </div>
              <p className="text-[13px] text-fg-primary">
                <span className="font-mono text-lg tabular-nums">{total}</span>{' '}
                {total === 1 ? 'note' : 'notes'} for the assistant
                {snap.state === 'done' && refs > 0 && (
                  <span className="text-fg-muted">
                    {' '}
                    · {total} of {refs} references resolved
                  </span>
                )}
              </p>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 font-mono text-[11.5px] text-fg-muted">
                <dt>named in the text</dt>
                <dd className="tabular-nums text-fg-primary">{snap.found.named}</dd>
                <dt>linked</dt>
                <dd className="tabular-nums text-fg-primary">{snap.found.linked}</dd>
                <dt>decisions</dt>
                <dd className="tabular-nums text-fg-primary">{snap.found.decision}</dd>
                <dt>threads walked</dt>
                <dd className="tabular-nums text-fg-primary">{snap.threads}</dd>
              </dl>
              {snap.offGraph > 0 && (
                <p className="text-[11.5px] text-fg-muted">
                  {snap.offGraph} more not shown: hidden by a layer.
                </p>
              )}
            </div>

            {snap.asks.length > 0 && (
              <div className="grid gap-1.5 border-t border-border-subtle pt-3">
                <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
                  To ask you · {snap.asks.length}
                </span>
                {snap.asks.map((a) => (
                  <div
                    key={a.term}
                    className="rounded-md border px-2 py-1.5 text-[12.5px]"
                    style={{
                      borderColor: `${CRAWL_COLORS.ask}55`,
                      background: `${CRAWL_COLORS.ask}10`,
                    }}
                  >
                    “{a.term}”<span className="block text-[11.5px] text-fg-muted">{a.why}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Before the log: what the assistant got matters more than how the replay walked it. */}
            {response && (
              <details
                open
                className="group grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5 border-t border-border-subtle pt-3"
              >
                <summary className="flex cursor-pointer list-none items-baseline justify-between outline-none focus-visible:text-fg-primary">
                  <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-secondary">
                    <span className="mr-1 inline-block transition-transform group-open:rotate-90">
                      ›
                    </span>
                    Response
                  </span>
                  <span className="font-mono text-[11px] text-accent">what the assistant got</span>
                </summary>
                <p className="text-[11.5px] leading-4 text-fg-muted">
                  {response.whole
                    ? 'What gather_context returns to the assistant, as it receives it.'
                    : 'From the history: the note bodies (excerpt) are not kept, so they are missing here.'}
                </p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-accent/30 bg-bg-base p-2 font-mono text-[10.5px] leading-[15px] text-fg-secondary">
                  {JSON.stringify(response.json, null, 2)}
                </pre>
              </details>
            )}

            <div className="grid gap-1 border-t border-border-subtle pt-3">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
                Log
              </span>
              <ol className="grid max-h-40 gap-px overflow-hidden font-mono text-[11px] leading-[17px]">
                {snap.log.slice(0, 12).map((l, i) => (
                  <li
                    key={`${l.t}-${i}`}
                    className="grid grid-cols-[40px_64px_minmax(0,1fr)] gap-1.5 whitespace-nowrap"
                  >
                    <span className="tabular-nums text-fg-disabled">{l.t.toFixed(1)}s</span>
                    <span style={{ color: VERB_COLOR[l.kind] }}>{l.verb}</span>
                    <span className="truncate text-fg-secondary">{l.text}</span>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </aside>

      <span aria-live="polite" className="sr-only">
        {inCrawl && asked ? `Searching your brain: ${asked}` : ''}
      </span>
    </div>
  );
}

function IconButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress(): void;
  children: React.ReactNode;
}) {
  return (
    <Button
      aria-label={label}
      onPress={onPress}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-border-default text-fg-secondary outline-none hover:text-fg-primary focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {children}
    </Button>
  );
}
