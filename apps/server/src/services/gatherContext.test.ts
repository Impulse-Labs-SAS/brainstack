// gather_context over Postgres: the seeds, the hop along wikilinks, what is
// reported instead of guessed, the budget, and the vault boundary.

import { pgSchema } from '@brainstack/core/pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { NoteService } from './NoteService.js';
import { SearchService } from './SearchService.js';
import { gatherContext } from './gatherContext.js';
import { createTestDatabase, type TestDatabase } from './testDb.js';

const { users } = pgSchema;

const ME = 'u1';
const SOMEONE_ELSE = 'u2';

let database: TestDatabase;
let notes: NoteService;
let search: SearchService;

const gather = (text: string, opts: { terms?: string[]; depth?: number; maxChars?: number } = {}) =>
  gatherContext({ notes, search }, ME, { text, ...opts });

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await database.reset();
  for (const id of [ME, SOMEONE_ELSE]) {
    await database.db
      .insert(users)
      .values({ id, email: `${id}@brain.test`, createdAt: Date.now(), updatedAt: 0 });
  }
  notes = new NoteService({ db: database.db });
  search = new SearchService({ db: database.db });
});

describe('gatherContext', () => {
  it('returns the notes the text names, then what they link to', async () => {
    await notes.create(ME, 'roadmap.md', '# Roadmap Q4\n\nShip [[billing]] first.');
    await notes.create(ME, 'billing.md', '# Billing service\n\nInvoices and plans.');
    await notes.create(ME, 'onboarding.md', '# Onboarding flow\n\nSteps for new users.');
    await notes.create(ME, 'unrelated.md', '# Gardening\n\nTomatoes.');

    const result = await gather('Plan the Roadmap Q4 work around the onboarding flow.');

    const paths = result.notes.map((n) => n.path);
    expect(paths.slice(0, 2).sort()).toEqual(['onboarding.md', 'roadmap.md']);
    expect(paths).toContain('billing.md');
    expect(paths).not.toContain('unrelated.md');

    expect(result.notes.find((n) => n.path === 'roadmap.md')).toMatchObject({
      reason: 'the text says "Roadmap Q4"',
      via: { kind: 'named' },
    });
    expect(result.notes.find((n) => n.path === 'billing.md')).toMatchObject({
      reason: 'linked from Roadmap Q4',
      via: { kind: 'linked', hop: 1 },
    });
    expect(result.coverage).toEqual({ resolved: 2, total: 2 });
  });

  it('follows backlinks too', async () => {
    await notes.create(ME, 'pricing.md', '# Pricing decision\n\nTiered.');
    await notes.create(ME, 'sales.md', '# Sales playbook\n\nSee [[pricing]].');

    const result = await gather('What does the Pricing decision say?');
    expect(result.notes.find((n) => n.path === 'sales.md')?.reason).toBe(
      'links to Pricing decision',
    );
  });

  it('stops at the seeds with depth 0', async () => {
    await notes.create(ME, 'roadmap.md', '# Roadmap Q4\n\nShip [[billing]] first.');
    await notes.create(ME, 'billing.md', '# Billing service');

    const result = await gather('Roadmap Q4', { depth: 0 });
    expect(result.notes.map((n) => n.path)).toEqual(['roadmap.md']);
  });

  it('reports a title two notes share, with both, instead of picking one', async () => {
    await notes.create(ME, 'alpha/architecture.md', '# Architecture\n\nAlpha.');
    await notes.create(ME, 'beta/architecture.md', '# Architecture\n\nBeta.');

    const result = await gather('Review the architecture before starting.');
    expect(result.notes).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        term: 'architecture',
        reason: 'ambiguous',
        candidates: [
          { path: 'alpha/architecture.md', title: 'Architecture' },
          { path: 'beta/architecture.md', title: 'Architecture' },
        ],
      },
    ]);
    expect(result.coverage).toEqual({ resolved: 0, total: 1 });
  });

  it('searches the vague terms, and reports the ones nothing matches', async () => {
    await notes.create(ME, 'refunds.md', '# Customer policies\n\nRefunds within thirty days.');

    const result = await gather('Handle refunds like we agreed, and the usual escalation.', {
      terms: ['refunds', 'escalation', 'Refunds'],
    });
    expect(result.notes[0]).toMatchObject({
      path: 'refunds.md',
      reason: 'matches "refunds"',
      via: { kind: 'search' },
    });
    expect(result.unresolved).toEqual([{ term: 'escalation', reason: 'no-match' }]);
    expect(result.coverage).toEqual({ resolved: 1, total: 2 });
  });

  it('weighs a decision above a note it would otherwise tie with', async () => {
    // Both link to the hub, so nothing in the link order tells them apart.
    await notes.create(ME, 'hub.md', '# Launch plan');
    await notes.create(ME, 'notes.md', '# Meeting notes\n\nFor [[hub]].');
    await notes.create(ME, 'decided.md', '# Go with plan B\n\nFor [[hub]].', { tags: ['decision'] });

    const result = await gather('Launch plan');
    const linked = result.notes.filter((n) => n.via.kind === 'linked');
    expect(linked.map((n) => n.path)).toEqual(['decided.md', 'notes.md']);
    expect(linked[0]!.isDecision).toBe(true);
  });

  it('keeps the excerpts within the budget', async () => {
    const long = 'Lorem ipsum dolor sit amet. '.repeat(400);
    await notes.create(ME, 'one.md', `# First topic\n\n${long}`);
    await notes.create(ME, 'two.md', `# Second topic\n\n${long}`);

    const result = await gather('First topic and Second topic', { maxChars: 1_000 });
    expect(result.budget.usedChars).toBeLessThanOrEqual(1_000);
    expect(result.notes.reduce((n, note) => n + note.excerpt.length, 0)).toBe(
      result.budget.usedChars,
    );
    expect(result.notes[0]!.truncated).toBe(true);
  });

  it('resolves wikilinks in the text, and names in code', async () => {
    await notes.create(ME, 'specs/atlas.md', '# Project Atlas');
    await notes.create(ME, 'billing.md', '# Billing service');

    const result = await gather(
      'Compare [[atlas|the Atlas spec]] with `Billing service`, then [[nowhere]].\n\n```\nBilling service\n```',
      { depth: 0 },
    );
    expect(result.notes.map((n) => n.path).sort()).toEqual(['billing.md', 'specs/atlas.md']);
    expect(result.notes.find((n) => n.path === 'specs/atlas.md')?.reason).toBe(
      'the text says "the Atlas spec"',
    );
    expect(result.notes.find((n) => n.path === 'billing.md')?.via).toMatchObject({ count: 2 });
    expect(result.unresolved).toEqual([{ term: 'nowhere', reason: 'no-match' }]);
    expect(result.coverage).toEqual({ resolved: 2, total: 3 });
  });

  it('does not count a term twice when the text already names it', async () => {
    await notes.create(ME, 'billing.md', '# Billing service');

    const result = await gather('Check the Billing service.', { terms: ['billing service'] });
    expect(result.coverage).toEqual({ resolved: 1, total: 1 });
  });

  it('finds the caller’s match even when other vaults crowd the ranking', async () => {
    for (let i = 0; i < 30; i++) {
      await notes.create(SOMEONE_ELSE, `r${i}.md`, `# Refunds ${i}\n\nrefunds refunds refunds`);
    }
    await notes.create(ME, 'policy.md', '# Customer policy\n\nWe handle refunds by email.');

    const result = await gather('Answer like we usually do.', { terms: ['refunds'] });
    expect(result.notes.map((n) => n.path)).toEqual(['policy.md']);
    expect(result.unresolved).toEqual([]);
  });

  it('answers a question that names no note, by what it is about', async () => {
    await notes.create(
      ME,
      'comercial.md',
      '# Política comercial\n\nEl descuento anual es del 15%.',
    );
    await notes.create(ME, 'otra.md', '# Jardín\n\nTomates.');

    const result = await gather('¿Qué decidimos sobre el descuento anual?');
    expect(result.notes.map((n) => n.path)).toEqual(['comercial.md']);
    expect(result.notes[0]).toMatchObject({
      reason: 'matches the question',
      via: { kind: 'prompt' },
    });
  });

  it('does not search a question made only of common words', async () => {
    await notes.create(ME, 'a.md', '# What this is about\n\nThat and this.');

    const result = await gather('What is this about? ¿Qué es esto?');
    expect(result.notes).toEqual([]);
  });

  it('hands over a whole note when it fits, so the assistant need not open it', async () => {
    const body = 'Una frase sobre la migración. '.repeat(100);
    await notes.create(ME, 'plan.md', `# Plan de migración\n\n${body}`);

    const result = await gather('Plan de migración');
    expect(result.notes[0]).toMatchObject({ path: 'plan.md', truncated: false });
    expect(result.notes[0]!.excerpt.length).toBeGreaterThan(2_500);
  });

  it('finds the note a question is about in a vault where every note shares its subject', async () => {
    // Every note here mentions Zuno, most of them many times, and full-text
    // ranking has no notion of a word being everywhere. The note the question
    // is about names it once — but its title says "Planes", and it is the one
    // note each of the caller's terms finds.
    const filler = (topic: string) =>
      `Zuno ${topic}: zuno-api, zuno-web y zuno-worker. `.repeat(60) +
      'Más detalle técnico. '.repeat(80);
    const projects = [
      'Arquitectura',
      'Infraestructura',
      'Webhooks',
      'Frontend',
      'Seguridad',
      'Datos',
    ];
    for (const p of projects) {
      await notes.create(ME, `zuno/${p.toLowerCase()}.md`, `# ${p} — Zuno ERP\n\n${filler(p)}`);
    }
    await notes.create(
      ME,
      'zuno/comercial/economia-de-la-ia.md',
      `# Economía de la IA en Zuno\n\nEl router elige entre dos tiers de costo. Los precios del proveedor quedan afuera.\n\n${filler('IA')}`,
    );
    await notes.create(
      ME,
      'zuno/ideas/precio-mayorista.md',
      `# Idea — Precio mayorista por cantidad\n\nEl modelo de precios de Zuno ya soporta precios por cliente; una tabla item_price_tiers.\n\n${filler('precios')}`,
    );
    await notes.create(
      ME,
      'zuno/comercial/planes-y-pricing.md',
      '# Planes y pricing\n\nCómo cobra Zuno a sus clientes: estructura de planes, eje de valor y modelo comercial.\n\n' +
        '- 3 tiers como ancla: Crecimiento es el target.\n- La banda de precios del mercado.\n\n' +
        'Detalle de cada plan y sus límites. '.repeat(40),
    );
    const all = [
      ...projects.map((p) => `zuno/${p.toLowerCase()}`),
      'zuno/comercial/economia-de-la-ia',
      'zuno/ideas/precio-mayorista',
      'zuno/comercial/planes-y-pricing',
    ];
    await notes.create(
      ME,
      'zuno/_zuno.md',
      `# Zuno\n\nERP SaaS multi-tenant.\n\n${all.map((p) => `- [[${p}]] — ${'descripción de la nota '.repeat(12)}`).join('\n')}`,
    );

    const result = await gather('¿Cuáles son los planes de Zuno y sus precios?', {
      terms: ['planes Zuno', 'tiers', 'precios'],
    });
    expect(result.notes.map((n) => n.path).slice(0, 2)).toEqual([
      'zuno/_zuno.md',
      'zuno/comercial/planes-y-pricing.md',
    ]);
    expect(result.notes[1]!.reason).toBe('matches "planes Zuno", "tiers" and "precios"');
    expect(result.coverage).toEqual({ resolved: 4, total: 4 });
  });

  it('puts the overview an index links to first above decisions that only mention it', async () => {
    // The case from production: "¿Qué es Zuno?" filled the budget with four
    // decisions that link *to* Zuno, and left out the overview its own index
    // puts first under "start here".
    const long = (what: string) => `${what}. ${'Detalle del producto y su contexto. '.repeat(60)}`;
    const areas = ['area-1', 'area-2', 'area-3', 'area-4', 'area-5', 'area-6', 'area-7'];
    await notes.create(ME, 'zuno/vision-general.md', `# Visión general\n\n${long('Qué es Zuno')}`);
    for (const a of areas) {
      await notes.create(ME, `zuno/${a}.md`, `# Área ${a.slice(-1)}\n\n${long(a)}`);
    }
    for (const d of ['convenciones', 'design-system', 'lecciones', 'subscription']) {
      await notes.create(
        ME,
        `zuno/decisiones/${d}.md`,
        `# Decisión ${d}\n\nAplica a [[zuno/_zuno]]. ${long(d)}`,
        { tags: ['decision'] },
      );
    }
    // As in production, the index also links out to most of its decisions.
    await notes.create(
      ME,
      'zuno/_zuno.md',
      `# Zuno\n\nPor dónde empezar: [[zuno/vision-general]].\n\n${[
        ...['convenciones', 'design-system', 'lecciones', 'subscription'].map((d) => `zuno/decisiones/${d}`),
        ...areas.map((a) => `zuno/${a}`),
      ]
        .map((p) => `- [[${p}]]`)
        .join('\n')}`,
    );

    const result = await gather('¿Qué es Zuno?');
    const order = result.notes.map((n) => n.path);
    expect(order[0]).toBe('zuno/_zuno.md');
    expect(order[1]).toBe('zuno/vision-general.md');
    const decisions = order.filter((p) => p.startsWith('zuno/decisiones/'));
    for (const d of decisions) expect(order.indexOf(d)).toBeGreaterThan(1);

    // What did not fit is named, so the assistant can open it.
    expect(result.budget.notesLeftOut).toBeGreaterThan(0);
    expect(result.leftOut).toHaveLength(result.budget.notesLeftOut);
    expect(result.leftOut[0]).toMatchObject({ path: expect.any(String), title: expect.any(String) });
  });

  it('never returns another user’s notes, however plainly the text names them', async () => {
    await notes.create(SOMEONE_ELSE, 'secret.md', '# Secret project\n\nHidden.');
    await notes.create(ME, 'mine.md', '# My project');

    const result = await gather('Secret project and My project', { terms: ['Hidden'] });
    expect(result.notes.map((n) => n.path)).toEqual(['mine.md']);
    expect(result.unresolved).toEqual([{ term: 'Hidden', reason: 'no-match' }]);
  });
});
