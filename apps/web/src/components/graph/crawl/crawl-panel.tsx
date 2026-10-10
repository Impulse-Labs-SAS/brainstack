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
// search" there takes it back.
//
// The panel is there for one thing: a prompt to paste into an assistant or an
// IDE, with the notes that answer what was asked (brief.ts). So Copy prompt is
// always in reach, and works from the first moment — the walk replays an
// answer that has already come, and nobody should wait for it to end. Around
// it, three tabs: Context, to check what was found — settle what the text
// left ambiguous, take notes out, put back what the budget left out
// (answer.ts); Prompt, the text exactly as it is copied, in either format;
// and Activity, the walk's log and the raw answer an assistant receives over
// MCP. The walk's own controls ride over the stage (panel/transport.tsx): they
// play the replay, not the search.
//
// On a wide screen it is a column at the left that can fold to a strip; on a
// phone, a sheet from the bottom that comes in low, leaving the stage to the
// walk (panel/phone-sheet.tsx).
//
// The plugin writes the scene's levels on one element (`chrome`), ancestor of
// both the prompt and the panel, as CSS variables, every frame, without React:
// the prompt fades by them and the panel slides by them. That element has no
// opacity of its own — an ancestor with opacity below 1 is a backdrop root, and
// the glass's blur would sample nothing. The live region sits outside the
// panel: inside an inert one it would not speak.

import { Check, ChevronRight, Copy } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from 'react';
import { Button, Tab, TabList, TabPanel, Tabs } from 'react-aria-components';

import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import type { GraphController } from '../graph-controller';
import { GLASS } from '../graph-preview';

import {
  NO_CURATION,
  answerOf,
  rowsOf,
  type Answer,
  type AnswerSource,
  type Curation,
} from './answer';
import type { BriefFormat } from './brief';
import { readBriefFormat, writeBriefFormat } from './brief-pref';
import { CRAWL_COLORS } from './crawl-colors';
import { CrawlPlugin, type SentinelUi } from './crawl-plugin';
import { walkOver, type CrawlSnapshot } from './crawl-snapshot';
import { ActivityTab } from './panel/activity-tab';
import { ContextTab } from './panel/context-tab';
import { copyText } from './panel/copy-text';
import { PanelHead, type HistoryProps } from './panel/panel-head';
import { CopyButton, Eyebrow, FOCUS_RING, IconButton, type CopyState } from './panel/panel-ui';
import { PhoneSheet, type SheetSize } from './panel/phone-sheet';
import { PromptTab } from './panel/prompt-tab';
import { Transport } from './panel/transport';
import { useBrief } from './panel/use-brief';
import { useWide } from './panel/use-wide';
import { CrawlPrompt } from './prompt/crawl-prompt';
import { addSeen, promptRecents, readSeen, writeSeen } from './prompt/recents';
import { readSentinelPref, writeSentinelPref } from './sentinel-pref';

/** How often the recent searches are asked for while the view is open. */
const POLL_MS = 4_000;
/** How long Copy prompt says it copied. */
const COPIED_MS = 1_800;

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
const NO_COPY =
  'This browser did not let the page copy. The prompt is selected: copy it with Ctrl+C (⌘C on a Mac).';

const PHASE = ['reading the question', 'following links', 'context ready'] as const;

type PanelTab = 'context' | 'prompt' | 'activity';

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
  onCrawl,
}: {
  controller: GraphController;
  reduceMotion: boolean;
  /** Told when the walk comes on screen and when it goes: the page hides what the panel replaces. */
  onCrawl?(inCrawl: boolean): void;
}) {
  const chrome = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const peekStatus = useRef<HTMLDivElement>(null);
  /** The folded strip: where focus goes in when the column is folded and has no heading. */
  const strip = useRef<HTMLDivElement>(null);
  const briefText = useRef<HTMLPreElement>(null);
  const pluginRef = useRef<CrawlPlugin | null>(null);
  /** A send or a recent on its way: one at a time, or two would race to play. */
  const busy = useRef(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wide = useWide();

  const [ui, setUi] = useState<SentinelUi>(STARTING);
  const [snap, setSnap] = useState<CrawlSnapshot | null>(null);
  const [sentinelOn, setSentinelOn] = useState(() => readSentinelPref(storage()));
  const [playing, setPlaying] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  /** The last of the plugin's focus requests the prompt was let answer (see the effect below). */
  const [promptFocus, setPromptFocus] = useState(0);
  /** The search on screen, as the panel reads it. */
  const [answer, setAnswer] = useState<Answer | null>(null);
  /** What the assistant was handed, as gather_context returned it or the history kept it. */
  const [raw, setRaw] = useState<{ json: unknown; whole: boolean } | null>(null);
  const [curation, setCuration] = useState<Curation>(NO_CURATION);
  const [tab, setTab] = useState<PanelTab>('context');
  const [format, setFormat] = useState<BriefFormat>(() => readBriefFormat(storage()));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [folded, setFolded] = useState(false);
  const [sheet, setSheet] = useState<SheetSize>('peek');
  const [copied, setCopied] = useState(false);
  /** Bumped to select the prompt's text, once it is on screen, for a copy by hand. */
  const [selectBrief, setSelectBrief] = useState(0);
  const selectPending = useRef(false);
  const [announce, setAnnounce] = useState('');
  /** Searches played in this browser: an assistant's reads new until it is one of them. */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => readSeen(storage()));
  const seenAtStart = useRef(seen);

  const gather = trpc.notes.gatherContext.useMutation();
  const utils = trpc.useUtils();
  // Polled, so a search an assistant makes over MCP shows up without a reload.
  // React Query pauses the interval while the tab is hidden.
  const recent = trpc.crawls.list.useQuery(undefined, { refetchInterval: POLL_MS });
  const brief = useBrief(answer, curation, format);

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

  const inCrawl = ui.scene === 'crawl';

  // Into the walk, focus goes to the panel: the prompt went inert under the caret.
  useEffect(() => {
    if (!inCrawl) {
      pluginRef.current?.mark(null);
      return;
    }
    (wide ? (heading.current ?? strip.current) : peekStatus.current)?.focus({ preventScroll: true });
    // Only on the way in: a turned phone must not pull focus from where the person put it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCrawl]);

  useEffect(() => {
    onCrawl?.(inCrawl);
  }, [inCrawl, onCrawl]);
  useEffect(() => () => onCrawl?.(false), [onCrawl]);

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

  // A copy the browser refused: the prompt's text selected, for Ctrl+C, once
  // the Prompt tab — opened for it, the panel unfolded — has it on screen.
  useEffect(() => {
    const pre = briefText.current;
    if (!selectPending.current || !pre) return;
    selectPending.current = false;
    pre.focus({ preventScroll: true });
    pre.scrollIntoView({ block: 'nearest' });
    const range = document.createRange();
    range.selectNodeContents(pre);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [selectBrief, tab, folded, sheet]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

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

  /** Plays what came back, and the panel shows it; false if the view could not take it. */
  const show = (
    plugin: CrawlPlugin,
    result: AnswerSource,
    prompt: string,
    handed: { json: unknown; whole: boolean },
  ): boolean => {
    if (pluginRef.current !== plugin || !plugin.play(result, prompt)) return false;
    // The plugin plays from here: a pause left from the last walk is gone.
    setPlaying(true);
    setAnswer(answerOf(prompt, result));
    setRaw(handed);
    setCuration(NO_CURATION);
    setTab('context');
    setEditing(false);
    setSheet('peek');
    setCopied(false);
    setAnnounce('');
    return true;
  };

  const clearErrors = () => {
    setPromptError(null);
    setPanelError(null);
  };

  const run = async (text: string, from: From) => {
    const plugin = pluginRef.current;
    const prompt = text.trim();
    if (!plugin || !prompt || busy.current) return;
    busy.current = true;
    clearErrors();
    try {
      const result = await gather.mutateAsync({ text: prompt, depth: 1 });
      // The id is the panel's, not part of what an assistant receives.
      const { crawlId, ...handedOver } = result;
      void utils.crawls.list.invalidate();
      if (!show(plugin, result, prompt, { json: handedOver, whole: true })) {
        failed(from, NOT_NOW);
        return;
      }
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
    clearErrors();
    try {
      let kept: Awaited<ReturnType<typeof utils.crawls.get.fetch>>;
      try {
        kept = await utils.crawls.get.fetch({ id });
      } catch {
        failed(from, GONE);
        return;
      }
      if (!show(plugin, kept.replay, kept.prompt, { json: kept.replay, whole: false })) {
        failed(from, NOT_NOW);
        return;
      }
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
    setEditing(false);
    setPromptError(null);
  };

  const toggleSentinel = (on: boolean) => {
    setSentinelOn(on);
    pluginRef.current?.setSentinel(on);
    writeSentinelPref(storage(), on);
  };

  const chooseFormat = (next: BriefFormat) => {
    setFormat(next);
    writeBriefFormat(storage(), next);
  };

  const copy = async () => {
    if (!answer || brief.reading > 0) return;
    const ok = await copyText(brief.text);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    if (ok) {
      setPanelError(null);
      setCopied(true);
      setAnnounce(
        `Prompt copied: ${brief.notes} ${brief.notes === 1 ? 'note' : 'notes'}, ${brief.tokens}. Paste it into your assistant.`,
      );
      copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
      return;
    }
    setTab('prompt');
    setFolded(false);
    if (!wide && sheet === 'peek') setSheet('half');
    setPanelError(NO_COPY);
    selectPending.current = true;
    setSelectBrief((n) => n + 1);
  };

  const mark = useCallback((key: string | null) => pluginRef.current?.mark(key), []);

  const items = recent.data?.items;
  const now = recent.data?.now;
  const recents = useMemo(
    () => (items ? promptRecents(items, seen, now ?? Date.now()) : []),
    [items, seen, now],
  );

  // While the Sentinel walks, the panel lists what it has reached; once it is done, everything.
  const done = walkOver(snap);
  const reachedKeys = snap?.reached;
  const reached = useMemo(() => (done ? null : new Set(reachedKeys ?? [])), [done, reachedKeys]);
  const askedTerms = useMemo(
    () => (done ? null : new Set((snap?.asks ?? []).map((a) => a.term))),
    [done, snap?.asks],
  );
  const rows = useMemo(
    () => (answer ? rowsOf(answer, curation, reached) : []),
    [answer, curation, reached],
  );
  const unresolved = useMemo(
    () => (answer ? answer.unresolved.filter((u) => !askedTerms || askedTerms.has(u.term)) : []),
    [answer, askedTerms],
  );
  const open = answer ? answer.unresolved.filter((u) => !curation.settled.has(u.term)).length : 0;
  const copyState: CopyState = copied ? 'copied' : brief.reading > 0 ? 'reading' : 'ready';
  const onGraph = answer ? Math.max(0, answer.notes.length - (snap?.offGraph ?? 0)) : 0;

  const status = answer && (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] tabular-nums text-fg-primary">
          {done ? (
            <>
              <b className="font-medium">{brief.notes}</b> {brief.notes === 1 ? 'note' : 'notes'} ready
              {open > 0 && <span style={{ color: CRAWL_COLORS.ask }}> · {open} to clarify</span>}
            </>
          ) : (
            <>
              Walking your notes ·{' '}
              <span className="whitespace-nowrap">
                <b className="font-medium">{reached?.size ?? 0}</b> of {onGraph}
              </span>
            </>
          )}
        </span>
        {/* On a phone it shares the row with Copy prompt: the bar says as much. */}
        <span className="shrink-0 font-mono text-[11px] text-fg-muted max-md:hidden">
          {PHASE[snap?.phase ?? 0]}
        </span>
      </div>
      <div className="h-0.5 overflow-hidden rounded-full bg-border">
        <div
          className={cn('h-full transition-[width] duration-300', done ? 'bg-success' : 'bg-accent')}
          style={{ width: `${done ? 100 : onGraph > 0 ? Math.round(((reached?.size ?? 0) / onGraph) * 100) : 0}%` }}
        />
      </div>
    </div>
  );

  const history: HistoryProps = {
    items,
    now: now ?? Date.now(),
    seen,
    activeId,
    enabled: recent.data?.enabled ?? true,
    onOpen: (id) => void openRecent(id, 'panel'),
  };

  const head = (withStatus: boolean) => (
    <PanelHead
      headingRef={heading}
      question={answer?.question ?? ''}
      editing={editing}
      draft={draft}
      busy={gather.isPending || opening}
      onDraft={setDraft}
      onEdit={() => {
        setDraft(answer?.question ?? '');
        setEditing(true);
      }}
      onCancelEdit={() => setEditing(false)}
      onRun={() => void run(draft, 'panel')}
      onNew={newSearch}
      history={history}
      sentinelOn={sentinelOn}
      onSentinel={toggleSentinel}
      trail={ui.status === 'trail' ? (ui.failure ?? 'it did not start') : null}
      onCollapse={wide ? () => setFolded(true) : undefined}
      status={withStatus ? status : null}
      error={panelError}
    />
  );

  const tabs = (scroll: 'panel' | 'whole') =>
    answer &&
    raw && (
      <Tabs
        selectedKey={tab}
        onSelectionChange={(key) => setTab(key as PanelTab)}
        className={cn('flex flex-col', scroll === 'panel' && 'min-h-0 flex-1')}
      >
        <TabList
          aria-label="Panel sections"
          className={cn(
            'flex shrink-0 gap-1 border-b border-border-subtle px-2.5',
            scroll === 'whole' && 'sticky top-0 z-10 bg-bg-surface',
          )}
        >
          <PanelTabName id="context">
            Context
            <span className="rounded bg-bg-elevated px-1.5 font-mono text-[10.5px] tabular-nums text-fg-muted">
              {rows.length}
            </span>
          </PanelTabName>
          <PanelTabName id="prompt">Prompt</PanelTabName>
          <PanelTabName id="activity">Activity</PanelTabName>
        </TabList>
        {(['context', 'prompt', 'activity'] as const).map((id) => (
          <TabPanel
            key={id}
            id={id}
            className={cn(
              'p-3 outline-none',
              scroll === 'panel' && 'min-h-0 flex-1 overflow-y-auto',
              scroll === 'whole' && 'pb-[calc(1.5rem+env(safe-area-inset-bottom,0px))]',
            )}
          >
            {id === 'context' ? (
              <ContextTab
                answer={answer}
                rows={rows}
                unresolved={unresolved}
                curation={curation}
                walking={!done}
                onCuration={setCuration}
                onMark={mark}
              />
            ) : id === 'prompt' ? (
              <PromptTab format={format} onFormat={chooseFormat} brief={brief} textRef={briefText} />
            ) : (
              <ActivityTab snap={snap} answer={answer} raw={raw} />
            )}
          </TabPanel>
        ))}
      </Tabs>
    );

  const transport = snap && snap.state !== 'idle' && (
    <Transport
      snap={snap}
      playing={playing}
      onPlaying={(on) => {
        setPlaying(on);
        pluginRef.current?.setPlaying(on);
      }}
      onReplay={() => {
        pluginRef.current?.replay();
        setPlaying(true);
        pluginRef.current?.setPlaying(true);
      }}
      onSkip={() => pluginRef.current?.skipToEnd()}
      onFollow={() => pluginRef.current?.followAgain()}
    />
  );

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

      {/* A turn across the breakpoint swaps one layout for the other: what the search
          found and what the person made of it live here and carry over; a disclosure
          left open inside a tab does not. */}
      {wide ? (
        <>
          <aside
            aria-label="Sentinel"
            inert={!inCrawl}
            aria-hidden={!inCrawl}
            className={cn(
              GLASS,
              'pointer-events-auto absolute left-3 top-16 z-10 flex flex-col rounded-lg text-sm shadow-2xl',
              folded ? 'w-14' : 'bottom-3 w-[360px]',
            )}
            style={{ transform: 'translateX(calc((var(--crawl-panel, 0) - 1) * 120%))' }}
          >
            {folded ? (
              <Folded
                stripRef={strip}
                notes={brief.notes}
                copyState={copyState}
                onUnfold={() => setFolded(false)}
                onCopy={() => void copy()}
              />
            ) : (
              <>
                {head(true)}
                {tabs('panel')}
                {answer && (
                  <div className="grid gap-1.5 border-t border-border-subtle p-3">
                    <CopyButton state={copyState} onPress={() => void copy()} className="w-full" />
                    <div className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums text-fg-muted">
                      <span>
                        {brief.notes} {brief.notes === 1 ? 'note' : 'notes'} · {brief.tokens}
                      </span>
                      <Button
                        onPress={() => setTab('prompt')}
                        className={cn('flex items-center gap-0.5 hover:text-fg-primary', FOCUS_RING)}
                      >
                        {format === 'refs' ? 'References' : 'Full text'}
                        <ChevronRight size={11} aria-hidden />
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </aside>
          {transport && (
            <div
              className="pointer-events-none absolute bottom-3 z-10 transition-[left] duration-300 motion-reduce:transition-none"
              style={{
                left: folded ? '5rem' : '24rem',
                transform: 'translateY(calc((1 - var(--crawl-panel, 0)) * 200%))',
              }}
            >
              {transport}
            </div>
          )}
        </>
      ) : (
        <PhoneSheet
          open={inCrawl}
          size={sheet}
          onSize={setSheet}
          above={transport || undefined}
          peek={
            <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border-subtle px-3.5 pb-3">
              <div ref={peekStatus} tabIndex={-1} className="min-w-0 outline-none">
                {status}
              </div>
              <CopyButton state={copyState} onPress={() => void copy()} />
            </div>
          }
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            {head(false)}
            {tabs('whole')}
          </div>
        </PhoneSheet>
      )}

      <span aria-live="polite" className="sr-only">
        {announce || (inCrawl && answer ? `Searching your brain: ${answer.question}` : '')}
      </span>
    </div>
  );
}

function PanelTabName({ id, children }: { id: PanelTab; children: ReactNode }) {
  return (
    <Tab
      id={id}
      className={cn(
        '-mb-px flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-1.5 pb-2 pt-2.5 text-[12.5px] text-fg-secondary hover:text-fg-primary',
        'selected:border-accent selected:text-fg-primary',
        FOCUS_RING,
      )}
    >
      {children}
    </Tab>
  );
}

/** The panel folded to a strip: how many notes, Copy prompt, and the way back. */
function Folded({
  stripRef,
  notes,
  copyState,
  onUnfold,
  onCopy,
}: {
  stripRef: Ref<HTMLDivElement>;
  notes: number;
  copyState: CopyState;
  onUnfold(): void;
  onCopy(): void;
}) {
  return (
    <div
      ref={stripRef}
      tabIndex={-1}
      className="flex flex-col items-center gap-2.5 py-2 outline-none"
    >
      <IconButton label="Unfold the panel" onPress={onUnfold}>
        <ChevronRight size={15} aria-hidden />
      </IconButton>
      <span className="rotate-180 [writing-mode:vertical-rl]">
        <Eyebrow>Sentinel</Eyebrow>
      </span>
      <span className="grid justify-items-center">
        <span className="font-mono text-[15px] tabular-nums text-fg-primary">{notes}</span>
        <span className="font-mono text-[10px] text-fg-muted">notes</span>
      </span>
      <Button
        aria-label={copyState === 'copied' ? 'Copied' : 'Copy prompt'}
        onPress={onCopy}
        isDisabled={copyState === 'reading'}
        className={cn(
          'flex h-9 w-9 items-center justify-center rounded-md disabled:opacity-60',
          copyState === 'copied'
            ? 'bg-[rgba(34,197,94,0.14)] text-success'
            : 'bg-accent text-accent-fg hover:bg-accent-hover',
          FOCUS_RING,
        )}
      >
        {copyState === 'copied' ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
      </Button>
    </div>
  );
}
