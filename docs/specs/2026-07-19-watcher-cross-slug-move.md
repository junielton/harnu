# Spec: watcher cross-slug session moves + manual rescan

> **Status:** Ready for implementation — independent, parallel-safe
> **Created:** 2026-07-19
> **Card:** BUG-55 (**re-scoped** — see §2, the card's stated suspicion is partly wrong)
> **Unblocks:** the `move-to-worktree` context-menu feature card

---

## 1. Problem

A session that uses Claude Code's native `EnterWorktree` to switch into
`.claude/worktrees/<name>` has its transcript **re-homed by Claude Code itself**: the
JSONL moves to a new slug dir under `~/.claude/projects/`. Capy never notices.
Ten minutes after the move (live repro 2026-07-18, session
`217100bb-9662-4149-a3e2-fa1937ab9eb1`), `get_fleet` still reported
`folderAlias: "capy"`, the sidebar showed the worktree folder empty and the session
still under the main folder. There is no refresh affordance — only a full Capy
restart rescans.

This matters beyond the bug: `EnterWorktree` turns out to be the zero-surgery way to
move a live session between folders, and Capy's index is the only broken link.

## 2. Re-scope — what the card guessed vs what the code says

The card suspected that a slug **directory** created after boot produces no events.
That is **not** what the code does:

- `src/main/claude-watcher.ts:568` — `watcher.on('addDir', ...)` is wired and emits
  `claude:project:added` for a `project`-classified dir.
- The `ignoredPredicate` (`:510-533`) explicitly refuses to reject directories, with
  the comment _"we MUST NOT reject directories or the recursive walk dies on the way
  down"_.

So dir-add events **are** handled. Two real gaps remain:

1. **`depth: 4`** (`claude-watcher.ts:539`). The documented layout reaches
   `<slug>/<uuid>/subagents/agent-*.jsonl` at depth 4 (`:155`). A slug dir created
   mid-flight is registered relative to the _root_, so a nested transcript can fall
   outside the budget the initial walk assumed. Verify the effective depth for a
   post-`ready` dir and raise or make it explicit.
2. **Cross-slug moves are not modeled at all.** A move is an `unlink` in the old slug
   (`:684`) plus an `add` in the new one. Nothing correlates the pair by sessionId, so
   the store either ghosts the row (old folder keeps it) or duplicates it (both
   folders show it). The observed symptom is the ghost.

## 3. Design

### 3.1 Re-map, do not duplicate — the semantics, settled

**A session id is globally unique and belongs to exactly one folder at a time.** When
a JSONL for a known sessionId appears under a new slug, the store **re-homes** the
existing row: it moves, keeping its identity, selection state, and any live terminal
attachment. It does not create a second row and does not leave a tombstone.

This is settled here rather than deferred, on two grounds: the transcript is the
session's identity (Claude Code moved the file, not copied it), and a duplicated row
would present the operator with two entries backed by one PTY — a strictly worse
failure than the ghost we have now.

Ordering is not guaranteed: the `add` may arrive before the `unlink`, or the `unlink`
may never arrive. So the design is **add-authoritative**:

- On `add` for a sessionId already known under a different slug → re-home
  immediately. The new slug wins.
- On `unlink` → remove only if that sessionId is still mapped to _that_ slug. If it
  has already been re-homed, the unlink is a no-op. This makes the pair
  order-independent and idempotent.

Watcher-side, the correlation is emitted as a new event, `claude:session:moved
{ sessionId, fromSlug, toSlug }`, when the watcher can see both sides; the renderer
must still handle a bare `add` for a known id (per above), since the watcher cannot
always observe the pair.

### 3.2 Manual rescan

Add a rescan IPC (`claude:rescan`) that re-runs the folder/session scan and
reconciles the store, surfaced as a refresh affordance. This is the escape hatch for
any future watcher gap — the 2026-07-18 operator had no option but a full restart.

### 3.3 Fleet snapshot

`src/main/mcp/fleet-snapshot.ts` reports `folderAlias` from the same index, so a
correct re-map fixes `get_fleet` for free. Add an assertion, not new logic.

## 4. Scope boundary

**Touch:** `src/main/claude-watcher.ts` (depth `:539`, `classify` `:151-160`,
`addDir` `:568`, `add` `:684`, `unlink`), `src/renderer/src/stores/sessions.ts`
(re-home on cross-slug add; rescan action), `src/preload/index.ts` +
`src/main/index.ts` (rescan IPC registration), `src/main/mcp/fleet-snapshot.ts`
(assertion only).
**Contracts:** `CHANGELOG.md`; `docs/user/` for the refresh affordance (new
user-reachable behavior).

**Do NOT touch:** `src/main/mcp/server.ts`, `tool-handlers.ts`, `user-projects.ts`,
`worktree-*.ts` — no other spec in this batch touches `claude-watcher.ts`, and this
one should touch nothing they own.

## 5. Acceptance criteria

- [ ] AC1 With Capy running: create a worktree, have a session `EnterWorktree` into
      it → within one watcher tick the session row appears under the worktree folder
      and disappears from the old one. No restart.
      **Falsifier:** `get_fleet` still reports the old `folderAlias` 30 s after the
      JSONL landed in the new slug dir.
- [ ] AC2 A slug dir created after watcher `ready` emits `claude:project:added`, and
      a JSONL inside it emits `claude:session:added`.
- [ ] AC3 A re-homed session appears exactly once across all folders — never
      duplicated, never ghosted.
- [ ] AC4 The `add`/`unlink` pair is order-independent and idempotent: an out-of-order
      or missing `unlink` produces the same end state.
- [ ] AC5 A re-homed session keeps its identity and live terminal attachment.
- [ ] AC6 A manual rescan reconciles the store without a restart.

## 6. TDD plan

**First failing test:** `tests/claude-watcher.test.ts` →
`'a session JSONL moving between slug dirs re-homes the session, not duplicates it'`.

The module notes the chokidar shell is e2e-covered while the `classify` core is unit
tested, so drive this at the store seam: feed the reducer a `session:added` for a
sessionId already mapped to another slug, then assert exactly one row exists and it
sits under the new folder. Fails today — nothing correlates the ids, so the old row
survives alongside the new one.

Then: (2) `'an unlink for an already re-homed session is a no-op'` (AC4); (3)
`'a slug dir created after ready emits project:added and session:added'` — create the
dir post-`ready` in a tmpdir and await the events (AC2); (4) `'a re-homed session
keeps its terminal attachment'` (`tests/session-live-registry.test.ts`, AC5); (5)
`'rescan reconciles a store that missed a watcher event'` (AC6).
