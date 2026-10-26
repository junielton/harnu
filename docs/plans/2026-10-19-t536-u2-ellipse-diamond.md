# T536 U2 — Ellipse and diamond shapes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `ellipse` and `diamond` node kinds that the operator draws from the toolbar and the agent draws through `draw_canvas`, and make edges keep their `props` on read and write so U5's arrow styling has a safe reader in place first.

**Architecture:** Both shapes are new built-in kinds in `canvas-cells.ts` mapped to X6's `ellipse` and `polygon` primitives, reusing `portsFor` (its side-midpoint ports are exactly a diamond's vertices). The agent catalog gains two entries. `canvas-core.ts` learns to carry `edge.props` through, and the pane's Save path takes an edge's `props` from the base document by id, the same way it already treats edge labels.

**Tech Stack:** as U1. **Depends on:** U1 merged (`canvas-tools.ts`, `CanvasToolbar.vue`, `OperatorShape`).

**Spec:** `docs/specs/2026-10-19-t536-canvas-toolbar.md` (landed by U1), §3, §6, §7.3.

## Global Constraints

- Everything in U1's Global Constraints.
- No schema version bump. An older build must still open a board with the new shapes (it draws a dashed box and keeps the kind).
- Agent-facing: `docs/harnu-features.md` updated and its `<!-- harnu-features vN -->` marker bumped; `docs/user/agent-control.md` mentions the two shapes.
- Body and label tokens identical to `box` (spec §6). No new token.

## Review Focus

1. A diamond or ellipse resized very thin (48×32 floor) still shows its label and ports. Test in Task 1.
2. A theme switch recolours ellipses and diamonds, not only boxes. Test in Task 1.
3. An edge drawn to a diamond attaches at a vertex, and the manhattan router does not cut through the diamond's empty corners in a way that hides the arrowhead. Live row in Task 4.
4. An agent `update_node` on a diamond that sets `shape` is refused as today (shape is not an `update_node` key), so a kind never changes silently. Test in Task 2.
5. A file whose edge has `props` from a newer build survives open, edit elsewhere, Save. Test in Task 3.

---

### Task 1: Render `ellipse` and `diamond`

**Files:**

- Modify: `src/renderer/src/components/canvas/canvas-cells.ts` (`BUILTIN_KINDS` line 74, `DEFAULT_SIZE_BY_SHAPE` line 63, `toX6Node` box branch ~317)
- Modify: `src/renderer/src/components/canvas/canvas-edit.ts` (`OperatorShape`)
- Modify: `design.md` §6 "Node and edge treatment" table (two rows), before the code
- Test: `tests/canvas-cells.test.ts`, `tests/canvas-edit.test.ts`

**Interfaces:**

- Produces: `DEFAULT_ELLIPSE_SIZE = { width: 132, height: 64 }`, `DEFAULT_DIAMOND_SIZE = { width: 132, height: 80 }` exported from `canvas-cells.ts`; `OperatorShape = 'box' | 'text' | 'ellipse' | 'diamond'`.

- [ ] **Step 1: Edit `design.md`.**
- [ ] **Step 2: Write failing tests:** `toX6Node` of an `ellipse` gives X6 `shape: 'ellipse'`, `data.kind: 'ellipse'`, four ports, body fill `palette.surface`, stroke `palette.border2`, no `strokeDasharray`; a `diamond` gives `shape: 'polygon'` with `refPoints: '0.5,0 1,0.5 0.5,1 0,0.5'` and the same; default sizes as above; a 48×32 diamond still has its label attrs; `buildCanvasDocumentFromCells` round-trips both kinds with `origin` intact; rendering with a second palette changes both bodies' stroke (Review Focus 2).
- [ ] **Step 3: Run to verify they fail.** `npx vitest run tests/canvas-cells.test.ts tests/canvas-edit.test.ts` → FAIL.
- [ ] **Step 4: Implement.** Share the box branch's `attrs` builder across the three framed kinds; only `shape` and `refPoints` differ.
- [ ] **Step 5: Run to verify they pass**, plus `npx vitest run tests/canvas-`.
- [ ] **Step 6: Commit** `feat(canvas): ellipse and diamond node kinds (T536 U2)`

---

### Task 2: Agent catalog

**Files:**

- Modify: `src/main/mcp/canvas-shapes.ts` (`CANVAS_BUILTIN_SHAPES`)
- Modify: `docs/harnu-features.md` (the `draw_canvas` shape vocabulary, marker bump), `docs/user/agent-control.md`
- Test: `tests/mcp-canvas-ops.test.ts`, `tests/mcp-draw-canvas-handler.test.ts`

**Interfaces:**

- Produces: catalog entries `{ name: 'ellipse', description: 'Ellipse with a centred label — for states, start/end points.', defaultSize: { width: 132, height: 64 }, props: [] }` and `{ name: 'diamond', description: 'Diamond with a centred label — for decisions in a flow.', defaultSize: { width: 132, height: 80 }, props: [] }`, placed after `box`.

- [ ] **Step 1: Write failing tests:** `add_node` with `shape: 'ellipse'` and `'diamond'` succeeds and is stamped `agent`; the ACK `shapes` lists both with those default sizes; `props: { x: 1 }` on either is `BAD_PROPS`; `update_node` with a `shape` key on a diamond is refused as `BAD_ARGS` (Review Focus 4).
- [ ] **Step 2: Run to verify they fail.** `npx vitest run tests/mcp-canvas-ops.test.ts tests/mcp-draw-canvas-handler.test.ts` → FAIL.
- [ ] **Step 3: Implement**, then update both docs and bump the marker.
- [ ] **Step 4: Run to verify they pass**, plus `node scripts/ci/awareness-gate.mjs` if it runs locally.
- [ ] **Step 5: Commit** `feat(mcp): draw_canvas draws ellipses and diamonds (T536 U2)`

---

### Task 3: Toolbar buttons and the edge-`props` reader

**Files:**

- Modify: `src/renderer/src/components/canvas/canvas-tools.ts` (`CanvasTool`, `CANVAS_TOOLS`), `CanvasToolbar.vue` (icons `Diamond`, `Circle`), both i18n files (`diagramPane.tool.diamond`/`ellipse`, `toolHint.diamond`/`ellipse` "Click to place, or drag to size it")
- Modify: `src/main/canvas-core.ts` (`CanvasEdge` gains `props?: Record<string, unknown>`; edge parse ~471-486 validates it like node props at 416; edge serialize ~534)
- Modify: `src/renderer/src/components/canvas/canvas-edit.ts` (`buildCanvasDocumentFromCells`: an edge's `props` come from the base document by id, like its label)
- Test: `tests/canvas-tools.test.ts`, `tests/canvas-toolbar.test.ts`, `tests/canvas-pane-tools.test.ts`, `tests/canvas-core.test.ts`, `tests/canvas-edit-save.test.ts`

**Interfaces:**

- Produces: `CanvasTool` adds `'diamond'` (`d`/`3`) and `'ellipse'` (`o`/`4`), toolbar order Hand · Select · Rectangle · Diamond · Ellipse · Arrow · Text · Eraser (spec §4.1); `CanvasToolSpec.creates` widens to `OperatorShape | null`; `CanvasEdge.props`.

- [ ] **Step 1: Write failing tests:** `toolForKey` maps `d`/`3` and `o`/`4` (and `ctrl+d` stays `null`, so duplicate keeps working); the §5 intent rows for diamond and ellipse equal rectangle's; toolbar renders 8 tools in spec order; pane: press `d`, drag → one `diamond` node; press `o`, click → one `ellipse` of `DEFAULT_ELLIPSE_SIZE`; `canvas-core`: an edge with `props: { style: { tone: 'green' } }` parses and serializes byte-equivalent, and non-plain-JSON edge props are `invalid-document`; Save path: a document whose edge has `props`, after an unrelated node move, writes the edge's `props` unchanged (Review Focus 5).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify they pass**, plus `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(canvas): Diamond and Ellipse tools; edges keep their props on save (T536 U2)`

---

### Task 4: e2e, live rows, docs

**Files:**

- Modify: `tests/e2e/ci/canvas-tools.spec.ts` (spec §9.3 item 8), `docs/user/canvas.md`, `CHANGELOG.md`
- Output: `/home/junielton/Workspace/jnieltn/harnu/.harnu/out/visual/T536/U2/` screenshots and `matrix.md`

- [ ] **Step 1: Extend the e2e** with `o` + drag → ellipse and `d` + click → diamond, asserted from the saved file. Run `npm run build && npx playwright test --project=ci tests/e2e/ci/canvas-tools.spec.ts` → PASS.
- [ ] **Step 2: Live rows** (second isolated instance): both tools × click blank, drag blank, shortcut; an arrow to each new shape (Review Focus 3); resize each to its floor; both themes. Record in `matrix.md`.
- [ ] **Step 3: Docs.** `docs/user/canvas.md` "Reading the board" gains ellipses and diamonds; `CHANGELOG.md` `### Added` for the two shapes and that agents can draw them.
- [ ] **Step 4: Gates.** `npm run typecheck && npm run build`, then the `local-ci` skill → green.
- [ ] **Step 5: Commit** `docs(canvas): ellipse and diamond docs and changelog (T536 U2)`
