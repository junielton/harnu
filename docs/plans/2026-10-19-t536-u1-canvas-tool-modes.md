# T536 U1 — Canvas tool modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the canvas pane an Excalidraw-style toolbar with Select as the default tool, so a first click on the board never creates anything.

**Architecture:** A new pure module `canvas-tools.ts` owns tool state, transitions, the key map and the gesture-intent table, with no X6 or Vue import. A new `CanvasToolbar.vue` renders it. `DiagramPane.vue` holds one tool state per pane and routes X6 blank/node mouse events through the intent table. Hand panning is done by the pane itself through `graph.translate()`, not by toggling X6's panning options at runtime.

**Tech Stack:** Vue 3 + TypeScript, AntV X6 core `2.19.2` + 2.x plugins (pinned, do not upgrade), vitest + jsdom, Playwright `_electron`, lucide-vue-next icons.

**Spec:** `.harnu/out/specs/2026-10-19-t536-canvas-toolbar-design.md` in the MAIN checkout (`/home/junielton/Workspace/jnieltn/harnu`). Task 8 lands it in the repo. Sections cited as §N below.

## Global Constraints

- No new npm dependency. No X6 upgrade. If a step seems to need one, stop and report (spec §7.0).
- No canvas schema change in U1. `capycanvas` stays `1`.
- `design.md` is edited **before** the Vue change that implements it, in the same PR.
- Tokens only. No raw colour, no off-system size, no ad-hoc keyframes (CLAUDE.md design contract).
- Every visible string through `$t()`, with the key in **both** `en.json` and `pt-BR.json`.
- English everywhere outside the i18n files.
- Every creation is stamped `origin: "operator"` through the existing `canvas-edit.ts` minters.
- Shortcut letters fire only without `ctrl`/`⌘`/`alt`, only when `hasFocus()` is true, never while `rename` is set.
- Right-button drag keeps panning in every tool. `ctrl`/`⌘` + wheel keeps zooming.
- `CHANGELOG.md` entry and `docs/user/canvas.md` update ship in this PR.
- Before pushing: `npm run typecheck`, `npm run build`, and the `local-ci` skill.

## Review Focus

1. A letter typed into another pane, the terminal or the rename input never switches the tool. Test in Task 4.
2. Switching tool mid-gesture (press `E` while drawing a box) cancels the gesture and leaves no preview on screen. Test in Task 4.
3. The window losing focus while `space` is held does not leave the pane stuck in Hand. Test in Task 4.
4. Two canvas panes open at once keep independent tools. Test in Task 4.
5. A mouse release outside the pane or window ends a draw, arrow or erase gesture with no stuck preview. Capture-phase window listeners, as `DRAW_LISTENER` already does; checked live in Task 8.

---

### Task 1: Pure tool-state module

**Files:**

- Create: `src/renderer/src/components/canvas/canvas-tools.ts`
- Test: `tests/canvas-tools.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type CanvasTool = 'hand' | 'select' | 'rectangle' | 'arrow' | 'text' | 'eraser'
  export interface CanvasToolSpec {
    id: CanvasTool
    key: string // lower-case letter
    digit: string | null // number-row shortcut
    cursor: 'grab' | 'default' | 'crosshair' | 'text' | 'cell'
    creates: 'box' | 'text' | null
  }
  export const CANVAS_TOOLS: readonly CanvasToolSpec[] // in toolbar order
  export const LOCK_KEY = 'q'
  export interface ToolState {
    tool: CanvasTool
    locked: boolean
    spaceHeld: boolean
  }
  export const INITIAL_TOOL_STATE: ToolState // select, unlocked, no space
  export function effectiveTool(s: ToolState): CanvasTool // 'hand' while spaceHeld
  export function selectTool(s: ToolState, t: CanvasTool): ToolState
  export function toggleLock(s: ToolState): ToolState
  export function afterCreate(s: ToolState): ToolState // select unless locked
  export function pressSpace(s: ToolState): ToolState
  export function releaseSpace(s: ToolState): ToolState
  export type EscOutcome = 'cancel-gesture' | 'to-select' | 'clear-selection'
  export function escapeOutcome(s: ToolState, gestureInProgress: boolean): EscOutcome
  export interface KeyLike {
    key: string
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
  }
  export function toolForKey(ev: KeyLike): CanvasTool | 'lock' | null
  export type BlankGesture = 'click' | 'drag' | 'dblclick'
  export type NodeGesture = 'press' | 'drag' | 'dblclick'
  export type GestureIntent =
    | 'none'
    | 'clear-selection'
    | 'rubberband'
    | 'select-node'
    | 'move-node'
    | 'pan'
    | 'place-shape'
    | 'draw-shape'
    | 'start-arrow'
    | 'place-text'
    | 'edit-text'
    | 'rename-node'
    | 'erase'
  export function blankIntent(tool: CanvasTool, g: BlankGesture): GestureIntent
  export function nodeIntent(tool: CanvasTool, g: NodeGesture, nodeShape: string): GestureIntent
  export function toolbarNeedsOwnRow(
    paneWidth: number,
    toolbarWidth: number,
    clusterRight: number
  ): boolean
  ```

Key map (spec §4.1): hand `h`/no digit, select `v`/`1`, rectangle `r`/`2`, arrow `a`/`5`, text `t`/`6`, eraser `e`/`0`. Digits `3` and `4` are reserved for U2's diamond and ellipse and return `null` in U1.

- [ ] **Step 1: Write the failing tests** in `tests/canvas-tools.test.ts`:
  - `INITIAL_TOOL_STATE.tool === 'select'`.
  - every `CANVAS_TOOLS` entry's `key` and `digit` round-trip through `toolForKey`; `q` returns `'lock'`; upper-case `R` returns `'rectangle'`.
  - `toolForKey({ key: 'r', ctrlKey: true, … })`, `metaKey`, `altKey` each return `null`; `'3'` and `'4'` return `null`.
  - `afterCreate` returns `select` when unlocked and keeps the tool when locked.
  - `pressSpace` then `releaseSpace` from `rectangle` (locked or not) gives back `rectangle`; `effectiveTool` is `'hand'` in between.
  - `escapeOutcome`: gesture in progress → `'cancel-gesture'`; tool `text` → `'to-select'`; tool `select` → `'clear-selection'`.
  - the §5 table as data: an `it.each` over every row of
    `[tool, gesture, expected]` for `blankIntent` and `[tool, gesture, shape, expected]` for `nodeIntent`. Rows to include, from spec §5: select blank click → `clear-selection`, select blank drag → `rubberband`, select blank dblclick → `place-text`; select node press → `select-node`, drag → `move-node`, dblclick → `rename-node`; hand anything → `pan` (blank click → `none`); rectangle blank click → `place-shape`, drag → `draw-shape`, node press/drag → same as blank; arrow blank → `none`, node press → `start-arrow`; text blank click/drag → `place-text`, node press on `text` → `edit-text`, on `box` → `place-text`; eraser blank click → `none`, blank drag → `erase`, node press/drag → `erase`, node dblclick → `none`.
  - `toolbarNeedsOwnRow(320, 220, 160)` is `true`; `toolbarNeedsOwnRow(900, 220, 160)` is `false`. Rule: the centred toolbar's left edge `(paneWidth - toolbarWidth) / 2` must be at least `clusterRight + 8`.

- [ ] **Step 2: Run to verify it fails**
      Run: `npx vitest run tests/canvas-tools.test.ts`
      Expected: FAIL, module not found.

- [ ] **Step 3: Implement `canvas-tools.ts`** with the signatures above. Plain functions over plain objects, every transition returns a new `ToolState`.

- [ ] **Step 4: Run to verify it passes**
      Run: `npx vitest run tests/canvas-tools.test.ts`
      Expected: PASS.

- [ ] **Step 5: Commit**
      `git commit -m "feat(canvas): pure tool-state module for canvas tool modes (T536 U1)"`

---

### Task 2: Graph input modes in `canvas-graph.ts` (spike first)

**Files:**

- Modify: `src/renderer/src/components/canvas/canvas-graph.ts` (`createCanvasGraph`, Selection options near line 262, `interacting` near line 203)
- Test: `tests/canvas-edit.test.ts:344-362` ("an editable graph arms selection, rubberband…")

**Interfaces:**

- Consumes: nothing from Task 1 (keeps `canvas-graph.ts` free of tool knowledge).
- Produces:

  ```ts
  export interface CreateCanvasGraphOptions {
    /* existing */ nodesInteractive?: () => boolean
  }
  export function setCanvasRubberband(graph: Graph, enabled: boolean): void
  ```

  `nodesInteractive` defaults to `() => true`. When it returns `false`, nodes are not movable and ports do not start edges.

- [ ] **Step 1: Spike, at most one hour, in the real app.** Confirm in a running dev build that `Selection` `enableRubberband()` / `disableRubberband()` toggle at runtime, and that a Selection created with `modifiers: null` rubberbands on a plain left drag. Write the result as a comment above `setCanvasRubberband`. If either fails, stop and report: this is the one place U1 depends on X6 behaving.
- [ ] **Step 2: Update the failing test** at `tests/canvas-edit.test.ts:344`: an editable graph's Selection has `rubberband: true`, `modifiers` null, and `multipleSelectionModifiers` equal to `['ctrl', 'meta', 'shift']`. Add: `setCanvasRubberband(g, false)` makes `isRubberbandEnabled()` false. Add: with `nodesInteractive: () => false`, a node view reports not movable.
- [ ] **Step 3: Run to verify it fails**
      Run: `npx vitest run tests/canvas-edit.test.ts -t "editable graph"`
      Expected: FAIL on `modifiers`.
- [ ] **Step 4: Implement.** Remove the `CANVAS_RUBBERBAND_MODIFIER` constant and update its importers. Set `multipleSelectionModifiers: ['ctrl', 'meta', 'shift']`. Turn `interacting` into a function that reads `nodesInteractive()`. Keep `panning` on `rightMouseDown` unchanged.
- [ ] **Step 5: Run to verify it passes**, then the whole canvas suite: `npx vitest run tests/canvas-`
      Expected: PASS, except pane tests that rely on drag-draws-a-box. Those are fixed in Task 4, not here.
- [ ] **Step 6: Commit**
      `git commit -m "feat(canvas): runtime rubberband and node-interaction switches (T536 U1)"`

---

### Task 3: `CanvasToolbar.vue`, design contract first

**Files:**

- Modify: `design.md` §6 "Diagram pane": add a "Toolbar" block (spec §4.2 verbatim), replace the "three blank-area gestures" table with spec §5's table, and add the `.canvas-erase-mark` treatment (eraser-marked cell at `opacity: 0.3`).
- Create: `src/renderer/src/components/CanvasToolbar.vue`
- Modify: `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json` (`diagramPane` namespace)
- Modify: `CLAUDE.md` "Design entity → file map": add `Canvas toolbar (§6 — T536) | CanvasToolbar.vue + canvas/canvas-tools.ts`
- Test: `tests/canvas-toolbar.test.ts`

**Interfaces:**

- Consumes: `CANVAS_TOOLS`, `CanvasTool` from Task 1.
- Produces: `<CanvasToolbar :tool :locked :used @select="(t: CanvasTool) => …" @toggle-lock />` where `used: ReadonlySet<CanvasTool>` hides the hint for tools already used. Root has `data-testid="canvas-toolbar"`; each button `data-testid="canvas-tool-<id>"`, the lock `data-testid="canvas-tool-lock"`.

i18n keys (both locales): `diagramPane.toolbar` ("Canvas tools"), `diagramPane.tool.<id>` names (Hand, Select, Rectangle, Arrow, Text, Eraser), `diagramPane.toolTitle` ("{name} — {key}"), `diagramPane.toolTitleDigit` ("{name} — {key} or {digit}"), `diagramPane.lock` ("Keep tool active"), `diagramPane.unlock` ("Return to Select after drawing"), and `diagramPane.toolHint.<id>`:

- select: "Drag to select · Space+drag to pan"
- hand: "Drag to move the board"
- rectangle: "Click to place, or drag to size it"
- arrow: "Drag from one shape to another"
- text: "Click anywhere to type"
- eraser: "Drag across anything to erase it"

Also change `diagramPane.emptyHint` to "Pick a shape from the toolbar, or paste an image." (the old copy now lies).

- [ ] **Step 1: Edit `design.md`** as listed. No Vue yet.
- [ ] **Step 2: Write failing tests** in `tests/canvas-toolbar.test.ts`: renders one button per `CANVAS_TOOLS` entry plus lock, in that order; exactly one `aria-pressed="true"`, on the `tool` prop; clicking `canvas-tool-rectangle` emits `select` with `'rectangle'`; clicking lock emits `toggle-lock`; the hint for `select` shows, and disappears when `used` contains `'select'`; each button's `title` is the localized `toolTitle`/`toolTitleDigit`.
- [ ] **Step 3: Run to verify it fails**
      Run: `npx vitest run tests/canvas-toolbar.test.ts`
      Expected: FAIL, component missing.
- [ ] **Step 4: Implement `CanvasToolbar.vue`** per spec §4.2: icons `Lock`/`LockOpen`, `Hand`, `MousePointer2`, `Square`, `MoveRight`, `Type`, `Eraser` from `lucide-vue-next`; 28px buttons; active `bg-accent-soft text-accent`; idle `text-text-3` hover `bg-surface-2 text-text`; separator after Hand; corner key label `text-text-4`; every button `@mousedown.stop` so it never starts a canvas gesture or a pane resize.
- [ ] **Step 5: Run to verify it passes**, plus `npm run typecheck:web`.
      Expected: PASS, no type errors (the i18n schema check catches a missing pt-BR key).
- [ ] **Step 6: Commit**
      `git commit -m "feat(canvas): CanvasToolbar component and its design contract (T536 U1)"`

---

### Task 4: Wire tool state into `DiagramPane.vue` — Select, Hand, Rectangle, Text

**Files:**

- Modify: `src/renderer/src/components/DiagramPane.vue` (`onBlankMouseDown`/`onDrawUp` ~316-370, `commitRename` ~406, `onWindowKeydown` ~907, `wireEditing` ~238, template floating cluster)
- Modify: `src/renderer/src/components/canvas/canvas-edit.ts` (`operatorNode`)
- Test: `tests/canvas-edit.test.ts` (pane block, ~690-790), `tests/canvas-pane-tools.test.ts` (new)

**Interfaces:**

- Consumes: Task 1 module, Task 2 `nodesInteractive` + `setCanvasRubberband`, Task 3 toolbar.
- Produces:
  ```ts
  export type OperatorShape = 'box' | 'text'
  export function operatorNode(
    rect: DrawnRect,
    taken: ReadonlySet<string>,
    label?: string,
    shape?: OperatorShape
  ): CanvasNode
  export function placedRect(cx: number, cy: number, shape: string): DrawnRect // centred, DEFAULT_SIZE_BY_SHAPE
  ```
  `shape` defaults to `'box'`, so existing callers are unchanged. U2 widens `OperatorShape`.

Behaviour to implement, all from spec §4.3 and §5:

- `toolState` ref per pane, starts at `INITIAL_TOOL_STATE`; `usedTools` set for the hints.
- Every tool change calls `setCanvasRubberband(g, effectiveTool === 'select')`. `nodesInteractive` returns `effectiveTool === 'select'`.
- The body's cursor comes from the active spec's `cursor`; Hand shows `grabbing` while panning.
- `blank:mousedown` and `node:mousedown` go through `blankIntent`/`nodeIntent`. Rectangle reuses the existing draw preview: a short drag becomes `place-shape` with `placedRect`, a long one `draw-shape` with `rectFromDrag`. Text places `operatorNode(placedRect(x, y, 'text'), taken, '', 'text')` and opens rename.
- Hand, and `space` held in any tool, pan with a capture-phase window listener calling `g.translate(tx + dx, ty + dy)`. `space` is ignored while `rename` is set. A window `blur` calls `releaseSpace`.
- A creation calls `afterCreate`. Switching tool during a gesture cancels it and clears the preview.
- `blank:dblclick` in Select places a text node.
- `node:dblclick` goes through `nodeIntent`: it renames in every tool except Eraser, where it does nothing.
- Text tool: pressing an existing `text` node opens its rename input (`edit-text`); pressing any other node places a new text on top.
- `shift`+drag on blank in Select adds the rubberband's catch to the current selection instead of replacing it.
- The in-flight draw preview carries `data-testid="diagram-draw-preview"`; add it if it is missing.
- `commitRename` removes a `text` node whose committed label is empty.
- `Esc` follows `escapeOutcome`. Letter and digit keys follow `toolForKey`, after the existing `rename` early return.
- Toolbar sits top-centre; when `toolbarNeedsOwnRow` is true it drops under the zoom cluster. Measure with the existing `ResizeObserver` pattern, not a new library.

- [ ] **Step 1: Write failing tests** in `tests/canvas-pane-tools.test.ts`, using `mountPane()` and `dragOnBlankCanvas()` as in `tests/canvas-edit.test.ts`:
  - fresh pane: `canvas-tool-select` is pressed; a blank drag creates **no** node (Save, assert node count unchanged).
  - press `r`, blank drag → one new `box` node stamped `operator`; tool is back to Select.
  - press `q` then `r`, two drags → two boxes; tool still Rectangle.
  - press `r`, short click → one box of `DEFAULT_NODE_SIZE` centred on the click.
  - press `t`, click → rename input open; type "note", Enter, Save → a `text` node labelled "note". Click again with `t`, Enter with empty input → no node added.
  - `Escape` with tool Text → tool Select; `Escape` again → selection cleared.
  - Review Focus 1: a `keydown` `r` dispatched while focus is in a `<textarea>` outside the pane leaves the tool on Select; same while the rename input is open.
  - Review Focus 2: press `r`, start a blank drag (mousedown + move), press `e` → no node added, `[data-testid="diagram-draw-preview"]` gone.
  - Review Focus 3: `keydown` space, then `window` `blur` → tool reads Select again.
  - Review Focus 4: mount two panes, press `r` in the first → second still Select.
  - select `n-a`, then `shift`+drag a rubberband around `n-b` → both selected.
  - press `e`, double-click `n-a` → no rename input; press `v`, double-click `n-a` → rename input open.
  - press `t`, press the seeded text node `n-c` → its rename input opens with its current label, and no node is added.
- [ ] **Step 2: Update the existing tests that drew a box with a plain drag** (`tests/canvas-edit.test.ts` "U3-2", the toast test near line 690, "drag-to-create" at 120 if it drives the pane, "the empty board says how to start drawing" at 772): press `r` before the drag, and assert the new `emptyHint` copy. Each changed test keeps its original assertion; only the setup gains the tool switch.
- [ ] **Step 3: Run to verify the new tests fail**
      Run: `npx vitest run tests/canvas-pane-tools.test.ts tests/canvas-edit.test.ts`
      Expected: new tests FAIL; updated old tests FAIL on the missing toolbar.
- [ ] **Step 4: Implement** the behaviour list above.
- [ ] **Step 5: Run to verify they pass**, then `npx vitest run tests/canvas-` and `npm run typecheck`.
      Expected: PASS everywhere.
- [ ] **Step 6: Commit**
      `git commit -m "feat(canvas): Select is the default tool; Hand, Rectangle and Text tools (T536 U1)"`

---

### Task 5: Arrow tool

**Files:**

- Modify: `src/renderer/src/components/DiagramPane.vue`
- Test: `tests/canvas-pane-tools.test.ts`

**Interfaces:**

- Consumes: `nodeIntent` → `'start-arrow'`; `operatorEdgeData()` from `canvas-edit.ts`.
- Produces: an edge cell `{ shape: 'edge', source: { cell: id }, target: { cell: id }, data: operatorEdgeData() }`, with the router, connector and accent stroke `createCanvasGraph`'s `createEdge` already uses. Extract that edge spec into one exported helper in `canvas-graph.ts` rather than copying it.

Behaviour: pressing on a node starts the arrow. A preview line from the node centre to the pointer is drawn as an overlay (`data-testid="diagram-arrow-preview"`, `--accent-line`, dashed), never as a graph cell, so it never enters undo history. Releasing on a different node adds the edge and calls `afterCreate`. Releasing on blank, on the same node, or on a node already connected to the source in that direction (X6 `allowMulti: false`) adds nothing. A press on blank in Arrow mode shows nothing; the hint already says "Drag from one shape to another".

- [ ] **Step 1: Write failing tests:** press `a`, drag from `n-a` to `n-b` → Save has one new edge `n-a → n-b` stamped `operator`, tool back to Select; drag `n-a` to blank → no edge; drag `n-a` to `n-a` → no edge; preview element present mid-drag, absent after.
- [ ] **Step 2: Run to verify it fails.** `npx vitest run tests/canvas-pane-tools.test.ts -t arrow` → FAIL.
- [ ] **Step 3: Implement.** Find the drop target with `g.getNodesFromPoint(x, y)`, topmost first.
- [ ] **Step 4: Run to verify it passes**, plus the whole canvas suite.
- [ ] **Step 5: Commit**
      `git commit -m "feat(canvas): Arrow tool draws a bound edge between two shapes (T536 U1)"`

---

### Task 6: Eraser tool

**Files:**

- Modify: `src/renderer/src/components/DiagramPane.vue`, `src/renderer/src/styles/main.css` (`.canvas-erase-mark`)
- Test: `tests/canvas-pane-tools.test.ts`

**Interfaces:**

- Consumes: `blankIntent`/`nodeIntent` → `'erase'`.
- Produces: nothing new for later tasks.

Behaviour: during an erase drag, every node under the pointer (`g.getNodesFromPoint`) and every edge within 6 screen pixels (`g.getEdgesInArea` on a small rect scaled by `g.zoom()`) is marked by adding the class `canvas-erase-mark` to its **view**, never by changing a cell attribute, so marking is not an edit. On release, remove all marked cells inside one `g.startBatch('erase')` / `g.stopBatch('erase')`. `Esc` mid-drag clears the marks and erases nothing. A plain press on a node erases just it.

- [ ] **Step 1: Write failing tests:** press `e`, drag across `n-a` and `n-b` → both gone after Save, their edges gone too; one `ctrl+z` → both back with their edges (one undo step); press `e`, start a drag over `n-a`, press `Escape`, release → nothing removed and no element has the class `canvas-erase-mark`; the pane is not dirty after a cancelled erase.
- [ ] **Step 2: Run to verify it fails.** `npx vitest run tests/canvas-pane-tools.test.ts -t eraser` → FAIL.
- [ ] **Step 3: Implement**, and the CSS class in `main.css` using `opacity: 0.3` (as declared in `design.md` in Task 3).
- [ ] **Step 4: Run to verify it passes**, plus the whole canvas suite.
- [ ] **Step 5: Commit**
      `git commit -m "feat(canvas): Eraser tool removes everything it crosses in one undo step (T536 U1)"`

---

### Task 7: End-to-end in the built app

**Files:**

- Create: `tests/e2e/ci/canvas-tools.spec.ts`
- Test: itself

**Interfaces:**

- Consumes: the `data-testid`s from Tasks 3-6.

Launch the same way `tests/e2e/ci/app-boot-mcp.spec.ts` does (`_electron.launch` on `out/main/index.js`, throwaway `--user-data-dir`, `HOME`). Get a canvas open by turning the MCP server on as that spec does, then calling `adopt_folder` on a temp folder and `draw_canvas` with two boxes; `draw_canvas` opens the pane. Assert by reading the saved file from disk after `ctrl+s`.

- [ ] **Step 1: Write the spec** with one `test.step` per item of spec §9.3 items 1 to 7: Select click and drag create nothing; Rectangle drag creates a box and returns to Select; Arrow A→B creates one edge and A→blank none; Text click creates a labelled text node; Eraser across both boxes removes them and `ctrl+z` restores them; Hand drag moves the viewport and no node; `r` + drag creates a box and `Escape` returns to Select. Use real `page.mouse` moves, because jsdom cannot reproduce X6's `mouseup` handling.
- [ ] **Step 2: Build and run**
      Run: `npm run build && npx playwright test --project=ci tests/e2e/ci/canvas-tools.spec.ts`
      Expected: PASS. A failure here that the vitest suite missed is exactly what this test exists for; fix the code, not the test.
- [ ] **Step 3: Commit**
      `git commit -m "test(canvas): e2e drives every U1 tool in the built app (T536 U1)"`

---

### Task 8: Live gesture matrix, docs, and landing the spec

**Files:**

- Create: `docs/specs/2026-10-19-t536-canvas-toolbar.md` (copy of the main-checkout spec), `docs/plans/2026-10-19-t536-u1-canvas-tool-modes.md` (this plan)
- Modify: `docs/user/canvas.md` ("Moving around" and "Drawing" sections: replace the gesture table with the toolbar and per-tool behaviour; remove "A plain drag draws a box"), `CHANGELOG.md` (new `## 2026-10-19` or current date, `### Added`/`### Changed`)
- Output: screenshots under `/home/junielton/Workspace/jnieltn/harnu/.harnu/out/visual/T536/U1/` (the MAIN checkout's `.harnu/out`, not the worktree's)

- [ ] **Step 1: Run the live matrix** per `docs/dev/live-verify-second-instance.md`: a second isolated instance, a seeded board, and for each of the six tools the rows click blank, drag blank, press node, drag node, right-drag, space+drag, `Esc`, and its shortcut. One screenshot per tool after its rows, plus: dark theme, light theme, pane at 320px wide (toolbar on its own row, nothing clipped), and maximized. Record each row as pass or fail in `.harnu/out/visual/T536/U1/matrix.md`.
- [ ] **Step 2: Fix any failing row**, re-run that row, update `matrix.md`.
- [ ] **Step 3: Write the docs.** `docs/user/canvas.md` in plain English for end users. `CHANGELOG.md` bullets: the toolbar; "a click on an empty board no longer draws a box"; the six tools; space to pan; Lock. No `docs/harnu-features.md` change: U1 adds nothing an agent calls.
- [ ] **Step 4: Gates.** `npm run typecheck && npm run build`, then the `local-ci` skill. Expected: all green.
- [ ] **Step 5: Commit**
      `git commit -m "docs(canvas): toolbar user docs, changelog, spec and plan (T536 U1)"`
