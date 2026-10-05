# A dead synthetic's boot is only reaped for MCP-created sessions — human-created ones linger as WORKING forever

**Date:** 2026-07-13
**Card:** `T120-design-spec-fix-for-orphaned-sessions-stuck-in-working-status` (parent:
`orphaned-sessions-stay-stuck-in-working-status`)
**Status:** design approved, not implemented

## Problem

The reported symptom (screenshot on the parent card): the sidebar's **WORKING** bucket held a
session titled **"New session"** — the literal, never-auto-renamed default title — for 3 hours,
while its terminal pane showed nothing but a fresh Claude Code banner sitting at an idle prompt.
A never-renamed title plus a 3-hour-stale `modified` timestamp is itself the signature of a
session whose PTY boot silently never completed: not a resumed session gone quiet, but one that
never produced a single byte of real activity.

### The classifier has an unprotected legacy tier, by design

There is no single "working vs idle" classifier — `resolveActivity`
(`src/renderer/src/stores/fleet-state.ts:173-194`) layers four signal tiers, richest first:

```ts
if (sig.liveAgentCount > 0) return 'working'
if (sig.taskState !== undefined) {
  return sig.taskState === 'working' ? workingOrStuck(sig, ctx) : 'idle' // tier 1
}
if (sig.registryState !== undefined) {
  return sig.registryState === 'working' ? workingOrStuck(sig, ctx) : 'idle' // tier 2
}
if (sig.transcriptState === 'working') return workingOrStuck(sig, ctx) // tier 3
if (sig.transcriptState === 'idle' || sig.transcriptState === 'needs-input') return 'idle'
// 4. Transcript lacking markers (`unknown`/undefined): legacy 5s heuristic.
return sig.status === 'active' ? 'working' : 'idle' // tier 4
```

Tiers 1–3 all route through `workingOrStuck` (`fleet-state.ts:142-152`), which demotes
`working` → `stuck` once the session has shown no sign of life (`modifiedMs`/`lastEventMs`) for
`STUCK_AFTER_MS` (3 minutes). **Tier 4 has no such check** — it is a bare boolean on the legacy
`status` field with zero regard for elapsed time. This is intentional, documented behavior,
covered by `tests/fleet-state.test.ts:92-94`:

```ts
it('no hook truth yet + active status → working (mirrors the legacy heuristic)', () => {
  expect(resolveActivity(sig({ taskState: undefined, status: 'active' }), ctx())).toBe('working')
})
```

A session lands in tier 4 whenever it has never received a hook event, a PID-registry entry, or
transcript content — i.e. exactly a session whose boot silently failed before producing anything.

### `status` only ever flips back to `idle` on real transcript growth

`status` is set to `'active'` the instant a synthetic row is created — in all three of the
store's session-creation functions (`sessions.ts:2377`, `:2437`, `:2496`). The **only** code path
in the entire store that ever writes `status = 'idle'` at runtime is `scheduleIdle()`
(`sessions.ts:3572-3582`), and it is armed from exactly one place: inside the
`onSessionUpdated` transcript-watcher IPC handler (`sessions.ts:4018-4067`) — i.e. only after a
real JSONL append is observed on disk. If the transcript never grows, `scheduleIdle` never fires,
`status` never leaves `'active'`, and tier 4 paints `working` with no possible self-correction.

### The existing reaper (BUG-23) only guards ONE of three creation paths

This exact failure class — a synthetic whose boot silently drops, lingering as `working`
forever — was already diagnosed and partially fixed as **BUG-23** (`.capy/memory/roadmap/BUG-23.md`,
status `done`). The fix is a boot-deadline reaper:

- `src/renderer/src/stores/synthetic-reaper.ts` — pure verdict core. `AGENT_BOOT_TIMEOUT_MS =
120_000` (line 26); `bootVerdict`/`shouldReapAtDeadline` (lines 51-72) decide `pending` /
  `booted` / `failed` from `{ present, isLive, elapsedMs, timeoutMs }`.
- `sessions.ts:1200-1241` — the store side: `armAgentBootDeadline` (arms a timer),
  `reapSyntheticBoot` (consults `shouldReapAtDeadline` against `isSessionLive`),
  `markSyntheticBootFailed` (sets `taskState:'failed'`, `failureReason:'boot_timeout'` via
  `applyTaskState` — which correctly routes tier 1 of `resolveActivity` to `idle`, ending the
  false `working` paint).

**But `armAgentBootDeadline` is only called from two sites in the whole store:**
`insertAgentSession` (`sessions.ts:2523`, the MCP `create_session` path) and
`retrySyntheticBoot` (`sessions.ts:1258`, re-arming after a manual retry). Grepping every call
site confirms this — there is no third caller.

**`createNewSession`** (`sessions.ts:2344-2393`, the human "+ New session" button — the exact
path that produces the screenshot's literal default title "New session") and
**`dispatchCardSession`** (`sessions.ts:2414-2452`, roadmap-card dispatch) both mint a synthetic
with `status:'active'` and **never call `armAgentBootDeadline`**. Their only correction
mechanism is `markSessionExited` (`sessions.ts:3199-3201`), which fires **only on an observed
`pty:exit` event** — and if the PTY was never created in the first place (the historical BUG-23
race), there is no exit event either.

**Net effect:** a `createNewSession`- or `dispatchCardSession`-created row whose boot silently
drops has zero correction mechanism — no reaper (only wired for `insertAgentSession`), no exit
event (no PTY ever existed to exit), no hook/registry/transcript signal (nothing ever ran) — so
it is permanently stuck in tier 4, painted `working`, forever. This matches the screenshot
exactly: default title, 3-hour-stale timestamp, literal `WORKING` bucket membership.

### The reaper mechanism itself is already creation-path-agnostic

Critically, nothing in the reaper is actually MCP-specific — it was just never wired up
elsewhere. `armAgentBootDeadline`/`reapSyntheticBoot`/`shouldReapAtDeadline` operate purely on a
`syntheticId` string, and `isSessionLive` (`sessions.ts:863`, backed by `registerLiveSession`/
`unregisterLiveSession`) is populated generically by `TerminalPane.vue:625` on **every** PTY
create/adopt, regardless of `kind` (`claude-new`, `claude-fork`, `claude-resume`, `shell`) — not
just queue-booted agent sessions. So a selection-driven boot (`createNewSession`,
`dispatchCardSession`) registers as live through the exact same mechanism the reaper already
checks. The gap is purely "nobody calls `armAgentBootDeadline` from these two functions" — not a
missing capability.

### A distinct, narrower, already-partly-mitigated issue (explicitly out of scope here)

`src/main/fleet-policy.ts:86-106` documents a second, unrelated bug in the raw hook-FSM truth
itself, for a real, **process-alive** session (e.g. after `claude --resume` replays tool-call
hooks with no `Stop` to follow — `taskState:'working'` latches with zero PTY output for 108s+).
For the renderer's sidebar/board this is already corrected by `workingOrStuck`'s 3-minute quiet
timer (tier 1 of `resolveActivity`). But the raw hook-FSM state itself never relaxes anywhere in
main (`TaskStateRegistry`/`hook-bridge.ts` — liveness-pruned only, no TTL), so the MCP `get_fleet`
disclosure (`src/main/mcp/fleet-snapshot.ts:265`, `s.taskState === 'working'`, no reconciliation)
can report `working` indefinitely for a session a human would correctly see as `stuck`. This is a
**different bug** (a live process with a stale FSM claim, not a dead process with no claim at
all) and is **not** addressed by this spec — it does not reproduce the reported screenshot, and
bundling it here would blur two independently-testable fixes. Tracking it separately is the
right call; a follow-up card should reference `fleet-policy.ts:86-106`'s own documented finding.

## Design

Close the BUG-23 reaper's gap by arming it from **every** synthetic-creation path, not just the
one MCP-agent path.

### 1. Arm the reaper in `createNewSession` and `dispatchCardSession`

Add `armAgentBootDeadline(sessionId)` at the end of both functions, in the same place
`insertAgentSession` (`sessions.ts:2523`) arms it — immediately after `folder.sessions.unshift(synthetic)`
and the selection assignment. No new parameters, no new state: the function already accepts a
bare `syntheticId` and the live-PTY probe it consults (`isSessionLive`) is populated identically
regardless of which function created the row.

`createNewSession`'s early dedupe-return (reusing an existing live, non-dead synthetic) needs no
change — that row already had its own reaper armed at its own creation, once this fix lands.

### 2. Leave the reaper's timeout and verdict logic untouched

`AGENT_BOOT_TIMEOUT_MS` (120s) was chosen generously for a `claude` spawn's cold-start budget
(font load + PTY + REPL), and a selection-driven boot (these two paths) is, if anything, faster
than the queue-driven MCP path (`insertAgentSession`) it was tuned for — there is no reason to
give human-initiated boots a different ceiling. `synthetic-reaper.ts`'s pure `bootVerdict`/
`shouldReapAtDeadline` need no change; they are already creation-path-agnostic.

### 3. Update the stale "MCP agent-created" framing in doc comments only

`synthetic-reaper.ts`'s module doc and `sessions.ts`'s comments around the reaper currently read
as MCP-agent-specific ("An MCP agent-created synthetic (`insertAgentSession`) boots its PTY in
the BACKGROUND…"). Once armed from all three creation paths, reword these to describe the reaper
as covering "any unbooted synthetic, regardless of how it was created" — a comment-only change,
no rename of `armAgentBootDeadline`/`AGENT_BOOT_TIMEOUT_MS`/`markSyntheticBootFailed`. Keeping the
existing names avoids an unnecessary rename sweeping every call site and test for a purely
cosmetic gain; the "Agent" in the names is now a slight misnomer but not worth the diff size.

### 4. No change to `resolveActivity` or tier 4

The legacy tier-4 heuristic (`fleet-state.ts:193`) stays exactly as documented and tested
(`tests/fleet-state.test.ts:92-94`) — it is still the correct fallback for a session that is
_genuinely_ newly active with no markers yet (the common case: a fresh boot that's seconds old).
The fix prevents a row from staying in that fallback forever by ensuring `taskState` eventually
becomes defined (`'failed'`, via `markSyntheticBootFailed`) for a boot that never produced
anything — which routes it to tier 1 (`idle`) instead, exactly the mechanism BUG-23 already
established for the one path it covered.

## Testing

New assertions in `tests/sessions-store.test.ts` (fake timers, mirroring the existing
`armAgentBootDeadline` coverage for `insertAgentSession`):

- **`createNewSession` arms the reaper:** call `createNewSession`, advance fake timers past
  `AGENT_BOOT_TIMEOUT_MS` with no live PTY registered and no migration — assert the row's
  `taskState` becomes `'failed'` with `failureReason: 'boot_timeout'`.
- **`dispatchCardSession` arms the reaper:** same shape, through `dispatchCardSession`.
- **No false reap:** for both functions, registering a live PTY (`registerLiveSession`) before
  the deadline elapses must leave the row untouched at the deadline — mirroring the existing
  `insertAgentSession` regression coverage.
- **End-to-end fleet-status assertion:** after a `createNewSession`-created row is reaped (no
  live PTY, deadline elapsed), assert `resolveActivity`/`dotFor` no longer paints `working` for
  it (using the real post-reap `taskState`) — the acceptance criterion for the reported bug.

No change required to `tests/synthetic-reaper.test.ts` (the pure verdict core is untouched) or
`tests/fleet-state.test.ts` (tier 4's own behavior is unchanged; the fix prevents a row from
_staying_ in tier 4 forever, not tier 4's own logic).

## Contract obligations

- **`CHANGELOG.md` — mandatory.** User-visible fleet-status inaccuracy fix: a session created via
  "+ New session" or a roadmap-card dispatch whose boot silently drops no longer lingers in the
  WORKING bucket forever. One bullet under `### Fixed`.
- **`docs/capy-features.md` — NOT required.** Per CLAUDE.md's litmus, agent-facing means a new/
  changed MCP verb, an ACK shape change, grant/confirm semantics, or a new UI affordance to
  proactively offer. This change touches none of them — it is an internal correction to two
  existing renderer-store functions, with no new verb and nothing new for a session to call or
  offer. (The related `get_fleet` `activeOnly` raw-`taskState` gap noted in Problem §"distinct
  issue" is out of scope for this fix; if addressed separately, `docs/capy-features.md` would be
  worth revisiting then, since it would change what `get_fleet`'s `activeOnly` filter discloses.)
- **`docs/user/` — NOT required.** No new top-level component, no new top-level `src/main/` file,
  no MCP verb change — this corrects existing behavior on an existing surface (the sidebar's
  WORKING bucket), it doesn't add a new user-reachable capability.
