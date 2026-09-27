# Graph — design

`/graph` draws every note the viewer can see and how they connect. This document covers what it
shows, how it behaves, how it is built, and the decisions worth not undoing.

## Views and layers

Two independent choices, kept apart on purpose.

**A view is the shape of the map.** A segmented control in the toolbar, keys `1` `2` `3`:

| View | Shape |
|---|---|
| Brain | 3D. Notes live inside a brain; each visible vault settles in its own lobe, yours in the frontal one. |
| Network | Flat. Links alone decide where notes sit. |
| Territories | Flat. Each vault gets a territory: yours in the middle, shared vaults around it, a nebula in the vault's colour behind each. |

Switching views never jumps: the same notes flow to their new places. Entering Brain rescales
the flat layout into the brain's side view and lets the forces inflate it into the volume.
The chosen view is remembered per browser and written to the URL hash (`#brain`, `#network`,
`#territories`). The first visit opens in Brain; without WebGL, in Network.

**A layer is what gets drawn.** One popover, the first button of the toolbar, like a map's
layers button:

- **Include shared vaults** — whether folders others shared with you are loaded at all. On by
  default and remembered per browser; off, they are not even fetched (`notes.graph` scope
  `mine`). Only shown when sharing is enabled on the deployment.
- **Vaults** — show, hide or isolate ("only") each vault. The last visible vault cannot be hidden.
- **Shared topics** — dotted edges between notes that share a rare topic nobody linked (`notes.affinity`).
- **Indexes (MOC)** — index notes and their structure edges.
- **Topics as nodes** — a hollow hexagon per topic, joined to the notes that carry it.

This replaced the four old connection modes (links, affinity, topics, projects). The projects
mode is gone because zooming out now shows projects (below).

## Behaviour in every view

| Gesture | Effect |
|---|---|
| Click a note | The camera flies to it and a preview opens beside the graph: path, dates, topics, connections. |
| Double click, or `Enter` | Opens the note (a shared note opens under `/notes/shared/<owner>/…`). |
| Shift+click two notes | The shortest path between them, with a pulse travelling along it. Links first; shared topics only when no link path exists, and the panel says so. |
| Arrow keys | With a note selected, move to the neighbour in that direction on screen. |
| `/` | Focus search. Matches light up; `Enter` flies to the best one. |
| Hover | The note fires: its neighbours light up at one and two hops, with pulses along the edges. |
| Zoom out | Semantic zoom: note labels give way to project names and clouds. |
| Drag the background | Pans the flat views; turns the brain (Shift+drag pans it). |

The brain spins slowly until the user touches anything; side, top and front presets reorient
it. With `prefers-reduced-motion`, nothing spins, pulses or fades in.

**Replay growth** shows the notes appearing one by one in order of creation, at an even pace,
each beside the neighbour it links to, while a chip shows when the newest one was created. The
pace is by order, not by date: a vault imported in one sitting has most of its notes created
within minutes of each other, and one note dated years back would leave the replay idle for
most of its length and then drop everything at once.

## What the marks mean

- **Colour is the vault**, never the project. A viewer sees a handful of vaults, not the fifty
  projects that made per-project colour unreadable. Your vault uses the accent family; shared
  vaults take five fixed hues by name order, and a neutral after that.
- **A ring marks somebody else's note**, so identity never rests on hue alone.
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
`notes.graph`; vault names come from `sharing.listSharedWithMe`.

| File | Role |
|---|---|
| `lib/graph-model.ts` | Pure: nodes and edges from what the server sent, filtered by layers; vaults; paths and hops. Tested. |
| `lib/graph-brain.ts` | Pure: the brain's distance field, its surface mesh and the container force. Tested. |
| `lib/graph-camera.ts` | Pure: orbit camera, projection, fitting, zoom and pan. The overlay projects with the same maths three.js renders with. Tested. |
| `components/graph/graph-engine.ts` | The layout: one `d3-force-3d` simulation for every view. |
| `components/graph/graph-scene.ts` | three.js: notes, edges, nebulae and the brain mesh, additive blending on a flat background. |
| `components/graph/graph-overlay.ts` | 2D canvas on top: labels, the focus signal, paths, rings, project and vault names, minimap. |
| `components/graph/graph-controller.ts` | Camera, pointer, keyboard, focus, growth replay and the frame loop. No React re-render while it animates. |
| `components/graph/graph-view.tsx` | React chrome: toolbar, layers, preview, legend; preferences. |

**The brain** is generated, not loaded: eleven ellipsoids blended smoothly (hemispheres,
frontal, temporal and occipital lobes, cerebellum, brainstem), a shallow groove between the
hemispheres, and noise folds for the cortex. About 6,000 points sampled on that surface, each
joined to its three nearest neighbours, make the mesh. There is no 3D model to license. A
container force keeps notes a little under the surface; the brain's size grows with the cube
root of the note count, so density holds and "Replay growth" shows it growing.

**One simulation for three views.** Network and Territories pull `z` to zero; Brain lets it
spread and gives each project its own depth so clusters stay whole. Layout is kept across
rebuilds (node objects are cached by id), so toggling a layer never reshuffles the map, and a
new note starts beside a placed neighbour. The last layout is saved per browser and reused on
the next visit to the same view.

**Why WebGL plus a 2D overlay.** Additive points and lines scale to thousands of notes cheaply,
but WebGL lines are one pixel wide and text is awkward. The overlay draws only what needs crisp
text or thicker strokes. Without WebGL the overlay draws the flat views on its own and Brain is
disabled, with the reason in the legend.

## Performance

Measured on the prototype with 1,600 notes and 5,100 edges: drawing costs about 2 ms a frame;
the 3D layout costs about 24 ms per tick while it settles, then stops. The simulation runs on
the main thread today. Moving it to a Web Worker is the next step for vaults in the thousands.

## Deliberately not built

- **Bridges between vaults.** Wikilinks resolve inside their owner's vault and affinity reads
  the viewer's vault only, so nothing connects your notes to a shared vault. Cross-vault
  affinity is possible if it is computed only over notes the viewer can read — rarity counts
  included — which makes it an authorisation change for `SharingService`, not a graph change.
- **A rotating 3D brain as the only view.** Worse for reading and clicking; Brain is one view
  of three, and the flat ones remain.
- **Colour per project.** See above.
