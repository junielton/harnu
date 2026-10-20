# T536 — Canvas tool modes: an Excalidraw-style toolbar for the canvas pane

Status: **scope settled by operator, 2026-10-19** · 2026-10-19 · card T536
Extends: `docs/specs/2026-08-23-t218-canvas-pane.md` (T218), `design.md` §6 "Diagram pane".

## 1. Intent — why this exists

The canvas pane works, but it is unpleasant to use. The first thing anyone does when a
board opens is **click on it**, and today a plain left-drag on empty board **draws a box**
while panning hides on the **right** button. A rubberband selection needs `shift`, and
click multi-select uses `ctrl`/`⌘` (X6's default). None
of that is discoverable: there is no on-screen hint of which gesture does what.

Every whiteboard people already know (Excalidraw, tldraw, Figma, FigJam) solves this the
same way: a **tool bar** of explicit modes. The pointer does what the active tool says,
the active tool is always visible, and the default tool is **Select**, so a first click
selects and never creates.

This spec adds that toolbar, a small set of new shapes, and a short list of style
properties, while keeping the canvas file readable by the agent and by older Harnu
builds.

### What success looks like

1. A first-time user opens a canvas, clicks around, and **nothing gets created by
   accident**.
2. Drawing a box, an ellipse, an arrow or a text label is: pick the tool (click or one
   key), then click or drag on the board.
3. Panning works with a visible tool, with `space` held, and with the right button as
   before.
4. Everything the operator can draw, the agent can draw through `draw_canvas`, and vice
   versa.
5. Every tool is covered by automated tests **and** a live gesture matrix run in the real
   app (§9).

### Goals

- G1. A floating toolbar with explicit tool modes; **Select is the default**.
- G2. Single-key shortcuts for every tool, gated to the focused pane.
- G3. Fix the gesture model: a plain left-drag on blank board in Select mode is a
  **rubberband selection**, not a box.
- G4. New shapes: **ellipse** and **diamond** (schema + renderer + agent verb).
- G5. Style properties: all of P1–P8 (§7), under the stop rule in §7.0.
- G6. Test coverage for every tool, including a live gesture matrix in the real app.

### Non-goals (v1)

- **Freehand pencil.** X6 is a node-and-edge graph library; freehand strokes would need a
  path node type, a different hit-test model and a different file shape. Out.
- **Hand-drawn "sloppiness" look.** Needs a rough.js-style renderer. Out.
- **Font family picker.** The design contract allows one UI font plus mono. Out.
- **Free-floating lines and arrows** (an arrow with no node at one end). The file schema
  requires both ends of an edge to be nodes, and an older build **refuses** a file that
  breaks that rule. Out of v1; see §10.
- Copy/paste between canvases, multi-user cursors, a mini-map.

### Anti-goals — this fails even if it "works" if…

- …a click on empty board in the default tool creates anything.
- …a raw hex colour lands in the canvas file or a component (design contract §2/§9).
- …a board saved by this build can no longer be opened, or silently loses data, in the
  previous Harnu release.
- …the agent can see a shape on the board that `draw_canvas` cannot draw.
- …a single-letter shortcut fires while the operator types in the rename input, or in a
  different pane.

## 2. Current state (verified 2026-10-19)

| Fact                                                                                       | Where                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Substrate is AntV X6 core `2.19.2` + 2.x plugins (Selection, History, Transform, Snapline) | `canvas-graph.ts`, `package.json` pin           |
| Plain left-drag on blank draws a box (≥48×32); a short drag is a click                     | `DiagramPane.vue` `onBlankMouseDown`/`onDrawUp` |
| Rubberband needs `shift` (`CANVAS_RUBBERBAND_MODIFIER`)                                    | `canvas-graph.ts:105`                           |
| Pan is `rightMouseDown` only when editable                                                 | `canvas-graph.ts:186`                           |
| Edges start from four hover ports on a framed node                                         | `canvas-cells.ts` `portsFor`                    |
| Shortcuts: ⌘S, ⌘Z, ⌘Y, ⌘D, ⌘A, Delete/Backspace, Esc — focus-gated                         | `DiagramPane.vue` `onWindowKeydown`             |
| Built-in shapes: `box`, `text`, `image`; HTML: `harnu/mockup-card`                         | `canvas-cells.ts:74`, `mcp/canvas-shapes.ts`    |
| Agent `props` are validated against each shape's declared keys (`BAD_PROPS`)               | `mcp/canvas-ops.ts`                             |
| An unknown shape renders as a dashed box and **round-trips unchanged**                     | `canvas-cells.ts:317`                           |
| Node `props` are preserved as plain JSON on read/write                                     | `canvas-core.ts:416,526`                        |
| **Edges drop unknown fields** on read; only `router` survives                              | `canvas-core.ts:471-486`                        |
| Schema version check is **strict equality**: a bump makes older builds refuse the file     | `canvas-core.ts:54,347`                         |
| jsdom does **not** reproduce X6's document-level `mouseup` swallowing                      | `DiagramPane.vue:304` comment                   |
| Playwright `_electron` e2e runs headless in CI                                             | `tests/e2e/ci/app-boot-mcp.spec.ts`             |

## 3. Compatibility rules (load-bearing)

These decide what is cheap and what is not. The builder must not break them.

- **C1. No schema version bump.** `capycanvas` stays `1`. Every addition is additive and
  must open in the previous release.
- **C2. New node kinds are safe.** An older build renders `ellipse`/`diamond` as a dashed
  box, keeps the kind on save, and the newer build draws it properly again.
- **C3. New node styling goes in `node.props`.** Props are preserved by older builds.
  Never add a new top-level key on a node.
- **C4. Edge styling is not free.** An older build **drops** any new edge field on save.
  If edge styling is chosen (Q1), it ships with an explicit, documented loss window, or
  it waits for a reader change that lands one release earlier. See §7.3.
- **C5. Colours are tone names, never colour values.** The file says `"tone": "green"`;
  the renderer maps the tone to theme tokens. Switching theme recolours the board.
- **C6. Agent parity.** Every shape and prop the pane can write is in the `draw_canvas`
  catalog in the same change, with `docs/harnu-features.md` updated and its marker bumped.

## 4. The toolbar

### 4.1 Tools in v1

| #   | Tool                    | Key | Number | Cursor               | Needs schema change |
| --- | ----------------------- | --- | ------ | -------------------- | ------------------- |
| —   | Lock (keep tool active) | `Q` | —      | —                    | no                  |
| 1   | Hand (pan)              | `H` | —      | `grab` / `grabbing`  | no                  |
| 2   | **Select** (default)    | `V` | `1`    | `default`            | no                  |
| 3   | Rectangle               | `R` | `2`    | `crosshair`          | no (`box`)          |
| 4   | Diamond                 | `D` | `3`    | `crosshair`          | **yes** (U2)        |
| 5   | Ellipse                 | `O` | `4`    | `crosshair`          | **yes** (U2)        |
| 6   | Arrow                   | `A` | `5`    | `crosshair`          | no (bound edge)     |
| 7   | Text                    | `T` | `6`    | `text`               | no (`text`)         |
| 8   | Eraser                  | `E` | `0`    | `cell` (CSS keyword) | no                  |

Order and letters follow Excalidraw so the muscle memory transfers. Diamond and Ellipse
buttons ship in U2, not U1; U1's toolbar has no placeholder for them.

### 4.2 Anatomy (design.md must gain this before the Vue change)

- A floating bar, **top-centre of the viewport**, absolute to the viewport so it neither
  pans nor zooms. Same surface as the zoom cluster: `bg-surface`, 1px `--border`,
  `--shadow-pop`, `--radius`.
- 28px square buttons, 16px lucide icons, 2px gap, a 1px `--border` separator between
  Lock|Hand and the rest.
- Active tool: `bg-accent-soft` + `text-accent`, `aria-pressed="true"`.
  Idle: `text-text-3`, hover `bg-surface-2 text-text`.
- Each button shows its key as a tiny `--text-4` corner digit/letter (Excalidraw idiom)
  and a native tooltip: "Rectangle — R or 2".
- Lock pressed: padlock closed, `text-accent`.
- **One muted hint line** under the bar for the active tool (`--text-4`, 11px), e.g.
  Select: "Drag to select · Space+drag to pan". It hides after the first successful use
  of that tool in the pane's lifetime.
- **Narrow panes.** The canvas is a helper pane and can be ~320px wide. Rule: the bar
  never overlaps the zoom cluster and never clips. Below the width where both fit on one
  row, the bar drops to a second row under the zoom cluster, left-aligned. Verified at
  320px in the live matrix (§9.4).
- Every visible string goes through `$t()`, with keys in **both** `en.json` and
  `pt-BR.json`.

Icons (lucide, already the app's set): `lock`/`lock-open`, `hand`, `mouse-pointer-2`,
`square`, `diamond`, `circle`, `move-right`, `type`, `eraser`.

### 4.3 Tool state rules

- The tool is **per pane**, held in memory, not saved to the file. A new pane starts on
  **Select**.
- **After a creation, the tool reverts to Select**, unless Lock is on. (Excalidraw
  behaviour: you draw one thing, then you are back to moving things.)
- `Esc`: if a creation is in progress, cancel it. Else if the tool is not Select, switch
  to Select. Else clear the selection.
- **Space held** = temporary Hand from any tool; releasing it restores the previous tool.
  Ignored while the rename input has focus.
- **Right-button drag pans in every tool**, unchanged, so nobody loses the current habit.
- `ctrl`/`⌘` + wheel zooms, unchanged.
- Switching tools never touches the undo history.
- Shortcut letters fire only **without** `ctrl`/`⌘`/`alt`, only when focus is inside this
  pane, and **never** while the rename input is focused. `⌘D`, `⌘A` etc. keep their
  current meaning.

## 5. Behaviour per tool — the gesture contract

This table **replaces** the "three blank-area gestures" table in `design.md` and the
"Drawing" table in `docs/user/canvas.md`.

| Tool                              | Click blank                                     | Drag on blank                                                                                                                     | Press on a node                                                              | Drag on a node                                                                                                |
| --------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Select**                        | clear selection                                 | **rubberband select** (no modifier); `shift`+drag adds to the selection                                                           | select it; `shift`+click **or** `ctrl`/`⌘`+click toggles it in the selection | move it (and the rest of the selection)                                                                       |
| **Hand**                          | nothing                                         | pan                                                                                                                               | nothing                                                                      | pan (nodes do not move)                                                                                       |
| **Rectangle / Diamond / Ellipse** | place a default-size shape centred on the click | draw it to the drag's footprint (floored at 48×32)                                                                                | same as blank: shapes may overlap                                            | same as blank                                                                                                 |
| **Arrow**                         | nothing                                         | nothing (no free arrows in v1; a hint says "Start on a shape")                                                                    | start an arrow from that node                                                | rubber-band line follows the pointer; release on another node creates a bound edge, release elsewhere cancels |
| **Text**                          | place a `text` node with the rename input open  | same as click (drag size ignored)                                                                                                 | if the node is a `text`, edit it; else place a new text on top               | —                                                                                                             |
| **Eraser**                        | nothing                                         | every node and edge the pointer crosses is marked (dimmed); release deletes them all as **one** undo step; `Esc` mid-drag cancels | delete it                                                                    | as drag on blank                                                                                              |

Further rules:

- A newly created shape opens its rename input immediately (today's box behaviour); an
  empty commit on a **text** node removes it, on a framed shape keeps it unlabelled.
- **Double-click blank in Select** places a text node (Excalidraw idiom).
- **Double-click a node** renames it in every tool except Eraser.
- The Arrow tool starts from **anywhere on a node**, not only from the four ports. The
  hover ports stay, and dragging from a port still creates an edge in Select mode.
- Deleting a node with the Eraser removes its edges, as Delete does today.
- Every creation is stamped `origin: "operator"`, as today.

## 6. New shapes (U2)

| Shape     | X6 primitive                | Default size | Ports                     | Label   |
| --------- | --------------------------- | ------------ | ------------------------- | ------- |
| `ellipse` | `ellipse`                   | 132×64       | 4, at the cardinal points | centred |
| `diamond` | `polygon` with 4 ref points | 132×80       | 4, at the vertices        | centred |

Body and label tokens are identical to `box` (§design "Node and edge treatment").
Resize via the Transform plugin as for `box`. The manhattan router must route around
them like a box; a test pins that an edge to a diamond attaches at a vertex port.

Changes: `canvas-cells.ts` (`BUILTIN_KINDS`, `DEFAULT_SIZE_BY_SHAPE`, cell builder),
`mcp/canvas-shapes.ts` (`CANVAS_BUILTIN_SHAPES`), `docs/harnu-features.md` (shape list +
marker bump), `docs/user/canvas.md`, `design.md`, `CHANGELOG.md`.

## 7. Style properties (U3–U5) — all chosen

### 7.0 Stop rule (operator, 2026-10-19)

The operator chose **every** property in §7.1, with one condition: a property that turns
out to need a **new external library**, or that **risks breaking existing boards or
existing behaviour**, is dropped from its unit and reported in the PR, not forced
through. Dropping one property never blocks the others. Iterating on polish is fine;
taking on risk to ship a property is not.

### 7.1 The menu, with cost

| Option                    | What the operator gets                                                                          | Cost                     | Compat                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1. Colour (tone)**     | 6 swatches: default, accent, green, amber, red, muted. Colours border + a soft fill + the label | medium                   | node `props.tone` (C3, C5)                                                                                                                                                                               |
| **P2. Stroke style**      | solid / dashed / dotted                                                                         | cheap                    | node `props.stroke`                                                                                                                                                                                      |
| **P3. Stroke width**      | thin / regular / bold                                                                           | cheap                    | node `props.strokeWidth`                                                                                                                                                                                 |
| **P4. Corners**           | sharp / round (box only)                                                                        | cheap                    | node `props.corners`                                                                                                                                                                                     |
| **P5. Text size + align** | S / M / L / XL; left / centre / right                                                           | cheap                    | node `props.fontSize`, `props.align`                                                                                                                                                                     |
| **P6. Opacity**           | 25 / 50 / 75 / 100                                                                              | cheap                    | node `props.opacity`                                                                                                                                                                                     |
| **P7. Layers**            | send to back / backward / forward / bring to front                                              | medium, **agent-facing** | existing `zIndex` field, but the Save path only writes back a `zIndex` the file already had (`canvas-edit.ts:333-339`) and `draw_canvas` has no `zIndex` op field (`canvas-ops.ts:308-310`); both change |
| **P8. Edge styling**      | tone + dashed on arrows                                                                         | medium **+ compat risk** | needs edge `props` (C4)                                                                                                                                                                                  |

Every value is a **fixed enum**. The renderer tolerates an unknown value (draws the
default); the `draw_canvas` verb refuses it with `BAD_PROPS`. Today the shape manifest
declares bare key names and `checkProps` checks keys only (`canvas-shapes.ts:56`,
`canvas-ops.ts:348`), so value checking needs a manifest schema change: each style key
declares its allowed values. That changes the `shapes` catalog the ACK returns, so
`docs/harnu-features.md` documents the new catalog shape in the same PR.

### 7.2 Tone → token map (P1)

| Tone      | Stroke       | Fill             | Label      |
| --------- | ------------ | ---------------- | ---------- |
| `default` | `--border-2` | `--surface`      | `--text`   |
| `accent`  | `--accent`   | `--accent-soft`  | `--text`   |
| `green`   | `--green`    | `--green-soft`   | `--text`   |
| `amber`   | `--warning`  | `--warning-soft` | `--text`   |
| `red`     | `--red`      | `--red-soft`     | `--text`   |
| `muted`   | `--border`   | `--bg`           | `--text-3` |

No new §9 token. If a tone needs one, `design.md` §9 and `themes.css` change first.

### 7.3 Edge styling and the loss window (P8)

Older builds drop edge `props` on save. Route chosen: **reader first.** U2 teaches
`canvas-core.ts` to preserve an edge's `props` on read and write (reader change only, no
UI). The arrow style UI ships last, in U5, so at least one release carries the reader
before any build writes edge styles. Edge style uses the same `props.style` object and
the same merging `style` verb field as nodes (§7.5), on `add_edge` / `update_edge`.
If U5 finds any other way an existing board could lose data, P8 is dropped under §7.0.

### 7.4 The properties panel

A floating panel on the **left edge of the viewport**, below the zoom cluster, visible
only while the selection is non-empty and the tool is Select. Same surface as the
toolbar. Shows only the controls that apply to every selected element; a mixed value
shows no active option. Each change is one undo step. The panel collapses to a single
`palette` button when the pane is narrower than the panel plus 200px. When the toolbar
has dropped to its fallback row (§4.2), the panel opens **below that row**; the toolbar
never moves for the panel.

### 7.5 Where style lives, and how it survives an agent edit

Style is stored as one nested object, `node.props.style` (for example
`{"tone":"green","stroke":"dashed"}`), never as loose keys beside a shape's own props.
Reason: `update_node`'s `props` **replaces** the whole object (`canvas-ops.ts:553-556`,
deliberately, so a key can be removed). Without a separate home, an agent updating an
image's `src` or a card's `title` would silently wipe the operator's colour.

- `draw_canvas` `add_node` / `update_node` gain a **`style`** field, merged **per key**;
  a key set to `null` removes it.
- `props` replace semantics are unchanged, and a `props` replace **never touches**
  `props.style`. A `style` key inside `props` is refused with `BAD_PROPS` and a hint to
  use `style`.
- Older builds keep `props.style` because they keep all of `props` (C3).

### 7.6 Which shapes take which properties

| Shape                | Colour (tone)     | Stroke style / width | Corners | Text size + align | Opacity | Layers |
| -------------------- | ----------------- | -------------------- | ------- | ----------------- | ------- | ------ |
| `box`                | full              | yes                  | yes     | yes               | yes     | yes    |
| `ellipse`, `diamond` | full              | yes                  | —       | yes               | yes     | yes    |
| `text`               | label colour only | —                    | —       | yes               | yes     | yes    |
| `image`              | —                 | —                    | —       | —                 | yes     | yes    |
| `harnu/mockup-card`  | —                 | —                    | —       | —                 | —       | yes    |

The properties panel shows only the controls every selected element accepts. The
agent catalog declares the same table, and one parity test pins the pane's table and
the catalog to each other.

## 8. Units — one unit, one PR

| Unit                        | Scope                                                                                                                                                                                    | Agent-facing? | Depends on                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------- |
| **U1 — Tool modes**         | Pure tool-state module, toolbar, Select/Hand/Rectangle/Arrow/Text/Eraser, Lock, space-pan, hints, the new gesture contract. No schema change. **This alone fixes the reported problem.** | no (pane UX)  | —                                   |
| **U2 — Ellipse + diamond**  | Schema-free node kinds, renderer, agent catalog, toolbar buttons; **plus** the edge-`props` reader change of §7.3                                                                        | **yes**       | U1                                  |
| **U3 — Node style + panel** | P1–P6 on nodes, the properties panel, `props.style`, the merging `style` verb field, value-checked catalog                                                                               | **yes**       | U1, U2                              |
| **U4 — Layers**             | P7: Save writes live stacking order, panel buttons, `zIndex` on `add_node`/`update_node`                                                                                                 | **yes**       | U3 (panel)                          |
| **U5 — Arrow style**        | P8: tone + stroke style on edges, panel for a selected edge, `style` on `add_edge`/`update_edge`                                                                                         | **yes**       | U3, and U2's reader change released |

Each unit's PR carries: `design.md` first, `CHANGELOG.md` entry, `docs/user/canvas.md`
update, both i18n locales, and — for U2 to U5 — `docs/harnu-features.md` + marker bump.
U1 lands this spec at `docs/specs/2026-10-19-t536-canvas-toolbar.md`.

**Suggested module seam (builder may change it):** a new pure
`src/renderer/src/components/canvas/canvas-tools.ts` owning tool state, transitions and
the key map, with no X6 or Vue import, so the whole state machine is unit-testable.
`DiagramPane.vue` (already 1,239 lines) delegates to it, and the toolbar is its own
component `CanvasToolbar.vue` (a new top-level component, so `docs/user/` is mandatory
anyway).

**Known X6 risk for U1, spike first (≤ 1 hour):** X6 2.x configures panning
`eventTypes` at construction. Switching left-drag between rubberband (Select) and pan
(Hand) at runtime may need `selection.disableRubberband()` plus a custom pan through
`graph.translate()`, or rebuilding the panning option. The spike answers which, before
the toolbar is wired.

## 9. Test plan — "test every tool"

### 9.1 Unit (vitest, pure)

`tests/canvas-tools.test.ts` over `canvas-tools.ts`:

- default tool is Select; every key and number maps to its tool; modifiers and the
  rename-focus flag block every letter;
- creation reverts to Select; Lock keeps the tool; `Esc` order (cancel → Select → clear);
- space-hold enters Hand and restores the exact previous tool, including after Lock;
- the per-tool gesture routing table of §5 as a data-driven test (tool × gesture →
  expected intent), so the contract table and the code cannot drift.

### 9.2 Component (vitest + jsdom, mounting `DiagramPane`)

Following `tests/canvas-pane-render.test.ts`:

- the toolbar renders all v1 tools with `aria-pressed` on exactly one;
- clicking a button and pressing its key both switch the tool;
- a key pressed in another pane, or in the rename input, does nothing;
- creation through each tool produces a node stamped `operator`, and a Save round-trips
  it through `canvas-edit.ts`;
- the eraser deletes in one history batch (one undo restores everything).
- **Existing tests asserting "plain drag draws a box" are updated on purpose**, with the
  old expectation moved to the Rectangle tool. A test that silently stops asserting is a
  defect.

jsdom limit, stated once: X6 swallows `mouseup` at `document` in the real app, and jsdom
does not. Gesture correctness is therefore proven in §9.3 and §9.4, not here.

### 9.3 End-to-end (Playwright `_electron`, CI project)

New `tests/e2e/ci/canvas-tools.spec.ts`: launch the built app, seed a canvas file in a
temp folder, open it, then per tool drive real mouse events and read the result back
from the saved file:

1. Select: click blank → no node; drag blank → rubberband selects the seeded nodes.
2. Rectangle: drag → a `box` of the dragged size; tool back to Select.
3. Arrow: drag node A → node B → one edge A→B; drag A → blank → no edge.
4. Text: click → a `text` node with the typed label.
5. Eraser: drag across two nodes → both gone; ⌘Z → both back.
6. Hand: drag → viewport moved, no node moved.
7. Shortcuts: `R`, then drag → box; `Esc` → Select.
8. (U2) Ellipse and diamond via `O` / `D`.
9. (U3–U5) Each property: set it, Save, read the file, assert the `props.style` value;
   for Layers, reorder, Save, reopen, assert the order held.

### 9.4 Live gesture matrix (real app, second isolated instance)

Per `docs/dev/live-verify-second-instance.md`, run the full matrix of §5 (every tool ×
click blank, drag blank, press node, drag node, right-drag, space+drag, `Esc`, its
shortcut) and save a screenshot per row under
`.harnu/out/visual/T536/<unit>/`. Also: dark and light theme, pane width 320px and
maximized, a theme switch with a styled board (U3). The verifier grades from these
screenshots and the saved files, never from the executor's account.

### 9.5 Compatibility tests

- `canvas-core.test.ts`: a board with `ellipse`, `diamond` and every new prop parses and
  writes back byte-equivalent.
- A board written by this build, read by the **previous** reader logic (fixture of the
  old `BUILTIN_KINDS`), renders the new shapes as dashed boxes and round-trips them.
- `mcp-canvas-ops.test.ts`: `draw_canvas` accepts the new shapes and props, refuses an
  unknown enum value with `BAD_PROPS`, and the ACK's `shapes` catalog lists them.

## 10. Later, not now

- **Free lines and arrows** (P-L): needs either a hidden anchor node at a free end or a
  schema rule change shipped reader-first, like §7.3 A.
- **Freehand pencil**: a `path` node kind with points in `props`; feasible but a separate
  spec.
- Card field editing in the pane, arrow-label editing (already listed as gaps in
  `docs/user/canvas.md`).

## 11. Decisions

| Decision                                                                                    | By                                                        |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Toolbar with explicit modes; Select is the default; left-click must not create              | operator                                                  |
| Excalidraw is the reference for the toolbar                                                 | operator                                                  |
| Freehand, sloppiness and font family are out                                                | assistant's call (feasibility)                            |
| Tool reverts to Select after a creation; Lock keeps it                                      | assistant's call (Excalidraw default)                     |
| Right-drag keeps panning in every tool                                                      | assistant's call (no lost habit)                          |
| Colours stored as tone names mapped to tokens, never hex                                    | design contract                                           |
| No schema version bump; styling in `node.props`                                             | assistant's call (compat, §3)                             |
| Agent parity for every new shape and prop                                                   | assistant's call (C6)                                     |
| Multi-select click accepts both `shift` and `ctrl`/`⌘`; `shift`+drag adds to the rubberband | assistant's call (keeps today's habit, adds Excalidraw's) |
| Style stored in `props.style`, set by a merging `style` verb field                          | assistant's call (§7.5, survives agent edits)             |
| Per-shape property table (§7.6)                                                             | assistant's call                                          |
| Narrow pane: the properties panel yields to the toolbar's fallback row                      | assistant's call                                          |
| Ellipse and diamond in v1                                                                   | operator (yes)                                            |
| All style properties P1–P8 ship, under the §7.0 stop rule                                   | operator                                                  |
| Edge styling goes reader-first: reader change in U2, UI in U5                               | assistant's call (§7.3)                                   |
| Layers and Arrow style are their own units                                                  | assistant's call (separate risk)                          |

## Implementation notes (U1)

What shipped in U1 differs from the text above in these ways. Each was checked live in the
built app (a 78-row gesture matrix; see the PR).

- **The toolbar wraps in very narrow panes.** The bar's positioning box is capped at the
  pane width minus its 12px left inset, so a pane narrower than about 237px puts the
  buttons on extra rows (two at ~200px, three at ~140px) instead of clipping. The hint
  wraps to the bar's width. This replaces the "drops to a second row under the zoom
  cluster" wording in §4.2: at 243px (the default helper split) and at 320px the bar is
  still one row. Below ~140px the pre-existing zoom cluster is itself wider than the pane;
  that is not part of U1.
- **Double-click rename in the creation tools.** §5 says a double-click on a node renames
  it "in every tool except Eraser". In Rectangle and Text the first press of the
  double-click already creates a shape (§5: press on a node places one on top), so the
  double-click places and edits a new shape and does not rename the node underneath. A
  node is renamed by double-clicking it in Select, Hand or Arrow. `design.md` §6 says so.
- **Space held does not re-highlight Hand.** While Space is down the board pans and the
  cursor is `grabbing`, but the toolbar keeps showing the previous tool as pressed. The
  spec was silent; Excalidraw behaves the same.
- **Release outside the pane or window.** Rectangle still creates the box (the dragged
  footprint reaches past the visible edge, and the rename field opens); Arrow cancels;
  Eraser commits what it had marked. The spec did not cover this.
- **Light-theme hint contrast.** The hint line and the 8px corner keys use `--text-4` as
  specified and read very faint on the light surface. Token-correct, but a legibility
  question for design to revisit.
- **The select tool's blank-click table entry is not consulted by the pane.** The
  pure intent table in `canvas-tools.ts` lists "clear selection" for a blank click in
  Select, but the pane leaves that gesture to X6, which already clears the selection.
- **Arrow hint.** §5 says a blank drag in Arrow shows "Start on a shape". What shipped is
  the generic toolbar hint "Drag from one shape to another", which hides after the first
  successful arrow.

## Implementation notes (U3)

What shipped in U3 (node styles and the properties panel) where this spec is silent, or
disagrees with itself or the code. The rules above are unchanged. Each call was checked in
the built app (a 31-row live matrix, rows cited below; see the PR).

1. **`props.style`, not `props.tone`.** §7.1's table names flat keys (`props.tone`,
   `props.stroke`, ...); §7.5 says one nested `props.style`. U3 follows §7.5, the later and
   reasoned rule: it survives `update_node`'s whole-object `props` replace.
2. **Text tone.** §7.2's Label column is `--text` for four of the six tones, so a coloured
   text node would not change colour under "label colour only" (§7.6). A text node's label
   takes the Stroke column instead; `default` keeps `--text-2`, `muted` is `--text-3`.
3. **Edges in the selection.** §7.4 says "controls that apply to every selected element".
   Edges take nothing until U5, so read literally every rubberband that caught an arrow
   would hide the panel. U3 ignores selected edges; an edge-only selection shows no panel
   (rows M3, M3b, M4b).
4. **Value spellings.** `align` is `left|center|right` (US spelling, matching CSS and SVG;
   the spec says "centre"). `fontSize` is `s|m|l|xl` = 11/12/15/20 px, with M = today's
   12 px so no existing board changes. `opacity` is the JSON numbers 25/50/75/100.
   `strokeWidth` is 1/1.5/2.5 px with regular = today's 1.5.
5. **Default equals absent.** Setting a key to `null` or to its default removes it, on both
   the verb and the pane, so a node styled and then reset is byte-identical to one never
   styled.
6. **Translucent soft fills.** The `--*-soft` tokens are 10 to 18% alpha, so the dot grid
   and an edge under a tinted node show through. The grid reads fine in both themes, but
   the live matrix (row T3) showed an edge running under a tinted node strikes through its
   label, clearly in the light theme. The opaque ground layer is therefore a recorded
   follow-up, not built in U3.
7. **Dashed versus unknown.** A user-dashed box could read as the dashed "unknown kind"
   fallback (`4 3`). Dashed is `6 4`, dotted `2 3`, and unknown kinds ignore style, so the
   fallback stays plain.
8. **Older builds.** Opening and saving a styled board in the previous release keeps every
   `props.style` byte for byte (row P1). But an older build's agent `update_node` with
   `props` still replaces the whole object and drops `props.style`; only this build's verb
   keeps it. Documented, not fixable from here.
9. **ACK scope.** The `draw_canvas` ACK gains `shapes[].style` only. It does not also start
   listing `props` keys, which it never has; that is out of U3's scope.
10. **Undo after a theme switch.** Attrs are derived from `data` and kept out of history
    through X6 History's `beforeAddCommand`, so Ctrl+Z restores the style, not stale
    colours. A theme switch also now re-selects the same ids and reopens the resize
    handles, so the panel stays open mid-edit (it used to empty the selection).

Outcomes the live matrix added:

- **`restyleCanvasNode` overlays derived attrs on the shape class's defaults.** Overwriting
  the whole attrs object dropped what the X6 shape class contributes at construction (a
  rect's `refWidth`/`refHeight`, an ellipse's radii, the label's centring), so a box
  collapsed to 0x0 after any pick, undo or redo. The derived attrs are now laid over
  `getDefaults().attrs`, and a restyled node equals a fresh render of the same style. The
  e2e asserts the body's size after each panel pick, because an attribute-only check could
  not see this.
- **Label length is an open design question.** Labels never wrap, so a long label at L or
  XL can overflow a small box (row S5: "Approve the release" at XL overflows a 132x52 box
  by 27 px each side), and "Diamond" at XL (86 px) exceeds the diamond's inscribed box
  (66 px), even centred. Wrapping, shrinking or accepting it is undecided; none of it
  changes an existing board, since M is today's size.
- **Diamond and ellipse label alignment.** A left or right label on a diamond poked past
  the slanted edge at every size, so it now aligns to the diamond's inscribed box
  (`refX` 25% / 75%). The ellipse keeps an 8 px inset, which measured inside (worst case
  0.992 of the chord at XL). `design.md` §6 says so.

## Implementation notes (U4)

What shipped in U4 (layers: bring to front, send to back, saved and agent-settable) where
this spec is silent, or disagrees with itself or the code. The rules above are unchanged.

1. **Ranks for every node once restacked.** A minimal write is not expressible: unstacked
   nodes all load at z 1 and tie by file order. After the first real restack Save writes
   `zIndex` 1..n on every node, so an agent's `zIndex: 100` becomes its rank. Order is kept,
   values are not. Adding a node to a board that already carries `zIndex` also ranks every
   node (the new node has none, so the file no longer renders in the live order). A board
   with no `zIndex` at all that is only moved, resized, renamed or restyled is saved with no
   `zIndex` added.
2. **Forward and backward step past the nearest overlapping node**, not one slot in the
   global list. Overlap is by area; boxes that only touch do not overlap.
3. **Arrows are not layered.** Edges stay at 0, nodes at `>= 1`, so arrows always draw under
   shapes.
4. **The agent's `zIndex` is an integer `>= 1`** (`null` removes it on `update_node`),
   stricter than the reader, so the verb refuses what the pane would never write.
5. **Visibility widens.** The panel shows Layers alone for any node selection (a card alone,
   `Ctrl+A`, a box plus a card); style groups still follow the shared-keys rule. Two U3 tests
   changed on purpose.
6. **Older builds and new shapes.** An older Harnu opens a restacked board with the same
   order, but a shape drawn there has no `zIndex`, loads at 1 and reappears near the bottom
   after reload. Not data loss. A plain move and Save here leaves it without a `zIndex` (Save
   writes ranks only when the live order differs from the order the file already renders
   in); it stays near the bottom until the operator restacks in this build, which then ranks
   every node.
7. **The edge-data fix lives in U4.** Delete, Save, undo, Save used to drop a restored
   arrow's `label`, `router` and `props`. U5 is reader-first, so the fix ships before it.
8. **No keyboard shortcuts for layers.** The panel only; `Ctrl+]` and `Ctrl+[` are left for a
   follow-up.
9. **The pane renders with distinct z values it never saves.** Unstacked nodes tie at z 1 and
   X6 breaks ties by collection order, so undoing a restack would restore numbers but not
   order. Rendering ranks fixes that without touching the file, because Save compares orders,
   not values.

Implementation rulings:

- **`renderStackZ`** returns the file's z verbatim only when every node has a finite z > 0
  and all are distinct; otherwise it returns dense ranks. A hand-written z <= 0 can
  therefore never draw under the arrows.
- **The theme redraw uses a `'live'` draft**, so undo and redo stay exact across a theme
  switch.
- **Warning for U5: X6 `graph.getNodes()` is insertion order, not stack order.** Use
  `getCells()` or sort by z when you need the stack.
- **The `draw_canvas` ACK has no free-text slot**, so the "arrows draw under nodes" rule is
  stated in the tool description, the refusal message and the docs rather than in the ACK.
- **The panel toggle and aria label is now "Properties"** ("Show properties"), replacing
  "Style options".
- **Pre-existing issue found by the e2e (out of scope):** `draw_canvas` writes arm the
  pane's self-write suppression, so a clean open pane never reloads the agent's write.
  Operators use the Reload button.

## Implementation notes (U5)

What shipped in U5 (arrow tone and stroke style, panel and agent) where this spec is silent,
or disagrees with itself or the code. The rules above are unchanged.

1. **No `accent` tone on arrows.** An arrow's default already is the accent line, so an
   `accent` choice would be a second identical swatch. Arrows take `default`, `green`,
   `amber`, `red`, `muted`; the agent refuses `accent` on an arrow with `BAD_PROPS` listing
   those five. A box plus an arrow offers only the intersection, so no `accent`.
2. **No stroke width on arrows.** P8 says "tone + dashed" and §8 says "tone + stroke
   style"; neither names width. Left out to stay inside the spec; cheap to add later.
3. **`dotted` is included.** Same `stroke` key, same values and same dasharrays as nodes
   (one shared table), because §8 says "stroke style", which U3 defined as solid, dashed or
   dotted.
4. **`muted` arrows use `--text-3`**, not the node `muted` stroke (`--border`), which is
   near-invisible as a 1.5 px line on `--bg` in the dark themes. Existing token, no §9
   change.
5. **Layers ignores arrows.** A box plus an arrow shows Layers acting on the box; an arrow
   alone shows no Layers. Arrows have no stacking (U4 note 3).
6. **Selected arrows show a selection box** (`showEdgeSelectionBox`). Before U5 a selected
   arrow showed nothing; once the panel edits arrows, an invisible selection is a usability
   bug. The spec was silent.
7. **The merge gate needs U4 Task 4 as well as U2.** U2's reader alone still lost edge
   `props` on delete, Save, undo, Save. The gate is a release containing both the edge-props
   reader (U2) and the arrow-data-through-the-graph fix (U4 Task 4).
8. **Row A is the accepted window.** A build older than U2's reader (Harnu 0.3.46 and
   earlier) drops arrow styles, and only those, when it saves a styled board. That is the
   window §7.3 accepted; it cannot be closed from a newer build. User docs, the CHANGELOG and
   `docs/harnu-features.md` say so plainly.

Implementation rulings:

- **Cell data is authoritative for edge `props`.** The panel writes `data.props.style`; Save,
  the theme redraw and undo all read the cell, never the base document. A reset to `default`
  deletes the key, and the arrow's `props` disappears when emptied, so the file is
  byte-identical to a never-styled arrow. Unknown style keys and values (a newer build, a
  hand edit) are kept verbatim through a pick, an agent merge, a theme redraw and a Save.
- **Arrows are a pseudo-kind (`@edge`) in the style tables.** The renderer's
  `PANE_EDGE_STYLE` mirrors the main process's `CANVAS_EDGE_STYLE`; a parity test fails if
  they drift, and the shared merge fixture runs against `update_edge`.
- **X6 2.19.2: `connection: true` lives on the `lines` selector group, not on `line`.** The
  `Edge` class defaults are `attrs.lines = { connection: true, strokeLinejoin: 'round' }`
  (shared by `line` and `wrap`) plus `wrap = { strokeWidth: 10 }`. A restyle therefore merges
  over `getDefaults().attrs` instead of replacing `attrs`, otherwise the path loses its
  geometry and the wide transparent hit path (U3's 0x0 lesson, on edges). The arrowhead
  follows the line colour and is never dashed.
- **Data-loss audit at U5 start, rows A to J.** A is open and accepted (note 8). B (delete,
  Save, undo, Save) and C (a pick or reset never reaching the file) are closed by U4 Task 4
  and pinned again here. D (theme redraw), E (agent `update_edge` without `style`), F (agent
  merge over unknown keys), G (unknown tone or stroke value) are pinned by tests. H
  (cascade, `clear`, Eraser) is intentional deletion. I (Save after the stale banner) is
  last-write-wins by design. J (a U2 to U4 build opening a styled board) is safe: arrows
  draw in accent and `props.style` round-trips.
- **Agent surface.** `add_edge` and `update_edge` accept `style` with the node merge rules
  (`mergeNodeStyle`, `null` clears a key, `{}` and non-objects are refused); the ACK gains
  `edgeStyle`, the values an arrow takes. Refusal text for a bad node style is unchanged.
- **Timing note for tests:** X6 repaints an edge line a frame after the model changes, so an
  assertion on a stroke right after undo or redo must poll.
