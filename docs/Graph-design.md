# Graph — design

`/graph` draws every note the viewer can see and how they connect. This document covers what it
shows, how it behaves, how it is built, and the decisions worth not undoing.

## Views and layers

Two independent choices, kept apart on purpose.

**A view is the shape of the map, and each one answers its own question.** A segmented
control in the toolbar, each tab an icon and a name. The Sentinel's tab comes first, since it is
the view `/graph` opens on. The keys `1` to `4` switch views too, in the tabs' order, without a
number printed on the tabs to say so:

| View        | Question                              | Shape                                                                                                                                                                    |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sentinel    | What did the vault give an assistant? | The dormant network: a cluster of your notes, dark until the Sentinel wakes it, walked as it replays a `gather_context` search (see [Sentinel](#sentinel)). Needs WebGL. |
| Brain       | —                                     | 3D. Notes live inside a brain; each visible vault settles in its own lobe, yours in the frontal one.                                                                     |
| Network     | How does it connect?                  | Flat. Links alone decide where notes sit.                                                                                                                                |
| Territories | What is there, and where is it filed? | Flat. A map: each project a country, each vault a continent. Links move nothing.                                                                                         |

Network and Territories used to be one layout with a pull per vault on top, so with a single
vault — anyone who uses BrainStack alone — they were the same picture. They are now built on
opposite principles: one from the links and nothing else, the other from the folder hierarchy
and nothing else.

Switching views never jumps: the same notes flow to their new places. Entering Brain rescales
the flat layout into the brain's side view and lets the forces inflate it into the volume.
The view on screen is written to the URL hash (`#brain`, `#network`, `#territories`,
`#sentinel`; the old `#crawl` still works and is rewritten), so a reload stays on it. The first
visit opens in Sentinel; without WebGL, in Network. A view chosen before — with a tab or a key —
is respected: the choice is remembered per browser (`brainstack.graph.choice`) only when it is
made. The key that held the view before was written on every visit, so of it only Network and
Territories count; its Brain, which nearly every browser holds, says nothing
(`crawl/view-choice.ts`).

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

### Sentinel

**"Sentinel" names two things that are one:** the engine behind `gather_context` and
`search_brain` (`@brainstack/core/sentinel`), and its figure in this view — a creature that walks
your notes the way the engine read them. The view was called Crawl; its code keeps that name
(`components/graph/crawl/`, `CrawlReplay`, `crawl_history`, the `crawls.*` router).

It is not a fourth layout: under it the engine shows the Brain and never hears of the rest.
`graph-view` mounts `components/graph/crawl/`, which plugs into the controller as a `GraphPlugin`
with a **stage** of its own. Removing that folder and the tab leaves the graph exactly as it was.

- **The prompt.** The view opens on one line at the centre — "Ask your brain something" — with
  the Sentinel clinging to a dark frame round it (`prompt/`): its claws hold the frame's rails,
  its body rests behind the box, its eye looks over the top. Under it, the last few searches.
  It is not found there: as the stage comes in, it crosses the void from behind the box, along
  the camera's axis, and takes hold (`PromptScene.enter`, `entrance` creature units back), the
  input taking focus as it lands. Under reduced motion it is simply there.
- **A search.** A prompt goes to `notes.gatherContext`; the answer says why each note is there
  (`via`), and that is enough to replay it: the notes the text names, then what could not be
  resolved, then out along the links from each note in turn (`crawl-plan.ts`, tested). On a
  send, or a recent touched, the side panel slides in, the cluster wakes, the camera backs out to
  the whole of it, and the Sentinel lets go of the frame, crosses the void to the first note and
  walks the rest (`prompt/transition.ts`). **New search** in the panel runs the way back. Both
  run on the scene's own clock — the replay's steps added up, never wall time — so a pause holds
  them too, and either way the plugin resumes it.
- **The dormant network** (`space/`): every note a crystal in one cluster — a hub with lobes
  round it, the biggest projects a lobe each, the rest regions of the hub — and every link a
  faint thread between them. It stays dark until the walk wakes it: the threads it takes become
  tubes of light and stay lit, and each note it finds ignites in the colour of why it was handed
  over (named, linked, a decision). It is laid out from the model, never from the brain's
  positions, which it leaves untouched — the brain's saved layout included.
- **Decisions.** `notes.graph` marks each note that records a decision (`isDecision`: a
  `decisión`/`decision` tag or `status: decidido`, with the same scope as everything else it
  returns, shared notes included); the cluster shows those, and every note the search itself
  handed over as one (`decisionIds` in `crawl-plan.ts`).
- **The camera** follows the walk until the user drags, zooms or clicks; _Follow the Sentinel_
  re-attaches it, and Fit shows the whole cluster and stops following. At the prompt the scene
  holds the camera still: drags, the wheel, `+`/`−` and Fit change nothing there.
- **The side panel** (`crawl-panel.tsx`, `panel/`) is there for one thing: a prompt to paste into an
  assistant or an IDE, with the notes that answer the question (`brief.ts`). **Copy prompt** stays
  in reach — at the foot of the column, on the low row of the phone's sheet — and works from the
  first moment: the walk replays an answer that has already come. Two formats, remembered per
  browser (`brainstack.graph.sentinel.brief`): _References_ lists the notes by path (with the
  `ownerId` of a shared one) for an assistant connected to BrainStack, which opens them with
  `get_note`; _Full text_ carries each note's body, so it works pasted anywhere — the excerpts of a
  search run here, or, for a search from the history or a note added by hand, bodies read with
  `notes.get` and cut to the engine's own budget. Three tabs. **Context** lists the notes by folder
  as the walk reaches them (`reached` in the snapshot), each ticked in or out of the prompt; a
  reference the text left ambiguous is settled there by picking the note meant, and one left open
  goes into the prompt as a question for the assistant to ask; what the budget left out can be put
  back (`answer.ts`). Pointing at a note rings it on the stage. **Prompt** shows the text exactly as
  it is copied. **Activity** holds the walk's counts, its log and the raw answer an assistant
  receives over MCP. The question is edited in place to search again; the recent searches sit
  behind the clock, the Sentinel switch behind the dots. Pause, Replay, Skip to the end and Follow
  ride on a bar over the stage: they play the replay, not the search.
- **On a phone** the panel is a sheet from the bottom with three heights. It comes in low — the
  walk's state and Copy prompt — leaving the stage to the walk, and rises only when the person
  drags or taps its handle, never on its own, not even when the walk ends. On a wide screen the
  column folds to a strip.
- **The Sentinel switch** (`brainstack.graph.sentinel`, per browser): off, the cluster still
  wakes, lit by a stand-in eye that rides the walk, and no creature is drawn. The spider switch's
  old choice (`brainstack.graph.spider`) carries over once: off stays off.
- **Recent searches.** Every `gather_context` call — an assistant's over MCP or one tried here —
  is kept per user in `crawl_history` (`CrawlHistoryService`): the start of the prompt and the
  replay (paths, titles, `via`), and the notes the budget left out, never the excerpts. The view
  polls `crawls.list` every few seconds, so an assistant's search shows up under the prompt and
  behind the panel's clock without a reload, marked **new**
  until it is played in this browser. It never plays by itself: what to watch is the person's
  call. Pruned on every write, by age (`CRAWL_HISTORY_DAYS`, default 30, 0 = off) and to the
  newest 50 per user. Only the user who searched lists them; a folder share never reaches them.
- **The stage** (`stage/sentinel-stage.ts`) has its own canvas and WebGL renderer, laid between
  the graph's canvas and the overlay; the overlay still takes every gesture and draws the labels.
  While it covers the graph, the graph's drawing buffer is parked at 1×1, so two full-size
  canvases never hold GPU memory at once. On leaving, the stage's context is freed
  (`forceContextLoss`), the graph's buffer comes back with a full upload, and the brain's camera
  and spin are given back as they were.
- **The trail.** Where the stage cannot run, the same walk is drawn as a trail of light over the
  brain: threads lit along the brain's curves, the notes found haloed, labels, and a point of
  light where the walk is. The reasons, each said once on the console and in the panel: the
  stage's code failed to load, no WebGL for it, a software renderer, the space failed to build,
  a shader failed to compile, the stage took too long to start (ten seconds of frames), the
  WebGL context was lost, or a frame failed. A crawl on screen carries on over the brain — at
  its end if it had finished. The next visit tries the stage again.
- **When the notes change.** The graph rebuilds its model on every change; the cluster is laid
  out again only when what its layout reads changed (`space/space-key.ts`: notes and their
  folders, vaults, projects, indexes, walkable links) and the model has held still for 300 ms. A
  search that had finished then shows its end; one still walking starts over from its first note.
- **Loading.** The panel comes with `next/dynamic` and the stage with `import()`, both only when
  the view opens (fetched alongside the graph when the page opens on it), so Brain, Network and
  Territories never download them (`crawl/lazy-imports.test.ts`). Until the stage has built the
  cluster and compiled its shaders — half a second to a couple — the brain is kept out of sight
  (the plugin's `veil`, and before the panel's code has even arrived, `awaitPlugin`): the inert
  prompt shows over the dark, and the stage fades in over that. Only on the trail does the brain
  come back, since the walk is drawn over it. In the Sentinel the brain's own tools are hidden (search,
  filters, Replay growth, the angles and Spin), and in its walk the legend too, whose colours the
  panel counts; zoom, Fit, the layers and the views stay.
- **Quality.** One governor per stage starts from what the GPU says it can do and from the last
  tier that held, steps down when frames at rest slip, and remembers where it ended. It times
  the Sentinel alone, never the cluster or the brain's layout settling.
- With `prefers-reduced-motion` every transition is a cut, a search jumps to its end, and the
  Sentinel holds still.
- **The lab** at `/dev/sentinel` (a `page.dev.tsx`, which exists under `next dev` only) assembles
  the same parts with every knob that shapes the creature's look, motion and cost, the cluster's
  and the prompt scene's; it is where the look is judged and the values that ship are chosen.

## Behaviour in every view

| Gesture                  | Effect                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Click a note             | The camera flies to it and a preview opens beside the graph: path, dates, topics, connections.                                                                     |
| Double click, or `Enter` | Opens the note (a shared note opens under `/notes/shared/<owner>/…`).                                                                                              |
| Shift+click two notes    | The shortest path between them, with a pulse travelling along it. Links first; shared topics only when no link path exists, and the panel says so.                 |
| Arrow keys               | With a note selected, move to the neighbour in that direction on screen.                                                                                           |
| `/`                      | Focus search. Matches light up; `Enter` flies to the best one.                                                                                                     |
| Hover                    | The note fires: its neighbours light up at one and two hops, with pulses along the edges. On the map, a country fires the same way along the routes that leave it. |
| Zoom out                 | Semantic zoom: note labels give way to project names and clouds; on the map, to country names.                                                                     |
| Drag the background      | Pans the flat views; turns the brain (Shift+drag pans it).                                                                                                         |

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

All of it is client-side. The server adds `createdAt`, `updatedAt` and `isDecision` to each node
of `notes.graph`; vault names come from the roots in `sharing.listSharedWithMe` (`sharedVaultNames`).

| File                                             | Role                                                                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/graph-model.ts`                             | Pure: nodes and edges from what the server sent, filtered by layers; vaults; paths and hops. Tested.                                                         |
| `lib/graph-brain.ts`                             | Pure: the brain's distance field, its surface mesh and the container force. Tested.                                                                          |
| `lib/graph-camera.ts`                            | Pure: orbit camera, projection, fitting, zoom and pan. The overlay projects with the same maths three.js renders with. Tested.                               |
| `lib/graph-map.ts`                               | Pure: Territories — where each note belongs on the map, and the land, coasts, borders and folder lines under the notes. Tested.                              |
| `components/graph/graph-engine.ts`               | The layout per view: a `d3-force-3d` simulation for Brain and Network, places on the map for Territories. Tested.                                            |
| `components/graph/graph-scene.ts`                | three.js: notes, edges, nebulae and the brain mesh, additive blending on a flat background; the map's land, translucent, under them.                         |
| `components/graph/graph-overlay.ts`              | 2D canvas on top: labels, the focus signal, paths, rings, project, vault and country names, the map's lines, minimap.                                        |
| `components/graph/graph-controller.ts`           | Camera, pointer, keyboard, focus, growth replay and the frame loop. No React re-render while it animates.                                                    |
| `components/graph/graph-view.tsx`                | React chrome: toolbar, layers, preview, legend; preferences.                                                                                                 |
| `components/graph/crawl/view-choice.ts`          | Pure: which view `/graph` opens on, and what counts as a choice. Tested.                                                                                     |
| `components/graph/crawl/crawl-plan.ts`           | Pure: a `gather_context` answer turned into replay steps, the walk along threads between two notes, and which notes are decisions. Tested.                   |
| `components/graph/crawl/crawl-replay.ts`         | Pure: the replay — where the walk is, what it lit and found, what each of the Sentinel's grips holds — over the brain or a space. Tested.                    |
| `components/graph/crawl/crawl-draw.ts`           | The 2D part: labels over the stage; threads, halos and the point of light of the trail. Tested.                                                              |
| `components/graph/crawl/crawl-plugin.ts`         | The Sentinel view's `GraphPlugin`: the replay, the prompt scene, the stage or the trail, the camera between them. Tested with a fake stage.                  |
| `components/graph/crawl/crawl-panel.tsx`         | React chrome for the Sentinel: the prompt and its recents; the side panel — a column, or a sheet on a phone — and the replay's controls over the stage.       |
| `components/graph/crawl/panel/`                  | The panel's parts: its head, the Context, Prompt and Activity tabs, the phone's sheet, the replay bar, copying, and the bodies a full-text prompt reads.      |
| `components/graph/crawl/brief.ts`                | Pure: the prompt the panel copies, by reference or in full text. Tested.                                                                                     |
| `components/graph/crawl/answer.ts`               | Pure: a search as the panel reads it, what the person kept, settled and put back, and what the prompt carries from that. Tested.                            |
| `components/graph/crawl/crawl-history.ts`        | Pure: how a recent search's age and author read. Tested.                                                                                                     |
| `components/graph/crawl/prompt/`                 | The prompt scene: the frame round the input, the Sentinel's perch on it, the way into the walk and back, the recents. Pure but for the React prompt. Tested. |
| `components/graph/crawl/stage/sentinel-stage.ts` | The stage: its renderer, the dormant network, the creature, the frame's bezel, the quality governor. Loaded only in the view.                                |
| `components/graph/crawl/space/`                  | The dormant network: the cluster's layout (`volume/`) and how it is drawn (`dormant/`). Layout tested.                                                       |
| `components/graph/crawl/space/space-key.ts`      | Pure: what the cluster's layout reads of a model, as one key, so a model rebuilt the same way is not laid out again. Tested.                                 |
| `components/graph/crawl/sentinel/`               | The creature: anatomy, grips, motion, geometry, materials, quality tiers; and the lab (`sentinel/lab/`). Motion tested.                                      |

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
