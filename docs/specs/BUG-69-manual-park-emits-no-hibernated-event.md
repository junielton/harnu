# BUG-69 — manual park never emits `pty:hibernated`

**Date:** 2026-07-22
**Status:** specified (not implemented)
**Card:** `.capy/memory/roadmap/BUG-69-manual-park-never-emits-pty-hibernated-the-renderer-s-xterm-and.md`
**Lands:** SECOND — after BUG-70, before T178 (BUG-70 §8).
**Depends on:** `docs/specs/BUG-70-park-misreported-as-completed.md` for the park-provenance
mechanism (`markParking` / `pty:exit.reason`). Not restated here.

## 1. Symptom

Parking a session by hand (**Park now** on a System Monitor row) kills the process but frees
none of the renderer's memory, and leaves the session's exit listener armed — which is what
turns a park into a fake "session finished" (BUG-70).

Ten auto-parked sessions look fine; hand-parked ones leak the whole scrollback.

## 2. Root cause — verified

`onPark` is two half-steps plus an implicit third that never happens
(`src/renderer/src/components/SystemMonitor.vue:73-78`):

```ts
async function onPark(sessionKey: string): Promise<void> {
  const ptyId = livePtyIdFor(sessionKey)
  if (ptyId) window.api.ptyDestroy(ptyId) // kill
  await window.api.monitorPark(sessionKey) // flag
  sessions.markHibernated(sessionKey) // hopeful UI
}
```

The main-side handler only flags (`src/main/monitor/sampler.ts:224-226`):

```ts
ipcMain.handle('monitor:park', (_e, sessionKey: string): void => {
  markHibernated(sessionKey)
})
```

The comment above it (`sampler.ts:218-223`) states the shortcut plainly — the kill rides the
existing `pty:destroy` "to keep this slice inside its one-new-pty.ts-export boundary". The
cost: **no `pty:hibernated` broadcast**, so the renderer's hibernation handler — the ONLY
caller of `disposeLiveTerminal` on this path (`TerminalPane.vue:987-994`) — never runs.

Consequences, each verified:

- the `LiveTerminal` (xterm.js `Terminal` + its full scrollback) stays in the module-level
  `liveTerminals` map for the life of the window. `disposeLiveTerminal`
  (`TerminalPane.vue:880-922`) is what calls `term.dispose()`, drops the writer, disarms the
  injection watchdog, detaches the screen scraper and runs `live.cleanups` — none of it fires.
- the `onPtyExit` subscription (registered at `TerminalPane.vue:609`, torn down only via
  `live.cleanups` in `disposeLiveTerminal`) stays armed, so the imminent `pty:exit` from the
  `ptyDestroy` kill is processed as a natural exit → BUG-70.
- `sessions.markHibernated` (`src/renderer/src/stores/sessions.ts:1636-1643`) clears
  `taskState`/`pulse` optimistically, then the late `pty:exit` **re-sets** `taskState` to
  `completed` via `applyTaskState` (`sessions.ts:3265-3289`). The row ends up flagged parked
  _and_ dotted completed — the two writes race and the exit wins, because it arrives after
  the awaited `monitorPark` resolves.

The sweep path (`hibernateSession`, `src/main/pty.ts:503-521`) does kill + flag + broadcast in
one place and the renderer disposes correctly — but see **BUG-70 §2.1**: its silence on the
exit channel is an ordering accident, which BUG-70 fixes structurally. That is why BUG-70
lands first and why this card is then a pure convergence.

## 3. Decision — one main-side verb; delete the renderer's orchestration

The card's preferred shape is feasible against the real IPC surface. Verified:

- `hibernateSession` is a closure inside `registerPtyHandlers` (`pty.ts:503`), reached today
  only by `runPolicy` (`pty.ts:529-533`) from the cap check in `pty:create` and from the 60 s
  sweep. Exposing it over IPC needs no new module: an `ipcMain.handle('pty:park', …)`
  registration sits beside `pty:destroy` (`pty.ts:828`) inside the same closure, so it reads
  `sessionIndex`, `ptys`, `lastFocusedAt` and `getWindow()` directly.
- resolving `sessionKey → ptyId` is already `sessionIndex.getPtyId(sessionKey)`
  (`pty.ts:504`), so the renderer no longer needs `livePtyIdFor` for this path.
- the preload gains `ptyPark(sessionKey): Promise<void>` beside `ptyDestroy`
  (`src/preload/index.ts:803` neighborhood); `monitorPark` (`preload/index.ts:1956-1957`) is
  **removed** together with the `monitor:park` handler.

### 3.1 The shape

```
SystemMonitor.onPark(sessionKey)
  → window.api.ptyPark(sessionKey)          // ONE call
      → pty.ts: hibernateSession(sessionKey)
          markParking(ptyId)                 // BUG-70 §3.1 — before .kill()
          flushNow · kill · ptys.delete · sessionIndex.removeByPtyId
          pruneTaskState · lastFocusedAt.delete
          markHibernated(sessionKey) + recordPark(...)   // BUG-70 §4
          send('pty:hibernated', { sessionKey })
  → renderer: onPtyHibernated → disposeLiveTerminal + liveTerminals.delete
              + sessions.markHibernated(sessionKey)      // from the EVENT
```

`sessions.markHibernated(sessionKey)` at `SystemMonitor.vue:77` is **deleted**. The flag comes
from the broadcast (`TerminalPane.vue:993` already calls it), so flag and disposal are one
transaction with one origin. The optimistic call is what makes today's state divergent when
the event never arrives; keeping it would preserve the divergence the fix exists to remove.

`monitorPark` and `monitor:park` are removed rather than left as a deprecated alias: the only
caller is `SystemMonitor.onPark`, and a second way to flag without disposing is precisely the
class of bug being closed ("no path can mark a session parked without the terminal being
disposed" — the card's third acceptance criterion).

### 3.2 Deliberately NOT changed: manual park ignores the immunity list

`explainFleet`'s `parkable` is **kind-only** (`src/main/fleet-policy.ts:167` →
`isParkable(s.kind)`); `selected` and `pending-approval` are separate `reason` values that do
not clear the flag. `SystemMonitorRow` gates the button on
`rowKind === 'session' && state === 'live' && parkable`
(`src/renderer/src/components/SystemMonitorRow.vue:86-87`), so **Park now** is offered for the
selected session and for a session holding a confirm.

Converging on `hibernateSession` preserves this: `hibernateSession` runs no policy — it kills
whatever key it is given. That is correct for an explicit operator gesture (a manual override
must be able to park what the operator points at), and it keeps this card a refactor rather
than a behavior change. The _consequences_ of parking a selected or approval-holding session
are audited in **T178 §3** (rows: Approval Inbox, selected-session UX), where the
`hasPendingApproval: false` finding is escalated.

## 4. Acceptance

- Manual park and automatic sweep produce **byte-identical observable state**: process dead,
  `liveTerminals` entry disposed and deleted, `hibernated` flag set from the broadcast,
  sidebar row and monitor row agree, `taskState` cleared and never re-set.
- Exactly one code path can set the parked flag (`hibernateSession`), and it always
  broadcasts.
- No `completed`/`failed` state and no notification on either path (guaranteed by BUG-70;
  asserted again here for the manual path).

## 5. Test plan

| Test                                                                                                              | File                                                                                                                                                                                                    | Asserts                                 |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pty:park` is registered and kills + flags + broadcasts for a live key; unknown key is a no-op, not a throw       | `tests/monitor-sampler-wiring.test.ts` (existing harness already doubles `electron`, `pty`, `hibernation` — extend it, or lift to a sibling `tests/pty-park-verb.test.ts` if the pty double gets heavy) | §3.1                                    |
| `monitor:park` is GONE — the handler map has no such channel after `registerMonitorHandlers`                      | `tests/monitor-sampler-wiring.test.ts` (replaces the existing `describe('monitor:park')` at `:149-157`)                                                                                                 | §3.1                                    |
| the parked row still renders (`state: 'parked'`, em-dash cost) from `hibernatedKeys()` after the verb change      | `tests/system-monitor-format.test.ts` (existing)                                                                                                                                                        | no regression in the sampler projection |
| the store's `markHibernated` clears `taskState`/`pulse` and a subsequent `reason: 'park'` exit does not re-set it | `tests/sessions-store.test.ts` (existing)                                                                                                                                                               | §2 race                                 |
| park ledger gets exactly one entry per manual park                                                                | `tests/hibernation.test.ts` (existing)                                                                                                                                                                  | BUG-70 §4                               |

**Honest gap — the card's headline assertion is not unit-testable as written.**
`liveTerminals` is a module-level map inside `TerminalPane.vue` with no exported accessor, and
`src/main/pty.ts` is a coverage-excluded imperative shell (`vitest.config.mts:22`). Asserting
`liveTerminals.has(key) === false` after a manual park therefore requires either (a) an
exported test-only probe on the pane, or (b) an e2e. Preferred: **(b)** — extend
`tests/e2e/reload-survival.spec.ts`'s pattern with a park case, and confirm the RSS drop with
the second-instance CDP recipe (`docs/dev/live-verify-second-instance.md`), as T119 §8.2 did.
Do not fake it with a unit test that asserts the handler was _called_.

## 6. Contracts touched

- `CHANGELOG.md` — **Fixed** ("parking a session from the System Monitor now frees its
  terminal and scrollback, like the automatic sweep").
- `docs/capy-features.md` — not agent-facing (no verb, no ACK field, no new affordance);
  `no-awareness` if the gate trips on an unrelated file.
- `docs/user/` — no new component and no new top-level `src/main/` file (the verb is added
  inside the existing `pty.ts`); `no-user-docs`.
- `design.md` — untouched: no new visual state (the parked row already exists, T127 S4).
- i18n — no new keys.

## 7. Definition of done

- [ ] `pty:park` handler in `src/main/pty.ts` delegating to `hibernateSession`
- [ ] `ptyPark` in the preload; `monitorPark` + `monitor:park` deleted
- [ ] `SystemMonitor.onPark` is one call; the optimistic `sessions.markHibernated` deleted
- [ ] tests in §5 green, including the removed-channel assertion
- [ ] e2e/live check that the terminal is actually disposed and RSS drops
- [ ] `CHANGELOG.md` entry
- [ ] `npm run typecheck` and `npm run build` pass
