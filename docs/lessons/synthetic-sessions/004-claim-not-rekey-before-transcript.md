# 004-claim-not-rekey-before-transcript: a row is never re-keyed before its transcript exists

**Category:** synthetic-sessions
**Discovered in:** T389 P1W3 design review, 2026-10 — the Harnu mod's hello knows the real session
id long before the CLI writes the transcript
**Status:** designed in and tested (the companion identity claim, `stores/sessions.ts`
`bindByClaim`); the legacy heuristics it demotes are untouched and still the default

## The trap

The Harnu mod says hello before the first prompt (smoke A2: 657-827 ms after spawn). From that
moment Harnu's main process knows, exactly, which session id a given PTY is running. The obvious
move is to re-key the sidebar row to that id **when hello arrives**. It is wrong, and the
failure is quiet.

The CLI writes the transcript only once the conversation has content. Between hello and the
first prompt there is no `<id>.jsonl` on disk. A row re-keyed to the real id in that window is:

1. **Dropped by the next reload.** `reloadModelOnce` re-injects only rows with `synthetic === true`
   (and shell terminals). A migrated row with a blank `fullPath` is "left entirely to the ordinary
   per-folder reconcile ... if not, it is correctly dropped" (BUG-88). Three watcher events fire a
   reload within about 150 ms of a new session (lesson 003), so the row vanishes while its
   `claude` is alive.
2. **Parkable with nothing to resume.** `pty:rekey` runs `applyRekeyToRecord`, which promotes the
   PTY to `claude-resume` on the stated ground that "the rekey event IS the proof the transcript now
   exists on disk" (BUG-65). Hibernation parks `claude-resume` only, and waking would run
   `claude --resume <id>` against a transcript that is not there.

The rekey event is a **fact about the disk**, and hello is a fact about the process. They are not
interchangeable.

## The rule

Identity is delivered in two steps and the second one is the existing one:

1. **Hello (or a rebound) gives a claim**: "PTY row `key` is session `sid`". Main records it, later
   waves key their events by it, nothing in the sidebar moves.
2. **The transcript appearing on disk migrates the row.** The watcher's `session:added` is the
   proof; `reconcileSessionAdded` consults the claim first, and the migration itself (`fireMigrate`,
   `ptyRekey`, the metadata backfill) is the code that always ran. The claim only replaces the
   _guess_ about which row it was.

A claim never creates a row, reaches another folder or grants a capability. It chooses which of
Harnu's own rows becomes a given transcript, and only after a watcher event confirms the
transcript exists.

## Why a claim beats the heuristics, not the other way round

The three legacy binders guess: the oldest armed agent correlation, the newest synthetic of the
folder, and a five-minute creation-time window. Each is right most of the time and wrong under a
fan-out (BUG-59, BUG-65). A claim comes from the PTY that carried the spawn token, so it cannot
cross two sessions that landed in the wrong order. While a claim **acts** (mode `active`, tested CLI,
live lease) the heuristics stand aside for that row; in `shadow` they bind as before and the claim is
only compared (the parity record). When the lease is lost or the PTY dies the claim stops acting and
the heuristics resume, so a claim that never completes cannot strand a synthetic.

## `/clear` and in-session `/resume`

Neither fires `session.start`, and today nothing re-keys a live row on `/clear`: the new transcript
appears as a second row while the PTY index still holds the old id, and opening that row resumes a
transcript another process is writing. With a claim the live PTY moves to the new id when the new
transcript's `session:added` fires; the old conversation stays as an ordinary cold row.

## How to apply

- Never call `fireMigrate` or `pty:rekey` from a hello, a rebound, a heartbeat or anything else that
  is not "a transcript for this id now exists on disk".
- A new source of identity (the external binding of P4W3, a future CLI event) produces a claim, not a
  re-key.
- If you narrow a legacy heuristic, do it only while a claim acts; `shadow` and `off` must behave
  exactly as before.
- Tests: `tests/sessions-store.test.ts` "no early re-key: the row survives a reload before the
  transcript exists".
