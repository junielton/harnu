---
status: draft
tier: medium
---

# `hide_folder`: let agents hide and unhide sidebar folders

## Problem

When a body of work ends, the sidebar fills with folders and worktrees nobody will open again, and the
operator hides them by hand, one right-click per row. The hide action is non-destructive and reversible
(`hiddenPaths` in `<userData>/projects.json`, written by `hideUserProject` / `unhideUserProject` behind the
`userProjects:hide` / `userProjects:unhide` IPC), so it fits the "mutations run free, every call audited"
posture of its sibling `archive_session` (T655).

The state is already main-owned, so no storage has to move. Two things are missing:

- there is no MCP verb that writes it;
- the renderer mirrors `hiddenPaths` (`manuallyHiddenPaths` in `stores/sessions.ts`) only from the IPC
  response of its own call and from `reloadModel()`. It does **not** hear a change made outside its own
  call, so a verb that wrote the file would leave an open sidebar stale until the next reload.

- R-1 Add an MCP verb `hide_folder({ folders, unhide? })` that does what the sidebar's hide action does.
- R-2 It must write exactly the state the sidebar action writes, and delete or move nothing.
- R-3 An open sidebar must update live; the existing menu actions and the hidden-folders view must not change.
- R-4 Concurrent calls must produce outcomes consistent with one serial order (the BUG-254 lesson for `archive_session`).

**Design decisions (settled here, before any code).**

1. **Same store, same lock.** The verb writes through a new `transactHiddenPaths(decide)` in
   `src/main/user-projects.ts`. It runs inside the same `withFileLock` that serializes `hideUserProject` /
   `unhideUserProject`, reads `projects.json` _inside_ the lock, lets the caller decide every row from that
   fresh `hiddenPaths`, and writes (same atomic tmp + rename) only when the set changed. Paths are
   normalized with the same `normalizePath` the IPC uses, so the persisted strings are identical. Hiding
   does not unpin, exactly like the menu action (BUG-39).
2. **Rows are decided inside the serialized write.** The pure planner `planHideFolder`
   (`src/main/mcp/hide-folder-core.ts`) is called from the `decide` callback with the `hiddenPaths` just
   read, never from a snapshot taken before the queue. N concurrent calls on one path therefore read as
   one serial order (`hidden`, then `alreadyHidden`), and the ACK always matches what was persisted. A
   failed write rejects the whole call (`HIDE_WRITE_FAILED`, nothing changed) instead of returning rows
   that were not saved.
3. **How the renderer hears changes: a push event.** `transactHiddenPaths` notifies listeners after a
   write that changed the set; `src/main/index.ts` forwards that to the window as
   `userProjects:hiddenChanged { hiddenPaths }` (the FULL list, so a missed event can never leave the
   mirror stale, the same shape as `sessionArchive:changed`). The preload exposes
   `onUserProjectsHiddenChanged`; the sessions store sets `manuallyHiddenPaths` and runs `reloadModel()`.
   The menu actions keep using their IPC response and do **not** emit the event, so their behaviour is
   untouched. The rejected alternative is a main to renderer "call `dismissFolder`" command: it only
   works while a window is open, which is not how the verb should behave.
4. **No new storage, no migration.** `projects.json` already carries `hiddenPaths`; the verb adds no field.
5. **Differs from `remove_folder`.** `remove_folder` reconciles a folder whose directory is already gone
   (unpins, unhides, drops its sessions from the live model, and refuses `DIRECTORY_STILL_EXISTS` while
   the directory exists). `hide_folder` is for folders that still exist: it only flips the hidden flag,
   leaves the pin and every session alone, and is undone by `unhide: true`. It is not changed by this card.

**Per-path outcome, in this order.** `notFound` (Harnu does not know the path: not pinned, not hidden,
not a folder in the scanned session history); `refused` with `FOLDER_NOT_ALLOWED` (the path is inside a
folder the operator blocked for agents); then for `unhide`, `shown` / `alreadyVisible`; for hide,
`alreadyHidden` (nothing changes, so nothing is refused), then `refused` with `SESSION_WORKING` (a session
whose folder is exactly this path is working right now), then `refused` with `PENDING_APPROVAL` (an
approval is parked for such a session), then `hidden`. Showing a folder is never refused except for a
blocked folder. Rows echo the **normalized** path (symlinks resolved), the string that is persisted.

## Slices

### S-1 · The `hide_folder` verb, its atomic store write and the live push

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/user-projects.ts`, `src/main/mcp/hide-folder-core.ts`, `src/main/index.ts`, `src/main/mcp/tool-catalog.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/mcp/validate.ts`, `src/main/mcp/plan-input.ts`, `src/preload/index.ts`, `src/renderer/src/stores/sessions.ts`, `tests/**`, `CHANGELOG.md`, `docs/harnu-features.md`, `docs/user/agent-control.md`, `docs/specs/T661-hide-folder.md`
- produces: hide_folder
- consumes: —
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-C

## Acceptance criteria

| id   | statement                                                                                                                                                                                                                           | proof                                                                                       | refines/inherits | covers |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------- | ------ |
| AC-1 | `hide_folder` takes 1..100 absolute folder paths and hides them; `unhide: true` shows them again; calling it twice is idempotent                                                                                                    | test:tests/mcp-hide-folder-handler.test.ts::idempotent                                      | —                | R-1    |
| AC-2 | The ACK reports one row per path with an outcome in `hidden`, `alreadyHidden`, `shown`, `alreadyVisible`, `notFound`, `refused` and, for `refused`, a reason code                                                                   | test:tests/mcp-hide-folder-core.test.ts::outcomes                                           | —                | R-1    |
| AC-3 | A path in a folder the operator blocked is refused `FOLDER_NOT_ALLOWED`; hiding a folder with a working session (`SESSION_WORKING`) or a pending approval (`PENDING_APPROVAL`) is refused; a path Harnu does not know is `notFound` | test:tests/mcp-hide-folder-core.test.ts::refusals                                           | —                | R-1    |
| AC-4 | It never deletes or moves anything on disk (directory, worktree, transcript, branch) and writes only the same persisted `hiddenPaths` the sidebar action writes: same normalized strings, pins and aliases untouched                | test:tests/mcp-hide-folder-handler.test.ts::only hiddenPaths                                | —                | R-2    |
| AC-5 | Concurrent calls on the same path produce outcomes consistent with one serial order, and the ACK always matches what was persisted (also against the sidebar's own hide / unhide IPC functions)                                     | test:tests/mcp-hide-folder-handler.test.ts::concurrent                                      | —                | R-4    |
| AC-6 | The sidebar updates live when the verb hides or shows a folder (`userProjects:hiddenChanged`); the menu hide / unhide actions and the hidden-folders view behave exactly as before                                                  | test:tests/sessions-hidden-folders-push.test.ts::follows the push, capture:/@verb-hide-show | —                | R-3    |
| AC-7 | Every call is audited like the other mutating verbs                                                                                                                                                                                 | test:tests/mcp-hide-folder-handler.test.ts::audited                                         | —                | R-1    |
| AC-C | Contract docs: `CHANGELOG.md`, `docs/harnu-features.md` (marker bumped, with the tests that pin it), `docs/user/agent-control.md`, this spec                                                                                        | record:changelog                                                                            | —                | R-1    |

## Amendments · Deviations

| date | kind | what changed | by  |
| ---- | ---- | ------------ | --- |
