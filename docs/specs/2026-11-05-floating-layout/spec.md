---
status: approved
tier: complex
mockup: docs/design/floating-layout/
---

# Floating layout package: islands, split orientation, expand-to-window, motion

## Problem

The operator reviewed the whole renderer in a live web preview on 2026-11-04 (the preview harness is
committed as the mockup, `docs/design/floating-layout/`, see its `README.md`) and asked for a layout
package. Measured findings that motivate it:

- The vertical pane dividers read as a double bar: the sidebar's `bg-sidebar` edge ends, then the
  divider's 6px hit column (`w-1.5`, transparent) holds a centered 1px `bg-border-2` line, so two
  parallel edges sit ~2.5px apart (sidebar | main and main | Fleet rail; `App.vue`).
- In sidebar drill-in mode the Back row (`data-drill-back`, `SidebarDrillView.vue`) is the first child
  INSIDE the list scroller, so it scrolls away with a long list (measured with 47 worktrees in one
  group). A sticky version was tried and rejected: its border stops 10px short of the island edge
  (scrollbar gutter) and rows show half-cut right at its edge.
- The Topbar hides "Browser" inside the split dropdown, one click deeper than "Terminal".
- The session area and helper stack can only sit side by side; a portrait window wastes the space.
- A helper pane can maximize inside the stack, but not to the whole window.
- Every size change (maximize, rail minimize, sidebar collapse) snaps with no motion.

Request atoms (the operator's words, distilled):

- R-1 Fix the divider "double bar".
- R-2 Keep the drill-in Back row pinned while the list scrolls, with no text leaking behind it and a
  border that reaches the island edge.
- R-3 Move the Browser action out of the dropdown into its own Topbar button.
- R-4 Let the session area and helper stack stack vertically; save the orientation, make it
  configurable and quick to change, with one ratio per orientation.
- R-5 An opt-in "floating panels" layout (VS Code style islands on a darker canvas), off by default.
- R-6 In that layout, everything lines up on one grid: equal 6px gaps, `--radius` (7px) islands,
  `--radius-sm` where noted, the top band aligned across columns.
- R-7 The app footer stays flush (not an island) but keeps its panel look.
- R-8 The sidebar's lower part (Add folder + Settings) is its own island and must accept more
  sections later.
- R-9 "Return here", "Needs you" and "Would-have" are their own islands; collapsed/minimized states
  never lose the gap.
- R-10 A helper pane can expand to the whole window, with both variants ("hide everything" and
  "hide the session area only") kept as an option.
- R-11 Layout changes animate, briefly, per design.md §7.

## Goals

- G-1 Every pane boundary reads as ONE edge in both layouts.
- G-2 The operator can switch to a floating-island layout that matches the approved mockup on every
  theme, and switch back to today's layout with zero pixel change.
- G-3 The split orientation is a saved setting with a quick switch.
- G-4 A helper pane can take the whole window and come back, smoothly, without remounting.

**Non-goals:** making floating panels the default; removing the current layout; moving the sidebar
or Fleet rail; per-folder orientation; animating divider drags.

**Anti-goals:** any xterm or PTY remount caused by a layout change; a browser pane drawing out of
sync during an animation; a light theme where the canvas reads as a heavy grey slab; a setting that,
when off, changes any pixel of today's layout.

## Slices

### S-1 · Spec and mockup on the integration branch

- depends-on: —
- substrate: worktree
- files-may-touch: `docs/specs/2026-11-05-floating-layout/spec.md`, `docs/design/floating-layout/**`
- produces: layout-spec
- consumes: —
- acs: AC-1

### S-2 · Divider double bar (BUG-247)

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/renderer/src/App.vue` (the three vertical divider blocks only),
  `src/renderer/src/components/Sidebar.vue`, `src/renderer/src/components/InboxRail.vue`,
  `src/renderer/src/components/HelperStack.vue` (root borders only, if they add an edge),
  `design.md`, `CHANGELOG.md`, `tests/**`
- produces: single-edge-dividers
- consumes: layout-spec
- acs: AC-2, AC-3, AC-4

### S-3 · Drill-in Back row pinned outside the scroller (BUG-248)

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/renderer/src/components/SidebarDrillView.vue`,
  `src/renderer/src/components/Sidebar.vue`, `design.md`, `CHANGELOG.md`, `tests/**`
- produces: pinned-drill-back
- consumes: layout-spec
- acs: AC-5, AC-6, AC-7

### S-4 · Browser button in the Topbar

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/renderer/src/components/Topbar.vue`,
  `src/renderer/src/components/SplitMenu.vue`, `src/renderer/src/i18n/en.json`,
  `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`, `docs/user/**`, `tests/**`
- produces: topbar-browser-button
- consumes: layout-spec
- acs: AC-8, AC-9, AC-10

### S-5 · Configurable split orientation (T627)

- depends-on: S-2, S-4
- substrate: worktree
- files-may-touch: `src/renderer/src/App.vue`, `src/renderer/src/components/HelperStack.vue`,
  `src/renderer/src/components/HelperPane.vue`, `src/renderer/src/components/SplitMenu.vue`,
  `src/renderer/src/components/SettingsDialog.vue`, `src/renderer/src/stores/helpers.ts`,
  `src/renderer/src/stores/settings.ts`, `src/renderer/src/stores/layout.ts`,
  `src/renderer/src/lib/**` (a new pure orientation resolver), `src/main/settings.ts`,
  `src/preload/index.ts` (settings wire type only), `src/main/keybindings-core.ts`,
  `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`,
  `docs/user/**`, `tests/**`
- produces: split-orientation
- consumes: single-edge-dividers, topbar-browser-button
- acs: AC-11, AC-12, AC-13, AC-14, AC-15, AC-16

### S-6 · Floating panels layout, opt-in (T626)

- depends-on: S-3, S-5
- substrate: worktree
- files-may-touch: `src/renderer/src/styles/themes.css`, `src/renderer/src/styles/main.css`,
  `src/renderer/src/App.vue`, `src/renderer/src/components/Sidebar.vue`,
  `src/renderer/src/components/SidebarDrillView.vue`,
  `src/renderer/src/components/SidebarReturnZone.vue`, `src/renderer/src/components/InboxRail.vue`,
  `src/renderer/src/components/StatusFooter.vue`, `src/renderer/src/components/Topbar.vue`,
  `src/renderer/src/components/HelperStack.vue`, `src/renderer/src/components/SettingsDialog.vue`,
  `src/renderer/src/stores/settings.ts`, `src/main/settings.ts`, `src/preload/index.ts` (settings
  wire type only), `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`,
  `design.md`, `CHANGELOG.md`, `docs/user/**`, `tests/**`
- produces: floating-layout
- consumes: pinned-drill-back, split-orientation
- acs: AC-17, AC-18, AC-19, AC-20, AC-21, AC-22, AC-23, AC-24, AC-25

### S-7 · Expand-to-window stage and layout motion (T628)

- depends-on: S-6
- substrate: worktree
- files-may-touch: `src/renderer/src/components/HelperPane.vue`,
  `src/renderer/src/components/HelperStack.vue`, `src/renderer/src/App.vue`,
  `src/renderer/src/components/Sidebar.vue`, `src/renderer/src/components/InboxRail.vue`,
  `src/renderer/src/components/BrowserPane.vue`, `src/renderer/src/stores/helpers.ts`,
  `src/renderer/src/stores/layout.ts`, `src/renderer/src/stores/settings.ts`,
  `src/main/settings.ts`, `src/preload/index.ts` (settings wire type only),
  `src/main/keybindings-core.ts`, `src/renderer/src/styles/main.css`,
  `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`,
  `CHANGELOG.md`, `docs/user/**`, `tests/**`
- produces: expand-and-motion
- consumes: floating-layout
- acs: AC-26, AC-27, AC-28, AC-29, AC-30, AC-31, AC-32, AC-33

### S-8 · Integration PR

- depends-on: S-2, S-3, S-4, S-5, S-6, S-7
- substrate: session
- files-may-touch: — (no code; the PR body carries the Delivery Report)
- produces: —
- consumes: expand-and-motion
- acs: AC-34

## Acceptance criteria

Every visual AC is checked with Floating panels OFF and ON once S-6 exists, on the default theme,
Dracula and one light theme, unless the statement says otherwise. "Gap" means the empty space
between two islands' outer borders.

| id    | statement                                                                                                                                                                                                                                                                                                                                                     | proof                                                                    | refines/inherits | covers    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------- | --------- |
| AC-1  | This spec (status approved) and the mockup directory are committed on `feat/floating-layout`, and the spec gate passes.                                                                                                                                                                                                                                       | script:node scripts/ci/spec-gate.mjs                                     | —                | R-1..R-11 |
| AC-2  | At rest, the sidebar \| main, main \| helper stack and main \| Fleet rail boundaries each render ONE edge: no strip of `--bg` between a panel's background edge and the divider line.                                                                                                                                                                         | capture:/@session-with-helper-stack                                      | —                | R-1       |
| AC-3  | Divider hit area stays ≥ 6px wide with `cursor-col-resize`; drag resizes and double-click resets (sidebar, helper stack, Fleet rail); hover lights `--accent-line`.                                                                                                                                                                                           | test:tests/app-dividers.test.ts::divider hit area and reset              | —                | R-1       |
| AC-4  | Collapsed sidebar and minimized Fleet rail (which has its own `border-l`) show no double edge.                                                                                                                                                                                                                                                                | capture:/@sidebar-collapsed-rail-minimized                               | AC-2             | R-1       |
| AC-5  | In drill depth 1 and 2, the Back row is rendered OUTSIDE the list scroller (a sibling above it); after scrolling to the end of a 40+ row list its top equals the list area's top.                                                                                                                                                                             | test:tests/sidebar-drill-back.test.ts::back row stays above the scroller | —                | R-2       |
| AC-6  | The Back row spans the full sidebar width (its bottom border reaches both edges, over the scrollbar gutter), is opaque on every theme, and no list row text is visible above, behind or through it; rows sliding under its edge fade through a gradient strip (≈14px, `--color-sidebar` → transparent) that leaves the borders and the scrollbar thumb solid. | capture:/@drill-in-scrolled                                              | AC-5             | R-2       |
| AC-7  | Back row hover, click (drill back) and right-click menu still work; non-drill mode is unchanged.                                                                                                                                                                                                                                                              | test:tests/sidebar-drill-back.test.ts::back row actions                  | —                | R-2       |
| AC-8  | The Topbar shows a dedicated Browser button next to the Terminal split button; one click opens a browser pane exactly as the dropdown's Browser item did.                                                                                                                                                                                                     | test:tests/topbar-browser-button.test.ts::opens a browser pane           | —                | R-3       |
| AC-9  | The split dropdown no longer lists Browser (or the dropdown is removed if Terminal is its only item); its other behavior is unchanged.                                                                                                                                                                                                                        | test:tests/topbar-browser-button.test.ts::dropdown without browser       | —                | R-3       |
| AC-10 | The new button has an icon from design.md §5, an aria-label and title from i18n (en and pt-BR), and design.md documents it.                                                                                                                                                                                                                                   | record:design-md                                                         | —                | R-3       |
| AC-11 | Settings → Appearance has "Split layout": `auto` (default), `side-by-side`, `stacked`; persisted in the settings store like the theme.                                                                                                                                                                                                                        | test:tests/split-orientation.test.ts::setting persists                   | —                | R-4       |
| AC-12 | `auto` resolves to stacked while the main area is taller than wide and side by side otherwise, with hysteresis so a near-square window does not flicker; the resolver is a pure function.                                                                                                                                                                     | test:tests/split-orientation.test.ts::auto threshold with hysteresis     | —                | R-4       |
| AC-13 | Stacked: session area on top, helper stack below; the divider is horizontal (`aria-orientation="horizontal"`, `cursor-row-resize`), drag computes the ratio on Y, double-click resets.                                                                                                                                                                        | capture:/@stacked-two-helpers                                            | —                | R-4       |
| AC-14 | Stacked: helper panes lay out side by side with width splitters; side by side keeps today's vertical stack; maximize, close and header-as-handle work in both.                                                                                                                                                                                                | test:tests/split-orientation.test.ts::helper panes follow orientation    | —                | R-4       |
| AC-15 | One split ratio per orientation (still keyed per worktree): switching orientation never changes the other orientation's ratio.                                                                                                                                                                                                                                | test:tests/split-orientation.test.ts::ratio per orientation              | —                | R-4       |
| AC-16 | The Topbar split menu offers the orientation, and a bindable shortcut (`layout.cycleSplitOrientation`) exists in the keybindings table.                                                                                                                                                                                                                       | record:design-md                                                         | —                | R-4       |
| AC-17 | Settings → Appearance has "Floating panels", off by default, persisted, applied as an attribute on `<html>`; with it off, today's layout renders with no pixel change.                                                                                                                                                                                        | test:tests/floating-panels.test.ts::off by default and attribute         | —                | R-5       |
| AC-18 | design.md defines a per-theme canvas token (hand-picked for light themes) and the island, gap (6px), radius (`--radius` for islands, `--radius-sm` where noted) and divider-grip rules BEFORE the implementation commit.                                                                                                                                      | record:design-md                                                         | —                | R-5, R-6  |
| AC-19 | On, the top band is three 42px islands on one line (sidebar toolbar, Topbar, Fleet rail header) sharing top and bottom; the first island under each column starts at the same y.                                                                                                                                                                              | test:tests/floating-panels.test.ts::grid alignment                       | —                | R-6       |
| AC-20 | On, every island is fully rounded with `--radius`, has its own 1px `--color-border`, never shares an edge with another island, and every gap (between islands and to the window edge) measures 6px.                                                                                                                                                           | capture:/@floating-default                                               | —                | R-6       |
| AC-21 | On, vertical dividers show no line at rest; on hover a 2px × 36px grip in `--color-accent-line`; the gap is the drag handle (≥ 6px).                                                                                                                                                                                                                          | capture:/@floating-divider-hover                                         | AC-3             | R-6       |
| AC-22 | On, the app footer is flush and full width with no margin or radius, keeps `--color-surface` and a 1px `--color-border` top rule, and the islands keep the 6px gap above it.                                                                                                                                                                                  | capture:/@floating-default                                               | —                | R-7       |
| AC-23 | On, the sidebar's lower part (Add folder + Settings) is its own island built as a slot that stacks N sections; design.md documents the slot.                                                                                                                                                                                                                  | record:design-md                                                         | —                | R-8       |
| AC-24 | On, the sidebar column is toolbar, [Return here], list, dock and the Fleet rail column is header, list, [Needs you], Would-have, each its own island 6px apart; Return here's internal bottom divider is hidden; in drill mode the list island starts with the pinned Back row.                                                                               | capture:/@floating-return-here-needs-you                                 | AC-6             | R-9       |
| AC-25 | On, minimized Fleet rail, collapsed sidebar and closed helper stack keep the 6px gap where a divider disappears.                                                                                                                                                                                                                                              | capture:/@floating-collapsed-states                                      | AC-20            | R-9       |
| AC-26 | Each helper pane header has an "Expand to window" button (`expand` icon) before maximize; Esc, the same button or `⌘⇧M` exits; a bindable `pane.expandToWindow` action exists.                                                                                                                                                                                | test:tests/pane-expand.test.ts::enter and exit                           | —                | R-10      |
| AC-27 | A setting "Expand hides" offers `everything` (default: sidebar, session area and Fleet rail collapse, only Topbar, the pane and the footer remain) and `session-only` (session area only).                                                                                                                                                                    | test:tests/pane-expand.test.ts::variant setting                          | —                | R-10      |
| AC-28 | Expanding never remounts or moves the pane: an xterm pane keeps the same Terminal instance and PTY across enter and exit.                                                                                                                                                                                                                                     | test:tests/pane-expand.test.ts::no remount                               | —                | R-10      |
| AC-29 | Expand state is ephemeral per worktree, resets on a worktree switch, and the F6 ring holds only the expanded pane.                                                                                                                                                                                                                                            | test:tests/pane-expand.test.ts::ephemeral and focus ring                 | —                | R-10      |
| AC-30 | Maximize/restore, expand/restore, Fleet rail minimize/expand, sidebar collapse/expand and the orientation switch animate with `--dur-slow` and `--ease`; divider drags do not animate.                                                                                                                                                                        | capture:/@motion-expand-restore                                          | —                | R-11      |
| AC-31 | During an animated resize an xterm reflows once at the end (debounced), never per frame.                                                                                                                                                                                                                                                                      | test:tests/pane-expand.test.ts::single reflow after motion               | —                | R-11      |
| AC-32 | A browser pane under an animated resize uses the JPEG stand-in that splitter drags already use, and is live again, correctly sized, when the motion ends.                                                                                                                                                                                                     | capture:/@motion-browser-pane                                            | —                | R-11      |
| AC-33 | With `prefers-reduced-motion: reduce` every layout transition is off.                                                                                                                                                                                                                                                                                         | test:tests/pane-expand.test.ts::reduced motion                           | —                | R-11      |
| AC-34 | One PR `feat/floating-layout → main` is open, carrying the Delivery Report in its body; every unit PR is merged into `feat/floating-layout`.                                                                                                                                                                                                                  | record:pr                                                                | —                | R-1..R-11 |

## Open decisions

| id  | question                                             | options                                            | default               | status                                                                                             |
| --- | ---------------------------------------------------- | -------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- |
| D-1 | What does expand-to-window hide?                     | everything, session-only, both as a setting        | both as a setting     | resolved 2026-11-04: both as a setting, default `everything` (operator: "the options as they are") |
| D-2 | Where does "Return here" sit in the floating layout? | own island, inside the toolbar island, in the dock | own island            | resolved 2026-11-04: own island between the toolbar and the list, aligned on the shared grid       |
| D-3 | Is the app footer an island?                         | island, flush with panel look, flush on canvas     | flush with panel look | resolved 2026-11-04: flush, keeps `--color-surface` and the top rule                               |

## Amendments · Deviations

| date       | kind      | what changed                                                                                 | by           |
| ---------- | --------- | -------------------------------------------------------------------------------------------- | ------------ |
| 2026-11-05 | amendment | AC-16: "the Topbar split menu" → "a Topbar control" (SplitMenu.vue was removed by S-4, AC-9) | orchestrator |
