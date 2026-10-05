# Spec: terminal-state ledger (BUG-54)

**Card:** `BUG-54-terminal-fleet-states-errored-done-are-memory-only-vanish-on`
**Stacks behind:** `BUG-53` (liveness axis). This spec MUST NOT touch the `isLive`
guards BUG-53 adds to `fleet-state.ts` — it only adds a new, higher-priority signal.
**ADR:** [`docs/adr/0006-terminal-ledger-not-transcript-derivation.md`](../adr/0006-terminal-ledger-not-transcript-derivation.md)

## Problem

Quit Capy and every terminal fleet state is gone. After a relaunch:

1. The `errored` tier silently empties — a session that failed at 09:00 (usage limit,
   crash) is invisible at 09:05, taking its failure badge and `resetsAt` countdown
   with it.
2. The `done` tier empties, breaking an explicit promise of the approved fleet-rail
   spec (`docs/specs/2026-07-17-fleet-rail/`): _"Done/return-here stays visible so
   finished work can be collected."_ A clean transcript tail reclassifies as `idle`,
   which the rail never renders (`InboxRail.vue:73` drops the idle bucket).
3. Failed/finished sessions with **dirty** tails (died mid-tool) resurrect as `stuck`
   — the operator's literal report, _"it takes the tasks I have as finished and gives
   them as stuck afterwards"_.

## Root cause

Disk signals are treated as the present; memory signals are treated as durable.

- `src/main/hook-bridge.ts` folds hook events into `taskState` and emits
  `failureReason` / `resetsAt` on the `claude:hook` wire (`:464-465`), but persists
  **nothing** — its only `writeFile` is `prefsPath()` (`:298`, `:326`).
- `pruneTaskState` (`:260`) actively drops a session's folded state on every PTY
  teardown, so even within one run the terminal edge is transient.
- `before-quit` (`src/main/index.ts:768`, `killAllPtys()` at `:773`) writes no record
  of what was running.
- On boot the renderer therefore has no level-1 signal and falls through to the
  transcript tier, where `deriveTurnState` (`src/main/transcript-truth.ts:145`)
  reports how the last turn _ended_ — see the ADR for why deriving `done`/`errored`
  from that is not a substitute.

## Decisions

**D1 — A ledger of events, not a cache of states.** We persist the _edge_ (this
session failed / completed, at this time), not a recomputed classification. Rationale
in the ADR.

**D2 — Main-process owner, one JSON file.** New module `src/main/terminal-ledger.ts`,
persisted to `join(app.getPath('userData'), 'terminal-ledger.json')` via the existing
`atomicWriteFile` helper (`src/main/mcp/atomic-write.ts:35`) — never a bare
`writeFile`, so a crash mid-write cannot corrupt it.

**D3 — Written from the existing in-main observer seam.** `addTaskEventObserver`
(`src/main/hook-bridge.ts:291`) already forwards every folded edge inside main and
survives a renderer reload. The ledger subscribes there; it does not add a second
hook path. The pty-exit → completed/failed axis writes through the same module API.

**D4 — Shape.** Two independent records in one file, versioned:

```jsonc
{
  "version": 1,
  "terminal": {
    "<sessionId>": {
      "state": "failed" | "completed",
      "failureReason": "usage_limit" | "unknown" | ...,  // only when failed
      "resetsAt": 1752960000000,                          // epoch ms, optional
      "at": 1752950000000                                 // epoch ms of the edge
    }
  },
  "lastShutdown": {
    "at": 1752951111111,
    "sessionIds": ["...", "..."]
  }
}
```

`resetsAt` is an absolute epoch, so countdowns survive a restart by construction —
persist and re-emit, do not recompute a duration.

**D5 — Staleness / supersede rule (the safety property).** A ledger entry must never
pin a resumed, healthy session to a stale `failed`. An entry for `sessionId` is
dropped the moment ANY of these holds:

- a new hook or PTY event arrives for that session in the current run (any sign of
  life supersedes — evaluated before the entry is applied);
- the session's transcript has a clean end-of-turn strictly newer than `entry.at`;
- a newer terminal edge arrives for the same session (last write wins).

This applies identically to `terminal` entries and to `lastShutdown` membership.

**D6 — Retention.** Two bounds, both cheap: entries older than **72h** are dropped on
load and on write, and the map is capped at **200** entries (oldest `at` evicted
first). `lastShutdown` is **replaced, not appended** on every quit, which bounds it
for free (typically <10 entries).

**D7 — before-quit shutdown write.** In `src/main/index.ts` around `killAllPtys()`
(`:773`), write the list of sessions whose activity was `working` at that instant,
replacing any previous `lastShutdown`. Best-effort: a hard crash writes nothing, and
the fallback is BUG-53's behavior (`idle`), which is safe. The quit is already
deferred for the watcher close, so there is a real window.

**D8 — Restore-and-rebroadcast wire shape.** On boot, after the window's
`did-finish-load`, main re-emits each surviving entry on the **existing**
`claude:hook` channel with the exact shape it already sends
(`{ sessionId, taskState, event, ts, failureReason?, resetsAt? }`), using
`event: 'LedgerRestore'` and `ts: entry.at`. The renderer needs no new IPC channel
and no new reducer — its existing `claude:hook` handler populates `taskState`, which
is level 1 of `resolveActivity` and therefore already outranks the transcript tier.
`lastShutdown` is exposed separately via a plain `ipcMain.handle('fleet:lastShutdown')`
read for T167 to consume later; this spec only writes and exposes it, it does not
render an `interrupted` state.

**D9 — Out of scope.** No `interrupted` state (T167). No changes to BUG-53's `isLive`
guards. No rail/CSS/design.md changes. No new MCP verb — so
`docs/capy-features.md` and `docs/user/` stay untouched (use the `no-awareness` /
`no-user-docs` labels if the CI gates disagree).

## Scope boundary — files

| File                            | Change                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/main/terminal-ledger.ts`   | **new** — pure core (record/supersede/retention) + the file I/O shell                      |
| `src/main/hook-bridge.ts`       | subscribe the ledger via `addTaskEventObserver`; no fold changes                           |
| `src/main/index.ts`             | `before-quit` shutdown write; boot restore + rebroadcast; the `fleet:lastShutdown` handler |
| `src/preload/index.ts`          | expose `fleetLastShutdown()`                                                               |
| `tests/terminal-ledger.test.ts` | **new** — the pure-core suite                                                              |
| `tests/hook-bridge.test.ts`     | one case: a `StopFailure` edge produces a ledger write                                     |
| `CHANGELOG.md`                  | one bullet under `### Fixed`                                                               |

Explicitly NOT touched: `src/renderer/src/stores/fleet-state.ts`,
`src/renderer/src/components/InboxRail.vue`, `src/main/transcript-truth.ts`.

## Acceptance criteria

- [ ] Fail one session (into `StopFailure`) and complete another; quit and relaunch:
      both reappear in their `errored` / `done` tiers with correct badges, and the
      rate-limit countdown shows the correct remaining time (not a reset one).
- [ ] A failed session that is resumed and works again sheds the stale `failed` on
      its first sign of life (no manual clear).
- [ ] A session whose transcript gained a newer clean end-of-turn than `entry.at` is
      not restored as `failed`.
- [ ] Retention holds: >72h and >200-entry cases both evict, verified by test.
- [ ] `lastShutdown` is replaced (not appended) across three consecutive quits.
- [ ] A corrupt/absent ledger file loads as empty and never throws on boot.
- [ ] `CHANGELOG.md` entry present.

## TDD plan

Write this test FIRST, in a new `tests/terminal-ledger.test.ts` (vitest, the same
pure-core shape as `tests/reaper-journal.test.ts`):

```ts
it('supersedes a failed entry once the session shows new life', () => {
  const led = recordTerminal(emptyLedger(), 's1', {
    state: 'failed',
    failureReason: 'usage_limit',
    at: 1_000
  })
  expect(restorable(led, { s1: { lastEventMs: undefined, cleanEndOfTurnMs: undefined } })).toEqual([
    { sessionId: 's1', state: 'failed', failureReason: 'usage_limit', at: 1_000 }
  ])
  // new life in this run → the entry must not be restored
  expect(restorable(led, { s1: { lastEventMs: 2_000, cleanEndOfTurnMs: undefined } })).toEqual([])
})
```

It fails to compile today (`terminal-ledger.ts` does not exist), which is the correct
first red. Then, in order: retention (72h + 200-cap eviction), `lastShutdown` replace
semantics, clean-end-of-turn supersede, corrupt-file load, and finally the
`hook-bridge.test.ts` integration case asserting a `StopFailure` edge reaches the
ledger writer.
