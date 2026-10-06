# Wiki-links y tags: hacia un Ecosistema navegable — diseño

> **Estado**: implementado en `feat/wiki-links-system` (10 commits), tests en verde en
> `core`/`server`/`web`. No mergeado a `main` todavía.
> **Scope**: parser, indexación y superficie de queries en `packages/core`/`apps/server`;
> UI de nota en `apps/web`; tools MCP en `apps/server/src/mcp/server.ts`.

## 1. Contexto y problema

BrainStack ya tenía wikilinks (`[[Nota]]`, `[[Nota|Alias]]`, `[[Nota#Sección]]`) indexados
en Postgres (tablas `links` y `tags`), pero la navegación se quedaba corta frente a
Obsidian:

- El panel de backlinks era un `<ul>` plano de una columna: sin salientes, sin
  relacionadas, sin metadatos.
- No existía ningún concepto de metadato tipado — el frontmatter era
  `{[key: string]: unknown}` sin estructura, sin forma de preguntar "qué notas usan
  Next.js".
- No había conexiones implícitas (por tag o metadato compartido), solo el grafo de
  enlaces explícitos.
- El editor no autocompletaba `[[`.

Se encontraron además tres bugs concretos durante el diseño, arreglados en la Fase 0
antes de construir nada nuevo (ver §7):

1. Borrar una nota dejaba sus backlinks apuntando a algo que ya no existe, con
   `targetType: 'note'` en vez de `'unresolved'`, hasta que la nota origen se reescribiera.
2. Un backlink no chequeaba si el viewer podía leer la **fuente** del link — solo el
   target. Una carpeta parcialmente compartida filtraba la existencia de notas privadas.
3. `[[Nota#Sección]]` indexaba bien en el servidor pero se renderizaba como enlace roto
   en la web: el parser del renderer y el resolver client-side tenían cada uno su propia
   copia (desincronizada) de "separar `#sección` del target".

## 2. Decisiones de diseño

1. **Metadatos tipados → tabla de facetas nueva**, no namespacing de tags
   (`tech/nextjs`). Ver §3.
2. **El panel lateral de backlinks se reemplaza** por una sección "Ecosistema" al pie de
   la nota — no se mantienen los dos.
3. **`list_related` no toma `ownerId`** — deliberado. Extenderlo a notas de otro dueño
   necesita el mismo trabajo de enmascarado que backlinks/outbound ya tuvieron (ver
   bug 2), y no se hizo para v1 (queda en §8, fast-follows).
4. **Sin mezcla con full-text search en el ranking de relacionadas** — normalizar una
   escala de rareza (tag/facet) contra un `ts_rank` de FTS es un problema real, pero de
   beneficio incierto sin datos de uso; documentado como idea v2, no bloquea nada de esto.

## 3. La tabla de facetas

Genérica, no atada a "technologies"/"resources": **cualquier campo del frontmatter
salvo `tags`** se indexa como pares `(key, value)`, sin allowlist.

Indexar no es lo mismo que relacionar: `list_related` ignora las claves de fecha y de
presentación (`created`, `updated`, `modified`, `date`, `title`, `aliases`, `cssclasses`,
en `RELATED_IGNORED_FACET_KEYS`). Siguen en la tabla y se pueden navegar; solo no cuentan
como señal de afinidad — dos notas del mismo día no están relacionadas por eso.

```ts
// packages/core/src/pg/schema.ts
export const facets = pgTable('facets', {
  notePath: text('note_path').notNull().references(() => notes.path, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),
  data: jsonb('data').$type<Record<string, unknown> | null>(),
  position: integer('position').notNull(),
}, (t) => ({
  pk: primaryKey({ name: 'facets_pkey', columns: [t.notePath, t.key, t.position] }),
  keyValueIdx: index('idx_facets_key_value').on(t.key, t.value),
}));
```

Extracción (`packages/core/src/parser/facets.ts`, `extractFacets`):

- Un array de strings → una fila por elemento.
- Un array de objetos → guarda el objeto crudo en `data`, y un string de display en
  `value` con preferencia `.value` → `.name` → `.title` → `.url` → `JSON.stringify`.
- Un escalar → una fila.
- `tags` está en la única constante de exclusión, `FACET_SKIP_KEYS`.

Esto indexa gratis cosas como `aliases:`, y cierra un bug ya existente:
`list_decisions` prometía en su descripción matchear `status: decidido` pero la
implementación solo miraba el tag `decisión`/`decision` — ahora matchea ambos
(`NoteService.listDecisions`, `leftJoin` a `facets` + `or(...)`).

Migración Drizzle en `packages/core/src/pg/migrations.ts` (`0009_pg_facets`) — obligatoria
en paralelo al cambio en `schema.ts`, porque `schema-parity.test.ts` aplica los dos
caminos (schema vs. migrations) a PGlite y falla si divergen. El snapshot generado
(`pnpm db:generate`) vive en `packages/core/src/pg/drizzle/`.

`rebuildGraph()` en `packages/core/src/pg/notes.ts` sigue el mismo patrón
delete-all-e-inserta que ya usaba para `tags`.

## 4. Superficie de queries

### `PgNoteStore` (packages/core/src/pg/notes.ts)

- `listOutboundLinks(path)` — espejo de `listBacklinks`, filtra por `sourcePath`.
- `listFacetsForNote(path)`, `listFacets(key?)` — espejo de `listTags`.
- `ListFilter` gana `facet?: {key, value}`, mismo patrón `EXISTS` que ya usaba `tag`.

### `listRelated` — ranking de notas relacionadas

Vive en `NoteService`, no en `PgNoteStore` — sigue el patrón de `NoteService.graph()`,
que ya consulta `db` directamente para construir el `or(...)` de scopes propios +
compartidos.

El algoritmo de ranking es una función **pura, sin DB**, en
`apps/server/src/services/relatedNotes.ts` (`rankRelated`), testeable en Node — mismo
patrón que `apps/web/src/lib/import-md.ts`:

```
peso(señal) = 1 / count(notas con esa señal, en todo el vault)
score(candidata) = Σ peso(señal) para cada señal que comparte con la nota de origen
```

Una señal es `tag:<tag>` o `facet:<key>:<value>`. Una etiqueta rara compartida pesa más
que una común (`nextjs` compartido con media biblioteca no debería ganarle a
`drizzle`, mucho menos frecuente).

## 5. tRPC y MCP

tRPC (`apps/server/src/trpc/router.ts`): `notes.outboundLinks`, `notes.related`,
`notes.facetsForNote`, `notes.facets`, `notes.tags`; `notes.list` gana
`facetKey`/`facetValue`.

MCP (`apps/server/src/mcp/server.ts`): `list_outbound_links`, `list_related` (sin
`ownerId`, ver §2.3), `list_facets` (con `path` → facetas de esa nota; sin `path` → todo
`(key, value)` en uso, mismo patrón que `list_notes`); `list_notes` gana
`facetKey`/`facetValue`.

`packages/skill/INSTRUCTIONS.md` documenta las tools nuevas y agrega una sección
`## Facetas — structured frontmatter beyond tags`.

## 6. UI: la sección Ecosistema

> Superseded by §13: the strip is now the Connections panel on the right of the note.

Reemplaza el panel lateral (`ResizablePanel` de backlinks) por una franja al pie de la
nota, debajo del editor/preview.

- `apps/web/src/components/ecosystem/ecosystem-section.tsx` — controlado 100% por
  props (`tags`, `facets`, `backlinks`, `outboundLinks`, `related`, `centerLabel`), así
  la nota propia y la compartida reusan el mismo componente con distinto subset de
  datos. Cada subsección se renderiza solo si su prop llega.
- `apps/web/src/components/ecosystem/tag-facet-chips.tsx` — primer uso real de
  `TagGroup`/`Tag` de `react-aria-components` en el repo (antes solo `button.tsx` usaba
  react-aria de verdad). Nunca shadcn, por CLAUDE.md.
- Rutas de filtro: `apps/web/src/app/notes/tag/[tag]/page.tsx`,
  `apps/web/src/app/notes/facet/[key]/[value]/page.tsx`.
- Nota propia (`apps/web/src/app/notes/[...path]/page.tsx`): las 5 subsecciones
  completas (tags, facetas, backlinks, salientes, relacionadas) + mini-grafo.
- Nota compartida (`apps/web/src/app/notes/shared/[ownerId]/[...path]/page.tsx`): solo
  `outboundLinks` en v1 — backlinks/facetas/relacionadas cross-owner quedan pendientes
  (§8), porque necesitan la misma revisión de enmascarado que tuvo backlinks (bug 2).

Lógica no trivial extraída a `apps/web/src/lib/ecosystem.ts` (agrupar facetas por key,
formatear el label de un link) y testeada en Node — este repo no tiene harness de render
de componentes (`vitest.config.ts` raíz es `environment: 'node'`), consistente con la
práctica ya existente.

## 7. Editor: autocompletado `[[`

- Dependencia nueva: `@codemirror/autocomplete`.
- `apps/web/src/lib/wikilink-autocomplete-match.ts` — matching puro, testeado en Node.
- `apps/web/src/components/editor/wikilink-autocomplete.ts` — extensión CM6, dispara
  tras `[[`, matchea contra los candidatos que la página ya construyó
  (`apps/web/src/lib/wikilinks-client.ts`'s `collectNoteCandidates`).
- **No se tocó el resolver de enlaces** (`packages/core/src/resolver/wikilinks.ts`) —
  resolver por alias/título en vez de path/filename sigue siendo un cambio más profundo
  y riesgoso, deliberadamente diferido (§8).

## 8. Mini-grafo (ego-graph) embebido — construido y luego removido

Se implementó un layout radial estático ("Mapa de un salto") al pie de la sección
Ecosistema y se removió después. Dos razones, en orden de peso:

1. **Afirmaba conexiones que no existían.** Tomaba sus vecinos de tres fuentes —
   backlinks, enlaces salientes y `related` — y dibujaba las tres con la misma línea.
   Pero `related` no es un enlace: son notas que comparten tag o faceta
   (`NoteService.listRelated`). Tres notas sin ningún `[[wikilink]]` entre sí se veían
   conectadas ahí mientras `/graph` —que lee sólo la tabla `links`— correctamente no
   mostraba ninguna arista. La contradicción se leía como un bug del grafo.
2. **No escalaba.** Un layout radial de un solo anillo se satura con las notas de un
   vault real; el cap de nodos lo hacía legible ocultando vecinos, que es peor que no
   mostrar el mapa.

Las cuatro columnas de texto de la sección Ecosistema (tags/facetas, backlinks,
enlaces salientes, relacionadas) cubren la misma información sin confundir un enlace
con una afinidad, y `/graph` sigue siendo la vista de estructura.

`apps/web/src/lib/graph-palette.ts` now holds only the graph's vault colours (see `Graph-design.md`).

## 9. Fast-follows documentados (no construidos en esta rama)

- **Scroll a `#sección`** al hacer click — necesita `rehype-slug` en el pipeline de
  `markdown-preview.tsx`, que no está hoy.
- **Resolución de enlaces por alias/título** (no solo autocompletado) — cambio más
  profundo en `resolver/wikilinks.ts`, deliberadamente diferido.
- **Faceta `aliases` alimentando el autocompletado** — pequeño, no entró en esta pasada.
- **Facetas/relacionadas cross-owner** en la nota compartida — necesita el mismo
  enmascarado que backlinks tuvo en la Fase 0.
- **Ranking de relacionadas mezclado con FTS** (`ts_rank`) — ver §2.4.
- **`ResizablePanel` con variante `side: 'bottom'`** — la franja Ecosistema hoy no es
  redimensionable verticalmente.

## 10. Verificación

- `pnpm --filter @brainstack/core test` — parser de facetas, `pg.test.ts` (indexación,
  outbound/facetas/backlinks-omission), `schema-parity.test.ts` en verde tras la
  migración `0009_pg_facets`.
- `pnpm --filter @brainstack/server test` — `services.test.ts` (incl. fórmula de
  rareza), `crossOwnerReader.test.ts`, `hosted-isolation.test.ts`,
  `mcp/sharingTools.test.ts`.
- `pnpm --filter web test` — `ecosystem.test.ts`,
  `wikilink-autocomplete-match.test.ts`, `wikilink-target.test.ts`,
  `wikilinks-client.test.ts`.
- Manual: nota con backlinks/facetas/relacionadas reales → confirmar que el panel
  lateral desapareció y la sección Ecosistema muestra sus 4 columnas;
  `[[` en el editor autocompleta; `[[Nota#Sección]]` en preview ya no se ve roto; dos
  usuarios de prueba con una carpeta parcialmente compartida confirman que el backlink
  desde la carpeta no compartida no se filtra.

## 11. `/graph`: structure, affinity, topics and projects

The graph itself — its views, layers and behaviour — is described in `Graph-design.md`. What
stays here is what the server decides for it.

**Structure vs. content.** An edge to or from an index (`_<Folder>.md`) is `structure`: it says
where a note is filed, not what it is about, so it pulls less, draws faint and counts a quarter
towards a node's size. Indexes can be hidden as a layer.

**What a topic is** (`services/affinity.ts`, `NoteService.affinity`): content tags and facets.
`tipo/*`, `persona/*`, `decisión`, `status`, `owner` and the keys `list_related` already
ignores are left out: they joined everything to everything. A topic counts when at least two
notes carry it and no more than 25% of the vault (minimum 3); it weighs `1 / notes`, as in
`list_related`. Each note keeps its three strongest affinity edges. Own vault only, like
`list_related`. The lesson of §8 holds: an affinity is never drawn like a link, and a pair that
is already linked gets no affinity edge.

**What a project is** (`services/projects.ts`, carried on every node of `notes.graph`): the
`proyecto/*` tag when the note has exactly one; otherwise the nearest index above it (and that
index's project tag, if it has one); otherwise the top-level folder, or the root. The top-level
folder alone was wrong: `Frodo/` holds several projects.

**No colour per project.** Colouring the three largest folders was tried and dropped: with
well-defined projects there are dozens, and three colours among fifty confuse. The graph colours
by vault instead, and names projects when zoomed out. In Territories the project is the unit of
the map itself: each one is a country of its vault's continent, and its subfolders are the
dotted lines inside it.

## 12. Menciones sin enlazar

La afinidad (§11) dibuja conexiones implícitas; esto crea conexiones reales. Una
mención sin enlazar es texto que dice el **título** de otra nota o uno de sus
**`aliases`** sin un wikilink.

**Qué cuenta** (`packages/core/src/links/mentions.ts`, puro): comparación sobre texto
plegado (minúsculas, sin acentos: "vision" encuentra "Visión"), palabra completa
("erebor" no matchea dentro de "ereborteca"), nunca dentro de código, de un link existente
ni de una URL. Si dos términos se pisan gana el más largo. Se ignoran los títulos de
menos de 4 letras y los que comparten dos notas: no hay forma de saber a cuál apunta.

**Las dos direcciones** (`NoteService.unlinkedMentions`): `incoming` (otras notas que
nombran a esta) y `outgoing` (esta nombra a otras). Un par que ya tiene un link queda
afuera: un link dice que la conexión existe; lo demás es prosa. Sólo bóveda propia,
como `list_related`.

**Enlazar** (`NoteService.linkMentions`) convierte **todas** las apariciones en
`[[ruta/completa|texto tal cual]]`: la frase se lee igual y el link resuelve desde
cualquier carpeta. Si la nota reescrita es la que está abierta, la web espera a que se
guarden los cambios pendientes y después recarga el borrador — si no, el autoguardado
volvía a escribir el texto viejo encima de los links.

**MCP:** `list_unlinked_mentions(path)` es de sólo lectura. La IA propone el link y lo
escribe con `update_note` cuando el usuario aprueba, como cualquier escritura.

## 13. The Connections panel and the note as a document

Built on `feat/notes-navigation-ux`. It replaces the Ecosistema strip of §6 and reworks the notes
screen around it.

**Why the strip went.** It sat under the editor and took up to 40% of the height with five narrow
columns: titles were cut off, a backlink showed only its alias ("Arquitectura", of which project?),
unresolved links were struck through as if deleted, and tags and facets repeated the frontmatter
shown above them.

**The panel** (`apps/web/src/components/ecosystem/connections-panel.tsx`) sits on the right of the
note from 1280px and over it below, toggled with Ctrl/⌘ + `.`. Four tabs:

- **Links** — backlinks, one card per source note with the line that cites this one; outgoing
  links, one row per target, where an unresolved target says *Not created yet* and offers Create.
- **Related** — each note with the tag or value it shares, and a line saying these are not links.
  Keeping them apart from links is the lesson of §8.
- **Mentions** — the unlinked mentions of §12, with their Link button.
- **Outline** — the note's headings (`lib/outline.ts`), which jump to the heading in Edit or Preview.

**Server support.** `listBacklinks` joins the source body and returns `snippet`, the line the link
sits in, found from `links.position` (`packages/core/src/links/snippet.ts`). Backlinks and outbound
links carry the other note's `title`. `listRelated` returns `reasons`: the tags and facet values
the two notes share, rarest first.

**The note as a document.** The editor sets prose in the sans face on a ~72-character column,
dims markdown's marks, shows wikilinks as links (Ctrl/⌘-click follows one) and folds the
frontmatter into a Properties block (`components/note/properties-block.tsx`, mounted inside
CodeMirror by `editor/properties-extension.tsx`); *Edit as YAML* reveals the raw text. Preview uses
the same column and block, and hovering a wikilink previews the note. The Split mode was removed: it
showed the same note twice.

**Around it.** The app sidebar is a 48px icon rail. Ctrl/⌘ + K is a quick switcher with recent
notes (kept per browser, `lib/recent-notes.ts`), arrow keys and `#tag` / `key:value` filters. The
tree groups Recent, My vault and Shared with me (by owner); every row has a ⋯ menu, folders show a
share button, and deleting asks first and says what it removes. All of it is in English.
