'use client';

// The prompt as the panel shows and copies it, from the answer and what the
// person made of it. In full text a note needs its body: a search run here
// brought each one's excerpt, but the history keeps none, and a note put back
// or picked for a reference never came with one. Those are read with
// `notes.get` — which asks the sharing service, as every read does — as soon
// as full text is chosen, not when Copy is pressed: a clipboard write after a
// wait may be refused, and the person would be left waiting besides. Each is
// cut to its share of the budget the engine itself keeps to.

import { useMemo } from 'react';

import { trpc } from '@/lib/trpc';

import { chosenNotes, openQuestions, type Answer, type Curation } from '../answer';
import { bodyShare, buildBrief, cutBody, tokensLabel, type BriefFormat } from '../brief';

export interface BriefState {
  text: string;
  /** Notes it carries. */
  notes: number;
  tokens: string;
  /** Bodies still being read: the copy waits for them. */
  reading: number;
}

/** Bodies kept for a minute: switching formats back and forth reads nothing twice. */
const BODY_STALE_MS = 60_000;

export function useBrief(answer: Answer | null, curation: Curation, format: BriefFormat): BriefState {
  const notes = useMemo(() => (answer ? chosenNotes(answer, curation) : []), [answer, curation]);
  const open = useMemo(() => (answer ? openQuestions(answer, curation) : []), [answer, curation]);
  const missing = useMemo(
    () => (format === 'full' ? notes.filter((n) => n.body === undefined) : []),
    [format, notes],
  );
  const bodies = trpc.useQueries((t) =>
    missing.map((n) =>
      t.notes.get(
        { path: n.path, ...(n.ownerId ? { ownerId: n.ownerId } : {}) },
        { staleTime: BODY_STALE_MS, retry: false },
      ),
    ),
  );

  const share = bodyShare(missing.length);
  const filled = notes.map((n) => {
    const i = missing.indexOf(n);
    const body = i >= 0 ? bodies[i]?.data?.body : undefined;
    if (body === undefined) return n;
    const cut = cutBody(body, share);
    return { ...n, body: cut.text, truncated: cut.truncated };
  });
  const text = answer
    ? buildBrief({ question: answer.question, notes: filled, open, format })
    : '';
  return {
    text,
    notes: notes.length,
    tokens: tokensLabel(text),
    reading: bodies.filter((q) => q.isPending).length,
  };
}
