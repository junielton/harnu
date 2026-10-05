# Sidebar: drill-in depth levels

Date: 2026-07-29
Status: Approved (design), pending implementation plan

Supersedes the on/off toggle introduced by
[`2026-07-19-sidebar-drill-in-navigation.md`](./2026-07-19-sidebar-drill-in-navigation.md),
which stays the reference for everything else about drill-in (screens, back
row, auto re-drill, toolbar anatomy).

## Problem

Drill-in navigation is binary today: either the classic always-expanded tree
(`drillModeEnabled === false`) or full one-screen-at-a-time navigation
(`true`), where every tier of the hierarchy costs another screen.

The full mode over-narrows for the most common way the operator actually
works. Wanting to focus on a single repo — "I only want to see Capy, nothing
else" — does not imply wanting to see one worktree at a time. Today, entering
the `Capy` group and then clicking `capy-brand` pushes a third screen that
hides the sibling worktrees, when what the operator wants at that point is the
classic behavior: `capy-brand` expands in place and its sessions appear
under it, with `feat-drag-n-drop` and `sidebar-drill-in` still visible above
and below.

There is no way to say "drill one level, then behave like the classic tree".

## Goals

- Make drill-in depth a settable level instead of a boolean, cycled from the
  same toolbar button (`0 → 1 → 2 → 0`).
- Level 1 drills into a group and then renders that group's folders exactly
  as the classic tree does inside a group — inline, expandable, sessions in
  place.
- Preserve today's behavior at level 2 and today's classic tree at level 0,
  including for operators who already have drill-in turned on (migration).
- Reuse the existing screens, rows, back row, and auto re-drill; add no new
  session/teammate/terminal rendering logic.

## Non-goals

- No new hierarchy tier. The tree is still group → folder → sessions, so the
  maximum meaningful depth is 2 and the cycle has exactly three states.
- No change to how folders are classified, sorted, or grouped
  (`folder-zones.ts`, `session-sort.ts` untouched).
- No per-folder or per-repo depth. The level is a single global sidebar
  preference.
- No keyboard shortcut for cycling the level (the button is the only
  affordance; the existing drill-mode shortcut gate in `App.vue` is unchanged).

## Design

### 1. Depth as a budget

`drillDepth: 0 | 1 | 2` replaces `drillModeEnabled: boolean` as the source of
truth. It is a **budget of drill screens**: a row on the current screen is
drillable only while `drillStack.length < drillDepth`. Once the budget is
spent, rows on that screen render as the classic tree instead
(`RepoGroupHeader` / `SidebarFolder`), inline and expandable.

| `drillDepth` | Root screen                     | Inside a group screen                                   |
| ------------ | ------------------------------- | ------------------------------------------------------- |
| `0`          | — (classic tree, no drill view) | —                                                       |
| `1`          | drillable rows                  | folders render **inline** (`SidebarFolder`, expandable) |
| `2`          | drillable rows                  | drillable rows → folder screen (today's behavior)       |

A standalone (ungrouped) folder on the root screen stays **drillable at
level 1** — it spends the single available step and opens its own session
screen. The alternative (expanding it inline at root) would leave level 1
with no drill step at all for folders that have no group.

`drillModeEnabled` survives as `computed(() => drillDepth.value > 0)` so
every existing consumer keeps working untouched: `App.vue`'s keyboard-shortcut
gate, `Sidebar.vue`'s classic-tree `v-if`, and
`stores/session-cursor.ts`.

### 2. Store (`stores/sessions.ts`)

- `drillDepth` is a `persistedRef<number>` under `om2tab.sidebarDrillDepth`,
  clamped to `0..DRILL_MAX_DEPTH` (`2`) on read, default `0`.
- **Migration:** when `om2tab.sidebarDrillDepth` is absent and the legacy
  `om2tab.sidebarDrillMode` is `true`, the initial value is `2` — an operator
  who already runs drill-in keeps exactly the behavior they had. A legacy
  value of `false`/absent yields `0`. The legacy key is read once and not
  written back.
- `toggleDrillMode()` becomes **`cycleDrillDepth()`**: `(drillDepth + 1) % 3`.
  On the transition to a non-zero level with a session selected, it seeds
  `drillStack` from `drillNodeStackForSession(selectedId)` (already clamped,
  see below); on the transition to `0` it clears `drillStack`.
- `drillNodeStackForSession(sessionId)` gains a trailing
  `.slice(0, drillDepth.value)`. This is what makes auto re-drill land on the
  right screen per level: at level 1, selecting a session in `capy-brand`
  resolves to `[{kind:'group', key:'Capy'}]` — the group screen, with
  `capy-brand` expanded inline by the watcher's existing
  `folder.expanded = true`.
- `drillIntoGroup(key)` / `drillIntoFolder(path)` no-op when
  `drillStack.length >= drillDepth`. Defensive only — the view does not
  render a drillable row past the budget.
- Lowering the level truncates the stack (`drillStack.value =
drillStack.value.slice(0, drillDepth.value)`), so the operator is never
  stranded on a screen the current level cannot reach.

### 3. View (`SidebarDrillView.vue`)

One new predicate, `canDrill = computed(() => sessions.drillStack.length <
sessions.drillDepth)`, gates each screen's row rendering:

- **Root screen** — `canDrill` is always true at levels 1 and 2 (stack is
  empty). Unchanged: drillable rows for groups and standalone folders.
- **Group screen** — when `canDrill`, today's drillable folder rows. When not
  (level 1), render `<SidebarFolder :folder="f" nested />` for each member
  folder: the identical component and props the classic tree uses inside a
  group, so expansion state, session rows, teammate nesting, terminals, and
  the inline action cluster all come along unchanged.
- **Folder screen** — unchanged (`SidebarFolder … headerless`).

The back row is unchanged on both screens, including the folder screen's
trailing peek/`+` cluster.

### 4. Toolbar (`Sidebar.vue`)

The drill button becomes a **three-state icon button** cycling on click:

| Level | Icon       | Style                         |
| ----- | ---------- | ----------------------------- |
| `0`   | `ListTree` | ghost (`text-4`)              |
| `1`   | `Columns2` | `accent-soft` bg, `accent` fg |
| `2`   | `Columns3` | `accent-soft` bg, `accent` fg |

Both icons already ship with `lucide-vue-next` — no new dependency. The
progression stays inside the "column view" metaphor `design.md` §6 already
selected for this button.

Accessibility: `aria-pressed` (a binary property) is replaced by an explicit
`aria-label` naming the level. Tooltip and label come from one key with the
level interpolated.

**Collapse-all becomes visible again at level 1.** Its current
`v-if="!sessions.drillModeEnabled"` becomes `v-if="sessions.drillDepth < 2"`:
level 1 renders inline, expandable folders inside group screens, so
expand/collapse-all has something to act on. At level 2 nothing inline exists
and the button stays hidden, as `design.md` §6 already argues.

### 5. Copy & docs

- New i18n key for the toolbar button label/tooltip, carrying the level
  (e.g. `sidebar.toolbar.drillLevel`), added to **both** `en.json` and
  `pt-BR.json` in the same change. Level `0` keeps using the existing
  `sidebar.toolbar.drillOn` ("turn on") wording; levels `1`/`2` describe the
  current depth and that clicking advances it. The now-unused
  `sidebar.toolbar.drillOff` is removed from both locales.
- `design.md` §6 — "Sidebar toolbar" item 2 rewritten from two-state to
  three-state; the "Drill-in navigation" section gains the depth table and the
  level-1 inline behavior; the collapse-all hiding rule updated to
  `drillDepth === 2`.
- `CHANGELOG.md` — one bullet under `### Changed`.
- `docs/user/folders-and-worktrees.md` — the drill-in paragraph updated to
  describe the three levels.

Not agent-facing: no MCP verb, ACK shape, grant semantics, or agent-offerable
affordance changes, so `docs/capy-features.md` is untouched.

## Testing

Extends the existing suites rather than adding new files:

- `tests/sidebar-drill-view.test.ts` — at level 2 a group screen renders
  drillable folder rows (`[data-drill-folder-row]`); at level 1 the same
  screen renders `SidebarFolder` inline instead, and clicking a folder
  expands it in place rather than pushing onto `drillStack`.
- `tests/sidebar-toolbar.test.ts` — clicking the drill button cycles
  `0 → 1 → 2 → 0`; the rendered icon and `aria-label` match the level;
  collapse-all is present at levels 0 and 1 and absent at level 2.
- Store unit tests — `drillNodeStackForSession` clamps to `drillDepth`
  (grouped folder at level 1 resolves to the group node only); lowering the
  level truncates `drillStack`; the legacy `sidebarDrillMode === true`
  migrates to `2` and an absent/`false` legacy key to `0`.
- `tests/sidebar-cursor-drill-gate.test.ts` — still passes unchanged, proving
  the `drillModeEnabled` computed preserves the existing cursor gate.
- Manual: cycle the button through all three levels with a session selected in
  a grouped worktree; confirm level 1 lands on the group screen with the
  owning folder expanded inline and its siblings still listed.
