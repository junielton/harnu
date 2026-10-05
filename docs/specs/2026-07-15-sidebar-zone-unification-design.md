# Sidebar zone unification — remove pinned/active-elsewhere split (design)

**Date:** 2026-07-15 · **Status:** approved in brainstorming, pending implementation plan

## Problem

The classic sidebar splits folders into two sections — **FOLDERS** (pinned) and **ACTIVE
ELSEWHERE** (auto-discovered active) — each independently grouped by repo. When a repo has
both a pinned worktree and a merely-active unpinned sibling worktree, each zone's own
`groupByRepo` pass produces its own repo-group header, so the same repo renders twice (e.g.
"ProjectAlpha" under both FOLDERS and ACTIVE ELSEWHERE). Verified against this machine's
real data: 2 of 6 currently-pinned repos duplicate right now, including this repo (`capy`).

Hide/unhide compounds the confusion: `dismissFolder` (Hide) unpins and hides a folder
atomically, but `unhideFolder` only clears the hidden flag — it never re-pins. Pin → Hide →
Unhide therefore returns the folder with `pinned: false`, which relocates it into "active
elsewhere" (if it still has a recent session) or makes it vanish entirely (if not).

The bento and drill-in sidebar layouts (T90/T95, T119) share the same zone-split
architecture — bento renders the same two-section template; drill-in concatenates the two
already-grouped zone arrays, so the identical duplicate-header defect is latent there as
"Spaces" rows instead of section headers. Per operator judgment, none of the three shipped
layouts (classic/bento/drill-in) fully satisfies the need going forward.

## Scope

- **Remove** the bento and drill-in sidebar layouts entirely — not hidden behind a flag.
  Classic becomes the only sidebar; a future redesign starts clean rather than layering onto
  half-finished code. This supersedes T90, T95, and T119 (roadmap history is left as-is;
  those layouts simply no longer exist in the app).
- **Fix classic**: one flat folder list, no FOLDERS/ACTIVE ELSEWHERE section split, no visual
  distinction between pinned and discovered folders.
- **Fix the store**: a single classify-and-group pass over the whole visible folder set,
  instead of two independent zone computeds.
- **Fix hide/unhide**: decouple `hidden` from `pinned`.

Decisions fixed during brainstorming:

| Decision                                 | Choice                                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Visual distinction pinned vs. discovered | None — fully flat, uniform rows                                                                                       |
| Scope                                    | Remove bento + drill-in entirely (not hidden behind a flag)                                                           |
| Grouping                                 | Single `groupByRepo` pass over the full visible set (pinned ∪ active, minus hidden)                                   |
| Hide semantics                           | Decoupled from pin — hide only sets `hidden`; unhide only clears it                                                   |
| `pinned` + `hidden` invariant            | Relaxed: both can be true; `hidden` still wins in render precedence (unchanged: `hidden > pinned > active > stale`)   |
| Auto-cleanup lifecycle                   | Unchanged — pinned folders never go `stale`; unpinned folders still vanish after `activeWindowMs` (48h) of inactivity |

## Store — `src/renderer/src/stores/folder-zones.ts` + `stores/sessions.ts`

- `classifyFolder` keeps its four-branch logic (`hidden > pinned > active > stale`)
  unchanged — only its **consumption** changes.
- Replace `sessions.pinnedZone` (`sessions.ts:1935-1957`) and `sessions.activeZone`
  (`:1965-1978`) with one `sessions.visibleFolders` computed: filter `folders.value` to
  `classifyFolder(f, ctx)` in `{'pinned', 'active'}`, run `sortFolders` once, then
  `groupByRepo` once over the combined array, then `nestByPath` once. This is the actual bug
  fix — a repo with members that used to fall in both zones now yields exactly one
  `RepoGroup`.
- `groupByRepo` / `nestByPath` need no signature change — they already take a `Folder[]`;
  they're just called once instead of twice.
- Collapse `SidebarLayout` (`sessions.ts:521`) to drop `'bento'` and `'drill-in'`. Prefer
  removing the `sidebarLayout` setting and its persisted ref entirely — a single-option
  toggle has nothing to choose between (YAGNI) — over keeping a vestigial one-value enum.
- Remove `zonesCollapsed` (localStorage `om2tab.zonesCollapsed`, `sessions.ts:563`) and its
  toggle — that was per-zone collapse state (FOLDERS collapsed independently of ACTIVE
  ELSEWHERE); with one list there is no zone left to collapse. `repoGroupsCollapsed` (per
  repo-group collapse) is unrelated and stays untouched.

## Hide/unhide — `stores/sessions.ts`

- `dismissFolder` (`:2819-2827`, the "Hide" action): stop calling `userProjectsRemove`
  (unpin). Only call `userProjectsHide`. A pinned folder can now be hidden while remaining
  pinned underneath.
- `unhideFolder` (`:2833-2836`): unchanged — it already only touches `hiddenPaths`. With the
  fix above, a folder that was pinned before being hidden now correctly reappears pinned
  after unhide — no more relocation into "active" and no more vanishing.
- `pinFolder` (`:2784-2812`): keep unhiding on pin (still correct — pinning something you're
  actively hiding should surface it).
- Update or remove the "a folder is never both pinned and hidden" invariant comment wherever
  it's asserted in the codebase — replace with "hidden always wins at render time, regardless
  of pinned," which is already true via `classifyFolder`'s branch order and needs no new code.

## Rendering — `Sidebar.vue`

- Collapse the two `v-for` blocks (pinned `:367-384`, active `:443+`) into one, iterating
  `sessions.visibleFolders`. Each item still resolves through the existing
  `RepoGroupHeader.vue` / `FolderNest` / plain-folder branches unchanged — those components
  are already zone-agnostic.
- Remove the "FOLDERS" / "ACTIVE ELSEWHERE" section headers, the divider between them, and
  the `sessions.isZoneCollapsed` / `toggleZoneCollapsed` calls tied to zone identity.
- Delete `SidebarBento.vue`, `BentoCard.vue`, `BentoCapsule.vue`, `BentoNest.vue`,
  `SidebarDrillIn.vue`, `DrillInSessionCard.vue`, and their `v-else-if` branches in
  `Sidebar.vue`. `TriageQueue.vue` stays — it's shared with classic, not bento/drill-in
  specific.
- `SettingsDialog.vue` (`:422-427`): remove the "Sidebar layout" `SegmentedControl` — with
  only classic left, there is nothing to choose between.

## Docs, i18n, tests

- `design.md`: rewrite the "Folder-first model (sidebar — two zones)" section (~~`:1341+`) to
  describe one flat list; delete the "Sidebar bento" (~~`:1838`) and "Sidebar drill-in"
  (~`:1976`) §6 sections entirely, with a short history note that they were removed
  2026-07-15, superseding T90/T95/T119, pending a future redesign.
- `docs/user/folders-and-worktrees.md`: rewrite "Pinned vs. 'Active elsewhere'" (lines 5-12)
  — no more two named zones; document pin as an attribute (still settable via the folder
  context menu) and hide as the sole visibility-suppression tool.
- i18n (`en.json` **and** `pt-BR.json` in the same change): remove
  `settings.sidebar.layoutBento`, `settings.sidebar.layoutDrillIn`, and the section-header
  keys that backed "FOLDERS"/"ACTIVE ELSEWHERE" (or repurpose one as a generic list label —
  left to implementation time; leaning toward no header at all, given the flat-list
  decision).
- Tests: remove bento/drill-in component tests and any `folder-zones.ts` / `sessions.ts`
  tests asserting two-zone behavior; add/update tests asserting (a) a repo with one pinned +
  one active-unpinned worktree groups into exactly one `RepoGroup`; (b) pin → hide → unhide
  round-trips back to `pinned: true`; (c) a hidden-and-pinned folder does not render.
- `CHANGELOG.md`: an entry dated today under `### Changed` (sidebar simplified to one list)
  and `### Removed` (bento, drill-in layouts).

## Out of scope

- Designing the next sidebar layout — explicitly deferred. This change only removes the two
  half-finished alternatives and fixes classic's structural duplication bug.
- Any new visual differentiation between pinned and discovered folders — the operator
  explicitly chose none for now; revisit only if scanning a long flat list proves it's
  needed.
