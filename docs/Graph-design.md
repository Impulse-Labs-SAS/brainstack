# Graph — design

`/graph` draws every note the viewer can see and how they connect. This document covers what it
shows, how it behaves, how it is built, and the decisions worth not undoing.

## Views and layers

Two independent choices, kept apart on purpose.

**A view is the shape of the map, and each one answers its own question.** A segmented
control in the toolbar, each tab an icon and a name; the keys `1` to `4` switch views too,
without a number printed on the tabs to say so:

| View | Question | Shape |
|---|---|---|
| Brain | — | 3D. Notes live inside a brain; each visible vault settles in its own lobe, yours in the frontal one. |
| Network | How does it connect? | Flat. Links alone decide where notes sit. |
| Territories | What is there, and where is it filed? | Flat. A map: each project a country, each vault a continent. Links move nothing. |
| Crawl | What did the vault give an assistant? | The Brain, with a `gather_context` crawl replayed on it (see [Crawl](#crawl)). Needs WebGL. |

Network and Territories used to be one layout with a pull per vault on top, so with a single
vault — anyone who uses BrainStack alone — they were the same picture. They are now built on
opposite principles: one from the links and nothing else, the other from the folder hierarchy
and nothing else.

Switching views never jumps: the same notes flow to their new places. Entering Brain rescales
the flat layout into the brain's side view and lets the forces inflate it into the volume.
The chosen view is remembered per browser and written to the URL hash (`#brain`, `#network`,
`#territories`, `#crawl`). The first visit opens in Brain; without WebGL, in Network.

### Network

- Nothing pulls a note towards its project or its vault; what sits together is linked.
- A note's size is its number of connections, so hubs show from afar.
- A link between two projects of the same vault is drawn warm white and brighter: the
  bridges are what this view is for.
- Pieces that no link joins — a shared vault, a project nobody links to — each get their own
  spot, packed side by side. Pulled to one centre, they used to thread through each other.
- Notes without a single link wait on a dotted ring around everything else, labelled with
  how many there are.

### Territories

- A project is a country, its area proportional to its notes. A vault's countries are packed
  into a continent; yours sits in the middle, shared vaults lie across the sea.
- Inside a country the notes sit evenly on a sunflower spiral. The index (MOC) is the capital,
  in the middle; each subfolder takes a wedge, and dotted lines separate them.
- The land is each note's Voronoi cell cut by a disc, so the coast follows the notes and two
  countries share a border exactly where they meet. Neighbouring countries never share a
  shade of their vault's colour.
- Every note is a city of the same size, and only the ones edited this week glow. The ring
  that marks someone else's note is dropped: the whole continent already says it.
- Links are routes, drawn only for what the pointer is on — a note (its neighbours at one and
  two hops, with the same travelling signal as the other views) or a country (every link
  that leaves it). The **All routes** layer draws them all, faintly.
- Zoomed out, country names in spaced capitals; zoomed in, they fade and the cities are
  named. A click on a country flies to it.
- Topics are not nodes here: a topic belongs to no project, so it has no place on the map.
- Dragging a note moves the map, not the note: its place is where it is filed.

**A layer is what gets drawn.** One popover, the first button of the toolbar, like a map's
layers button:

- **Include shared vaults** — whether folders others shared with you are loaded at all. On by
  default and remembered per browser; off, they are not even fetched (`notes.graph` scope
  `mine`). Only shown when sharing is enabled on the deployment.
- **Vaults** — show, hide or isolate ("only") each vault. The last visible vault cannot be hidden.
- **Shared topics** — dotted edges between notes that share a rare topic nobody linked (`notes.affinity`).
- **Indexes (MOC)** — index notes and their structure edges.
- **All routes** — Territories only: every link drawn faintly over the map.
- **Topics as nodes** — Brain and Network only: a hollow hexagon per topic, joined to the notes
  that carry it.

A layer that belongs to one view is only listed in that view. Shown disabled elsewhere, a
ticked box could not be unticked; hidden, its choice waits for the view it belongs to. The dot
on the button that says the layers were changed counts only what the current view shows.

This replaced the four old connection modes (links, affinity, topics, projects). The projects
mode is gone because zooming out now shows projects (below).

### Crawl

Not a fourth layout: the Brain view with a crawl replayed on it. The engine never hears of it —
`graph-view` shows the Brain and mounts `components/graph/crawl/`, which plugs into the
controller as a `GraphPlugin` (draws over the overlay, may ask the camera to follow a point).
Removing that folder and the tab leaves the graph exactly as it was.

- A prompt goes to `notes.gatherContext`; the answer says why each note is there (`via`), and
  that is enough to replay it: the notes the text names, then what could not be resolved, then
  out along the links from each note in turn (`crawl-plan.ts`, tested).
- **The spider only walks threads the graph draws** — links and structure edges — along the same
  curve the scene draws them with. Its feet hold the threads around the note it stands on; each
  thread it steps on lights up and stays lit, so the path remains on the brain. Where no thread
  joins two notes it spins a strand of silk rather than walking through the void.
- It is sized from the vault's median link, so it reads the same at ten notes or ten thousand.
  Body and legs are computed in 3D and drawn by the 2D overlay, for the same reason labels are:
  WebGL lines are one pixel wide.
- **Spider off** (a switch, remembered per browser) replays the same walk as a trail of light.
- The camera follows the replay until the user drags, zooms or clicks; *Follow* re-attaches it.
- With `prefers-reduced-motion` the replay jumps to its end state.
- **Recent crawls.** Every `gather_context` call — an assistant's over MCP or one tried in the
  panel — is kept per user in `crawl_history` (`CrawlHistoryService`): the start of the prompt and
  the replay (paths, titles, `via`), never the excerpts. The panel polls `crawls.list` every few
  seconds, so an assistant's crawl shows up without a reload and plays by itself unless another
  replay is under way; clicking one replays it. Pruned on every write, by age
  (`CRAWL_HISTORY_DAYS`, default 30, 0 = off) and to the newest 50 per user. Only the user who
  crawled lists them; a folder share never reaches them.

## Behaviour in every view

| Gesture | Effect |
|---|---|
| Click a note | The camera flies to it and a preview opens beside the graph: path, dates, topics, connections. |
| Double click, or `Enter` | Opens the note (a shared note opens under `/notes/shared/<owner>/…`). |
| Shift+click two notes | The shortest path between them, with a pulse travelling along it. Links first; shared topics only when no link path exists, and the panel says so. |
| Arrow keys | With a note selected, move to the neighbour in that direction on screen. |
| `/` | Focus search. Matches light up; `Enter` flies to the best one. |
| Hover | The note fires: its neighbours light up at one and two hops, with pulses along the edges. On the map, a country fires the same way along the routes that leave it. |
| Zoom out | Semantic zoom: note labels give way to project names and clouds; on the map, to country names. |
| Drag the background | Pans the flat views; turns the brain (Shift+drag pans it). |

The brain spins slowly until the user touches anything; side, top and front presets reorient
it. With `prefers-reduced-motion`, nothing spins, pulses or fades in.

**Replay growth** shows the notes appearing one by one in order of creation, at an even pace,
each beside the neighbour it links to — on the map, at its own place, so the countries grow —
while a chip shows when the newest one was created. The
pace is by order, not by date: a vault imported in one sitting has most of its notes created
within minutes of each other, and one note dated years back would leave the replay idle for
most of its length and then drop everything at once.

## What the marks mean

- **Colour is the vault**, never the project. A viewer sees a handful of vaults, not the fifty
  projects that made per-project colour unreadable. Your vault uses the accent family; shared
  vaults take five fixed hues in order of their owner's name, and a neutral after that — so a
  vault keeps its hue when its owner shares one more folder.
- **A shared vault is named after the folders shared**, as the file tree names them, with the
  person who shared them beside it (`Gondor, Khand` · `@samwise`). A vault is still one
  person: every folder they share with you lands in it.
- **A ring marks somebody else's note**, so identity never rests on hue alone — except on the
  map, where the note's continent says it.
- **A square is an index (MOC); a hollow hexagon is a topic.**
- **Brightness is recent activity** (`updatedAt`): edited this week glows and breathes; untouched
  for months is an ember.
- **Edges:** a solid curve is a link someone wrote — the only kind that is a fact. A faint one
  is a structure edge to an index. A dotted, unlit one is a shared topic. An affinity is never
  drawn like a link: that is what got the first ego-graph removed (see
  `Wiki-links-y-ecosistema-design.md` §8).
- Labels drop a trailing `— Project` from titles, since the node's region already says it.

## How it is built

All of it is client-side. The server adds `createdAt` and `updatedAt` to each node of
`notes.graph`; vault names come from the roots in `sharing.listSharedWithMe` (`sharedVaultNames`).

| File | Role |
|---|---|
| `lib/graph-model.ts` | Pure: nodes and edges from what the server sent, filtered by layers; vaults; paths and hops. Tested. |
| `lib/graph-brain.ts` | Pure: the brain's distance field, its surface mesh and the container force. Tested. |
| `lib/graph-camera.ts` | Pure: orbit camera, projection, fitting, zoom and pan. The overlay projects with the same maths three.js renders with. Tested. |
| `lib/graph-map.ts` | Pure: Territories — where each note belongs on the map, and the land, coasts, borders and folder lines under the notes. Tested. |
| `components/graph/graph-engine.ts` | The layout per view: a `d3-force-3d` simulation for Brain and Network, places on the map for Territories. Tested. |
| `components/graph/graph-scene.ts` | three.js: notes, edges, nebulae and the brain mesh, additive blending on a flat background; the map's land, translucent, under them. |
| `components/graph/graph-overlay.ts` | 2D canvas on top: labels, the focus signal, paths, rings, project, vault and country names, the map's lines, minimap. |
| `components/graph/graph-controller.ts` | Camera, pointer, keyboard, focus, growth replay and the frame loop. No React re-render while it animates. |
| `components/graph/graph-view.tsx` | React chrome: toolbar, layers, preview, legend; preferences. |
| `components/graph/crawl/crawl-plan.ts` | Pure: a `gather_context` answer turned into replay steps, and the walk along threads between two notes. Tested. |
| `components/graph/crawl/crawl-history.ts` | Pure: which recent crawl plays by itself, and how its age reads. Tested. |
| `components/graph/crawl/crawl-layer.ts` | The Crawl view's `GraphPlugin`: the spider, lit threads, silk, labels; asks the camera to follow. |
| `components/graph/crawl/crawl-panel.tsx` | React chrome for Crawl: try a prompt, the spider switch, recent crawls, what was found. |

**The brain** is generated, not loaded: eleven ellipsoids blended smoothly (hemispheres,
frontal, temporal and occipital lobes, cerebellum, brainstem), a shallow groove between the
hemispheres, and noise folds for the cortex. About 6,000 points sampled on that surface, each
joined to its three nearest neighbours, make the mesh. There is no 3D model to license. A
container force keeps notes a little under the surface; the brain's size grows with the cube
root of the note count, so density holds and "Replay growth" shows it growing.

**One set of notes, three layouts.** Brain and Network share one simulation: Network pulls
`z` to zero; Brain lets it spread, pulls each project together and gives it its own depth so
clusters stay whole. Territories runs no forces: its places are computed (`graph-map.ts`) and
the notes ease to them, so nothing a link does can move a note on the map. Layout is kept
across rebuilds (node objects are cached by id), so toggling a layer never reshuffles the
graph, and a new note starts beside a placed neighbour — or, on the map, at its place. The
last layout is saved per browser and reused on the next visit to the same view.

During a replay the simulation grows in place, resynced with the notes shown so far every
90 ms. It is always handed a **copy** of that list: d3 keeps the array it is given, and a note
pushed onto it between two syncs is ticked by forces never initialised for it — its position
turns `NaN`, and d3 re-seeds it on a spiral far outside the brain.

**The map's land** is computed without a Delaunay triangulation: each note's cell starts as a
disc and is cut by the perpendicular bisector with every note close enough to matter, found
through a grid. The fills are one WebGL mesh under the notes, the only layer that blends
normally rather than additively; the coasts, borders and folder lines are drawn by the
overlay, because WebGL lines are one pixel wide and a coast needs a glow. Countries and
continents are packed with `d3-hierarchy`'s `packSiblings`.

**Why WebGL plus a 2D overlay.** Additive points and lines scale to thousands of notes cheaply,
but WebGL lines are one pixel wide and text is awkward. The overlay draws only what needs crisp
text or thicker strokes. Without WebGL the overlay draws the flat views on its own and Brain is
disabled, with the reason in the legend.

## Performance

Measured on the prototype with 1,600 notes and 5,100 edges: drawing costs about 2 ms a frame;
the 3D layout costs about 24 ms per tick while it settles, then stops. About three quarters of
a tick is many-body repulsion, the rest collision. At 300 notes a tick is about 3 ms.

**The first layout settles out of sight, a few ticks per frame.** Opening the graph runs 30 to
150 ticks before a note is shown. They used to run in one go inside `setModel` and froze the
page for 0.5–0.9 s at any vault size; now each frame spends up to 12 ms on them, the notes stay
hidden until they are done, and the camera frames them the moment they appear.

**Network ticks in two dimensions.** A flat layout in a 3D simulation paid for an octree it did
not need: in 2D a Network tick costs about 40% less (14 ms instead of 25 ms at 1,600 notes).
Arriving from the brain, the notes still fall onto the plane in three dimensions, exactly as
before; the third is dropped once every note is within 0.05 of it.

The simulation runs on the main thread. A Web Worker would free it while the layout settles,
but half of the engine moves notes directly (placement, the replay, the rescale into the brain,
the map) and each of those would become a message; it is worth it once vaults in the thousands
are real, not before.

The map costs nothing per frame once built. For 1,600 notes, placing them takes about 7 ms
and the land about 16 ms (40 ms the first time, before the JIT warms up); it is rebuilt when
the notes or layers change, and every 200 ms during a replay.

## Deliberately not built

- **Bridges between vaults.** Wikilinks resolve inside their owner's vault and affinity reads
  the viewer's vault only, so nothing connects your notes to a shared vault. Cross-vault
  affinity is possible if it is computed only over notes the viewer can read — rarity counts
  included — which makes it an authorisation change for `SharingService`, not a graph change.
- **A rotating 3D brain as the only view.** Worse for reading and clicking; Brain is one view
  of three, and the flat ones remain.
- **Colour per project.** See above.
