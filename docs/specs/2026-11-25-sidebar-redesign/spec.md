---
status: draft
tier: complex
mockup: docs/design/sidebar-redesign/
---

# Redesigned sidebar

Commit 0 of mission `mnt-0387322e` ("Ship the redesigned sidebar"). The visual contract is
`design.md` §6 ("Sidebar tree", "Folder View") plus the approved screens in
`docs/design/sidebar-redesign/`; the approvals and rejections are in
`docs/design/sidebar-redesign/decisions.md`. Slices S-1..S-6 are the mission's steps stp-2..stp-7,
stacked on `feat/sidebar-redesign` in that order.

## Problem

The sidebar nests repo groups, lineage and folders, takes a fourth column (the Fleet rail) to show
what needs the operator, offers three drill depths to find a folder, and opens a Folder View that
repeats what the sidebar already shows. The request, as approved in the mockup rounds:

- R-1 Checkouts sit flat under each folder header; worktrees with no session fold into one row.
- R-2 Trailing counts and chevrons share one aligned lane; session age leaves the rows; the mission chip is compact.
- R-3 Row states change only the left bar and the text colour, with no fill, no box and no layout shift.
- R-4 A working checkout is marked by a rail at its left edge.
- R-5 Needs attention is pinned above the list; Needs you and Return here sit in a bottom dock; the Fleet rail goes.
- R-6 Focus on one folder replaces drill-in.
- R-7 The Folder View keeps identity and actions only.
- R-8 One button collapses in three levels and shows which level it is on.

## Goals

- G-1 What is working, waiting or failed is readable from the tree, without a fourth column.
- G-2 Every row type shares one right edge and one set of states.

**Non-goals:**

- NG-1 No change to what a session, folder or worktree **is**: the path-keyed model, the watcher, the age filter and the sort stay (R-1).
- NG-2 No new colour, radius, easing or duration token; the dim working green is `--color-green` at 40% (R-4).
- NG-3 No change to the interceptor, the shadow log's data or its settings; moving the Would-have view into Settings is card T809 (R-5).
- NG-4 No change to what Needs you rows, parked confirms or Your move cards contain or do, only where they are drawn (R-5).
- NG-5 No change to the Topbar, the footer, the jump palette, the command palette or the helper stack (R-5, R-6).
- NG-6 No change to the session hover card; D-1 is open (R-2).
- NG-7 No rework of the Roadmap board, PR Stack or the explorer that the Folder View links to (R-7).
- NG-8 No new loader or skeleton for the tree; the existing empty, loading and filter states are reused (R-6).

**Anti-goals:** an approval, a failed session or an agent-opened pane that becomes harder to notice
than today; a row that moves when the pointer, the keyboard or a state change touches it.

**Readings the mockups do not draw.** The screens show the tree with sample data; these are the
spec's answers for what they leave out, so a slice does not invent its own. Anything not listed here
and not drawn keeps its current behaviour.

| Case                                                                    | Reading                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Repo-group header, parent-directory groups, worktree lineage nesting    | The folder header replaces the repo header; the other two are no longer drawn. Data and menus stay.           |
| New session, older and archived peeks of a folder row                   | In the checkout row's context menu.                                                                           |
| Unseen agent-panes pill, agent-blocked and orchestrator-default markers | Stay visible on the folder header.                                                                            |
| Subagent and teammate disclosure                                        | On their trailing count chips; the leading toggle slot goes.                                                  |
| Non-git folder                                                          | No checkout row; sessions directly under the header.                                                          |
| `stuck` sessions                                                        | Count as working for the ring and the rail; not listed in Needs attention.                                    |
| Compact density                                                         | Folder 26px, checkout and session 23px.                                                                       |
| Folder View of a worktree                                               | The same slim layout; there is one profile.                                                                   |
| Mission-grants strip of the Fleet rail                                  | Gone from the main screen; Settings → Control server lists and revokes grants.                                |
| Collapsed sidebar                                                       | Hides the dock too. The chime, the OS notification, the window-title count, the Activity bell and `⌘⇧A` stay. |

## Slices

### S-1 · Build the flat checkout tree

- mission step: stp-2
- depends-on: —
- substrate: worktree
- files-may-touch: `src/renderer/src/components/Sidebar.vue`, `src/renderer/src/components/SidebarFolder.vue`, `src/renderer/src/components/RepoGroupHeader.vue`, `src/renderer/src/components/SidebarShelvedSection.vue`, `src/renderer/src/components/Sidebar*.vue` (new row components), `src/renderer/src/components/FolderMenu.vue`, `src/renderer/src/components/SidebarHiddenPopover.vue`, `src/renderer/src/stores/ui.ts`, `src/renderer/src/components/sidebar-density.ts`, `src/renderer/src/lib/sidebar-tree.ts` (new), `src/renderer/src/lib/shelved-sidebar.ts`, `src/renderer/src/stores/folder-zones.ts`, `src/renderer/src/stores/session-cursor.ts`, `src/renderer/src/stores/sessions.ts`, `src/renderer/src/composables/useSidebarActions.ts`, `src/renderer/src/composables/useFolderMenuActions.ts`, `src/renderer/src/App.vue`, `src/renderer/src/styles/main.css`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/**`, `docs/user/folders-and-worktrees.md`, `docs/user/sessions.md`, `CHANGELOG.md`
- produces: flat-tree
- consumes: —
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9

### S-2 · Move row states to the tree guide bar

- mission step: stp-3
- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/renderer/src/components/Sidebar.vue`, `src/renderer/src/components/Sidebar*.vue`, `src/renderer/src/styles/main.css`, `tests/**`, `docs/user/sessions.md`, `CHANGELOG.md`
- produces: bar-states
- consumes: flat-tree
- acs: AC-10, AC-11, AC-12

### S-3 · Mark working checkouts with the group rail

- mission step: stp-4
- depends-on: S-2
- substrate: worktree
- files-may-touch: `src/renderer/src/components/Sidebar*.vue`, `src/renderer/src/lib/sidebar-tree.ts`, `src/renderer/src/styles/main.css`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/**`, `docs/user/sessions.md`, `CHANGELOG.md`
- produces: group-rail
- consumes: bar-states
- acs: AC-13, AC-14, AC-15

### S-4 · Add Needs attention and the bottom dock

- mission step: stp-5
- depends-on: S-3
- substrate: worktree
- files-may-touch: `src/renderer/src/App.vue`, `src/renderer/src/components/Sidebar.vue`, `src/renderer/src/components/Sidebar*.vue` (new attention and dock components), `src/renderer/src/components/InboxRail.vue`, `src/renderer/src/components/FleetBoardCard.vue`, `src/renderer/src/components/fleet-board.ts`, `src/renderer/src/lib/fleet-cards.ts`, `src/renderer/src/components/ApprovalRow.vue`, `src/renderer/src/components/McpConfirmRow.vue`, `src/renderer/src/components/SettingsDialog.vue`, `src/renderer/src/composables/useHoverPreview.ts`, `src/renderer/src/components/SidebarSection.vue`, `src/renderer/src/composables/useSidebarSections.ts`, `src/renderer/src/composables/useMissionGrants.ts`, `src/renderer/src/lib/sidebar-section.ts`, `src/renderer/src/stores/layout.ts`, `src/renderer/src/stores/sessions.ts`, `src/renderer/src/stores/ui.ts`, `src/main/keybindings-core.ts`, `src/renderer/src/styles/main.css`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/**`, `docs/user/approval-inbox.md`, `docs/user/sessions.md`, `docs/user/settings.md`, `CHANGELOG.md`
- produces: attention-dock
- consumes: group-rail
- acs: AC-16, AC-17, AC-18, AC-19, AC-20

### S-5 · Replace drill-in with Focus on one folder

- mission step: stp-6
- depends-on: S-4
- substrate: worktree
- files-may-touch: `src/renderer/src/components/Sidebar.vue`, `src/renderer/src/components/Sidebar*.vue`, `src/renderer/src/components/SidebarDrillView.vue`, `src/renderer/src/components/FolderMenu.vue`, `src/renderer/src/components/sidebar-density.ts`, `src/renderer/src/stores/sessions.ts`, `src/renderer/src/stores/session-cursor.ts`, `src/renderer/src/composables/useSidebarActions.ts`, `src/renderer/src/composables/useFolderMenuActions.ts`, `src/renderer/src/App.vue`, `src/main/keybindings-core.ts`, `src/renderer/src/styles/main.css`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/**`, `docs/user/folders-and-worktrees.md`, `docs/user/settings.md`, `CHANGELOG.md`
- produces: folder-focus
- consumes: attention-dock
- acs: AC-21, AC-22, AC-23, AC-24

Overlap: mission `mnt-17198171` (card T791 and its siblings) adds a loader at every drill level, and
this slice removes the drill levels. Before dispatching S-5, read that mission's state: whatever it
has merged into `main` by then is removed here along with the drill view, and what it has not merged
should not be built against drill-in.

### S-6 · Slim the Folder View to identity and actions

- mission step: stp-7
- depends-on: S-5
- substrate: worktree
- files-may-touch: `src/renderer/src/components/FolderView.vue`, `src/renderer/src/components/FolderViewSessions.vue`, `src/renderer/src/components/FolderViewRoadmap.vue`, `src/renderer/src/components/FolderViewWorktrees.vue`, `src/renderer/src/components/FolderViewFanout.vue`, `src/renderer/src/components/FolderViewOwnedCard.vue`, `src/renderer/src/components/folder-view-format.ts`, `src/renderer/src/components/ui/ScopeTag.vue`, `src/renderer/src/components/Sidebar*.vue`, `src/renderer/src/styles/themes.css`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/**`, `docs/user/folders-and-worktrees.md`, `design.md` (only to drop the two unused `--fv-*` tokens from §9), `CHANGELOG.md`
- produces: slim-folder-view
- consumes: folder-focus
- acs: AC-25, AC-26, AC-27

## Acceptance criteria

`capture:` proofs are screenshots of the running app (an isolated second instance,
`docs/dev/live-verify-second-instance.md`) compared with the named screen and state. The test files
named here are the ones each slice creates.

| id    | statement                                                                                                                                                                                                                                       | proof                                                                                                                              | refines/inherits | covers |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------ |
| AC-1  | Each repo or standalone folder draws one header with its checkouts directly under it, main first, then worktrees, then their sessions; no repo-group, parent-directory or lineage row exists and no checkout is indented past its siblings.     | test:tests/sidebar-tree.test.ts::renders flat checkouts under each folder header                                                   | —                | R-1    |
| AC-2  | Worktrees with no listed session fold into one "n idle worktrees" row that expands to them; the main checkout is never folded into it, and a worktree that gains a session leaves it.                                                           | test:tests/sidebar-tree.test.ts::folds sessionless worktrees into one row                                                          | —                | R-1    |
| AC-3  | Folder headers are 30px, checkout and session rows 26px at Comfortable, and the folder header stays on screen while its checkouts scroll.                                                                                                       | capture:sidebar@default                                                                                                            | —                | R-1    |
| AC-4  | The right edge of the value slot of folder and checkout rows and of the session icon slot is the same x in every row type, with the list scrolling or not, and every item is within 0.75px of its row's vertical centre.                        | capture:sidebar@checkout-folded                                                                                                    | —                | R-2    |
| AC-5  | Folder and checkout rows show their count at rest and the chevron in the same 24px box on hover or keyboard focus, with no layout shift.                                                                                                        | test:tests/sidebar-tree.test.ts::count and chevron share the value slot                                                            | —                | R-2    |
| AC-6  | Session rows show no age, context or branch, and the mission chip reads as the number owed to the operator at rest and its full text on hover or focus without changing the row's width.                                                        | test:tests/sidebar-tree.test.ts::session row has no age and a compact mission chip                                                 | —                | R-2    |
| AC-7  | The collapse button cycles everything open, sessions folded, folders folded, with three, two and zero level dots and a label naming the next click.                                                                                             | test:tests/sidebar-tree.test.ts::collapse button cycles three levels                                                               | —                | R-8    |
| AC-8  | Every action the removed rows offered (new session, older, archived, rename repo, reset name, shelved restore) and every always-visible folder signal is still reachable or visible from the header, a checkout row or its menu.                | test:tests/sidebar-tree.test.ts::keeps folder actions and signals                                                                  | —                | R-1    |
| AC-9  | Clicking a folder header opens its Folder View and never collapses it; the chevron is what collapses.                                                                                                                                           | test:tests/sidebar-tree.test.ts::header click selects, chevron collapses                                                           | AC-25            | R-7    |
| AC-10 | Hover, selected and keyboard focus on session rows, checkout rows and folder headers draw only the left bar of design.md "Row states" and light the label to the text colour; no fill and no outline box (the forced-colors fallback excepted). | capture:row-states@default                                                                                                         | —                | R-3    |
| AC-11 | No row changes height, padding, weight or the position of any item between rest, hover, selected and focus.                                                                                                                                     | test:tests/e2e/sidebar-row-states.spec.ts::no row moves between states                                                             | AC-10            | R-3    |
| AC-12 | The arrow-key cursor draws the same 3px bar as keyboard focus on every row type.                                                                                                                                                                | test:tests/sidebar-row-states.test.ts::cursor uses the focus bar                                                                   | AC-10            | R-3    |
| AC-13 | A checkout with a working (or stuck) session shows a rail of the success colour at 40% over its row and sessions, inset 2px, never joined to its neighbour; idle and done checkouts and folder headers show none.                               | capture:group-rail@separate-rails                                                                                                  | —                | R-4    |
| AC-14 | A needs-input session makes the rail the warning colour and a failed one the red, both at full strength, overriding working; needs-input beats failed.                                                                                          | test:tests/sidebar-tree.test.ts::rail takes the hottest session                                                                    | AC-13            | R-4    |
| AC-15 | The rail enters over --dur and leaves over --dur-slow with --ease, does not animate under reduced motion, ends on the same y as the group's tree guide, and its checkout row names the state to assistive tech.                                 | test:tests/sidebar-group-rail.test.ts::rail motion, geometry and label                                                             | AC-13            | R-4    |
| AC-16 | Needs attention lists only needs-input and failed sessions, needs-input first, as one 28px row each, from every folder; it is absent when there are none and a click lands on the session.                                                      | test:tests/sidebar-attention.test.ts::lists only needs-input and failed                                                            | —                | R-5    |
| AC-17 | Needs you and Return here are dock sections above Add folder, folded by default with label, count and age, absent when empty, and their open bodies hold the same rows, confirms and cards as before.                                           | test:tests/sidebar-dock.test.ts::needs you and return here sit in the dock                                                         | —                | R-5    |
| AC-18 | The Fleet rail, its minimized strip, divider, grants strip and Would-have section no longer render, and the shell has no fourth column.                                                                                                         | test:tests/sidebar-dock.test.ts::the fleet rail does not render                                                                    | —                | R-5    |
| AC-19 | The approvals shortcut, palette action and OS-notification deep-link open the dock's Needs you section, expanding a collapsed sidebar, and nothing opens it on its own; commands that only drove the rail are gone.                             | test:tests/sidebar-dock.test.ts::deep link and shortcut open needs you                                                             | AC-17            | R-5    |
| AC-20 | The dock sections are their own islands under Floating panels.                                                                                                                                                                                  | capture:sidebar@floating                                                                                                           | AC-17            | R-5    |
| AC-21 | Focus shows exactly one folder under a sticky "All folders" row that counts the other folders, how many need you and how many failed; the row returns to the full list.                                                                         | test:tests/sidebar-focus.test.ts::focus shows one folder under the back row                                                        | —                | R-6    |
| AC-22 | The drill-depth control, drill view, drill stack and its keybinding are gone from the code.                                                                                                                                                     | script:test ! -e src/renderer/src/components/SidebarDrillView.vue && ! grep -rq -e drillDepth -e drillStack -e cycleDrillDepth src | —                | R-6    |
| AC-23 | Selecting a session outside the focused folder leaves Focus; the focused folder survives a restart and is dropped when it no longer resolves.                                                                                                   | test:tests/sidebar-focus.test.ts::leaves and restores focus                                                                        | AC-21            | R-6    |
| AC-24 | The list keeps one row width with and without a scrollbar, so the value lane does not move when Focus is entered.                                                                                                                               | capture:sidebar@focus                                                                                                              | AC-4             | R-6    |
| AC-25 | A folder header click opens a Folder View with the folder's name, branch, git summary, path, the actions and, when the repo has a board, one roadmap line.                                                                                      | capture:folder-view@default                                                                                                        | —                | R-7    |
| AC-26 | The Folder View renders no count tile, worktree table, fan-out, sessions list, snapshot card, activity chart or owned card.                                                                                                                     | test:tests/folder-view.test.ts::renders identity and actions only                                                                  | AC-25            | R-7    |
| AC-27 | Every action of the old action bar is still one or two clicks away: New session, Terminal here, Browse files, Roadmap board, and under More: PR Stack, the editor and Open folder.                                                              | test:tests/folder-view.test.ts::keeps every action                                                                                 | AC-25            | R-7    |

Mission step criteria and where they are covered: stp-2 → AC-1, AC-2, AC-4, AC-5; stp-3 → AC-10,
AC-11; stp-4 → AC-13, AC-14; stp-5 → AC-16, AC-17, AC-18; stp-6 → AC-21, AC-22; stp-7 → AC-9 with
AC-25, AC-26.

## Open decisions

| id  | question                                                                                                                               | options                                           | default              | status |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------- | ------ |
| D-1 | Should the session hover card also show mission progress and the orchestrator role?                                                    | add both, leave the card as is                    | leave the card as is | open   |
| D-2 | With the sidebar collapsed, should a pending approval show anywhere on screen besides the Activity bell and the OS notification (R-5)? | nothing new, a count on the Topbar sidebar button | nothing new          | open   |
| D-3 | Parent-directory groups and lineage nesting stop being drawn (R-1). Keep it so?                                                        | drop, bring one back as a menu or header cue      | drop                 | open   |

None of the three gates a slice: each slice builds the default, and a different answer is a follow-up.

## Amendments · Deviations

Append-only after approval.

| date | kind | what changed | by  |
| ---- | ---- | ------------ | --- |
