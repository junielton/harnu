# T536 U5 — Arrow styling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator colour an arrow and make it dashed or dotted from the properties panel, and let the agent do the same through a merging, value-checked `style` field on `draw_canvas` `add_edge` / `update_edge`, stored in `edge.props.style`, with no path on which this build loses an arrow's data, and with the one unavoidable path (builds older than U2's reader) closed off by the merge gate.

**Architecture:** Arrow style is the node model applied to edges. It lives in `edge.props.style`, the field U2's reader already preserves (spec §7.3), holding fixed enum values only (C5). The agent catalog gains one edge style table, `CANVAS_EDGE_STYLE` (`tone`, `stroke`), and `canvas-ops.ts` reuses U3's `checkStyle` / `mergeNodeStyle` against it. The renderer mirrors the table in `canvas-style.ts` under a pseudo-kind, `EDGE_STYLE_KIND`, so the existing selection math (`styleKeysFor`, `readCanvasStyle`, `panelValues`) covers arrows; it becomes **value-aware** (`sharedStyleOptions`), because an arrow's tone list has no `accent` (its default already is accent). `toX6Edge` derives the line attrs from the style; the pane re-derives them on every `cell:change:data` through a new `restyleCanvasEdge` that never enters history, exactly like U3's nodes. Save reads an arrow's `props` from its cell `data` (U4 Task 4), so a pick, a reset, a theme redraw and an undo after a Save all reach the file.

**Tech Stack:** Vue 3 + TypeScript, AntV X6 core `2.19.2` + 2.x plugins (pinned, do not upgrade), vitest + jsdom, Playwright `_electron`, lucide-vue-next 1.0.0 icons. **Depends on:** U1–U4 (U4's `CanvasPropertiesPanel` `layers` prop and `layer` event, `panelNodes`, `LAYER_BATCH`, `CanvasStackMode`, and above all U4 Task 4: an edge's `label`/`router`/`props` ride in its cell `data` and `edgeFromCell` reads `props` from there). **Merge gate:** merge only after a published release contains U2's edge-`props` reader **and** U4 Task 4 (Task 1 checks this).

**Spec:** `docs/specs/2026-10-19-t536-canvas-toolbar.md`. §3 (C1, C4, C5, C6), §7.0, §7.1 row P8, §7.3, §7.4, §7.5, §8 row U5, §9.3 item 9, §9.4, §9.5, and "Implementation notes (U3)" items 3, 5, 7.

## Global Constraints

- Everything in U1–U4's Global Constraints still holds (no new npm dependency, no X6 upgrade, tokens only, `$t()` with keys in **both** locales, English everywhere outside i18n files, design.md first).
- **No schema version bump, and `src/main/canvas-core.ts` is not modified.** Edge `props` are already read, validated as plain JSON and written by `orderedEdge` (U2). Every compatibility test runs against that reader.
- **Style only in `edge.props.style`** (spec §7.3, §7.5). No new top-level edge key. Other keys an edge's `props` may carry (a hand edit, a newer build) are kept verbatim by every path.
- **Keys:** `tone` and `stroke` only (P8 "tone + dashed"; §8 U5 "tone + stroke style"). No `strokeWidth` on arrows (Open point 2).
- **Tone names only** (C5). Every colour comes from `CanvasPalette`. **No new §9 token.**
- **Agent parity (C6):** every key and value the panel can put on an arrow is in `CANVAS_EDGE_STYLE` and the ACK's `edgeStyle` in the same PR; `docs/harnu-features.md` updated and its marker bumped (`v98` after U4, so `v99` unless main has moved; take the next number at rebase); `docs/user/agent-control.md` updated. Both CI gates are satisfied, not labelled away.
- **Stop rule (§7.0, §7.3).** P8 is all of U5's user-facing change. If Task 1 finds a data-loss path not in the audit below, or a test in Tasks 3–6 that protects an existing arrow cannot be made green, U5 drops P8: no catalog entry, no panel controls, no docs; the PR carries only what is already safe (tests), and the finding goes into the PR and the spec's implementation notes.
- `CHANGELOG.md` entry in this PR.
- **Environment.** Every Electron run (Playwright e2e, the live second instance, the previous-release AppImage) runs under `env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE`, **one instance at a time**. The `local-ci` skill runs with `HARNU_SPAWN_TOKEN` unset (`env -u HARNU_SPAWN_TOKEN`).
- Before pushing: `npm run typecheck`, `npm run build`, and the `local-ci` skill.

## Data-loss audit (spec §7.3: "if U5 finds any other way an existing board could lose data, P8 is dropped")

Every path that reads, rebuilds or writes an edge, checked against U3's head (`199b001`) plus U4. Task 1 re-runs it against the branch as it is when U5 starts.

| #   | Path                                                                                                                                                                                                              | Status                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | A build **without** U2's reader (0.3.46 and earlier today) opens and Saves the board, or its `draw_canvas` writes it: every edge `props` is dropped                                                               | **Open, by construction.** Not fixable from a newer build. This is the window §7.3 / C4 accepts; the merge gate keeps it to people who have not updated for a full release. Documented. |
| B   | Delete an arrow (or a node it touches), Save, ⌘Z, Save: the arrow is written without `props`, `label`, `router` (base document no longer has it; Save keeps history; the watcher suppresses the pane's own write) | **Closed by U4 Task 4** in every build that has it. Open in a build with U2 but not U4 Task 4, hence the merge gate names U4 Task 4 too.                                                |
| C   | Pane Save takes edge `props` from the base document: a pick never reaches the file; a reset to default is resurrected                                                                                             | **Closed by U4 Task 4** (`data` is authoritative, no base fallback). Pinned again here (Task 4).                                                                                        |
| D   | Theme switch redraws from the draft                                                                                                                                                                               | Safe once C is closed: the draft reads `data`. Pinned (Task 6).                                                                                                                         |
| E   | Agent `update_edge` without `style` (label / router change)                                                                                                                                                       | Safe: the op spreads the existing edge. Pinned (Task 3).                                                                                                                                |
| F   | Agent `style` merge over unknown style keys or other `props` keys                                                                                                                                                 | Safe: `mergeNodeStyle` keeps both. Pinned (Task 3).                                                                                                                                     |
| G   | Renderer meets an unknown tone / stroke value or a non-object `style`                                                                                                                                             | Safe: draws the default and never writes; Save writes `data.props` verbatim. Pinned (Task 4).                                                                                           |
| H   | `remove_node` cascade, `clear`, Eraser, Delete                                                                                                                                                                    | Intentional deletion, not loss.                                                                                                                                                         |
| I   | Save after the stale banner (§7.3 case C, last write wins)                                                                                                                                                        | By design for every field, warned by the banner. Not P8-specific.                                                                                                                       |
| J   | A U2–U4 build (reader, no U5) opens a styled board                                                                                                                                                                | Safe: arrows draw in accent, `props.style` round-trips (pinned in U2), its agent `update_edge` keeps it.                                                                                |

**Verdict for the plan:** with B and C closed by U4 Task 4 and the gate holding, A is the only open path, and it is the one §7.3 accepted in advance. P8 ships. If the gate cannot be met (no release with U2 + U4 Task 4), the PR stays draft; it does not merge with B open.

## Review Focus

The five failure modes most likely to bite a user that no existing test covers. Each has a test in its owning task.

1. **A pick, or a reset, never reaches the file.** If anything still reads edge `props` from the base document, the panel paints the arrow green and Save writes the old style; a reset to `default` comes back after Save. Test in Task 4 (pure) and Task 6 (pane).
2. **A restyle makes the arrow vanish or unclickable.** Overwriting an edge's attrs drops what the X6 `edge` class contributes (`line.connection`, the wide transparent `wrap` hit path): U3's 0×0 lesson, on edges. Test in Task 4 (attrs merged over `Edge` defaults) and Task 7 (the path's `d` is non-empty and a click still selects it after a pick and an undo).
3. **A mixed selection writes what one side cannot take.** Box + arrow must offer only `tone` (without `accent`) and `stroke`; a pick must never put `accent` or `strokeWidth` on an arrow, `corners` on anything else, or anything on a mockup card. Test in Task 5 (panel) and Task 6 (pane).
4. **An arrow loses data it did not show.** Other `props` keys, unknown style keys and unknown values (a newer build, a hand edit) must survive a pick, an agent `style` merge, a theme redraw and a Save. Test in Tasks 3, 4 and 6.
5. **Theme switch and undo.** An unsaved arrow style must survive a theme switch, ⌘Z after the switch must paint the new theme's colour, and the arrowhead must follow the line's colour and never be dashed. Test in Task 4 (marker attrs) and Task 6.

---

### Task 1: Preflight — the merge gate and the audit

**Files:**

- Read only: `git log` / `git tag --contains` on main, the GitHub releases list (`gh release list`, `gh release view <tag>`), `src/renderer/src/components/canvas/canvas-edit.ts`, `canvas-cells.ts`, `canvas-graph.ts`, `DiagramPane.vue`, `src/main/mcp/canvas-ops.ts`
- Output: a "Gate and audit" section in the PR description draft

**Interfaces:**

- Consumes: the Data-loss audit table above.
- [ ] **Step 1: Gate.** Find the merge commits of U2 and of U4 Task 4 on main and the first release tag containing both (`git tag --contains <sha>`). Record the tag, or "none yet".
- [ ] **Step 2: Audit.** `grep -n` every place that builds or rewrites an edge: `edgeFromCell`, `toX6Edge`, `operatorEdgeSpec`, every `currentDraft(` caller, `applyCanvasOps` `add_edge` / `update_edge` / `remove_*` / `clear`, `validateCanvasDocument` / `orderedEdge`. Confirm each row A–J still holds. A path not in the table is a stop-rule finding (Global Constraints).
- [ ] **Step 3: Record** both in the PR draft. With "none yet" for the gate, continue; the PR opens as draft and says "merge only after a release containing U2 and U4 Task 4" (Task 8).

---

### Task 2: Design contract first

**Files:**

- Modify: `design.md` §6 "Diagram pane": a new **"Arrow styles (T536 U5)"** block after "Node styles", the "Properties panel" block's Visibility and Option-glyph bullets, the "Node and edge treatment" edge rows
- Modify: `CLAUDE.md` file-map row for the properties panel only if its wording names "nodes" (it should say "selected shapes and arrows")

**Interfaces:**

- Produces, written into `design.md` exactly:

| Key      | Values (file spelling)                  | Default   | Renders as                                         |
| -------- | --------------------------------------- | --------- | -------------------------------------------------- |
| `tone`   | `default` `green` `amber` `red` `muted` | `default` | line and arrowhead colour, table below             |
| `stroke` | `solid` `dashed` `dotted`               | `solid`   | `strokeDasharray`: none / `6 4` / `2 3` (as nodes) |

Arrow tone → token: `default` `--accent` (today's arrow, so no existing board changes), `green` `--green`, `amber` `--warning`, `red` `--red`, `muted` `--text-3` (the node `muted` stroke, `--border`, is near-invisible as a 1.5px line on `--bg` in the dark themes). No `accent` value: it would draw exactly like `default`. Width stays 1.5px. The arrowhead takes the line's colour and is never dashed. The label stays `--text-3` on its `--bg` plate whatever the tone.

- **Panel.** Arrows join the selection math: the panel shows the keys **and values** every selected element takes. Arrow only: Color (5) and Stroke. Box + arrow: Color without `accent`, Stroke. Box + arrow + mockup card: no style group (Layers only, from U4). Layers act on the selected shapes only; an arrow-only selection shows no Layers. With only arrows selected, the Color options are 16px line glyphs in the tone's text utility (`text-accent`, `text-green`, `text-warning`, `text-red`, `text-text-3`) instead of fill swatches.
- **Selected arrow.** Shown with X6's edge selection box (`showEdgeSelectionBox`), the same treatment as a selected node, so a click on an arrow visibly selects it.
- Treatment rows: `styled arrow (U5)` — keys of "Arrow styles"; an arrow with none renders as today.
- [ ] **Step 1: Edit `design.md`.** No code.
- [ ] **Step 2: Commit** `docs(design): arrow styles contract (T536 U5)`

---

### Task 3: Agent catalog — `style` on `add_edge` / `update_edge`

**Files:**

- Modify: `src/main/mcp/canvas-shapes.ts` (`CANVAS_EDGE_STYLE`)
- Modify: `src/main/mcp/canvas-ops.ts` (`OP_KEYS` ~308-310, `checkStyle` ~386, `add_edge` ~548, `update_edge` ~640, `canvasEdgeStyleAck`)
- Modify: `src/main/mcp/tool-handlers.ts` (~1700: the ACK gains `edgeStyle`)
- Modify: `src/main/mcp/tool-catalog.ts` (`draw_canvas` description and `ops` describe string ~930-948)
- Modify: `docs/harnu-features.md` ("Ops, not a redraw", "Shape names come from the ACK", "Style a node with `style`" → "…a node or an arrow"; marker bump), `docs/user/agent-control.md`
- Test: `tests/mcp-canvas-ops.test.ts`, `tests/mcp-draw-canvas-handler.test.ts`

**Interfaces:**

- Produces in `canvas-shapes.ts`:
  ```ts
  export const CANVAS_EDGE_STYLE: Readonly<
    Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>
  >
  //   { tone: ['default','green','amber','red','muted'], stroke: CANVAS_STYLE_VALUES.stroke }
  ```
- Produces in `canvas-ops.ts`:
  ```ts
  function checkStyle(
    table: Readonly<Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>>,
    owner: string, // 'shape "box"' or 'an edge' — names the owner in a refusal
    style: unknown,
    at: string
  ): { style: Record<string, CanvasStyleValue | null> } | CanvasVerbErr
  export function canvasEdgeStyleAck(): Record<string, readonly CanvasStyleValue[]>
  ```
  The node callers pass `spec.style` and `shape "${spec.name}"`, so every existing node refusal text is unchanged. `OP_KEYS.add_edge` and `.update_edge` gain `'style'`; `update_edge`'s "at least one field" list gains `'style'`. `add_edge` with `style` → `props = mergeNodeStyle(undefined, patch)` (omitted when empty). `update_edge` with `style` → `mergeNodeStyle(edge.props, patch)`, assigned in place so an existing `props` keeps its key position and is deleted only if the merge emptied it. `mergeNodeStyle` is reused unchanged (it only touches `props.style`; edge and node defaults agree: `tone` `default`, `stroke` `solid`). The ACK gains a top-level `edgeStyle: canvasEdgeStyleAck()`.
- [ ] **Step 1: Write failing tests** in `tests/mcp-canvas-ops.test.ts`, new `describe('T536 U5 — edge style')`:
  - `add_edge` with `style: { tone: 'green', stroke: 'dashed' }` → the edge's `props` is exactly `{ style: { tone: 'green', stroke: 'dashed' } }`, stamped `agent`.
  - `style: { tone: 'accent' }` → `BAD_PROPS` listing the five edge tones; `{ strokeWidth: 'bold' }` → `BAD_PROPS` containing "an edge does not take style key" and "it takes tone, stroke"; `{ stroke: 'wavy' }` → `BAD_PROPS`; `{}` → `BAD_ARGS`; `'red'` → `BAD_PROPS`; no `doc` on any refusal.
  - `update_edge` with only `style: { stroke: 'dotted' }` on `props: { style: { tone: 'red' }, weight: 2 }` → `{ style: { tone: 'red', stroke: 'dotted' }, weight: 2 }` (style alone counts as a change; other props kept: Review Focus 4).
  - `update_edge` `style: { tone: null }` on `{ style: { tone: 'red' } }` → no `props`; `style: { tone: 'default' }` on `{ style: { tone: 'red' }, weight: 2 }` → `{ weight: 2 }`.
  - `update_edge` `style: { tone: 'amber' }` on a file style `{ glow: 1, tone: 'red' }` → `{ glow: 1, tone: 'amber' }`.
  - `update_edge { id, label: 'x' }` on a styled edge keeps `props` byte-equal (audit row E).
  - the node refusal message for `ellipse` `corners` is unchanged (regression).
  - `canvasEdgeStyleAck()` deep-equals `CANVAS_EDGE_STYLE`; every edge value is a member of `CANVAS_STYLE_VALUES[key]` and every default is in its list.
    In `tests/mcp-draw-canvas-handler.test.ts`: a real handler call's ACK carries `edgeStyle`, and `update_edge` with `style` writes the merged style to disk.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/mcp-canvas-ops.test.ts tests/mcp-draw-canvas-handler.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `tool-catalog.ts`: `add_edge{source,target,label?,router?,style?}`, `update_edge{id, any of label,router,style}`, and "arrows take `style` too (tone, stroke); their allowed values are in the ACK's `edgeStyle`".
- [ ] **Step 4: Docs.** `docs/harnu-features.md`: `style?` on both edge ops; the ACK paragraph lists `edgeStyle`; the style paragraph says arrows take `tone` (no `accent`: their default is accent) and `stroke`, same merge rules; and one sentence that a Harnu build older than the edge reader drops arrow styles when it saves, so do not rely on them on a board shared with old builds. Bump the marker. `docs/user/agent-control.md`: a session can colour and dash the arrows it draws.
- [ ] **Step 5: Run to verify they pass**, plus `npx vitest run tests/mcp-` and `node scripts/ci/awareness-gate.mjs` if it runs locally.
- [ ] **Step 6: Commit** `feat(mcp): draw_canvas styles arrows with a merging, value-checked style field (T536 U5)`

---

### Task 4: Render arrow styles, mirror the table, pin parity and compatibility

**Files:**

- Modify: `src/renderer/src/components/canvas/canvas-style.ts`
- Modify: `src/renderer/src/components/canvas/canvas-cells.ts` (`toX6Edge`)
- Modify: `src/renderer/src/components/canvas/canvas-graph.ts` (`restyleCanvasEdge`; Selection `showEdgeSelectionBox: true`)
- Test: `tests/canvas-style.test.ts`, `tests/canvas-style-parity.test.ts`, `tests/canvas-cells.test.ts`, `tests/canvas-edit-save.test.ts`, `tests/canvas-core.test.ts`, `tests/canvas-edit.test.ts`

**Interfaces:**

- Produces in `canvas-style.ts`:
  ```ts
  /** Pseudo-kind for an arrow in the selection math. Never a document shape name. */
  export const EDGE_STYLE_KIND = '@edge'
  export const PANE_EDGE_STYLE: Readonly<
    Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>
  > // mirror of main
  export type StyleOptions = Partial<Record<CanvasStyleKey, readonly CanvasStyleValue[]>>
  export function styleOptionsFor(kind: string): Readonly<StyleOptions> // edges → PANE_EDGE_STYLE; shapes → their keys with CANVAS_STYLE_VALUES; unknown → {}
  export function sharedStyleOptions(kinds: readonly string[]): StyleOptions // CANVAS_STYLE_KEYS order; values = intersection; a key with none left is dropped
  export function edgeToneStroke(tone: CanvasStyleValue | undefined, palette: CanvasPalette): string
  export function edgeLineAttrs(props: unknown, palette: CanvasPalette): Record<string, unknown>
  ```
  Changed, same signatures: `styleKeysFor(kind)` = `Object.keys(styleOptionsFor(kind))`; `readCanvasStyle(props, kind)` checks each value against `styleOptionsFor(kind)` (so `accent` on an arrow reads as unset); `sharedStyleKeys(kinds)` = keys of `sharedStyleOptions(kinds)`; `panelValues` accepts `EDGE_STYLE_KIND` entries.
- `toX6Edge`: `attrs.line` = `edgeLineAttrs(edge.props, palette)` (stroke from `edgeToneStroke`, `strokeWidth` 1.5, `strokeDasharray` only when not solid, the `block` target marker without dasharray). `data` as U4 Task 4 left it.
- Produces in `canvas-graph.ts`:
  ```ts
  export function restyleCanvasEdge(edge: Edge, palette: CanvasPalette): void
  //   attrs = merge({}, Edge class defaults .attrs, { line: edgeLineAttrs(data.props, palette) })
  //   edge.setAttrs(attrs, { overwrite: true, dirty: true, [CANVAS_DERIVED_CHANGE]: true })
  ```
- [ ] **Step 1: Write failing tests.**
      `tests/canvas-style.test.ts`: `styleOptionsFor(EDGE_STYLE_KIND)` equals `{ tone: [5 tones], stroke: [3] }`; `sharedStyleOptions(['box', EDGE_STYLE_KIND])` → `{ tone: ['default','green','amber','red','muted'], stroke: ['solid','dashed','dotted'] }` (**Review Focus 3**); `sharedStyleOptions(['text', EDGE_STYLE_KIND])` → `{ tone: [5] }`; `sharedStyleOptions(['harnu/mockup-card', EDGE_STYLE_KIND])` → `{}`; `sharedStyleOptions([])` → `{}`; `readCanvasStyle({ style: { tone: 'accent', stroke: 'dashed' } }, EDGE_STYLE_KIND)` → `{ stroke: 'dashed' }`; `panelValues` over an edge `{ tone: 'red' }` and a box `{ tone: 'red' }` → `tone: 'red'`, over an unstyled edge → `tone: 'default'`; `edgeToneStroke(undefined, p)` and `('default', p)` → `p.accent`; `('muted', p)` → `p.text3`; `('purple', p)` → `p.accent`. Existing U3 assertions on nodes unchanged.
      `tests/canvas-cells.test.ts`, new `describe('toX6Edge — arrow styles (T536 U5)')`: an unstyled edge's attrs deep-equal U4's (regression); `tone: 'green'` → `line.stroke === p.green`; `stroke: 'dashed'` → `'6 4'`, `'dotted'` → `'2 3'`, solid → no `strokeDasharray` key; the target marker has no `strokeDasharray`; **Review Focus 4:** `props: { style: { tone: 'purple', stroke: 40 }, weight: 2 }` and `props: { style: 'red' }` render attrs deep-equal to the unstyled edge, and `data.props` keeps them verbatim; the same styled edge under two palettes gives each palette's green.
      `tests/canvas-edit.test.ts` (**Review Focus 2**): on an editable graph, `restyleCanvasEdge` after a `setData` to `tone: 'red'` leaves `line.connection === true`, the `wrap` attrs equal the class defaults, `line.stroke === p.red`; after a reset to solid the rendered path has no `stroke-dasharray`; the History keeps the `setData` and drops the restyle; `getSelectedCells` can include a clicked edge with the selection box shown (`showEdgeSelectionBox`).
      `tests/canvas-style-parity.test.ts`: renderer `PANE_EDGE_STYLE` deep-equals main's `CANVAS_EDGE_STYLE`; `EDGE_STYLE_KIND` is not a name in `CANVAS_SHAPE_CATALOG` or `LEGACY_CANVAS_SHAPE_NAMES`; the merge fixture table run through `mergeCanvasStyle` and through `applyCanvasOps` `update_edge` `style` gives the same edge `props`.
      `tests/canvas-edit-save.test.ts`, new `describe('arrow styles survive a pane Save (T536 U5)')`, cells from a real graph: an arrow `setData` to `tone: 'green'` → the draft's edge `props` is `{ style: { tone: 'green' } }` (**Review Focus 1**); a styled arrow reset to default (props removed from `data`) → no `props` key; an unrelated node move → every edge `props` (with unknown keys and values) written back unchanged.
      `tests/canvas-core.test.ts`: a document whose edges carry `props.style` (one unknown value, one unknown key, one extra props key) parses and serializes byte for byte (the U2 reader, unmodified).
- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/canvas-style.test.ts tests/canvas-style-parity.test.ts tests/canvas-cells.test.ts tests/canvas-edit.test.ts tests/canvas-edit-save.test.ts tests/canvas-core.test.ts` → FAIL (the canvas-core test may already pass; keep it).
- [ ] **Step 3: Implement** the interfaces above. Update the `canvas-style.ts` header: arrows are a pseudo-kind; why their tone list has no `accent`.
- [ ] **Step 4: Run to verify they pass**, plus `npx vitest run tests/canvas-` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(canvas): render arrow tone and stroke from props.style and pin the arrow table to the agent catalog (T536 U5)`

---

### Task 5: The panel learns per-key options and arrow glyphs

**Files:**

- Modify: `src/renderer/src/components/CanvasPropertiesPanel.vue`
- Modify: `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json` only if a key is added (none is expected: the group and value labels exist since U3)
- Test: `tests/canvas-properties-panel.test.ts`

**Interfaces:**

- Produces:
  ```vue
  <CanvasPropertiesPanel
    :keys
    :options
    :values
    :edge-only
    :collapsed
    :open
    :layers
    @change
    @layer
    @toggle
  />
  ```
  `options: StyleOptions` (values per key; a key absent from `options` falls back to `CANVAS_STYLE_VALUES[key]`, so U3/U4 callers keep working), `edgeOnly: boolean`. With `edgeOnly`, tone options render a 16px line glyph (`data-testid="canvas-prop-glyph"`) in `TONE_LINE[value]` (`text-accent`, `text-green`, `text-warning`, `text-red`, `text-text-3`) instead of a fill swatch.
- [ ] **Step 1: Write failing tests:** `options: { tone: ['default','green','amber','red','muted'] }` renders five tone options and no `canvas-prop-tone-accent` (**Review Focus 3**); with no `options` the six U3 tones render (regression); `edgeOnly: true` → each tone option holds a line glyph with the tone's text class and no `canvas-prop-swatch`; `edgeOnly: false` → swatches as U3; `layers: false, keys: ['tone','stroke']` → no `canvas-layers`; no option carries an inline colour `style`.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/canvas-properties-panel.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `npm run typecheck:web` catches a missing pt-BR key if one was added.
- [ ] **Step 4: Run to verify they pass.**
- [ ] **Step 5: Commit** `feat(canvas): properties panel offers per-key options and arrow colour glyphs (T536 U5)`

---

### Task 6: Wire arrow styles into `DiagramPane.vue`

**Files:**

- Modify: `src/renderer/src/components/DiagramPane.vue` (`cell:change:data` handler ~337, `panelNodes` ~457 → `panelCells`, `panelKeys`, `panelStyleValues`, `panelVisible`, `applyStylePatch` ~503, the panel mount ~2207)
- Test: `tests/canvas-pane-edge-style.test.ts` (new, on `tests/helpers/canvas-pane-harness.ts`), `tests/canvas-pane-style.test.ts` (the "edges are ignored" cases that change on purpose)

**Interfaces:**

- Pane:
  ```ts
  function cellKind(cell: Cell): string // nodeKind for a node, EDGE_STYLE_KIND for an edge
  const panelCells: ComputedRef<Cell[]> // selected nodes AND edges
  const panelNodes: ComputedRef<Node[]> // unchanged meaning: nodes only (Layers)
  const panelOptions: ComputedRef<StyleOptions> // sharedStyleOptions(panelCells.map(cellKind))
  const panelKeys: ComputedRef<CanvasStyleKey[]> // keys of panelOptions
  const panelEdgeOnly: ComputedRef<boolean> // panelCells non-empty and all edges
  function applyStylePatch(patch: CanvasStylePatch): void // same name, now over panelCells
  ```
  `applyStylePatch` keeps, per cell, only the patch keys **and values** `styleOptionsFor(cellKind(cell))` allows, merges with `mergeCanvasStyle`, skips unchanged cells, and writes every change in the one `STYLE_BATCH`. `cell:change:data` calls `restyleCanvasEdge` for an edge. `panelVisible` = ready ∧ chosen tool Select ∧ (`panelKeys.length > 0` ∨ `panelNodes.length > 0`). `layers` = `panelNodes.length > 0`.
- [ ] **Step 1: Write failing tests** in `tests/canvas-pane-edge-style.test.ts` (seed: boxes `n-a`, `n-b`, mockup card `n-m`, agent edge `e-1` `n-a → n-b` with `props: { weight: 2 }`, operator edge `e-2` `n-b → n-a`; palette CSS variables set on `document.documentElement`):
  - select `e-1` alone → panel with Color (five options, line glyphs) and Stroke, no Layers.
  - click `canvas-prop-tone-red` → dirty; `e-1` line stroke in the DOM equals the red variable and its arrowhead fill too; Save → `e-1.props` is `{ weight: 2, style: { tone: 'red' } }` (**Review Focus 1, 4**).
  - click `canvas-prop-tone-default` → Save → `e-1.props` is `{ weight: 2 }` (reset is written, not resurrected).
  - select `e-1` + `e-2`, click `canvas-prop-stroke-dashed`, one `ctrl+z` → Save shows neither dashed; `ctrl+y` → both.
  - **Review Focus 3:** select `n-a` + `e-1` → Color without `accent`, Stroke, Layers; no `canvas-prop-strokeWidth-*`, no `canvas-prop-corners-*`; click `tone-green` → Save: both green; `ctrl+a` (boxes, card, edges) → no style group, Layers shown; click `back` → the edges' z still `0`.
  - **Review Focus 5:** `e-1` tone green; switch theme (new CSS variable values) → `e-1` stroke equals the **new** green, the pane stays dirty, the pick survives a Save; `ctrl+z` → `e-1` stroke equals the new theme's accent; `ctrl+y` → the new green; the redo stack survived.
  - **Review Focus 2:** after a pick and after its undo, `e-1`'s `path` has a non-empty `d` and a `mousedown`+`mouseup` on its midpoint still selects it.
  - delete `e-1`, Save, `ctrl+z`, Save → `e-1` saved with its style and `weight` (audit row B, in this build).
  - a mousedown on a panel option keeps the edge selection (no `selection:changed` to empty).
    `tests/canvas-pane-style.test.ts`: update **on purpose** the U3 cases "edge alone selected → no panel" and "the edge has no `props` after a node pick" to the U5 behaviour, with a comment citing U5.
- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/canvas-pane-edge-style.test.ts tests/canvas-pane-style.test.ts` → FAIL.
- [ ] **Step 3: Implement** the interfaces and behaviour above.
- [ ] **Step 4: Run to verify they pass**, then `npx vitest run tests/canvas-` and `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(canvas): properties panel styles selected arrows, one undo step per change (T536 U5)`

---

### Task 7: End-to-end in the built app

**Files:**

- Modify: `tests/e2e/ci/canvas-tools.spec.ts` (spec §9.3 item 9, arrow half)
- Test: itself

**Interfaces:**

- Consumes: Task 5–6 `data-testid`s, `openSeededBoard`, `saveAndRead`, `selectedIds`, the `mcp` client. New local helpers `edgeStroke(id): Promise<string | null>` (the `line` path's `stroke` attribute), `edgePathD(id): Promise<string>`, `edgeMidpoint(id): Promise<{ x: number; y: number }>`.

- [ ] **Step 1: Add `test.step('11. Arrow styles: panel and agent', …)`**:
  - the agent seeds edge `A → B` with `add_edge { style: { tone: 'amber' } }` → `edgeStroke` equals `--color-warning`.
  - click the edge's midpoint in Select → `selectedIds()` is that edge; the panel shows `canvas-prop-group-tone` and `-stroke`, no `canvas-layers`, no `canvas-prop-tone-accent`.
  - click `stroke-dotted`, then `tone-red` → `saveAndRead()` edge `props.style` deep-equals `{ tone: 'red', stroke: 'dotted' }`; `edgePathD` non-empty; `edgeStroke` equals `--color-red`.
  - `ctrl+z` once, Save → `{ tone: 'amber', stroke: 'dotted' }`.
  - agent `update_edge { id, style: { stroke: null } }` with the pane clean → file has `{ tone: 'amber' }`, the reloaded pane draws it solid.
  - agent `update_edge { id, style: { tone: 'accent' } }` → `BAD_PROPS`, file unchanged.
  - shift+click box A with the edge selected → groups tone and stroke only, Layers present.
- [ ] **Step 2: Build and run.** `npm run build && env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE npx playwright test --project=ci tests/e2e/ci/canvas-tools.spec.ts` → PASS. A failure the vitest suite missed is a code bug; fix the code, not the test.
- [ ] **Step 3: Commit** `test(canvas): e2e styles an arrow from the panel and the agent (T536 U5)`

---

### Task 8: Live matrix, docs, PR gate, and landing the plan

**Files:**

- Create: `docs/plans/2026-10-19-t536-u5-arrow-styling.md` (this plan)
- Modify: `docs/user/canvas.md` ("Styling shapes" becomes "Styling shapes and arrows"; "What is not built yet" loses "Arrows cannot be styled"; "Saving" says arrow styles need Harnu `<gate release>` or newer to survive a save), `CHANGELOG.md`, `docs/specs/2026-10-19-t536-canvas-toolbar.md` ("Implementation notes (U5)")
- Output: `/home/junielton/Workspace/jnieltn/harnu/.harnu/out/visual/T536/U5/` (the MAIN checkout's `.harnu/out`, not the worktree's): one screenshot per row and `matrix.md`

- [ ] **Step 1: Live matrix** per `docs/dev/live-verify-second-instance.md`, one isolated instance at a time, under `env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE`, on a board with three boxes, a mockup card, and four arrows (one with a label). Rows:
  - five tones × three strokes on arrows, in **dark and light** (one grid per theme); `muted` legible in both; arrowhead colour follows, never dashed; label unchanged;
  - a selected arrow is visibly selected; a click on a dashed or dotted arrow still hits it;
  - mixed selections: arrow only, box + arrow (no `accent`), box + arrow + card (Layers only), rubberband over everything;
  - theme switch with styled arrows, then ⌘Z / ⌘Y (Review Focus 5);
  - reset to default → `git diff` shows the arrow's `props` gone, byte-identical to never styled;
  - delete a styled arrow, Save, ⌘Z, Save → style kept (audit B);
  - agent `style` on `add_edge` / `update_edge`, then an operator pick and Save, then an agent `label` change (style kept);
  - pane at 320px (collapsed palette), ~243px split, maximized;
  - **the gate release** (the first release with U2 + U4 Task 4, own `--user-data-dir`): open the styled board, arrows draw in accent, move a node, Save, reopen in this build → every arrow `props.style` intact (audit J);
  - **a pre-reader release** (0.3.46 or the last one before U2): open and Save the same board → record that arrow styles are dropped. This is audit row A, the documented window, recorded as expected, not as a failure.
    Record each row pass or fail in `matrix.md`.
- [ ] **Step 2: Fix any failing row**, re-run it, update `matrix.md`. A row that shows an arrow losing data on a path outside row A triggers the stop rule.
- [ ] **Step 3: Docs.** `docs/user/canvas.md` in plain English: select an arrow (or arrows with shapes), pick a colour and a line style; arrows have no "accent" choice because that is already their default; one change is one undo step; colours follow the theme; a session can do the same; and plainly, an older Harnu that saves the board drops arrow colours (name the release). `CHANGELOG.md` `### Added`: arrow colour and dashed/dotted lines in the properties panel; agents can style arrows with `draw_canvas`'s `style` field. Copy this plan to `docs/plans/2026-10-19-t536-u5-arrow-styling.md`. Add the spec's "Implementation notes (U5)".
- [ ] **Step 4: PR body.** Include the Gate and audit section from Task 1, the matrix link, and verbatim: **"Merge only after a release containing U2 (edge-props reader) and U4 Task 4 (arrow data through the graph) has shipped."** Open as draft while that release does not exist.
- [ ] **Step 5: Gates.** `npm run typecheck && npm run build`, then `env -u HARNU_SPAWN_TOKEN` + the `local-ci` skill → all green.
- [ ] **Step 6: Commit** `docs(canvas): arrow style user docs, changelog, plan and spec notes (T536 U5)`

---

## Open points

Decisions this plan makes where the spec is silent or disagrees with itself or the code. Each becomes an "Implementation notes (U5)" entry in the spec if the PR keeps it.

1. **No `accent` tone on arrows.** An arrow's default already is `--accent`; keeping `accent` would give the panel two identical swatches. The arrow tone list is the other five, so selection math becomes value-aware (intersection), and box + arrow offers no `accent`.
2. **No stroke width on arrows.** P8 says "tone + dashed", §8 U5 says "tone + stroke style"; neither names width. Cheap to add later; left out to keep U5 inside the spec.
3. **`dotted` is included.** P8 says "dashed"; §8 says "stroke style", which U3 defined as solid / dashed / dotted. Same key, same values, same dasharrays as nodes.
4. **Muted arrows use `--text-3`, not the node `muted` stroke `--border`**, which is near-invisible as a 1.5px line on `--bg` in the dark themes (e.g. `#302a25` on `#17120e`). Existing token, no §9 change.
5. **Layers ignores arrows.** A box + arrow selection shows Layers acting on the box; an arrow-only selection shows none. Arrows have no stacking (U4 Open point 3).
6. **Arrows are visibly selectable** (`showEdgeSelectionBox`). Today a selected arrow shows nothing; once the panel edits arrows, an invisible selection is a usability bug. Spec silent.
7. **The reader-first premise needed U4 Task 4.** U2's reader alone still loses edge `props` on delete → Save → undo → Save. The merge gate therefore names U4 Task 4 too. If Task 4 moved into U2 before U2 merged, the gate is simply "a release containing U2".
8. **Row A is not "another way".** Builds older than U2's reader drop arrow styles on save; that is the window §7.3 accepted. Every other path is closed or pinned, so P8 ships. If the operator reads §7.3 as "no loss path at all", P8 cannot ship under any plan, because row A can never be closed from a newer build.
