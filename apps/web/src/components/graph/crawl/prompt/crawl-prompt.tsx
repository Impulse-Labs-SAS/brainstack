'use client';

// The prompt at the centre of the Sentinel view: one line to ask the brain
// something, a send button, and under it, discreetly, the last few searches to
// watch again.
// The Sentinel clings to the frame round this box, drawn in the stage below
// it, so the box is measured from outside (`boxRef`) and the frame is fitted
// to its rectangle every frame it shows. That is why the box itself is never
// transformed or scaled, and why it fades through a CSS variable the stage
// sets (`--crawl-prompt`), in step with the frame it draws.
//
// The frame is wider than the box — its margin and its bar — so the stage also
// writes how far it reaches below the box (`--crawl-frame-below`, CSS pixels),
// and the recents start that far down, under the bar. That cannot feed back
// into the frame: the recents are out of the form's flow (absolute, below
// it), the form is exactly the box's height and centred by the grid, and only
// the box is measured — moving the recents never moves what the frame is
// fitted to. Nor can they run off the bottom: on a short screen — a phone
// held sideways — what is left under the frame may hold fewer rows than
// there are, and a row past the edge of the stage, which clips, can neither
// be seen nor clicked, and focused from the keyboard it scrolls the whole
// stage up for good. So the recents are held to the room left — the overlay
// is a size container, and they measure it in `cqh` — and scroll within it.
//
// The glass is dark and translucent, with a backdrop blur, so the creature's
// body behind it reads as a shape behind glass while the text stays crisp; its
// alpha and blur are CSS variables too (`--crawl-glass-alpha`,
// `--crawl-glass-blur`), which the lab tunes. Nothing with an opacity below 1
// may sit above the box: an ancestor with opacity becomes the backdrop root,
// and the blur would sample nothing for the whole fade. So the level is put on
// the box and on the recents, never on the root.
//
// Whoever drives it says when it takes text (`interactive`) and when it should
// take focus again (`focusKey`, bumped on every return; 0 asks for nothing, so
// a driver can let a return pass without taking focus from wherever the person
// put it): while the scene runs its transition the whole of it is inert. It is
// hidden from everyone only once its level reaches 0
// (`--crawl-prompt-visibility`, set by the stage), never the instant the scene
// turns away, or the fade out would be cut.
//
// A send that fails says so in a line under the box (`error`), above the
// recents, in the same block under the frame, so they move down to make room.
//
// It takes its recents and callbacks as props, and knows nothing of what plays
// them: the lab hands it the sample crawls, the Sentinel view its own history.

import { ArrowUp } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { Button, Input, TextField } from 'react-aria-components';

import type { PromptRecent } from './recents';

export interface CrawlPromptProps {
  /** The box the scene frames: measured, never transformed or scaled, so its rect is the layout's. */
  boxRef: Ref<HTMLDivElement>;
  recents: readonly PromptRecent[];
  /** There is a prompt at all: false where the stage cannot show one (hidden from everyone, still laid out). */
  shown: boolean;
  /** It takes text and a send: false while a transition runs, or in the crawl. */
  interactive: boolean;
  /** Changes each time the input should take focus — every return to the prompt — and empties it. 0 asks for nothing. */
  focusKey: number;
  onSubmit(text: string): void;
  onRecent(id: string): void;
  /** A send is on its way (the Sentinel view: the gather): the button waits. */
  pending?: boolean;
  /** Why the last send or recent failed, said under the box; null or absent when nothing did. */
  error?: string | null;
}

/**
 * The box's glass, and the level it fades with. Inline, not classes: values
 * built from variables the stage writes, which no stylesheet knows ahead.
 */
const GLASS_STYLE: CSSProperties = {
  opacity: 'var(--crawl-prompt, 1)',
  backgroundColor: 'rgba(10, 10, 10, var(--crawl-glass-alpha, 0.5))',
  backdropFilter: 'blur(var(--crawl-glass-blur, 12px))',
  WebkitBackdropFilter: 'blur(var(--crawl-glass-blur, 12px))',
};

/** Under the frame the stage draws round the box, a gap below it; without a stage writing it, 1rem under the box as before. */
const RECENTS_GAP = 'calc(var(--crawl-frame-below, 0px) + 1rem)';

/**
 * The room left for the recents: from below that gap to a gap above the
 * overlay's bottom. The box is centred in the overlay, so its bottom edge is
 * half the overlay's height and half its own (`h-14`, 3.5rem) down.
 */
const RECENTS_ROOM = `max(0px, calc(50cqh - 1.75rem - ${RECENTS_GAP} - 1rem))`;

const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-accent/40';

export function CrawlPrompt({
  boxRef,
  recents,
  shown,
  interactive,
  focusKey,
  onSubmit,
  onRecent,
  pending = false,
  error = null,
}: CrawlPromptProps) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  /** The last focus request answered: a change of `interactive` alone takes no focus, nor does key 0. */
  const answered = useRef(0);
  const recentLabel = useId();

  // After `inert` is gone, or the focus would not take.
  useEffect(() => {
    if (!interactive || answered.current === focusKey) return;
    answered.current = focusKey;
    setText('');
    input.current?.focus({ preventScroll: true });
  }, [focusKey, interactive]);

  const asked = text.trim();
  const canSend = interactive && !pending && asked.length > 0;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Escape that cancels an IME composition is the composition's.
    if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    // First Escape empties the line, the next lets go of it.
    if (text) setText('');
    else e.currentTarget.blur();
  };

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10 grid place-items-center"
      style={{
        // Its size is the stage's, never its content's: the recents can measure it.
        containerType: 'size',
        visibility: (shown
          ? 'var(--crawl-prompt-visibility, visible)'
          : 'hidden') as CSSProperties['visibility'],
      }}
      inert={!interactive}
      aria-hidden={!shown}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) onSubmit(asked);
        }}
        className="pointer-events-auto relative w-[min(560px,80vw)]"
      >
        <div
          ref={boxRef}
          className="flex h-14 items-center gap-2 rounded-2xl border border-border-strong pl-4 pr-2 focus-within:border-accent/60"
          style={GLASS_STYLE}
        >
          <TextField
            value={text}
            onChange={setText}
            aria-label="Ask your brain"
            className="min-w-0 flex-1"
          >
            <Input
              ref={input}
              placeholder="Ask your brain something…"
              autoComplete="off"
              enterKeyHint="send"
              spellCheck={false}
              onKeyDown={onKeyDown}
              className="w-full bg-transparent text-[15px] text-fg-primary outline-none placeholder:text-fg-muted"
            />
          </TextField>
          <Button
            type="submit"
            aria-label="Send"
            isDisabled={!canSend}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-accent-fg hover:bg-accent-hover disabled:opacity-40 ${FOCUS_RING}`}
          >
            <ArrowUp size={16} aria-hidden />
          </Button>
        </div>

        {/* Below the box and its frame, out of its flow, so the box itself stays centred; no taller than the room left under it. */}
        {(recents.length > 0 || error) && (
          <div
            className="absolute inset-x-0 top-full grid content-start gap-1 overflow-y-auto px-1 pb-1"
            style={{
              opacity: 'var(--crawl-prompt, 1)',
              marginTop: RECENTS_GAP,
              maxHeight: RECENTS_ROOM,
            }}
          >
            {error && (
              <p role="alert" className="px-1.5 pb-1 text-[12px] leading-4 text-danger">
                {error}
              </p>
            )}
            {recents.length > 0 && (
              <>
                <span
                  id={recentLabel}
                  className="px-1.5 font-mono text-[10.5px] uppercase tracking-wider text-fg-muted"
                >
                  Recent
                </span>
                <ul aria-labelledby={recentLabel} className="grid gap-px">
                  {recents.map((r) => (
                    <li key={r.id} className="min-w-0">
                      <Button
                        onPress={() => onRecent(r.id)}
                        className={`flex w-full min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] text-fg-secondary hover:text-fg-primary ${FOCUS_RING}`}
                      >
                        <span className="min-w-0 truncate">{r.prompt}</span>
                        <span className="shrink-0 font-mono text-[10.5px] text-fg-muted">
                          {r.meta}
                        </span>
                        {r.fresh && (
                          <>
                            <span
                              aria-hidden
                              className="shrink-0 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] leading-4 text-accent"
                            >
                              new
                            </span>
                            {/* In the button's own name: a label on a span inside it would be ignored. */}
                            <span className="sr-only">, new, not watched yet</span>
                          </>
                        )}
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
