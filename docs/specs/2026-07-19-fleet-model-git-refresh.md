# Mini-spec: refresh `gitByPath` on full rescans (BUG-34)

**Card:** `BUG-34-fleet-model-a-branch-switch-in-a-quiet-folder-is-invisible-to`
**Origin:** T123 S1 review triage, finding A-M4 (`.superpowers/sdd/progress.md`).
**Priority:** low — a bounded, self-healing staleness. Scoped deliberately small.

## Problem

Switching branches in a folder that has **no session activity** leaves `gitBranch`
stale for MCP consumers (`get_fleet`, worktree listings) until some session in that
slug writes to disk. An agent asking "what branch is this folder on?" can get an
answer that is hours old.

Exposure is bounded and the card says so: the renderer re-probes on boot via
`probeGitMetaBatch`, and the sidebar shows fresh branches — so this is an
MCP-consumer-only inaccuracy, and a mild regression versus pre-S1 (the old 2s TTL
re-derived git metadata on every rescan).

## Root cause

`src/main/fleet-model.ts` only recomputes `gitByPath` inside session-mutation paths.
Verified call sites — every one of them derives git metadata as a by-product of
flattening sessions:

- `:96-97` — boot full scan → `flattenFolders` → `replaceAllSessions(state, sessions, gitByPath)`
- `:209-210` — full rescan → `replaceAllSessions(...)`
- `:223-224` — slug-scoped rescan → `mergeSlugSessions(...)`

A folder whose sessions never change is never re-flattened, so its git metadata is
never re-derived. The centralized model made session churn the _only_ clock for a
fact that has nothing to do with sessions.

## Decisions

**D1 — Fix it where the model already refreshes: the full rescans.** The two
full-rescan entry points already exist and already run for exactly the right reasons:

- `notifyWatcherReady` (`:154`) — the chokidar `ready` gap-close;
- `notifyWatcherDegraded` (`:170`) — the degraded fallback, which additionally
  poll-rescans on an interval while the watcher is unhealthy.

Both funnel into the full-rescan path at `:209-210`. Ensure that path **re-probes git
metadata for every known folder**, not only for folders whose session set changed —
i.e. `replaceAllSessions` receives a freshly probed `gitByPath` covering all tracked
paths. This is a handful of lines inside a code path that already runs; it adds no new
timer, no new watcher, and no new state.

**D2 — Reject the `.git/HEAD` watcher, for now.** The card lists it as an option and
it is the "correct" answer in the abstract: it would make a branch switch visible
within milliseconds. Rejected here because the cost/benefit does not clear the bar:

- It adds a **new watch surface** — one more chokidar subscription per tracked folder,
  which must be created, torn down, and reconciled on every folder add/remove, and
  which participates in the watcher's own degradation/health story. That is a real
  ongoing liability in a subsystem (`claude-watcher` + `fleet-model`) that already
  carries a degraded-mode fallback for exactly this class of fragility.
- It also does not fully solve the problem alone: worktree metadata beyond the branch
  name (`repoId`, `isMainWorktree`) is not derivable from `.git/HEAD` writes, so a
  rescan-based refresh is needed regardless.
- The exposure being fixed is low-priority, bounded, and invisible in the UI.

Revisit only if a real consumer needs sub-rescan branch freshness. Record that as a
new card, not as scope creep here.

**D3 — No new polling interval.** The degraded path already poll-rescans; the healthy
path already rescans on `ready` and on every session change. Adding a third clock to
chase a low-priority staleness would be the wrong trade.

**D4 — Not user-visible, not agent-facing.** No new component, no new main-process
top-level capability, no MCP verb change — an existing field simply becomes more
accurate. `docs/capy-features.md` and `docs/user/` stay untouched (use the
`no-awareness` / `no-user-docs` labels if the CI gates disagree). `CHANGELOG.md`
still gets an entry: the accuracy change is observable to an agent consumer.

## Scope boundary — files

| File                             | Change                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/fleet-model.ts`        | re-probe `gitByPath` for all tracked folders on the full-rescan path (`:209-210`), reached from `notifyWatcherReady` / `notifyWatcherDegraded` |
| `tests/fleet-model-core.test.ts` | the failing test below (pure core)                                                                                                             |
| `tests/fleet-model.test.ts`      | only if the shell needs a wiring assertion                                                                                                     |
| `CHANGELOG.md`                   | one bullet under `### Fixed`                                                                                                                   |

Explicitly NOT touched: `src/main/claude-watcher.ts` (no new watch), `claude-reader.ts`,
anything in `src/renderer/`.

## Acceptance criteria

- [ ] A full rescan updates `gitByPath` for a folder whose session set did NOT change.
- [ ] `get_fleet` reports the new branch for a quiet folder after a watcher
      `ready`/degraded rescan, without any session having written.
- [ ] No new watcher subscription and no new interval timer are introduced (verify by
      reading the diff — this is a scope guard, not a runtime assertion).
- [ ] Slug-scoped rescans keep their current behavior (no regression at `:223-224`).
- [ ] `CHANGELOG.md` entry present.

## TDD plan

Write this test FIRST, in `tests/fleet-model-core.test.ts` (vitest, pure core — no
electron, no fs mocks):

```ts
it('refreshes gitByPath on a full rescan even when the session set is unchanged', () => {
  const sessions = [{ sessionId: 's1', folderPath: '/repo' }]
  let state = replaceAllSessions(emptyState(), sessions, { '/repo': { gitBranch: 'main' } })
  // same sessions, new branch → the full-rescan path must adopt the new metadata
  state = replaceAllSessions(state, sessions, { '/repo': { gitBranch: 'feat/x' } })
  expect(gitMetaFor(state, '/repo')?.gitBranch).toBe('feat/x')
})
```

If the pure core already passes this (the staleness may live entirely in _who calls_
the full rescan with _which_ probe results), escalate the red one level: assert in
`tests/fleet-model.test.ts` that a `notifyWatcherReady()` rescan re-probes git for a
folder with no session churn. One of the two must be red before any fix lands —
do not write the fix against a green suite.
