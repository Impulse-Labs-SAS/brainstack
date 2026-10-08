// gather_context over Postgres: the seeds, the hop along wikilinks, what is
// reported instead of guessed, the budget, and the vault boundary.

import { pgSchema } from '@brainstack/core/pg';
import { MAX_LINK } from '@brainstack/core/sentinel';
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
    await notes.create(ME, 'roadmap.md', '# Roadmap Q4\n\nShip [[ledger]] first.');
    await notes.create(ME, 'ledger.md', '# Ledger service\n\nInvoices and plans.');
    await notes.create(ME, 'onboarding.md', '# Onboarding flow\n\nSteps for new users.');
    await notes.create(ME, 'unrelated.md', '# Gardening\n\nTomatoes.');

    const result = await gather('Plan the Roadmap Q4 work around the onboarding flow.');

    const paths = result.notes.map((n) => n.path);
    expect(paths.slice(0, 2).sort()).toEqual(['onboarding.md', 'roadmap.md']);
    expect(paths).toContain('ledger.md');
    expect(paths).not.toContain('unrelated.md');

    expect(result.notes.find((n) => n.path === 'roadmap.md')).toMatchObject({
      reason: 'the text says "Roadmap Q4"',
      via: { kind: 'named' },
    });
    // The question's own words also find it ("plans"), and coverage is what
    // a score is built on, so that reason is named first.
    expect(result.notes.find((n) => n.path === 'ledger.md')).toMatchObject({
      reason: 'matches the question; also linked from Roadmap Q4',
      via: { kind: 'prompt' },
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
    await notes.create(ME, 'roadmap.md', '# Roadmap Q4\n\nShip [[ledger]] first.');
    await notes.create(ME, 'ledger.md', '# Ledger service');

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
    await notes.create(ME, 'decided.md', '# Go with plan B\n\nFor [[hub]].', {
      tags: ['decision'],
    });

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
    await notes.create(ME, 'ledger.md', '# Ledger service');

    const result = await gather(
      'Compare [[atlas|the Atlas spec]] with `Ledger service`, then [[nowhere]].\n\n```\nLedger service\n```',
      { depth: 0 },
    );
    expect(result.notes.map((n) => n.path).sort()).toEqual(['ledger.md', 'specs/atlas.md']);
    expect(result.notes.find((n) => n.path === 'specs/atlas.md')?.reason).toBe(
      'the text says "the Atlas spec"',
    );
    expect(result.notes.find((n) => n.path === 'ledger.md')?.via).toMatchObject({ count: 2 });
    expect(result.unresolved).toEqual([{ term: 'nowhere', reason: 'no-match' }]);
    expect(result.coverage).toEqual({ resolved: 2, total: 3 });
  });

  it('does not count a term twice when the text already names it', async () => {
    await notes.create(ME, 'ledger.md', '# Ledger service');

    const result = await gather('Check the Ledger service.', { terms: ['ledger service'] });
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
    // Every note here mentions Orbit, most of them many times, and full-text
    // ranking has no notion of a word being everywhere. The note the question
    // is about names it once — but its title says "Planes", and it is the one
    // note each of the caller's terms finds.
    const filler = (topic: string) =>
      `Orbit ${topic}: orbit-api, orbit-web y orbit-worker. `.repeat(60) +
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
      await notes.create(ME, `orbit/${p.toLowerCase()}.md`, `# ${p} — Orbit\n\n${filler(p)}`);
    }
    await notes.create(
      ME,
      'orbit/comercial/costos-de-proveedores.md',
      `# Costos de proveedores en Orbit\n\nDos tiers de costo. Los precios de cada proveedor.\n\n${filler('IA')}`,
    );
    await notes.create(
      ME,
      'orbit/ideas/descuentos-por-volumen.md',
      `# Idea — Descuentos por volumen\n\nLos precios de Orbit por cliente; una tabla price_tiers.\n\n${filler('precios')}`,
    );
    await notes.create(
      ME,
      'orbit/comercial/planes-y-pricing.md',
      '# Planes del producto\n\nCómo cobra Orbit a sus clientes: estructura de planes.\n\n' +
        '- Tres tiers.\n- Precios por mes.\n\n' +
        'Detalle de cada plan y sus límites. '.repeat(40),
    );
    const all = [
      ...projects.map((p) => `orbit/${p.toLowerCase()}`),
      'orbit/comercial/costos-de-proveedores',
      'orbit/ideas/descuentos-por-volumen',
      'orbit/comercial/planes-y-pricing',
    ];
    await notes.create(
      ME,
      'orbit/_orbit.md',
      `# Orbit\n\nUn producto.\n\n${all.map((p) => `- [[${p}]] — ${'descripción de la nota '.repeat(12)}`).join('\n')}`,
    );

    const result = await gather('¿Cuáles son los planes de Orbit y sus precios?', {
      terms: ['planes Orbit', 'tiers', 'precios'],
    });
    expect(result.notes.map((n) => n.path).slice(0, 2)).toEqual([
      'orbit/_orbit.md',
      'orbit/comercial/planes-y-pricing.md',
    ]);
    expect(result.notes[1]!.reason).toBe(
      'matches "planes Orbit", "tiers" and "precios"; also linked from Orbit',
    );
    expect(result.coverage).toEqual({ resolved: 4, total: 4 });
  });

  it('puts the overview an index links to first above decisions that only mention it', async () => {
    // "What is <product>?" could fill the budget with decisions that link *to*
    // the product, and leave out the overview its own index
    // puts first under "start here".
    const long = (what: string) => `${what}. ${'Detalle del producto y su contexto. '.repeat(60)}`;
    const areas = ['area-1', 'area-2', 'area-3', 'area-4', 'area-5', 'area-6', 'area-7'];
    await notes.create(
      ME,
      'orbit/vision-general.md',
      `# Visión general\n\n${long('Qué es Orbit')}`,
    );
    for (const a of areas) {
      await notes.create(ME, `orbit/${a}.md`, `# Área ${a.slice(-1)}\n\n${long(a)}`);
    }
    for (const d of ['convenciones', 'design-system', 'lecciones', 'subscription']) {
      await notes.create(
        ME,
        `orbit/decisiones/${d}.md`,
        `# Decisión ${d}\n\nAplica a [[orbit/_orbit]]. ${long(d)}`,
        { tags: ['decision'] },
      );
    }
    // As a real index does, it also links out to most of its decisions.
    await notes.create(
      ME,
      'orbit/_orbit.md',
      `# Orbit\n\nPor dónde empezar: [[orbit/vision-general]].\n\n${[
        ...['convenciones', 'design-system', 'lecciones', 'subscription'].map(
          (d) => `orbit/decisiones/${d}`,
        ),
        ...areas.map((a) => `orbit/${a}`),
      ]
        .map((p) => `- [[${p}]]`)
        .join('\n')}`,
    );

    const result = await gather('¿Qué es Orbit?');
    const order = result.notes.map((n) => n.path);
    expect(order[0]).toBe('orbit/_orbit.md');
    expect(order[1]).toBe('orbit/vision-general.md');
    const decisions = order.filter((p) => p.startsWith('orbit/decisiones/'));
    for (const d of decisions) expect(order.indexOf(d)).toBeGreaterThan(1);

    // What did not fit is named, so the assistant can open it.
    expect(result.budget.notesLeftOut).toBeGreaterThan(0);
    expect(result.leftOut).toHaveLength(result.budget.notesLeftOut);
    expect(result.leftOut[0]).toMatchObject({
      path: expect.any(String),
      title: expect.any(String),
    });
  });

  it('keeps another subject’s notes that share a word of the question under what the named note links to', async () => {
    // "A general concept of <product>" could also bring another project's
    // overview, which says "general" but never the product, ahead of its notes.
    // A small index, so the budget has room and the other subject's notes come
    // back: what is tested is the weight they come back with.
    const long = (what: string) => `${what}. ${'Detalle del módulo y su contexto. '.repeat(20)}`;
    const areas = Array.from({ length: 2 }, (_, i) => `orbit/area-${i}`);
    for (const a of areas) await notes.create(ME, `${a}.md`, `# Área ${a.slice(-1)}\n\n${long(a)}`);
    await notes.create(
      ME,
      'orbit/vision-general.md',
      `# Orbit — Visión general\n\n${long('Qué es')}`,
    );
    await notes.create(
      ME,
      'orbit/_orbit.md',
      `# Orbit\n\n${['orbit/vision-general', ...areas].map((p) => `- [[${p}]]`).join('\n')}`,
    );
    // The other subject is linked too, as a vault is: its index says the words
    // and puts its overview first, and its notes link back to the index. That
    // is how its overview could score over the product's links.
    const general = 'Concepto general, visión general, concepto general del producto. ';
    await notes.create(
      ME,
      'brainstack/vision-general.md',
      `# Visión general\n\n${general.repeat(20)}`,
    );
    await notes.create(
      ME,
      'brainstack/_brainstack.md',
      `# BrainStack\n\n- [[brainstack/vision-general]]\n\n${general.repeat(15)}`,
    );
    for (const n of ['apertura', 'lecciones']) {
      await notes.create(
        ME,
        `brainstack/${n}.md`,
        `# ${n}\n\nVer [[brainstack/_brainstack]]. ${general.repeat(10)}`,
      );
    }

    const result = await gather('Dame un concepto general de Orbit');
    const orbit = result.notes.filter((n) => n.path.startsWith('orbit/'));
    const other = result.notes.filter((n) => n.path.startsWith('brainstack/'));
    expect(orbit.map((n) => n.path)).toEqual(
      expect.arrayContaining([
        'orbit/_orbit.md',
        'orbit/vision-general.md',
        ...areas.map((a) => `${a}.md`),
      ]),
    );
    // They still come back — the question did say "general" — but outside the
    // named folder the question's hit weighs only as a link: under every Orbit
    // note, even those only linked from the index, and never more than all
    // the links a note can collect are worth.
    expect(other.length).toBeGreaterThan(0);
    const linkedOnly = orbit.filter((n) => n.via.kind === 'linked');
    expect(linkedOnly.length).toBeGreaterThan(0);
    const weakestOrbit = Math.min(...orbit.map((n) => n.score));
    for (const n of other) {
      expect(n.score).toBeLessThan(weakestOrbit);
      expect(n.score).toBeLessThanOrEqual(MAX_LINK);
    }
  });

  it('brings the note several results link to, ahead of the indexes that named it', async () => {
    // A question that spans two projects names both their indexes. Read as
    // seeds, their lists of links filled the budget and left out the one note
    // all three results link to — the contract between the two.
    const long = (what: string) => `${what}. ${'Detalle y contexto de la nota. '.repeat(150)}`;
    const orbitAreas = Array.from({ length: 20 }, (_, i) => `orbit/area-${i}`);
    const ledgerAreas = Array.from({ length: 20 }, (_, i) => `ledger/area-${i}`);
    for (const a of [...orbitAreas, ...ledgerAreas]) {
      await notes.create(ME, `${a}.md`, `# Área ${a}\n\n${long(a)}`);
    }
    await notes.create(
      ME,
      'ledger/integracion-con-orbit.md',
      `# Integración con Orbit — el contrato entre los dos servicios\n\n${long('El contrato')}`,
    );
    await notes.create(
      ME,
      'orbit/ventas-y-facturacion.md',
      `# Ventas y facturación\n\nEmitir una factura electrónica llama a Ledger, que la registra; ` +
        `ver [[ledger/integracion-con-orbit]]. ${long('Facturación electrónica')}`,
      { tags: ['decision'] },
    );
    const index = (title: string, paths: string[]) =>
      `# ${title}\n\n${paths.map((p) => `- [[${p}]] — ${'qué cubre esta nota y por qué. '.repeat(9)}`).join('\n')}`;
    await notes.create(
      ME,
      'orbit/_orbit.md',
      index('Orbit', ['orbit/ventas-y-facturacion', ...orbitAreas, 'ledger/integracion-con-orbit']),
    );
    await notes.create(
      ME,
      'ledger/_ledger.md',
      index('Ledger', [...ledgerAreas, 'ledger/integracion-con-orbit']),
    );

    const result = await gather(
      '¿Cómo se integra Orbit con el Ledger para la facturación electrónica?',
    );
    const order = result.notes.map((n) => n.path);
    expect(order).toContain('ledger/integracion-con-orbit.md');
    const contract = result.notes.find((n) => n.path === 'ledger/integracion-con-orbit.md')!;
    expect(contract.reason).toMatch(/^matches the question; also linked from /);
    for (const from of ['Orbit', 'Ledger', 'Ventas y facturación']) {
      expect(contract.reason).toContain(from);
    }
    // Linked from three results, it outranks every note only one of them links to.
    for (const a of [...orbitAreas, ...ledgerAreas]) {
      const area = result.notes.find((n) => n.path === `${a}.md`);
      if (area) expect(area.score).toBeLessThan(contract.score);
    }
    // An index is read for its links, which the crawl has already followed:
    // it costs the budget what a linked note does, not what a seed does.
    for (const p of ['orbit/_orbit.md', 'ledger/_ledger.md']) {
      const hub = result.notes.find((n) => n.path === p)!;
      expect(hub.excerpt.length).toBeLessThanOrEqual(1_500);
    }
  });

  it('puts the overview first when the question asks what a project is', async () => {
    // A named index, its overview first; a generic word ("concepto") that
    // notes everywhere say, and a decision in another project's folder that
    // says it most; another project's overview that shares "visión general".
    const filler = (what: string) => `${what}. ${'Texto de relleno sobre el módulo. '.repeat(40)}`;
    const areas = Array.from({ length: 8 }, (_, i) => `orbit/area-${i}`);
    for (const a of areas) {
      await notes.create(
        ME,
        `${a}.md`,
        `# Área ${a.slice(-1)}\n\nUn concepto del módulo. ${filler(a)}`,
      );
    }
    await notes.create(
      ME,
      'orbit/vision-general.md',
      `# Orbit — Visión general\n\nVisión general del proyecto: qué es y para quién. ${filler('Orbit')}`,
    );
    await notes.create(
      ME,
      'ledger/vision-general.md',
      `# Ledger — Visión general\n\nVisión general del servicio. Visión general. ${filler('Ledger')}`,
    );
    await notes.create(
      ME,
      'ledger/modelo-de-datos.md',
      `# Modelo de datos\n\n${'Cada factura lleva un concepto; el concepto se guarda. '.repeat(20)}`,
      { tags: ['decision'] },
    );
    await notes.create(
      ME,
      'ledger/integracion.md',
      `# Integración con Orbit\n\nEl contrato. Ver [[ledger/vision-general]]. ${filler('contrato')}`,
      { tags: ['decision'] },
    );
    await notes.create(
      ME,
      'orbit/_orbit.md',
      `# Orbit\n\n${['orbit/vision-general', ...areas, 'ledger/integracion']
        .map((p) => `- [[${p}]] — qué cubre`)
        .join('\n')}`,
    );

    const result = await gather('¿Qué es Orbit? Dame el concepto general del proyecto.', {
      terms: ['Orbit', 'visión general', 'concepto'],
    });
    const order = result.notes.map((n) => n.path);
    expect(order.slice(0, 2)).toEqual(['orbit/_orbit.md', 'orbit/vision-general.md']);
    // The decision in another folder that only shares the generic word stays under it.
    expect(order.indexOf('ledger/modelo-de-datos.md')).toBeGreaterThan(1);
  });

  it('ranks the note that covers every term above one that covers half, however many link to it', async () => {
    // Four terms. One note covers all four; another covers two, and five
    // notes of the same folder link to it.
    const filler = (what: string) => `${what}. ${'Más detalle comercial. '.repeat(30)}`;
    await notes.create(
      ME,
      'orbit/vision-general.md',
      `# Orbit — Visión general\n\n${filler('Qué es')}`,
    );
    await notes.create(
      ME,
      'orbit/comercial/planes.md',
      '# Planes y precios\n\nLos planes, el pricing, los precios y los tiers del producto.\n\n' +
        'Planes por tamaño. Pricing mensual. Precios en pesos. Tres tiers.',
    );
    const around = ['anclas', 'entitlements', 'suscripcion', 'costos', 'canales'];
    for (const n of around) {
      await notes.create(
        ME,
        `orbit/comercial/${n}.md`,
        `# ${n}\n\nVer [[orbit/comercial/economia]] y [[orbit/comercial/planes]]. ${filler(n)}`,
        n === 'entitlements' || n === 'suscripcion' ? { tags: ['decision'] } : {},
      );
    }
    await notes.create(
      ME,
      'orbit/comercial/economia.md',
      `# Economía de la IA\n\nDos tiers de costo. Los precios del proveedor. Tiers y precios. ${filler('IA')}`,
    );
    await notes.create(
      ME,
      'orbit/_orbit.md',
      `# Orbit\n\n${[
        'orbit/vision-general',
        'orbit/comercial/planes',
        'orbit/comercial/economia',
        ...around.map((n) => `orbit/comercial/${n}`),
      ]
        .map((p) => `- [[${p}]] — qué cubre`)
        .join('\n')}`,
    );

    const result = await gather(
      '¿Cómo son los planes y el pricing de Orbit? ¿Cuánto cobra a sus clientes?',
      {
        terms: ['planes', 'pricing', 'precios', 'tiers'],
      },
    );
    const order = result.notes.map((n) => n.path);
    expect(order.slice(0, 2)).toEqual(['orbit/_orbit.md', 'orbit/comercial/planes.md']);
    expect(order.indexOf('orbit/comercial/economia.md')).toBeGreaterThan(1);
    // The scores stay apart: no pile-up against 1.
    const [, planes, next] = result.notes;
    expect(planes!.score - next!.score).toBeGreaterThan(0.05);
  });

  it('never returns another user’s notes, however plainly the text names them', async () => {
    await notes.create(SOMEONE_ELSE, 'secret.md', '# Secret project\n\nHidden.');
    await notes.create(ME, 'mine.md', '# My project');

    const result = await gather('Secret project and My project', { terms: ['Hidden'] });
    expect(result.notes.map((n) => n.path)).toEqual(['mine.md']);
    expect(result.unresolved).toEqual([{ term: 'Hidden', reason: 'no-match' }]);
  });
});

describe('SearchService.counts', () => {
  it('counts each query among the caller’s own notes, all in one call', async () => {
    await notes.create(ME, 'a.md', '# Planes\n\nLos planes y los precios.');
    await notes.create(ME, 'b.md', '# Precios\n\nSolo precios.');
    await notes.create(ME, 'c.md', '# Otra cosa\n\nNada de eso.');
    await notes.create(SOMEONE_ELSE, 'd.md', '# Planes\n\nPlanes y precios de otro.');

    expect(await search.counts(ME, ['planes', 'precios', 'inexistente', '', '!!'])).toEqual([
      1, 2, 0, 0, 0,
    ]);
    expect(await search.counts(ME, [])).toEqual([]);
  });
});
