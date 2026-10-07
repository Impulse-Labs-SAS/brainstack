'use client';

// The Crawl view's chrome: a prompt to try, the spider switch, the recent
// crawls, and what the replay found. The replay itself runs in CrawlLayer,
// outside React; this panel only hears about it when something a person would
// read changes.

import { Bot, Bug, Crosshair, Pause, Play, RotateCcw, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Switch, TextArea, TextField } from 'react-aria-components';

import type { GraphModel } from '@/lib/graph-model';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

import type { GraphController } from '../graph-controller';
import { GLASS } from '../graph-preview';

import { ago, madeBy, newAssistantCrawl } from './crawl-history';
import { CRAWL_COLORS, CrawlLayer, type CrawlSnapshot } from './crawl-layer';
import type { CrawlResult } from './crawl-plan';

/** How often the recent crawls are asked for while the view is open. */
const POLL_MS = 4_000;
const RECENT_SHOWN = 8;

const SPIDER_KEY = 'brainstack.graph.spider';

function readSpider(): boolean {
  try {
    return localStorage.getItem(SPIDER_KEY) !== 'off';
  } catch {
    return true;
  }
}

const VERB_COLOR: Record<CrawlSnapshot['log'][number]['kind'], string> = {
  named: CRAWL_COLORS.named,
  linked: CRAWL_COLORS.linked,
  decision: CRAWL_COLORS.decision,
  ask: CRAWL_COLORS.ask,
  walk: 'var(--fg-muted)',
  done: 'var(--fg-primary)',
};

export function CrawlPanel({
  controller,
  model,
  reduceMotion,
}: {
  controller: GraphController | null;
  model: GraphModel | null;
  reduceMotion: boolean;
}) {
  const [snap, setSnap] = useState<CrawlSnapshot | null>(null);
  const [text, setText] = useState('');
  const [spiderOn, setSpiderOn] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  /** What the assistant was handed, as the panel last saw it. */
  const [response, setResponse] = useState<{ json: unknown; whole: boolean } | null>(null);
  const layerRef = useRef<CrawlLayer | null>(null);
  const gather = trpc.notes.gatherContext.useMutation();
  const utils = trpc.useUtils();
  // Polled, so a crawl an assistant makes over MCP shows up without a reload.
  // React Query pauses the interval while the tab is hidden.
  const recent = trpc.crawls.list.useQuery(undefined, { refetchInterval: POLL_MS });
  /** Crawls already on screen when the view opened, or since: only newer ones play by themselves. */
  const seenRef = useRef<Set<string> | null>(null);

  // One layer for as long as the view is open; it leaves the graph when the view does.
  useEffect(() => {
    if (!controller) return;
    const layer = new CrawlLayer(setSnap, reduceMotion);
    layer.spiderOn = readSpider();
    setSpiderOn(layer.spiderOn);
    layerRef.current = layer;
    controller.setPlugin(layer);
    return () => {
      controller.setPlugin(null);
      layerRef.current = null;
    };
  }, [controller, reduceMotion]);

  const play = (result: CrawlResult) => {
    const layer = layerRef.current;
    if (!layer || !model) return;
    layer.load(result, model);
    layer.playing = true;
    setPlaying(true);
  };

  const run = async () => {
    const prompt = text.trim();
    if (!prompt || !model) return;
    const result = await gather.mutateAsync({ text: prompt, depth: 1 });
    setOpenError(null);
    // The id is the panel's, not part of what an assistant receives.
    const { crawlId: _crawlId, ...handedOver } = result;
    setResponse({ json: handedOver, whole: true });
    setActiveId(result.crawlId);
    if (result.crawlId) seenRef.current?.add(result.crawlId);
    play(result);
    void utils.crawls.list.invalidate();
  };

  const open = async (id: string) => {
    setActiveId(id);
    setOpenError(null);
    try {
      const { replay } = await utils.crawls.get.fetch({ id });
      setResponse({ json: replay, whole: false });
      play(replay);
    } catch {
      setOpenError('That crawl is no longer kept.');
    }
  };

  // A crawl an assistant just made plays by itself, but not over a replay
  // under way: cutting that off loses whatever the person was watching. It
  // waits instead, and plays as soon as that replay ends.
  const busy = snap?.state === 'walking' || snap?.state === 'reading';
  const openRef = useRef(open);
  openRef.current = open;
  const items = recent.data?.items;
  useEffect(() => {
    if (!items) return;
    if (!seenRef.current) {
      seenRef.current = new Set(items.map((c) => c.id));
      return;
    }
    if (busy || !model) return;
    const fresh = newAssistantCrawl(items, seenRef.current);
    for (const c of items) seenRef.current.add(c.id);
    if (fresh) void openRef.current(fresh.id);
  }, [items, busy, model]);

  const toggleSpider = (on: boolean) => {
    setSpiderOn(on);
    if (layerRef.current) layerRef.current.spiderOn = on;
    try {
      localStorage.setItem(SPIDER_KEY, on ? 'on' : 'off');
    } catch {
      // storage blocked: the choice holds for this visit
    }
  };

  const total = snap ? snap.found.named + snap.found.linked + snap.found.decision : 0;
  const refs = total + (snap?.asks.length ?? 0);

  return (
    <aside
      aria-label="Crawl"
      className={cn(
        GLASS,
        'pointer-events-auto absolute inset-x-3 top-16 z-10 flex max-h-[45%] flex-col gap-3 overflow-y-auto rounded-lg p-3 text-sm md:inset-x-auto md:left-3 md:max-h-[calc(100%-10rem)] md:w-[320px]',
      )}
    >
      <TextField value={text} onChange={setText} aria-label="Prompt" className="grid gap-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-muted">
          Try a prompt
        </span>
        <TextArea
          rows={4}
          placeholder="Paste what you would ask an assistant. The spider walks your notes to find what it refers to."
          className="w-full resize-y rounded-md border border-border-default bg-bg-surface px-2.5 py-2 text-[13px] leading-5 text-fg-primary outline-none placeholder:text-fg-muted focus:border-accent"
        />
      </TextField>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onPress={run}
          isDisabled={!text.trim() || !model || gather.isPending}
          className="flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-40"
        >
          <Bug size={14} aria-hidden />
          {gather.isPending ? 'Crawling…' : 'Crawl'}
        </Button>
        {snap && snap.state !== 'idle' && (
          <>
            <IconButton
              label={playing ? 'Pause' : 'Resume'}
              onPress={() => {
                const next = !playing;
                setPlaying(next);
                if (layerRef.current) layerRef.current.playing = next;
              }}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
            </IconButton>
            <IconButton
              label="Replay"
              onPress={() => {
                layerRef.current?.replay();
                setPlaying(true);
                if (layerRef.current) layerRef.current.playing = true;
              }}
            >
              <RotateCcw size={14} />
            </IconButton>
            {!snap.following && (
              <IconButton label="Follow the spider" onPress={() => layerRef.current?.followAgain()}>
                <Crosshair size={14} />
              </IconButton>
            )}
          </>
        )}
      </div>
      {gather.error && <p className="text-[12.5px] text-danger">{gather.error.message}</p>}

      <Switch
        isSelected={spiderOn}
        onChange={toggleSpider}
        className="group flex cursor-pointer items-center justify-between gap-3 outline-none"
      >
        <span className="grid">
          <span className="text-[13px] text-fg-primary">Spider</span>
          <span className="text-[11.5px] leading-4 text-fg-muted">
            Off, the crawl shows as a trail of light.
          </span>
        </span>
        <span className="relative h-5 w-9 shrink-0 rounded-full bg-bg-hover transition-colors group-selected:bg-accent group-focus-visible:ring-2 group-focus-visible:ring-accent/40">
          <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-fg-primary transition-transform group-selected:translate-x-4" />
        </span>
      </Switch>

      {recent.data && !recent.data.enabled && (
        <p className="text-[11.5px] leading-4 text-fg-muted">
          Crawl history is off on this server: assistants’ crawls are not kept.
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
                  onPress={() => void open(c.id)}
                  isDisabled={!model}
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
                    <span className="shrink-0">{ago(c.createdAt, recent.data?.now ?? c.createdAt)}</span>
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

      {response && (
        <details className="group grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 border-t border-border-subtle pt-3">
          <summary className="cursor-pointer list-none font-mono text-[10.5px] uppercase tracking-wider text-fg-muted outline-none hover:text-fg-secondary focus-visible:text-fg-primary">
            <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
            Response
          </summary>
          <p className="text-[11.5px] leading-4 text-fg-muted">
            {response.whole
              ? 'What gather_context returns to the assistant, as it receives it.'
              : 'From the history: the note bodies (excerpt) are not kept, so they are missing here.'}
          </p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-base p-2 font-mono text-[10.5px] leading-[15px] text-fg-secondary">
            {JSON.stringify(response.json, null, 2)}
          </pre>
        </details>
      )}
    </aside>
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
