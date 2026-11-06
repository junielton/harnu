---
status: draft
tier: medium
---

# `archive_session`: let agents archive and unarchive sessions

## Problem

Triaging dozens of finished sessions ends with "close the trash ones", and the operator archives
them by hand, one right-click per row. Archive is non-destructive (the JSONL stays) and reversible,
so it fits the "mutations run free, every call audited" posture. But the archive state is renderer-only
today: `archivedIds` in `src/renderer/src/stores/sessions.ts` is a `persistedSet` over the
`localStorage` key `om2tab.archivedSessions`, and the menu action is `toggleArchived` in
`src/renderer/src/composables/useSessionActions.ts`. The main process cannot see it, so no MCP verb
can write it, and a verb that needs an open window would silently do nothing with the window closed.

- R-1 Add an MCP verb `archive_session({ sessionIds, unarchive? })` that does what the sidebar's Archive action does.
- R-2 The archive state must live in the main process, so the verb works with the window closed.
- R-3 The sidebar must still behave exactly as today.
- R-4 Sessions the operator already archived (in `localStorage`) must not be lost.

**Design decision (settled here, before any code).** The authoritative archive set moves to a
main-process store: one JSON file `archived-sessions.json` under the app's userData, written
atomically (tmp file + rename, the same `atomicWriteFile` the MCP layer already uses), holding
`{ version: 1, ids: string[], legacyImported: boolean }`. The renderer hydrates `archivedIds` from it
at boot (`sessionArchive:get`), writes through it when the menu action runs (`sessionArchive:set`,
applied optimistically so the sidebar stays synchronous) and subscribes to `sessionArchive:changed`,
which main broadcasts after every write, including the verb's. The verb and the menu action are two
callers of the same store. The rejected alternative is a main to renderer "call the store" command: it
only works while a window is open, which is exactly the case the card exists to fix. Migration: on
first boot after this change the renderer sends its `localStorage` ids to `sessionArchive:importLegacy`;
main merges them into the store and sets `legacyImported`, so the import happens once. The old
`localStorage` key is read, never written and never deleted, so a rollback still finds its data. A
session the verb archives while it has a live idle terminal gets the same put-away teardown the menu
action runs (close the PTY, drop the selection) when the renderer sees the change event.

**Refusal reasons (AC-3).** Per id, in this order: `notFound` (no such session on disk or in flight);
`refused` with `FOLDER_NOT_ALLOWED` (the session's folder is blocked by the operator);
`refused` with `SESSION_WORKING` (task state `working`, archive only); `refused` with
`PENDING_APPROVAL` (an approval is parked for it, archive only). Restoring is never refused except for
a blocked folder.

## Slices

### S-1 · Main-owned archive store and the `archive_session` verb

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/**`, `src/preload/index.ts`, `src/renderer/src/stores/sessions.ts`, `src/renderer/src/composables/useSessionActions.ts`, `tests/**`, `CHANGELOG.md`, `docs/harnu-features.md`, `docs/user/agent-control.md`, `docs/specs/T655-archive-session.md`
- produces: archive_session
- consumes: —
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-C

## Acceptance criteria

| id   | statement                                                                                                                                                                         | proof                                                                           | refines/inherits | covers |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------- | ------ |
| AC-1 | `archive_session` takes 1..100 session ids and archives them; `unarchive: true` restores them; calling it twice is idempotent                                                     | test:tests/mcp-archive-session-handler.test.ts::idempotent                      | —                | R-1    |
| AC-2 | The ACK reports one row per id with an outcome in `archived`, `alreadyArchived`, `restored`, `alreadyActive`, `notFound`, `refused` and, for `refused`, a reason code             | test:tests/mcp-archive-session-core.test.ts::outcomes                           | —                | R-1    |
| AC-3 | A session in a folder the operator blocked is refused `FOLDER_NOT_ALLOWED`; a `working` session or one with a pending approval is refused (`SESSION_WORKING`, `PENDING_APPROVAL`) | test:tests/mcp-archive-session-core.test.ts::refusals                           | —                | R-1    |
| AC-4 | It never deletes a transcript, a worktree or any file other than its own archive store                                                                                            | test:tests/session-archive-store.test.ts::only its own file                     | —                | R-1    |
| AC-5 | Archive state lives in the main process: archiving with no renderer window open persists, and the renderer shows the same set after a reload                                      | test:tests/session-archive-store.test.ts::survives a reload                     | —                | R-2    |
| AC-6 | Existing archived ids in `localStorage` are migrated into the main store exactly once on first boot, none lost, the old key left untouched                                        | test:tests/session-archive-store.test.ts::legacy import                         | —                | R-4    |
| AC-7 | The sidebar updates live when the verb archives or restores a session; archived sessions stay excluded from needs-input and badge counts as today                                 | capture:/@verb-archive-restore                                                  | —                | R-3    |
| AC-8 | The menu's Archive / Unarchive action and the folder "Show N archived" reveal behave exactly as before                                                                            | test:tests/sessions-archive-store.test.ts::menu action, capture:/@show-archived | —                | R-3    |
| AC-9 | Every call is audited like the other mutating verbs                                                                                                                               | test:tests/mcp-archive-session-handler.test.ts::audited                         | —                | R-1    |
| AC-C | Contract docs: `CHANGELOG.md`, `docs/harnu-features.md` (marker bumped), `docs/user/agent-control.md`, this spec                                                                  | record:changelog                                                                | —                | R-1    |

## Amendments · Deviations

| date       | kind      | what changed                                                                                                                                     | by       |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| 2026-11-06 | deviation | AC-1 met · idempotent archive/restore and the 1..100 id limit covered by the handler tests                                                       | verifier |
| 2026-11-06 | deviation | AC-2 met · one ACK row per id with outcome and reason covered by the core and handler tests                                                      | verifier |
| 2026-11-06 | deviation | AC-3 met · blocked folder, working session and parked approval refused with their codes                                                          | verifier |
| 2026-11-06 | deviation | AC-4 met · only the verb's own store file is written (atomic write plus mkdir)                                                                   | verifier |
| 2026-11-06 | deviation | AC-5 met · state survives a reload and persists with no window; renderer hydrates from main                                                      | verifier |
| 2026-11-06 | deviation | AC-6 met · one-time legacy import of the old ids, old localStorage key left untouched                                                            | verifier |
| 2026-11-06 | deviation | AC-7 met · sidebar updates live; archived sessions stay out of the needs-input count (1→0→1)                                                     | verifier |
| 2026-11-06 | deviation | AC-8 needs-human · menu and "Show N archived" files untouched, store tests pass, no capture of the right-click flow; operator checks after merge | verifier |
| 2026-11-06 | deviation | AC-9 met · calls go through the shared audit path; audited tests pass                                                                            | verifier |
| 2026-11-06 | deviation | AC-C met · CHANGELOG, awareness doc v123, user docs and this spec match the code                                                                 | verifier |
