---
status: draft
tier: medium
---

# Archive the idle sessions of a folder

## Problem

Archiving is per session today: the sidebar's **Archive** menu item and the `archive_session`
verb both take one row at a time, so putting a finished folder away costs one right-click per
session. The archive store (`src/main/session-archive-core.ts`) already takes a batch through
`transact`, and `planArchiveSession` (`src/main/mcp/archive-session-core.ts`) already refuses a
working session (`SESSION_WORKING`) and one with a parked approval (`PENDING_APPROVAL`). What is
missing is a folder-level action and a way back.

The request, atomized (one atom per sentence of the brainstorm's "What was asked"):

- R-1 A folder's menu gets one action that archives every idle session in that folder.
- R-2 A session that is working, or that has an approval waiting, is left alone.
- R-3 A toast says how many sessions were archived and how many were left alone, with Undo.
- R-4 Undo restores exactly the sessions that action archived, nothing else.

"Idle" and "that folder" are settled by the code, not asked: idle is what `planArchiveSession`
archives (not archived yet, not working, no parked approval), and a folder is its exact path, as
in the folder-first model of `src/renderer/src/stores/sessions.ts`, so a worktree is its own folder.

## Slices

### S-1 · Folder planner and IPC for archiving idle sessions

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/mcp/archive-session-core.ts`, `src/main/session-archive-ipc.ts`, `src/preload/index.ts`, `tests/archive-idle-sessions.test.ts`
- produces: archive-idle-ipc
- consumes: existing:session-archive-store, existing:archive-session-planner
- acs: AC-1, AC-2

### S-2 · Folder menu action and the Undo toast

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/renderer/src/components/FolderMenu.vue`, `src/renderer/src/stores/sessions.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/folder-menu-archive-idle.test.ts`, `docs/user/sessions.md`, `CHANGELOG.md`
- produces: archive-idle-action
- consumes: archive-idle-ipc
- acs: AC-3, AC-4, AC-5, AC-6

## Acceptance criteria

| id   | statement                                                                                                                                              | proof                                                                                    | refines/inherits | covers   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------- | -------- |
| AC-1 | Given a folder path, the planner archives every session of that exact folder that `planArchiveSession` would archive, in one `transact` write.         | test:tests/archive-idle-sessions.test.ts::archives the idle sessions of the folder       | —                | R-1, R-2 |
| AC-2 | A working session and a session with a parked approval come back as left alone with their refusal reason, and no session of another folder is touched. | test:tests/archive-idle-sessions.test.ts::leaves working and waiting sessions alone      | AC-1             | R-2      |
| AC-3 | The folder menu shows "Archive idle sessions", and choosing it calls the S-1 IPC for that folder.                                                      | test:tests/folder-menu-archive-idle.test.ts::the folder menu archives idle sessions      | —                | R-1      |
| AC-4 | After the action a toast reads how many sessions were archived and how many were left alone, and carries an Undo button.                               | test:tests/folder-menu-archive-idle.test.ts::the toast counts archived and left alone    | AC-3             | R-3      |
| AC-5 | Undo restores exactly the ids the action archived; a session that was archived before the action stays archived.                                       | test:tests/folder-menu-archive-idle.test.ts::undo restores only what the action archived | AC-4             | R-4      |
| AC-6 | `CHANGELOG.md` has a dated entry and `docs/user/sessions.md` describes the action, the sessions it leaves alone and Undo.                              | record:changelog                                                                         | —                | —        |
