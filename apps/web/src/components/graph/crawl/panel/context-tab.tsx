'use client';

// What the search found, for the person to check before they copy it: the
// references left to settle, then the notes by folder, each one ticked in or
// out of the prompt, then what the budget left out, to put back. While the
// Sentinel walks, the notes come in as it reaches them; pointing at one
// rings it on the stage.

import { ChevronRight, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Checkbox } from 'react-aria-components';

import { cn } from '@/lib/utils';

import {
  candidateLabels,
  setAdded,
  setNotes,
  settle,
  type Answer,
  type Curation,
  type Row,
  type Unresolved,
} from '../answer';
import { byFolder } from '../brief';
import { CRAWL_COLORS } from '../crawl-colors';

import { Dot, Eyebrow, FOCUS_RING, Tick } from './panel-ui';

export function ContextTab({
  answer,
  rows,
  unresolved,
  curation,
  walking,
  onCuration,
  onMark,
}: {
  answer: Answer;
  /** The notes to list: as far as the walk has reached, or all of them. */
  rows: Row[];
  /** The references to settle: as far as the walk has asked, or all of them. */
  unresolved: Unresolved[];
  curation: Curation;
  walking: boolean;
  onCuration(next: Curation): void;
  onMark(key: string | null): void;
}) {
  if (rows.length === 0 && unresolved.length === 0) {
    return (
      <p className="text-[12.5px] leading-5 text-fg-muted">
        {walking
          ? 'The Sentinel is reading your question…'
          : 'No note matched. Try other words, or name a note by its title.'}
      </p>
    );
  }
  const count = { named: 0, linked: 0, decision: 0 };
  for (const r of rows) count[r.kind]++;
  const open = unresolved.filter((u) => !curation.settled.has(u.term)).length;

  return (
    <div className="grid min-w-0 gap-4">
      {/* The stage's colours, counted: the legend of what lit up. */}
      <ul className="flex flex-wrap gap-1.5" aria-label="Found">
        <Chip kind="named" n={count.named} label="named" title="named in your question" />
        <Chip kind="linked" n={count.linked} label="linked" title="reached over a link" />
        <Chip kind="decision" n={count.decision} label={count.decision === 1 ? 'decision' : 'decisions'} title="a note that records a decision" />
        {unresolved.length > 0 && (
          <Chip kind="ask" n={open} label="to clarify" title="references to settle with you" />
        )}
      </ul>

      {unresolved.length > 0 && (
        <section className="grid gap-2" aria-label="To clarify">
          <Eyebrow>
            <span style={{ color: CRAWL_COLORS.ask }}>To clarify</span>
          </Eyebrow>
          {unresolved.map((u) => (
            <ClarifyCard
              key={u.term}
              item={u}
              settled={curation.settled.get(u.term)}
              onSettle={(choice) => onCuration(settle(curation, u.term, choice))}
            />
          ))}
        </section>
      )}

      {rows.length > 0 && (
        <section className="grid min-w-0 gap-2" aria-label="Notes for the assistant">
          <Eyebrow>Notes for the assistant</Eyebrow>
          {byFolder(rows).map((g) => (
            <FolderGroup
              key={g.key}
              heading={g.heading}
              rows={g.notes}
              curation={curation}
              onCuration={onCuration}
              onMark={onMark}
            />
          ))}
        </section>
      )}

      {!walking && answer.leftOutCount > 0 && (
        <LeftOutList answer={answer} curation={curation} onCuration={onCuration} />
      )}
    </div>
  );
}

function Chip({
  kind,
  n,
  label,
  title,
}: {
  kind: 'named' | 'linked' | 'decision' | 'ask';
  n: number;
  label: string;
  title: string;
}) {
  return (
    <li
      title={title}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] tabular-nums text-fg-secondary"
    >
      <Dot kind={kind} />
      {n} {label}
    </li>
  );
}

function ClarifyCard({
  item: u,
  settled,
  onSettle,
}: {
  item: Unresolved;
  settled: readonly string[] | 'none' | undefined;
  onSettle(choice: readonly string[] | 'none' | null): void;
}) {
  const all = u.candidates.map((c) => c.key);
  const labels = candidateLabels(u.candidates.map((c) => c.path));
  const isAll = Array.isArray(settled) && settled.length === all.length && all.length > 1;
  const pick = (choice: readonly string[] | 'none') => {
    const same =
      choice === settled ||
      (Array.isArray(choice) &&
        Array.isArray(settled) &&
        choice.length === settled.length &&
        choice.every((k) => settled.includes(k)));
    // Pressing what is chosen opens it again.
    onSettle(same ? null : choice);
  };
  const ambiguous = u.reason === 'ambiguous' && u.candidates.length > 0;
  let says: string;
  if (ambiguous) {
    says = !settled
      ? `${u.candidates.length} notes have this title. Which one do you mean?`
      : settled === 'none'
        ? 'Left out of the prompt.'
        : isAll
          ? `${all.length === 2 ? 'Both go' : 'All of them go'} into the prompt.`
          : `Using ${u.candidates.find((c) => settled.includes(c.key))?.path ?? 'the one you picked'}.`;
  } else {
    says = settled
      ? 'Left out of the prompt.'
      : 'No note covers it. The prompt tells the assistant to ask you about it.';
  }

  return (
    <div
      className={cn('grid gap-2 rounded-lg border p-2.5', !settled ? '' : 'border-border')}
      style={
        settled
          ? undefined
          : { borderColor: `${CRAWL_COLORS.ask}55`, background: `${CRAWL_COLORS.ask}0d` }
      }
    >
      <p className="flex items-baseline gap-2 text-[13px] text-fg-primary">
        <span className="min-w-0 break-words">“{u.term}”</span>
        <span
          className="ml-auto shrink-0 font-mono text-[10px] uppercase tracking-wider"
          style={{ color: settled ? CRAWL_COLORS.decision : CRAWL_COLORS.ask }}
        >
          {settled ? 'settled' : ambiguous ? 'ambiguous' : 'no match'}
        </span>
      </p>
      <p className="break-words text-[12px] leading-[17px] text-fg-secondary">{says}</p>
      <div className="flex flex-wrap gap-1.5">
        {ambiguous ? (
          <>
            {u.candidates.map((c, i) => (
              <ChoiceButton
                key={c.key}
                pressed={Array.isArray(settled) && !isAll && settled.includes(c.key)}
                onPress={() => pick([c.key])}
                title={c.path}
              >
                <span className="font-mono text-[11px]">
                  {labels[i]}
                  {c.ownerId ? ' (shared)' : ''}
                </span>
              </ChoiceButton>
            ))}
            {u.candidates.length > 1 && (
              <ChoiceButton pressed={isAll} onPress={() => pick(all)}>
                {u.candidates.length === 2 ? 'Both' : 'All'}
              </ChoiceButton>
            )}
            <ChoiceButton pressed={settled === 'none'} quiet onPress={() => pick('none')}>
              Neither
            </ChoiceButton>
          </>
        ) : (
          <ChoiceButton quiet pressed={false} onPress={() => onSettle(settled ? null : 'none')}>
            {settled ? 'Ask me about it after all' : 'Leave it out of the prompt'}
          </ChoiceButton>
        )}
      </div>
      {!settled && ambiguous && (
        <p className="text-[11.5px] leading-4 text-fg-muted">
          Left open, the prompt asks the assistant to check with you.
        </p>
      )}
    </div>
  );
}

function ChoiceButton({
  pressed,
  quiet = false,
  onPress,
  title,
  children,
}: {
  pressed: boolean;
  quiet?: boolean;
  onPress(): void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Button
      onPress={onPress}
      aria-pressed={pressed}
      className={cn(
        'max-w-full truncate rounded-md border px-2 py-1 text-[12px]',
        pressed
          ? 'border-[color:var(--ask-color)] text-[color:var(--ask-color)]'
          : quiet
            ? 'border-border text-fg-secondary hover:text-fg-primary'
            : 'border-border bg-bg-elevated text-fg-body hover:border-border-strong hover:text-fg-primary',
        FOCUS_RING,
      )}
      style={{ ['--ask-color' as string]: CRAWL_COLORS.ask }}
    >
      {title ? <span title={title}>{children}</span> : children}
    </Button>
  );
}

function FolderGroup({
  heading,
  rows,
  curation,
  onCuration,
  onMark,
}: {
  heading: string | null;
  rows: Row[];
  curation: Curation;
  onCuration(next: Curation): void;
  onMark(key: string | null): void;
}) {
  const own = rows.filter((r) => r.from === 'answer');
  const on = rows.filter((r) => r.on).length;
  const allOwnOn = own.every((r) => r.on);
  return (
    <div className="grid min-w-0 gap-px">
      {heading !== null && (
        <Checkbox
          isSelected={on === rows.length}
          isIndeterminate={on > 0 && on < rows.length}
          isDisabled={own.length === 0}
          onChange={() => onCuration(setNotes(curation, own.map((r) => r.key), !allOwnOn))}
          aria-label={`Every note in ${heading}`}
          className="group flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 outline-none hover:bg-bg-hover disabled:cursor-default"
        >
          <Tick on={on === rows.length} half={on > 0 && on < rows.length} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-secondary" title={heading}>
            {heading}
          </span>
          <span className="font-mono text-[10.5px] tabular-nums text-fg-muted">
            {on}/{rows.length}
          </span>
        </Checkbox>
      )}
      {rows.map((r) => (
        <NoteRow key={r.key} row={r} curation={curation} onCuration={onCuration} onMark={onMark} />
      ))}
    </div>
  );
}

function NoteRow({
  row: r,
  curation,
  onCuration,
  onMark,
}: {
  row: Row;
  curation: Curation;
  onCuration(next: Curation): void;
  onMark(key: string | null): void;
}) {
  const change = (on: boolean) => {
    if (r.from === 'answer') onCuration(setNotes(curation, [r.key], on));
    // A note picked for a reference, or put back, goes out by undoing that.
    else if (r.from === 'settled' && r.term) {
      const s = curation.settled.get(r.term);
      const rest = Array.isArray(s) ? s.filter((k) => k !== r.key) : [];
      onCuration(settle(curation, r.term, rest.length > 0 ? rest : null));
    } else onCuration(setAdded(curation, r.key, false));
  };
  return (
    <Checkbox
      isSelected={r.on}
      onChange={change}
      onHoverStart={() => onMark(r.key)}
      onHoverEnd={() => onMark(null)}
      onFocusChange={(focused) => onMark(focused ? r.key : null)}
      className="group grid min-w-0 cursor-pointer grid-cols-[16px_7px_minmax(0,1fr)] items-start gap-2.5 rounded-md px-1.5 py-1.5 outline-none hover:bg-bg-hover"
    >
      <Tick on={r.on} />
      <span className="mt-[6px]">
        <Dot kind={r.kind} dim={!r.on} />
      </span>
      <span className="grid min-w-0" title={r.path}>
        <span className={cn('break-words text-[13px] leading-[18px]', r.on ? 'text-fg-primary' : 'text-fg-muted')}>
          {r.title}
          {r.isDecision && <Tag color={CRAWL_COLORS.decision}>decision</Tag>}
          {r.from !== 'answer' && <Tag color={CRAWL_COLORS.ask}>you</Tag>}
        </span>
        <span className="truncate font-mono text-[11px] leading-[15px] text-fg-muted">{r.reason}</span>
      </span>
    </Checkbox>
  );
}

function Tag({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span
      className="ml-1.5 inline-block rounded-[4px] border px-1 align-[1px] font-mono text-[9.5px] uppercase leading-[14px] tracking-wider"
      style={{ color, borderColor: `${color}59` }}
    >
      {children}
    </span>
  );
}

function LeftOutList({
  answer,
  curation,
  onCuration,
}: {
  answer: Answer;
  curation: Curation;
  onCuration(next: Curation): void;
}) {
  const [open, setOpen] = useState(false);
  const unlisted = answer.leftOutCount - answer.leftOut.length;
  return (
    <section className="grid gap-2 border-t border-border-subtle pt-3">
      {answer.leftOut.length > 0 ? (
        <Button
          onPress={() => setOpen(!open)}
          aria-expanded={open}
          className={cn('flex items-baseline gap-2 text-left', FOCUS_RING)}
        >
          <ChevronRight
            size={12}
            aria-hidden
            className={cn('shrink-0 self-center text-fg-muted transition-transform', open && 'rotate-90')}
          />
          <Eyebrow>Didn&apos;t fit · {answer.leftOutCount}</Eyebrow>
          <span className="text-[11.5px] text-fg-muted">left out to keep the answer short</span>
        </Button>
      ) : (
        <p className="text-[11.5px] leading-4 text-fg-muted">
          {answer.leftOutCount} more {answer.leftOutCount === 1 ? 'note' : 'notes'} did not fit the
          answer. Search again with fewer words to see them.
        </p>
      )}
      {open && (
        <ul className="grid gap-px">
          {answer.leftOut.map((l) => {
            const added = curation.added.has(l.key);
            return (
              <li
                key={l.key}
                className="grid grid-cols-[7px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-md px-1.5 py-1.5"
                title={l.path}
              >
                <span className="mt-[6px]">
                  <Dot kind={l.kind} />
                </span>
                <span className="grid min-w-0">
                  <span className="break-words text-[13px] leading-[18px] text-fg-primary">{l.title}</span>
                  <span className="truncate font-mono text-[11px] leading-[15px] text-fg-muted">{l.reason}</span>
                </span>
                <Button
                  onPress={() => onCuration(setAdded(curation, l.key, !added))}
                  className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-[12px]',
                    added ? 'text-fg-muted hover:text-fg-primary' : 'text-accent-hover hover:bg-accent/15',
                    FOCUS_RING,
                  )}
                >
                  {added ? 'Remove' : (
                    <>
                      <Plus size={12} aria-hidden /> Add
                    </>
                  )}
                </Button>
              </li>
            );
          })}
          {unlisted > 0 && (
            <li className="px-1.5 text-[11.5px] text-fg-muted">
              and {unlisted} more the engine did not list.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
