# Sidebar ghost-folder cleanup — `remove_folder` MCP verb + the underlying fix

**Status:** PRD v1 (2026-07-18) · **Card:** `BUG-56-reaper-and-manual-remove-worktree-leaves-a-dead-folder-in-capy`
**Base:** operator live-testing of Reaper (2026-07-18) · code audit of `src/main/reaper/reaper-ipc.ts`, `src/main/worktree-ipc.ts`, `src/renderer/src/stores/{sessions,folder-zones,command-dispatch}.ts`, `src/main/mcp/tool-catalog.ts`
**Related:** `docs/adr/0016-remove-folder-is-sidebar-cleanup-not-a-destructive-worktree-op.md`

---

## 0. Premise — what this protects

Reaper (and the manual "Remove worktree" action) already delete the right
things on disk: the worktree directory, the local branch, optionally the
remote branch. What they do NOT do is make Capy's own sidebar agree that the
folder is gone. The operator hit this live: a swept worktree's folder and
broken session ("original directory no longer exists") kept showing in the
sidebar after Reaper reported success.

This PRD fixes the actual defect (the sidebar's `active` classification has no
disk-existence check) and, since the operator asked for it explicitly, exposes
the fix as a new MCP verb (`remove_folder`) so an agent can also invoke it
directly — not just Reaper's internal call path.

**This is not a new "folder health" system.** No badges, no UI polish, no
general staleness dashboard. One cleanup path, reused by three callers
(Reaper, manual Remove-worktree, the new verb).

## 1. Root cause (verified, not assumed)

- Sidebar folders = `pinned ∪ active` (`src/renderer/src/stores/sessions.ts:1787-1812`).
- `pinned` comes from `projects.json#projects[]` (`src/main/user-projects.ts`).
- `active` comes from `classifyFolder` (`src/renderer/src/stores/folder-zones.ts:122-136`),
  driven only by recent/live session transcripts under `~/.claude/projects/<slug>/` —
  **no disk-existence check on the folder path.**
- Reaper's `sidebar-detach` step (`reaper-ipc.ts:58-61`) only calls
  `removeUserProject`/`unhideUserProject` — clears `pinned`, leaves `active` untouched.
- Manual `removeWorktree()` (`worktree-ipc.ts:1186-1223`) does neither.
- Dead plumbing already exists: `folders:removed` is fully wired on the
  renderer side (`command-dispatch.ts:86` → `sessions.ts:3712-3716`) but **no
  code in `src/main` ever emits it**, and even if it fired, its handler today
  only clears an in-memory git-meta cache (`adoptedGitByPath.delete`), not the
  folder/session list.
- The "directory no longer exists" check Capy already performs elsewhere
  (`src/main/pty.ts:742-745`, `!existsSync(opts.cwd)`) is the exact primitive
  this fix needs — it's just never consulted by the folder model.

## 2. Decision — one cleanup function, three callers

| #   | Decision                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | One new main-process function (`removeGhostFolder` or similar, in `src/main/user-projects.ts` or a small sibling module) does the full cleanup: unpin from `projects.json`, unhide, and make `active` classification stop returning true for that path.                                                                                            |
| D2  | The function ONLY proceeds when `!existsSync(folder)` — refuses otherwise. This is the safety guardrail: it can only ever clean up a ghost, never hide a folder whose data is still on disk. See ADR-0002 for why this keeps the "no destructive worktree op" invariant intact.                                                                    |
| D3  | Three callers, same function: Reaper's `sidebar-detach` step (after it has already deleted the directory), manual `removeWorktree()` (after `git worktree remove` succeeds), and the new `remove_folder` MCP verb (for ad-hoc/agent-initiated cleanup of a ghost the two automated paths missed — e.g. a directory deleted outside Capy entirely). |
| D4  | Actually emit `folders:removed` from this function, and extend its existing (currently inert) renderer handler (`sessions.ts:3712-3716`) to drop the folder + its sessions from the in-memory model — not just the git-meta cache.                                                                                                                 |
| D5  | `classifyFolder`/the folder model also gets taught to treat a folder whose directory doesn't exist as never `active`, independent of the three explicit callers — belt-and-suspenders so a ghost folder can't resurface after an app restart re-scans `~/.claude/projects/`.                                                                       |

## 3. `remove_folder` verb contract

Modeled on `adopt_folder`'s inverse and `archive_card`'s "direct write, no
confirm, reversible-in-spirit" posture (`tool-catalog.ts:410-425`, `:688-702`):

```
name: remove_folder
description: Remove a folder from the Capy sidebar whose underlying directory
  no longer exists on disk — cleans up the ghost left behind after a worktree
  or folder was deleted outside this exact call (e.g. by Reaper, by `rm -rf`,
  by a manual `git worktree remove`). Refuses if the directory still exists —
  this verb only ever removes ghosts, never hides live data.
input: { folder: string }  // absolute path
mutates: true
op: remove_folder
grantable: isSafeGrantVerb('remove_folder')
alwaysAllowable: true
silentAllowInAgentFolder: true
```

**Errors:**

- `DIRECTORY_STILL_EXISTS` — refused; `folder` is still present on disk.
- `FOLDER_UNKNOWN` — refused; `folder` isn't pinned and has no known sessions, nothing to clean up.

**Success ACK:** `{ ok: true, removed: { path, unpinned: boolean, sessionsDropped: number } }`.

## 4. Slices — one PR

Small enough for one unit:

1. `removeGhostFolder(path)` in `user-projects.ts` (or sibling module) — the
   disk-existence guard + unpin/unhide + `folders:removed` emit.
2. Extend `onFolderRemoved` (`sessions.ts:3712-3716`) to actually drop the
   folder + its sessions from the store, not just `adoptedGitByPath`.
3. Teach `classifyFolder`/folder model the disk-existence check (D5).
4. Wire Reaper's `sidebar-detach` step and `removeWorktree()` to call
   `removeGhostFolder` after their existing disk deletion succeeds.
5. New MCP verb `remove_folder`: catalog entry (`tool-catalog.ts`) + handler
   (`tool-handlers.ts`) calling the same `removeGhostFolder`.
6. **Mandatory doc updates (repo contract, do not skip):**
   - `docs/capy-features.md` — new agent-facing verb; bump the version marker.
   - `docs/user/agent-control.md` — plain-prose entry for human readers.
   - `CHANGELOG.md` — dated entry (Added: `remove_folder` verb; Fixed: ghost folders after Reaper sweep / Remove-worktree).
   - No `design.md` change expected — no new UI component or token.

**ACs:**

- Sweeping a worktree via Reaper (or manual Remove-worktree) makes its folder
  and sessions disappear from the sidebar without an app restart.
- `remove_folder` on a path that still exists on disk returns `DIRECTORY_STILL_EXISTS` and changes nothing.
- `remove_folder` on an unknown path returns `FOLDER_UNKNOWN`.
- `remove_folder` on a genuinely-gone, previously-pinned-or-active path removes it from the sidebar and from `projects.json`.
- Existing Reaper/worktree-remove test suites still pass; add coverage for the new call sites.

## 5. Out of scope

Any UI affordance beyond "the folder disappears" (no "orphaned folder" badge,
no undo toast) — the operator's ask was cleanup, not a new indicator system.
General folder-health/staleness dashboards. Removing a folder whose directory
still exists (that's `adopt_folder`'s inverse, a different and more
consequential feature, not requested here).
