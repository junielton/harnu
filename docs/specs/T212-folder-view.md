# T212 — Folder View: clicking a folder opens its view

**Status:** implemented
**Date:** 2026-08-26

## Problem

Clicking a folder row in the sidebar only expands/collapses it. For a folder with
zero sessions that expands into nothing, so the click reads as "nothing happened".

Behind that symptom sits a structural gap: **Capy has no concept of a selected
folder.** The only selection is `sessions.selectedId` (a session). Three
consequences, all verifiable in the current code:

1. `Topbar.vue:334` gates the entire right-hand action cluster behind
   `v-if="sessions.selectedSession"`.
2. Every one of those actions is in fact **folder-scoped** — Roadmap board, PR
   Stack, Open folder, Open in VS Code, Browse files all read
   `sessions.selectedSession?.projectPath` purely to derive a folder path
   (`Topbar.vue:161,177,199,205,215,227`).
3. Therefore a folder with no session can reach none of them. You must create a
   session just to open that folder's board.

The folder is already a first-class entity in the model (`Folder`, path-keyed,
the sidebar's primary row). It is not a first-class entity in the UI.

## Goal

Make folder click symmetric with session click: clicking a session opens the
session, clicking a folder opens the folder's view.

## Non-goals (YAGNI)

Recent commits list, a PR list (PR Stack Canvas already owns that), per-folder
usage charts, inline memory editing, drag-and-drop of sessions between folders.
None of these answer "what is happening here, and what do I do next".

---

## A. Selection model

Add `selectedFolderPath: string | null` to the sessions store alongside the
existing `selectedId`. The two are **mutually exclusive by construction**, not by
vigilance — the invariant lives in the two setters:

```ts
function select(id: string): void {
  selectedId.value = id
  selectedFolderPath.value = null
}

function selectFolder(path: string): void {
  selectedFolderPath.value = path
  selectedId.value = null
}
```

Both null → the existing global `EmptyState`.

**Selecting a folder kills no PTY.** `TerminalPane` treats `selectedId → null` as
`detachCurrent()` — a detach, never a dispose (see CLAUDE.md, "Terminal embedding
… switching sessions detaches, it does not dispose"). Every background session
keeps its PTY, its scrollback and its conversation. Clicking a folder is free.

### Folder row click

`SidebarFolder.vue:458` currently binds `@click="toggle"`. It becomes:

```ts
function onFolderClick(): void {
  sessions.selectFolder(folder.path)
  if (!expanded.value) toggle() // first click also expands; never auto-collapses
}
```

- 1st click: selects (view opens) **and** expands.
- 2nd click: collapses. Selection is unchanged, the view stays open.
- The chevron keeps its own independent toggle.
- Keyboard: `Enter` on a focused folder row does the same as a click. The
  existing `data-focused` / `folderFocused` plumbing is reused unchanged.

The inline action cluster (`SidebarFolder.vue:552-587`) keeps `@click.stop`, so
the peek and `+` affordances never leak into folder selection.

### Falling back to the folder

Closing the last session of a folder selects that folder (its view) instead of
dropping to the global `EmptyState`. Same for closing any session whose folder
still exists — the operator stays in context rather than being thrown to a
neutral screen.

---

## B. `activeFolderPath` — the structural fix

A single computed in the sessions store:

```ts
const activeFolderPath = computed<string | null>(
  () => selectedFolderPath.value ?? selectedSession.value?.projectPath ?? null
)
```

All six folder-scoped Topbar handlers resolve from this instead of
`sessions.selectedSession?.projectPath`:

| Handler                              | Line today       |
| ------------------------------------ | ---------------- |
| `onSplitClick` (shell in folder)     | `Topbar.vue:161` |
| `onOpenExplorerClick` (Browse files) | `Topbar.vue:177` |
| `onRoadmapClick`                     | `Topbar.vue:199` |
| `onPrStackClick`                     | `Topbar.vue:205` |
| `onOpenFolderClick`                  | `Topbar.vue:215` |
| `onOpenInVSCodeClick`                | `Topbar.vue:227` |

This change stands on its own: it fixes the "no actions without a session" bug
even before the view exists.

### Helper stack must render next to the Folder View

`addExplorerHelper(root, cwd)` and `addShellHelper` key panes by **worktree
path**, so they already accept a folder path. But `showHelperStack` (`App.vue:305`)
only allows the helper column next to views where a pane makes sense (Roadmap
board or terminal). The Folder View joins that list — otherwise "Browse files"
with a folder selected opens a pane that never renders.

### Folder terminal

`sessions.createFolderTerminal(folderPath)` already exists
(`sessions.ts:2814`) and already returns a session id for a shell in the folder's
cwd. The Topbar terminal button and the Folder View action bar both call it when
the active selection is a folder (rather than `addShellHelper`, which needs a
session's split stack).

---

## C. Topbar with a folder selected

The `v-if="sessions.selectedSession"` block splits into two branches driven by
which kind of thing is selected:

```
FOLDER selected:
 ◫  📁 example-app  ⎇ main · ✎3 ↑1        [🔔][+ new][kanban][PR][📂][</>][🌳][>_]

SESSION selected (unchanged from today):
 ◫  📁 example-app › Refactor auth        [🔔][kanban][PR][📂][</>][🌳][>_][◫]
```

- Breadcrumb becomes folder alias + branch; there is no session title to edit, so
  the `contenteditable` title, the provider badge and the orchestrator pill are
  hidden.
- The action cluster renders identically and operates on `activeFolderPath`.
- A `+ New session` button appears in the folder branch only (with a session
  selected, `⌘N` and the sidebar `+` already cover it).
- The helper-panel toggle keeps its existing `v-if="helpers.hasHelpersForCurrentWorktree"`
  guard, now evaluated against the active folder.
- `ActivityBell` stays outside both branches, as today.

---

## D. `FolderView.vue` — a selection-driven view, not a sixth takeover

The five existing takeovers form their own mutex (`ui.closeAllTakeovers`). The
Folder View is **not** one of them: it is driven by selection, exactly like
`TerminalPane`. It slots into the `App.vue` chain after the takeovers and before
`EmptyState`:

```
CleanupView → PrStackCanvas → UsageDashboard → SystemMonitor → RoadmapBoard
→ Onboarding → FolderView → EmptyState → CloudSessionPanel → TerminalPane
```

Guard changes in `App.vue`:

```ts
const showFolder = computed(() => !showOnboarding.value && !!sessions.selectedFolderPath)
const showEmpty = computed(
  () => !showOnboarding.value && !sessions.selectedId && !sessions.selectedFolderPath
)
```

Consequence, which is the desired one: opening the Roadmap board from a selected
folder shows the board (a takeover wins), and closing it returns to the folder
view (the selection was never lost).

### Layout

Single scrollable column, content capped at ~880px, sections stacked in priority
order:

```
┌ 📁 example-app ────────────────────────── ⎇ main · main worktree · ✎3 ↑1 ┐
│ ~/Workspace/me/example-app                                          │
├──────────────────────────────────────────────────────────────────────┤
│ [ + New session ]  [kanban] [PR Stack] [Browse] [VS Code] [📂] [>_]   │
├──────────────────────────────────────────────────────────────────────┤
│ WHERE WE LEFT OFF                              (hot.md, collapsible) │
│ Worktree provider migration stalled on the seed step…                │
├──────────────────────────────────────────────────────────────────────┤
│ SESSIONS (0)                                                         │
│   No sessions here yet.   [ + New session ]                          │
│   ▸ Older (12)      ▸ Archived (3)                                   │
├──────────────────────────────────────────────────────────────────────┤
│ ROADMAP   backlog 7 · ready 2 · in-progress 1 · review 3              │
│   ▶ T210 worktree-steps-pipeline      in-progress · session bound    │
│   ◆ T199 statusline-rate-limits       review                         │
├──────────────────────────────────────────────────────────────────────┤
│ WORKTREES IN THIS REPO                                               │
│   ⎇ main (this) · ⎇ feat/t210 ↳ cut from here · ⎇ fix/bug-81         │
└──────────────────────────────────────────────────────────────────────┘
```

**1. Header.** Alias (`displayAlias`), absolute path, branch, worktree kind badge
(main worktree / worktree), dirty count, ahead/behind. Same fields
`FolderPreview.vue` already renders, at reading size.

**2. Action bar.** New session (primary), Roadmap, PR Stack, Browse files, VS
Code, Open folder (OS), Terminal here. Deliberately duplicates the Topbar: the
view is the folder's home, and a home screen that makes you look elsewhere for
its verbs is not a home screen.

**3. Where we left off.** The `hot.md` cue, rendered through
`MarkdownRenderer`. Section is omitted entirely when the repo has no memory or
the read is denied — never an empty box.

**4. Sessions.** Rows carrying status dot, title (`summary || firstPrompt`), last
activity, and the existing chips (orchestrator crown, teammates). Click →
`sessions.select(id)`, the same call the sidebar row makes. With zero sessions the
section becomes an inline empty state plus the CTA.

**5. Older / Archived.** Collapsed sections that expand in place, with counts.
These retire the discoverability problem of the hover-gated peeks — the peeks in
`SidebarFolder.vue:552-587` stay as a shortcut, but stop being the only path.

**6. Roadmap.** Per-column counts, plus every `in-progress` and `review` card
named and clickable (opens the board). Answers "what is running here" without
opening the board.

**7. Worktrees.** Sibling worktrees of the same repo, and children cut from this
folder, using the lineage data already in `stores/folder-zones.ts`.

---

## E. Data sources

Everything the view needs already exists in the renderer, with exactly one
exception.

| Section                     | Source                                                                                                         | New work           |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------ |
| Header + git                | `window.api.foldersGitStatus(path)` (throttled probe, called once on open, same discipline as `FolderPreview`) | none               |
| Where we left off           | `memory.peek(path)` for the warm paint, `memory.load(path)` to refresh                                         | none               |
| Sessions / Older / Archived | `folder.sessions` + `sessions.isArchived`                                                                      | none               |
| Worktrees / lineage         | `groupByRepo` + `bornFrom` (`stores/folder-zones.ts:48,408`)                                                   | none               |
| **Roadmap**                 | `roadmapLoad(folder)` **re-targets the roadmap watcher** at that folder                                        | **`roadmap:peek`** |

### The one new main-process surface: `roadmap:peek`

`roadmapLoad` is not a pure read — it resolves the repo that owns
`.capy/memory/roadmap/` and **re-targets the watcher there**
(`preload/index.ts:1228-1231`). Calling it just to render counts would let opening
one folder's view hijack the watcher backing another folder's open board.

Add a read-only `roadmap:peek` to `roadmap-ipc.ts` returning
`{ counts: Record<Status, number>, active: CardSummary[] }` — counts per column
plus the `in-progress` / `review` cards — with **no watcher side effect**. It
lives inside the existing `roadmap-ipc.ts`, so it adds no new top-level
main-process file.

Degradation: a folder with no `.capy/memory/roadmap/` resolves to empty counts and
the Roadmap section is omitted, exactly like the memory cue.

---

## F. Testing

- **Store unit tests:** `select` / `selectFolder` mutual exclusion; `activeFolderPath`
  resolution across all four states (folder / session / both-null / session in a
  folder); fallback-to-folder on closing the last session.
- **Component tests:** `FolderView` with zero sessions (CTA present, Older/Archived
  hidden when zero), with sessions, with no memory (section absent), with no
  roadmap (section absent).
- **Topbar test:** the folder branch renders the action cluster and the session
  branch is unchanged; both resolve handlers through `activeFolderPath`.
- **Regression to protect explicitly:** selecting a folder while a session is
  running must not dispose that session's `LiveTerminal`. Assert `ptyDestroy` is
  never called on a folder selection.
- **`roadmap:peek`:** returns correct counts and does not move the watcher target
  (assert the watcher's folder is unchanged across a peek).

## G. Repo contracts this change triggers

- `CHANGELOG.md` — mandatory entry.
- `docs/user/` — **the CI gate fires**: `FolderView.vue` is a new top-level
  component. `docs/user/` gains the folder-view flow.
- `design.md` §6 — new component section (Folder View), plus the Topbar
  folder-branch variant; and a row in the CLAUDE.md "Design entity → file map".
- `en.json` **and** `pt-BR.json` in the same change — schema parity is enforced by
  `vue-tsc`.
- `docs/capy-features.md` — **not** triggered. No new or changed MCP verb, no ACK
  shape change, no grant/confirm semantics, and nothing here is an affordance the
  agent proactively offers the operator. `roadmap:peek` is renderer-facing IPC, not
  an agent verb.

## H. Files touched

| File                                                                            | Change                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/renderer/src/stores/sessions.ts`                                           | `selectedFolderPath`, `selectFolder`, `activeFolderPath`, fallback-to-folder |
| `src/renderer/src/components/SidebarFolder.vue`                                 | folder row click → select + expand; `Enter` key                              |
| `src/renderer/src/components/FolderView.vue`                                    | **new**                                                                      |
| `src/renderer/src/components/Topbar.vue`                                        | folder branch; six handlers via `activeFolderPath`                           |
| `src/renderer/src/App.vue`                                                      | `showFolder`, `showEmpty`, view chain, `showHelperStack`                     |
| `src/main/roadmap-ipc.ts`                                                       | `roadmap:peek`                                                               |
| `src/preload/index.ts`                                                          | `roadmapPeek`                                                                |
| `design.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/user/`, `en.json`, `pt-BR.json` | contracts                                                                    |
