import { describe, expect, it } from 'vitest';

import {
  NO_CURATION,
  answerOf,
  candidateLabels,
  chosenNotes,
  openQuestions,
  rowsOf,
  setAdded,
  setNotes,
  settle,
  type AnswerSource,
} from './answer';
import { place } from './crawl-plan';

/** gather_context's answer to a question about a delivery app, invented. */
const LIVE: AnswerSource = {
  notes: [
    {
      path: 'Projects/Courier/live-tracking.md',
      title: 'Live tracking',
      isDecision: false,
      via: { kind: 'search', term: 'GPS', rank: 0 },
      reason: 'matches "GPS"; also matches "maps"',
      excerpt: 'Couriers send their position every five seconds.',
      truncated: false,
    },
    {
      path: 'Clients/Orbit/kickoff.md',
      ownerId: 'owner-1',
      title: 'Orbit kickoff',
      isDecision: false,
      via: { kind: 'prompt', rank: 1 },
      reason: 'matches the question',
      excerpt: 'Forty restaurants',
      truncated: true,
    },
    {
      path: 'Projects/Courier/map-provider.md',
      title: 'Map provider',
      isDecision: true,
      via: {
        kind: 'linked',
        from: 'Projects/Courier/live-tracking.md',
        fromTitle: 'Live tracking',
        direction: 'out',
        hop: 1,
      },
      reason: 'linked from Live tracking',
      excerpt: 'Decided: Mapbox.',
      truncated: false,
    },
  ],
  unresolved: [
    {
      term: 'Maps',
      reason: 'ambiguous',
      candidates: [
        { path: 'Learning/maps.md', title: 'Maps' },
        { path: 'Clients/Orbit/maps.md', ownerId: 'owner-1', title: 'Maps' },
      ],
    },
    { term: 'route optimization', reason: 'no-match' },
  ],
  coverage: { resolved: 2, total: 4 },
  leftOut: [{ path: 'Learning/offline-maps.md', title: 'Offline maps', reason: 'linked from Live tracking' }],
  budget: { notesLeftOut: 3 },
};

/** The same search as the history keeps it: the replay alone. */
const KEPT: AnswerSource = {
  notes: LIVE.notes.map(({ path, ownerId, title, isDecision, via }) => ({
    path,
    ...(ownerId ? { ownerId } : {}),
    title,
    isDecision,
    via,
  })),
  unresolved: LIVE.unresolved,
  coverage: LIVE.coverage,
  notesLeftOut: 3,
};

const TRACKING = 'Projects/Courier/live-tracking.md';
const KICKOFF = place('Clients/Orbit/kickoff.md', 'owner-1');
const PROVIDER = 'Projects/Courier/map-provider.md';
const LEARNING_MAPS = 'Learning/maps.md';
const ORBIT_MAPS = place('Clients/Orbit/maps.md', 'owner-1');
const OFFLINE = 'Learning/offline-maps.md';

describe('answerOf', () => {
  it('keys each note by where it is, as the replay names what it reached', () => {
    const a = answerOf('q', LIVE);
    expect(a.notes.map((n) => n.key)).toEqual([TRACKING, KICKOFF, PROVIDER]);
    expect(a.unresolved[0]!.candidates.map((c) => c.key)).toEqual([LEARNING_MAPS, ORBIT_MAPS]);
    expect(a.unresolved[1]!.candidates).toEqual([]);
  });

  it('colours a note as the replay lights it: what the text led to, then decisions and links', () => {
    expect(answerOf('q', LIVE).notes.map((n) => n.kind)).toEqual(['named', 'named', 'decision']);
  });

  it('takes the engine’s reason and excerpt from a search run here', () => {
    const [tracking, kickoff] = answerOf('q', LIVE).notes;
    expect(tracking!.reason).toBe('matches "GPS"; also matches "maps"');
    expect(tracking!.excerpt).toBe('Couriers send their position every five seconds.');
    expect(kickoff!.truncated).toBe(true);
  });

  it('says why from `via` for a search from the history, which keeps no reason and no body', () => {
    const a = answerOf('q', KEPT);
    expect(a.notes.map((n) => n.reason)).toEqual([
      'matches "GPS"',
      'matches the question',
      'linked from Live tracking',
    ]);
    expect(a.notes.every((n) => n.excerpt === undefined)).toBe(true);
    expect(a.leftOut).toEqual([]);
    expect(a.leftOutCount).toBe(3);
  });
});

describe('candidateLabels', () => {
  it('names each candidate by as little of its path as sets it apart', () => {
    expect(candidateLabels(['Ops/runbook-a.md', 'Ops/runbook-b.md'])).toEqual([
      'runbook-a.md',
      'runbook-b.md',
    ]);
    expect(candidateLabels(['Ops/runbook.md', 'Main/runbook.md'])).toEqual([
      'Ops/runbook.md',
      'Main/runbook.md',
    ]);
    expect(candidateLabels(['A/x/plan.md', 'B/x/plan.md', 'B/y/plan.md'])).toEqual([
      'A/x/plan.md',
      'B/x/plan.md',
      'y/plan.md',
    ]);
  });

  it('gives the whole path when nothing shorter tells two apart', () => {
    expect(candidateLabels(['plan.md', 'plan.md'])).toEqual(['plan.md', 'plan.md']);
  });
});

describe('rowsOf', () => {
  const a = answerOf('q', LIVE);

  it('lists only what the walk has reached while it walks, everything once it is done', () => {
    expect(rowsOf(a, NO_CURATION, new Set([KICKOFF])).map((r) => r.key)).toEqual([KICKOFF]);
    expect(rowsOf(a, NO_CURATION).map((r) => r.key)).toEqual([TRACKING, KICKOFF, PROVIDER]);
  });

  it('adds the notes a settled reference meant, and what was put back, after the answer’s', () => {
    let c = settle(NO_CURATION, 'Maps', [ORBIT_MAPS]);
    c = setAdded(c, OFFLINE, true);
    const rows = rowsOf(a, c);
    expect(rows.map((r) => [r.key, r.from])).toEqual([
      [TRACKING, 'answer'],
      [KICKOFF, 'answer'],
      [PROVIDER, 'answer'],
      [ORBIT_MAPS, 'settled'],
      [OFFLINE, 'added'],
    ]);
    expect(rows[3]).toMatchObject({ term: 'Maps', reason: 'you picked it for "Maps"', ownerId: 'owner-1' });
    expect(rows[4]).toMatchObject({ kind: 'linked', reason: 'linked from Live tracking' });
  });

  it('never lists a note twice: a candidate already in the answer stays the answer’s', () => {
    const withCandidate = answerOf('q', {
      ...LIVE,
      unresolved: [
        {
          term: 'tracking',
          reason: 'ambiguous',
          candidates: [{ path: TRACKING, title: 'Live tracking' }],
        },
      ],
    });
    const rows = rowsOf(withCandidate, settle(NO_CURATION, 'tracking', [TRACKING]));
    expect(rows.filter((r) => r.key === TRACKING)).toHaveLength(1);
  });

  it('puts a note back in when it is picked for a reference after being taken out', () => {
    const withCandidate = answerOf('q', {
      ...LIVE,
      unresolved: [
        {
          term: 'tracking',
          reason: 'ambiguous',
          candidates: [{ path: TRACKING, title: 'Live tracking' }],
        },
      ],
    });
    const out = setNotes(NO_CURATION, [TRACKING], false);
    const picked = settle(out, 'tracking', [TRACKING]);
    expect(chosenNotes(withCandidate, picked).map((n) => n.path)).toContain(TRACKING);
    // Leaving the reference out takes nothing back out.
    expect(settle(out, 'tracking', 'none').out.has(TRACKING)).toBe(true);
  });
});

describe('what the brief carries', () => {
  const a = answerOf('q', LIVE);

  it('leaves out the notes taken out, and carries their bodies where the answer had them', () => {
    const notes = chosenNotes(a, setNotes(NO_CURATION, [KICKOFF], false));
    expect(notes.map((n) => n.path)).toEqual([TRACKING, PROVIDER]);
    expect(notes[0]).toMatchObject({ body: 'Couriers send their position every five seconds.', truncated: false });
    expect(notes[1]!.isDecision).toBe(true);
  });

  it('puts a note back in when asked', () => {
    const out = setNotes(NO_CURATION, [KICKOFF, PROVIDER], false);
    const back = setNotes(out, [KICKOFF], true);
    expect(chosenNotes(a, back).map((n) => n.path)).toEqual([TRACKING, 'Clients/Orbit/kickoff.md']);
    // What it was built from is left as it was.
    expect(out.out.size).toBe(2);
  });

  it('carries a shared note with its owner, and a note put back without a body', () => {
    const notes = chosenNotes(a, setAdded(NO_CURATION, OFFLINE, true));
    expect(notes.find((n) => n.title === 'Orbit kickoff')!.ownerId).toBe('owner-1');
    expect(notes.at(-1)).toEqual({
      path: OFFLINE,
      title: 'Offline maps',
      isDecision: false,
      reason: 'linked from Live tracking',
    });
  });

  it('asks about every reference still open, and none once settled, even as left out', () => {
    expect(openQuestions(a, NO_CURATION).map((q) => q.term)).toEqual(['Maps', 'route optimization']);
    expect(openQuestions(a, NO_CURATION)[0]!.candidates).toHaveLength(2);
    expect(openQuestions(a, NO_CURATION)[1]).toEqual({ term: 'route optimization', reason: 'no-match' });
    let c = settle(NO_CURATION, 'Maps', 'none');
    c = settle(c, 'route optimization', 'none');
    expect(openQuestions(a, c)).toEqual([]);
    expect(chosenNotes(a, c)).toHaveLength(3);
    expect(openQuestions(a, settle(c, 'Maps', null)).map((q) => q.term)).toEqual(['Maps']);
  });
});
