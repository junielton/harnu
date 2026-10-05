# Sidebar: reactive selection sync + optional drill-in navigation

Date: 2026-07-19
Status: Approved (design), pending implementation plan

## Problem

The sidebar does not reliably reflect the selected session. Only 4 of the
~14 call sites that change `sessions.selectedId` route through
`activateSession()` (`stores/sessions.ts:2850-2862`), which is the only path
that expands the owning folder, expands the teammate group, moves the
keyboard cursor, and reveals/scrolls to the row. The other ~10 call sites
(`CommandPalette.vue`, `SessionMenu.vue`, `EmptyState.vue`, `MemoryPane.vue`,
`RoadmapBoard.vue`, `FleetBoardCard.vue`, `ApprovalRow.vue`, `App.vue`,
`SidebarFolder.vue`) call the bare `select(id)` and leave the sidebar
untouched — a session can become selected while its row is collapsed,
filtered out, or off-screen. Additionally, `activateSession` itself never
expands a collapsed **repo-group**, so a session inside a grouped worktree
can be selected into a row that isn't rendered at all.

Separately, the user wants an optional "drill-in" navigation mode for the
sidebar (mobile-menu style: tap a folder, the list swaps to show only that
folder's contents, with a back control) as an alternative to the always-
expanded classic tree — toggleable, not the default.

Both problems intersect: whatever makes the sidebar reactive to selection
must also work correctly when drill-in is engaged.

## Goals

- Any code path that sets `selectedId` results in the sidebar reflecting
  that selection: owning repo-group and folder expanded (or drilled into),
  teammate group expanded if applicable, row scrolled into view.
- Add an optional, persisted "drill-in" sidebar mode: navigate one screen
  at a time (root list → folder's sessions) instead of an always-expanded
  tree, with a back control.
- When drill-in is engaged and a selection lands outside the currently
  drilled screen, the sidebar re-drills automatically to the folder that
  owns the new selection.
- Replace the sidebar's hidden `⋯` overflow menu with an exposed icon
  toolbar row: drill-mode toggle, collapse-all, hidden-folders.
- No new npm package — icons come from `lucide-vue-next`, already a
  dependency.

## Non-goals

- Drill-in does not add a third navigation level for teammate/subagent
  groups — those still render nested inside a folder's session list
  exactly as `SidebarFolder.vue` renders them today (reusing
  `buildSessionRows` from `components/teammate-grouping.ts`).
- No change to how folders are classified, sorted, or grouped
  (`folder-zones.ts`, `session-sort.ts` are untouched).
- No change to `SidebarFolder.vue`'s row rendering logic for sessions,
  teammates, or terminals — drill-in's level-1 screen reuses that logic,
  it does not reimplement it.
- Keyboard cursor behavior (`session-cursor.ts`) adapting to the active
  drill screen is an implementation detail for the plan, not specified
  further here.

## Design

### 1. Reactive sync via a central watcher

A single `watch(selectedId, ...)` is set up once inside `stores/sessions.ts`
(not in `Sidebar.vue`) so it fires regardless of whether the sidebar is
mounted, and covers every `select()` call site — not just `activateSession`
callers.

On every change to `selectedId` (to a non-null value):

1. Resolve the session's owning folder, and that folder's repo-group (if
   any) and teammate-lead group (if the session is a teammate/subagent).
2. Expand the repo-group: `collapsedRepoGroupsSet.delete(repoId)` — this is
   new behavior; `activateSession` does not do this today.
3. Expand the folder: `folder.expanded = true`.
4. Expand the teammate group if applicable (same lookup `activateSession`
   already does via `teamHex`).
5. If drill-in mode is enabled, replace `drillStack` to point at the
   session's folder (see §3, "auto re-drill").
6. Set `revealSessionId` — reuses the existing reveal/scroll mechanism
   already wired in `Sidebar.vue:37-61`.

`activateSession()` is simplified to just: clear an active filter that
would hide the session, move the keyboard cursor, and call `select(id)`.
The expand/reveal work it used to do inline moves into the watcher, so it
now happens for `select()` callers too.

### 2. Drill-in mode — state

New store state in `stores/sessions.ts`:

- `drillModeEnabled: Ref<boolean>` — persisted to `localStorage` under
  `om2tab.sidebarDrillMode`, default `false`.
- `drillStack: Ref<DrillNode[]>` where
  `DrillNode = { kind: 'repo'; repoId: string } | { kind: 'folder'; path: string }`
  — transient, not persisted (resets to root on app restart; avoids
  pointing at a folder that no longer exists).

Navigation:

- **Root** (`drillStack` empty): the same top-level entries as today's
  `visibleFolders` root — repo-groups (rendered as a single drillable row,
  not inline-expanded) and standalone folders — same ordering as today.
- Clicking a repo-group row pushes `{kind:'repo', repoId}` → shows that
  repo's folders (worktrees) as rows.
- Clicking a folder row (from root or from inside a repo screen) pushes
  `{kind:'folder', path}` → shows that folder's session rows, produced by
  the same `buildSessionRows(...)` call `SidebarFolder.vue` already makes,
  so teammate nesting and the "+ New session" row are unchanged.
- A folder that itself has nested child folders (the existing `nestByPath`
  1-level path-containment case) renders those child folders as further
  drillable rows inside its own screen — no new stack semantics, it is
  just another `{kind:'folder'}` push.
- Back control (`‹`) pops the last `drillStack` entry.
- Toggling drill-in **on** while a session is selected immediately drills
  to that session's folder (reusing the same resolver as the watcher).
  Toggling **off** clears `drillStack` (returns to the classic tree, which
  independently reflects `folder.expanded`/`collapsedRepoGroupsSet` as it
  does today).

### 3. Auto re-drill on cross-folder selection

Part of the same `watch(selectedId, ...)` from §1: when `drillModeEnabled`
is `true`, the watcher recomputes and replaces `drillStack` to point
directly at the new selection's folder screen — skipping the intermediate
repo-chooser screen even if the folder belongs to a repo-group. E.g.
selecting a session in `wt-t168` while looking at `main`'s sessions jumps
straight to `wt-t168`'s session list, not to a "pick a worktree" screen.

### 4. Toolbar

Replaces the `⋯` trigger (`Sidebar.vue:189-209`) and retires
`SidebarSectionMenu.vue` entirely. Three icon buttons sit in a row between
the header and `SidebarReturnZone`, same ghost-icon-button visual pattern
as the header's search button:

1. **Drill toggle** — two-state icon button (not a switch): `ListTree`
   (off / classic tree) ↔ `Columns3` (on / drill-in), both already
   available in `lucide-vue-next@^1.0.0`. Pressed state uses the existing
   `accent-soft` background + `accent` icon color convention. Calls
   `sessions.toggleDrillMode()`.
2. **Collapse all** — same `ChevronsDownUp`/expand-collapse icon and
   `expandAll()`/`collapseAll()` behavior as today's menu item, now
   inline.
3. **Hidden (N)** — icon button with a count badge (omitted when count is
   `0`; button stays present but inert at `0`). Click opens a small
   popover anchored to the button — same hidden-folders list and
   click-to-unhide behavior as today's disclosure, just relocated out of
   the `⋯` menu into its own popover (`SidebarHiddenPopover.vue`),
   repurposing the existing anchored-popover state shape in `stores/ui.ts`
   (`sidebarMenu` → `sidebarHiddenPopover`).

`SidebarSectionMenu.vue` is deleted. `ui.sidebarMenu` /
`openSidebarMenu` / `closeSidebarMenu` are replaced by the equivalent
single-item popover state.

## Visual reference

Mockups for the three sidebar states (classic tree, drill-in root,
drill-in level 1) and the three drill-toggle icon-pair options considered
are in Paper: https://app.paper.design/file/01KXY5YZB2662SHFM15DMSJX72

Icon pair **A — `ListTree` ↔ `Columns3`** was selected (evokes macOS
Finder's column view, the clearest available metaphor for one-screen-at-a-
time navigation).

## Testing

- Unit: the `selectedId` watcher resolves the correct repo-group / folder /
  teammate-group for a session and expands them; verify it fires for a
  plain `select()` call, not just `activateSession()`.
- Unit: `drillStack` push/pop transitions (root → repo → folder, back).
- Unit: auto re-drill replaces `drillStack` correctly when selection moves
  to a session in a different folder/repo while drill mode is on.
- Manual/UI: toggle drill mode on/off via the new toolbar button; click
  through repo → folder → session; use the back control; click a
  notification/command-palette/board-card selection while drilled into an
  unrelated folder and confirm auto re-drill lands on the right screen;
  confirm the Hidden popover still lists and unhides folders correctly.

## Open implementation details (left to the plan)

- Exact `DrillNode` resolution helper (shared by the watcher and the
  toggle-on jump) — one function, used from both places.
- How `useSidebarCursor` (`stores/session-cursor.ts`) sources its list when
  drill mode is active (root screen list vs. current drill screen's rows)
  instead of always `visibleFolders`.
- Whether `SidebarHiddenPopover.vue` is a new small component or an inline
  template block in `Sidebar.vue` — a plan-time call, not a design one.
