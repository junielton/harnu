# BUG-70 — `pty:exit` carries no park provenance

**Date:** 2026-07-22
**Status:** specified (not implemented)
**Card:** `.capy/memory/roadmap/BUG-70-pty-exit-carries-no-park-provenance-a-parked-session-is.md`
**Lands:** FIRST of three — before BUG-69, before T178 (see §8).

This spec **owns the park-provenance mechanism**. BUG-69 and T178 consume it and do not
restate it.

## 1. Symptom

Parking a session (automatic sweep or the System Monitor's per-row **Park now**) raises a
native "session completed" notification. Clicking it selects the session → spawns a fresh
`claude --resume` → ~450 MB comes straight back, and the parked flag is erased with no trace.
The app trains the operator to resurrect exactly what it just reclaimed.

## 2. Root cause — verified

The exit event has no idea a park happened.

| Step                                                                     | Evidence                                                                                                                                                                                                     |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pty.onExit` broadcasts unconditionally, no provenance field             | `src/main/pty.ts:788-803` — `getWindow()?.webContents.send('pty:exit', { id, exitCode, signal })` before any state is consulted                                                                              |
| the preload fans it out per-ptyId, payload is `{ id, exitCode, signal }` | `src/preload/index.ts:396-400` (`PtyExitPayload`), dispatcher at `:432-437`                                                                                                                                  |
| the renderer's session exit handler treats every exit as natural         | `src/renderer/src/components/TerminalPane.vue:609-627` — its own comment (`:621-624`) asserts "a NATURAL exit — user-close removes this listener before the kill"                                            |
| → `markSessionExited` → `applyTaskState('completed' \| 'failed')`        | `src/renderer/src/stores/sessions.ts:3322-3325`                                                                                                                                                              |
| → `maybeNotify` → OS notification / toast / chime / remote push          | `sessions.ts:3288`, `:3219-3255`; title key `notifications.completed.title` at `sessions.ts:560`; push at `sessions.ts:3244-3252`                                                                            |
| nothing in that chain reads `isHibernated()`                             | the only consumers of the registry are `src/main/monitor/sampler.ts:163` and `src/main/mcp/tool-handlers.ts:358,411` — grep for `isHibernated` returns **zero** call sites outside `src/main/hibernation.ts` |
| waking erases the evidence                                               | `clearHibernated` — `src/main/hibernation.ts:24-26` (main, called from `pty:create` at `src/main/pty.ts:766`) and its renderer twin `sessions.ts:1645-1648`, called from `TerminalPane.vue:1342`             |

### 2.1 Correction to the card: the sweep is silent only by RACE

The card (and BUG-69's) claim that "the automatic sweep does it right" is **half true**.
`hibernateSession` (`src/main/pty.ts:503-521`) does emit `pty:hibernated`, and the renderer's
handler (`TerminalPane.vue:987-994`) disposes the terminal — which unsubscribes the exit
listener. But `hibernateSession` never detaches `pty.onExit`, and `onExit` still sends
`pty:exit` unconditionally (`pty.ts:788`). The sweep escapes the false completion **only
because** `pty:hibernated` is sent synchronously inside `hibernateSession` while `onExit`
fires on a later tick, after the child actually dies.

That is an ordering accident, not an invariant. It is a second, independent reason to fix
provenance in main rather than to rely on the renderer having already torn down.

## 3. Decision — emit `pty:exit` WITH a `reason`, do not suppress it

Two options were weighed.

|             | **A — suppress `pty:exit` for a park**                                                                                           | **B — emit it with `reason: 'park'`** (chosen)                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| shape       | `onExit` returns early when the ptyId is marked parked; `pty:hibernated` is the only signal                                      | payload gains `reason?: 'natural' \| 'park'`; every consumer keeps receiving it |
| what breaks | every OTHER `pty:exit` consumer silently stops being cancelled                                                                   | nothing — consumers that ignore the new field behave exactly as today           |
| ordering    | still race-dependent (the renderer must already have torn down before…) — no, it removes the race, but only for the one consumer | removes the race for all consumers: the fact travels with the event             |

`pty:exit` is **not** a private channel of `TerminalPane`'s session handler. Grepped consumers:

| Consumer                            | File:line                                         | What it does on exit                                                                                         | Effect if suppressed (option A)                                                            |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| session exit handler (the offender) | `TerminalPane.vue:609-627`                        | writes `[session ended]`, sets `live.dead`, `unregisterLiveSession`, `unregisterWriter`, `markSessionExited` | the park path already skips it via the dispose — no loss                                   |
| pre-prompt inject gate              | `TerminalPane.vue:1172`                           | `gate.cancel()`                                                                                              | gate hangs until `capMs` instead of cancelling                                             |
| prompt submitter                    | `src/renderer/src/components/prompt-inject.ts:78` | `submitter.cancel()`                                                                                         | same — a retry loop keeps firing at a dead ptyId                                           |
| helper-pane exit watch              | `src/renderer/src/stores/helpers.ts:823-835`      | early-exit "stale session" toast, or auto-close the pane                                                     | helper PTYs are never parked (§3.1), but the channel would become conditional for them too |

Helper panes are structurally out of the park path: `fleetSnapshot()` skips PTYs without a
`sessionKey` (`pty.ts:474`) and `isParkable` only admits `claude-resume`
(`src/main/fleet-policy.ts:167`). They are listed to show the channel is shared.

**Decision: option B.** `reason` is optional on the wire and **absent means `'natural'`**, so
a stale preload/renderer pair keeps today's behavior instead of going mute.

### 3.1 Where the intent is recorded — BEFORE `.kill()`

The exit callback can fire on the next tick, so the mark must exist before the kill. It goes
in `src/main/hibernation.ts`, next to the registry it belongs to — **not** in `pty.ts`, which
is a coverage-excluded imperative shell (`vitest.config.mts:22`) while `hibernation.ts` is
pure and already unit-tested (`tests/hibernation.test.ts`).

```ts
// src/main/hibernation.ts (additions)
const parkingPtyIds = new Set<string>()
/** Tag a ptyId as being killed FOR A PARK. Must be called before `.kill()`. */
export function markParking(ptyId: string): void
/** True iff this ptyId's imminent exit is a park. Does not consume. */
export function isParking(ptyId: string): boolean
/** Drop the tag — called from `onExit` after the reason is stamped. */
export function clearParking(ptyId: string): void
```

Keyed by **ptyId**, not sessionKey: `hibernateSession` already removes the index entry
(`pty.ts:513`), so by the time `onExit` runs the reverse lookup `sessionIndex.getSessionKey(id)`
returns `undefined` for a parked session. The ptyId is the only identifier that survives.

`clearParking` in `onExit` is the normal path; `hibernateSession` also clears defensively if
`.kill()` throws (already caught at `pty.ts:509-512`), so a failed kill cannot leave a
permanent tag that would mislabel a later natural exit of a reused id.

### 3.2 The wire

```ts
// src/main/pty.ts — onExit
const reason: PtyExitReason = isParking(id) ? 'park' : 'natural'
clearParking(id)
getWindow()?.webContents.send('pty:exit', {
  id,
  exitCode: evt.exitCode,
  signal: evt.signal,
  reason
})
```

`PtyExitReason` and the extra field are added to `PtyExitPayload` / `PtyExitEvent`
(`src/preload/index.ts:380-400`) and forwarded by the dispatcher (`:432-437`).

### 3.3 The renderer rule

`TerminalPane.vue:609-627` keeps **all** its teardown (`live.dead`, `unregisterLiveSession`,
`unregisterWriter`) — those describe the PTY, which really is gone — and gates only the
lifecycle verdict:

```ts
// a park is a resource decision, not a lifecycle outcome
if (evt.reason !== 'park') sessions.markSessionExited(sessionId, evt.exitCode)
```

The `[session ended]` line is also suppressed for a park: the terminal is about to be
disposed anyway (BUG-69), and on the racy ordering it would otherwise paint a lie into a
scrollback the operator may still scroll.

`markSessionExited` itself is left untouched — it is the honest name for "a natural exit
happened". The guard belongs at the call site that knows the provenance, not inside a store
function that would then need a second source of truth.

## 4. Waking must be recorded, not erased

`clearHibernated` (`hibernation.ts:24`) deletes the only trace. Replace the erasure with a
ledger entry — same module, no new file:

```ts
interface ParkEvent {
  sessionKey: string
  parkedAt: number
  wokenAt: number | null
  wakeGesture: WakeGesture
}
type WakeGesture = 'select' | 'restart' | 'notification-click' | 'unknown'
export function recordPark(sessionKey: string, atMs: number): void
export function recordWake(sessionKey: string, atMs: number, gesture: WakeGesture): void
export function parkHistory(): readonly ParkEvent[] // bounded ring, 200 entries
```

`markHibernated`/`clearHibernated` keep their signatures and call into the ledger; `now` is
injected by the caller (`pty.ts` passes `Date.now()`) so the module stays clock-free and
testable, exactly like `evaluateFleet` (T119 §3.1).

The gesture is carried on `pty:create` (`opts.wakeGesture`), defaulting to `'unknown'`. The
UI surfacing of the ledger (a parked row that says "parked 12 min ago") belongs to **T178**;
this card only guarantees the record exists.

## 5. What must NOT change

A genuine agent completion still notifies exactly as today. The regression bar is explicit
because the cheap version of this fix (muting `completed` whenever `isHibernated(key)` is
true) would silence real finishes for any session that had ever been parked in this run —
the flag is set for the _session_, the provenance belongs to the _exit_.

## 6. Test plan

| Test                                                                                                                              | File                                                                                                                                               | Asserts                    |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `markParking` → `isParking` → `clearParking` round-trip, idempotent, unknown-id safe                                              | `tests/hibernation.test.ts` (existing)                                                                                                             | the mechanism              |
| the park ledger records `parkedAt`, then `wokenAt` + gesture; ring is bounded                                                     | `tests/hibernation.test.ts`                                                                                                                        | §4                         |
| exit handler: `reason: 'park'` → `markSessionExited` NOT called; `unregisterLiveSession`/`unregisterWriter` still called          | `tests/sessions-store.test.ts` (existing — extract the guard as a tiny pure `shouldMarkExited(reason)` so it is testable without mounting the SFC) | §3.3                       |
| `reason` absent → treated as natural (back-compat)                                                                                | `tests/sessions-store.test.ts`                                                                                                                     | §3 decision                |
| a park produces zero `maybeNotify` calls; a real `exitCode: 0` still notifies                                                     | `tests/session-notify-store.test.ts` (existing)                                                                                                    | §5 regression bar          |
| no push send on a park                                                                                                            | `tests/push-relay.test.ts` (existing)                                                                                                              | §2 chain                   |
| park → click-to-wake writes a ledger entry with `gesture: 'notification-click'` never being reachable (no notification is raised) | `tests/hibernation.test.ts`                                                                                                                        | closes the necromancy loop |

**Honest gap:** none of these prove the real IPC ordering. The end-to-end assertion (park a
live session, observe zero notifications, observe the process gone) belongs to
`tests/e2e/os-notifications.spec.ts` or the second-instance CDP recipe
(`docs/dev/live-verify-second-instance.md`), as in T119 §8.2.

## 7. Contracts touched

- `CHANGELOG.md` — **Fixed**, user-visible ("parking a session no longer reports it as
  completed or raises a notification").
- `docs/capy-features.md` — **not** agent-facing: no MCP verb, no ACK field, no new
  affordance the session can offer. `get_fleet`'s `hibernated` flag is unchanged.
  Carry `no-awareness` if the gate trips.
- `docs/user/` — not user-reachable surface (no new component, no new `src/main/` top-level
  file, no `tool-catalog.ts` change); carry `no-user-docs`.

## 8. Landing order

**BUG-70 → BUG-69 → T178.**

BUG-70 first because it is the only one of the three that makes the silence **structural**.
If BUG-69 lands first, the manual park stops lying — but only through the same
send-before-exit race documented in §2.1, and its tests could not assert silence
deterministically. With provenance on the wire, BUG-69 becomes a pure convergence refactor
and T178's audit has a fact to check each surface against.

## 9. Definition of done

- [ ] `markParking`/`isParking`/`clearParking` in `src/main/hibernation.ts`, tagged before `.kill()` in `hibernateSession` and in the new park verb (BUG-69)
- [ ] `pty:exit` carries `reason`; absent ⇒ `'natural'`
- [ ] `TerminalPane.vue:609-627` skips `markSessionExited` and the `[session ended]` paint for `reason === 'park'`
- [ ] park ledger (§4) records park + wake with a gesture
- [ ] tests in §6 green; the "real completion still notifies" regression test written FIRST
- [ ] `CHANGELOG.md` entry
- [ ] `npm run typecheck` and `npm run build` pass
