# T178 — a parked session must be silent

**Date:** 2026-07-22
**Status:** specified (not implemented)
**Card:** `.capy/memory/roadmap/T178-a-parked-session-must-be-silent-audit-every-noise-source.md`
**Lands:** THIRD — after BUG-70, then BUG-69 (BUG-70 §8).
**Depends on:** `docs/specs/BUG-70-park-misreported-as-completed.md` (park provenance, park
ledger) and `docs/specs/BUG-69-manual-park-emits-no-hibernated-event.md` (one park verb).
Neither mechanism is restated here.

---

## 0. Findings that change the picture — read first

### 0.1 Spontaneous resurrection: NOT FOUND. The question is settled — see §4.

The suspicion that a parked session comes back on its own is **not supported by the code**.
Every path to `ptyCreate` was enumerated (§4); the only wake vectors are an operator
selection, an explicit Restart, and a click on an OS notification — and that last one exists
only because of BUG-70, which this stack removes. No watcher, no timer, no reconciliation,
and no MCP verb can spawn a PTY for an existing (parked) session. The card's "not in scope"
paragraph can be closed with this verdict rather than split into a new bug.

### 0.2 NEW DEFECT — the `pending-approval` immunity is inert. Needs its own card.

T119 §3.4 lists "`!hasPendingApproval` → immune: hibernating would strand the confirm in the
Approval Inbox". In production that rule can never fire: **`hasPendingApproval` is hardcoded
`false`** at both sites that build the policy input —

- `src/main/pty.ts:483-490` (`fleetSnapshot`, feeds `evaluateFleet` → the cap and the sweep)
- `src/main/monitor/sampler.ts:129-136` (feeds `explainFleet` → the System Monitor's `reason`)

Both carry a comment claiming it is safe because "the confirm is re-raised on resume". That
claim is **unverified and probably false** for hook approvals: `approval-resolver.ts` parks
each request in a `pending` map keyed by `requestId` with an abort deadline
(`src/main/approval-resolver.ts:85-99`), and nothing prunes it on PTY teardown — `pty.ts` has
zero references to approvals. Killing the session kills the hook subprocess that is blocked
on the HTTP response, so the Inbox row survives its own session and can only end in a
timeout (`closeApprovals`, `approval-resolver.ts:137-141`, is quit-time only). The MCP-confirm
queue (`session-mcp-confirms.ts`, rehydrated from `mcpConfirmsList`) has the same shape.

Manual park makes it worse: **Park now** is offered regardless of `reason`, because the button
gate is kind-only (`SystemMonitorRow.vue:86-87` ← `fleet-policy.ts:167`), so the operator can
park a session that is holding a confirm with one click.

This is a real defect with its own failure mode (a stranded approval, not noise) and its own
fix (wire `hasPendingApproval` from the approval registry, or prune approvals on teardown).
**File it as a separate bug card; it is not fixed here.** It appears in the audit table below
as an open row so the table stays honest.

### 0.3 The `[session ended]` line and the stale registry dot

Two smaller "the row speaks" leaks, both in the table: the exit handler paints
`[session ended]` into the scrollback before anything checks provenance
(`TerminalPane.vue:610`) — fixed by BUG-70 §3.3 — and the PID-registry overlay
(`session-registry-watch` → `setRegistryState`, `sessions.ts:4386-4390`) is never cleared for a
parked key, so `resolveActivity` can still resolve a dot for a session with no process.

---

## 1. The principle

**A parked session is silent.** It does not notify, ding, badge, raise the window, push, or
ask for anything. Reclaiming memory is a decision Capy made on the operator's behalf; it must
never be dressed up as an event that invites a click.

**Waking is deliberate and recorded.** A wake is an operator gesture (selection, Restart) or
an explicit agent verb — never a side effect of a re-render, a re-selection, or a watcher
event. It is written to the park ledger (BUG-70 §4) rather than erased by `clearHibernated`.

## 2. Method

Every surface below was read, not guessed. A surface is silent for a parked session in one of
three ways:

- **structural** — it cannot fire, because the thing that raises it is the dead process;
- **derived** — it is fed by a chain BUG-70/BUG-69 already cut (`markSessionExited` →
  `applyTaskState` → `maybeNotify` → toast / OS notification / chime / push / badge);
- **needs a guard** — it has an independent trigger and must consult `isHibernated()` (main)
  or `session.hibernated` (renderer).

## 3. The audit table

| #   | Surface                                             | Evidence                                                                                                                                                                       | Can it fire for a PARKED session?                                                                                                                                        | What makes it silent                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OS notification ("session completed/failed")        | `sessions.ts:3322-3325` → `:3265-3289` → `maybeNotify` `:3219-3255`; main renderer `src/main/notifications.ts:62-84`                                                           | **Yes, today** — the whole bug                                                                                                                                           | **derived**: BUG-70 §3.3 skips `markSessionExited` for `reason: 'park'`                                                                                                                                                                                                                                  |
| 2   | In-app toast (window focused)                       | `dispatchNotification`, `src/renderer/src/stores/notify-dispatch.ts:34-57`                                                                                                     | Yes, today — same call                                                                                                                                                   | **derived**: same cut                                                                                                                                                                                                                                                                                    |
| 3   | Chime                                               | `playNotificationSound()`, `notify-dispatch.ts:50`                                                                                                                             | Yes, today — same call                                                                                                                                                   | **derived**: same cut                                                                                                                                                                                                                                                                                    |
| 4   | Remote push (ntfy / webhook)                        | `sessions.ts:3244-3252` → `push:send` → `src/main/push.ts:321`                                                                                                                 | Yes, today — rides the OS channel only, so it fires exactly when the operator is away                                                                                    | **derived**: same cut. No guard in `push.ts` — it must stay a dumb relay                                                                                                                                                                                                                                 |
| 5   | Window attention (flash / dock bounce)              | `src/main/window-attention.ts:25-46`; callers `sessions.ts:4366` (Sentinel-blocked) and `session-mcp-confirms.ts:102` (a confirm arrived)                                      | **No** — neither trigger can occur for a parked session: both originate in a running `claude` (a blocked command, an MCP confirm from its agent)                         | **structural** — no guard needed; do not add one                                                                                                                                                                                                                                                         |
| 6   | Dock/taskbar badge                                  | `src/main/badge.ts:49-70`; count is the renderer's needs-input tally                                                                                                           | **No** — `markHibernated` clears `taskState` (`sessions.ts:1636-1643`), so a parked row cannot be counted as needs-input                                                 | **structural**, but only once BUG-69 makes the flag authoritative; the today-race in BUG-69 §2 can leave a stale count for one tick                                                                                                                                                                      |
| 7   | Activity bell (notification history)                | `ActivityBell.vue:20-31` renders `useNotificationsStore()`; rows are written by `dispatchNotification` (#1–#3) and by the agent `notify` verb                                  | Only via #1–#3, plus an agent's own `notify` — which a parked (dead) process cannot call                                                                                 | **derived**                                                                                                                                                                                                                                                                                              |
| 8   | Hook bridge — a LATE hook event                     | `src/main/hook-bridge.ts:464-474` sends `claude:hook` unconditionally; renderer applies it with no liveness check (`sessions.ts:4364-4372` → `applyTaskState` → `maybeNotify`) | **Yes** — a `Stop`/`SessionEnd` POSTed by the dying process (or an in-flight request) lands after the kill and both notifies and re-animates `taskState` on a parked row | **needs a guard**: drop the event in main when `isHibernated(sessionId)` (`hook-bridge.ts`, beside the existing `pruneTaskState` liveness convention). Guard in MAIN, not the renderer, so the MCP disclosure and the digest observers (`addTaskEventObserver`, `hook-bridge.ts:295`) see the same truth |
| 9   | Approval Inbox — new confirm                        | `approval-resolver.ts:85-99`; `session-mcp-confirms.ts`                                                                                                                        | **No** — a dead process raises nothing                                                                                                                                   | **structural**                                                                                                                                                                                                                                                                                           |
| 10  | Approval Inbox — a confirm the session ALREADY held | `pty.ts:483-490` / `sampler.ts:129-136` (`hasPendingApproval: false`); no teardown pruning in `approval-resolver.ts`                                                           | **Yes** — the row outlives its session and can only time out                                                                                                             | **OPEN — §0.2, separate card.** Not fixed here                                                                                                                                                                                                                                                           |
| 11  | Statusline / telemetry                              | `src/main/statusline.ts:261` sends `telemetry:updated` (usage numbers, not session events)                                                                                     | No session-scoped signal at all                                                                                                                                          | **structural**                                                                                                                                                                                                                                                                                           |
| 12  | `claude-watcher` (JSONL)                            | `src/main/claude-watcher.ts:501`; renderer handler `sessions.ts:4240-4272` — sets `transcriptState`, `ctxPct`, `pulse`, `maybeAutoname`, never `maybeNotify`                   | Fires only if the JSONL changes, which needs a live writer → **No** in practice; and it cannot notify even if it did                                                     | **structural** (data-only channel). Leave alone                                                                                                                                                                                                                                                          |
| 13  | `session-registry-watch` (PID registry)             | `src/main/session-registry-watch.ts:227`; renderer `sessions.ts:4386-4390` → `setRegistryState`                                                                                | Fires (the PID file disappears when the process dies) but **cannot notify** — it only sets an overlay state; the stale overlay can still colour a parked row's dot       | **needs a small guard**: clear the registry override for a key on `pty:hibernated` (renderer, in `markHibernated`) — cosmetic honesty, no sound                                                                                                                                                          |
| 14  | `team-watcher`                                      | `src/main/team-watcher.ts:182` → `claude:team:updated` (board data)                                                                                                            | Team board rows, no per-session notification                                                                                                                             | **structural**                                                                                                                                                                                                                                                                                           |
| 15  | `roadmap-watcher`                                   | `src/main/roadmap-watcher.ts` → board card events                                                                                                                              | Card-scoped, not session-scoped                                                                                                                                          | **structural**                                                                                                                                                                                                                                                                                           |
| 16  | Sentinel-blocked toast + attention                  | `sessions.ts:4357-4368`                                                                                                                                                        | Needs a command being run by a live process                                                                                                                              | **structural**                                                                                                                                                                                                                                                                                           |
| 17  | Helper-pane "stale session" toast                   | `src/renderer/src/stores/helpers.ts:823-835` on `pty:exit`                                                                                                                     | Helper PTYs are never parked — `fleetSnapshot` skips PTYs with no `sessionKey` (`pty.ts:474`) and `isParkable` admits only `claude-resume` (`fleet-policy.ts:167`)       | **structural**                                                                                                                                                                                                                                                                                           |
| 18  | `[session ended]` painted into the scrollback       | `TerminalPane.vue:610`                                                                                                                                                         | Yes, today — before any provenance check                                                                                                                                 | **derived**: BUG-70 §3.3                                                                                                                                                                                                                                                                                 |
| 19  | Injection gate / prompt submitter cancels           | `TerminalPane.vue:1172`, `prompt-inject.ts:78`                                                                                                                                 | They _should_ fire on a park (the PTY really is gone) and they are silent — no toast, no sound                                                                           | **structural**; this is why BUG-70 emits `pty:exit` with a reason instead of suppressing it                                                                                                                                                                                                              |

Rows needing new code: **#8** (main-side hook guard) and **#13** (clear the registry
override). Everything else is either already cut by BUG-70/BUG-69 or structurally unreachable
— and rows #5, #6, #12, #14–#17 must **not** grow a defensive `isHibernated()` check, because a
guard that can never be false is a lie about how the system works.

## 4. Every path to `ptyCreate` — and why none is spontaneous

`ptyCreate` has exactly **two** call sites in the renderer (grep: `window.api.ptyCreate`):

| Call site                                     | Reached from                                                         | Can it wake a PARKED session?                                                  |
| --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `TerminalPane.vue:488` (`createLiveTerminal`) | `activate()` (`TerminalPane.vue:1284`) and `drainBgBoot()` (`:1374`) | see below                                                                      |
| `HelperPane.vue:366`                          | helper-pane creation (explicit split/helper gesture)                 | **No** — helper PTYs carry their own pane ids and are never parked (§3 row 17) |

`activate()` is called from exactly two places (`TerminalPane.vue:969`, `:1464`):

| Caller                                      | Trigger                                                                                                                | Gesture?                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `watch(sessions.selectedId)` (`:1451-1464`) | any assignment to `selectedId`                                                                                         | see the enumeration below     |
| `registerReloadHandler` (`:961-970`)        | `sessions.reloadSession()` — the "Restart session" menu item (`docs/specs/2026-07-20-restart-ended-session-design.md`) | **explicit operator gesture** |

`drainBgBoot()` **cannot** wake a parked session: it skips any id that is not a live synthetic
(`TerminalPane.vue:1396-1399`, `if (!entry || entry.synthetic !== true) continue`), and
synthetics are excluded from parking by `isParkable` (`fleet-policy.ts:167`, T119 §5.2).

Every assignment to `selectedId` (grep `selectedId.value =`, 16 sites in
`src/renderer/src/stores/sessions.ts`):

| Sites                                                                             | What they do                                                                                                           | Verdict                                                                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `:2129`, `:2133` (`select`/unselect), `:2361`, `:2393`, `:2471`, `:2674`, `:2746` | operator actions: click a row, New session, Dispatch card, Fork, New folder terminal — all mint or select on a gesture | gesture                                                                                                                       |
| `:1285`, `:2577` (`insertAgentSession`)                                           | an agent's `create_session`: selects **only when nothing is selected**, and only its own brand-new synthetic           | never an existing parked session                                                                                              |
| `:2187`, `:2238`, `:4120`, `:4185`, `:4203`                                       | clear selection when the selected session vanishes (`= null`)                                                          | cannot spawn                                                                                                                  |
| `:2621`, `:3949`, `:3957`, `:4076`                                                | synthetic → real re-key, only when that id was already selected                                                        | same session, already live; no new PTY (`registerMigrateHandler`, `TerminalPane.vue:1010+`)                                   |
| `:4392` `onNotifyActivate`                                                        | a click on an OS notification → `activateSession`                                                                      | **operator click, but on a notification Capy raised** — the necromancy loop. Removed by BUG-70: a park raises no notification |

MCP: the catalog (`src/main/mcp/tool-catalog.ts:280-747`) has **no** verb that selects, opens,
focuses or resumes an existing session. `create_session` and `spawn_terminal` mint new ones;
`get_fleet` / `get_session` are read-only. An agent therefore cannot resurrect a parked peer.

**Verdict: no spontaneous-resurrection path exists.** The observation that motivated the
suspicion is fully explained by BUG-70 — a park raised a "completed" notification, the
operator clicked it, and `clearHibernated` erased the evidence that a park had ever happened
(`hibernation.ts:24`, `pty.ts:766`, renderer twin `TerminalPane.vue:1342`).

## 5. Making the wake visible (UI)

Small, and the only user-visible surface this card adds:

- a parked sidebar row states its cost — "parked · click to wake (~450 MB)" — so waking reads
  as spending, not as resuming a chat. The parked row state already exists (T119 §7 `💤`);
  this is copy plus the ledger's `parkedAt` age. **`design.md` §6 must be edited first**, and
  the strings go into **both** `en.json` and `pt-BR.json`.
- the park ledger (BUG-70 §4) backs the age and the wake gesture. No new pane.

## 6. Test plan

| Test                                                                                                                                                                                                           | File                                                                                                                                                        | Asserts   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| a late `claude:hook` event for a hibernated key is dropped in main (no `claude:hook` send, no task-event observer call) and a live key still forwards                                                          | `tests/hook-bridge.test.ts` (existing)                                                                                                                      | row #8    |
| park → each surviving noise source driven → silence: no `notify:show`, no `push:send`, no `badge:set > 0`, no `window:requestAttention`                                                                        | `tests/hibernation-silence.test.ts` (**new**, node env — the table's executable form; doubles `electron` like `tests/monitor-sampler-wiring.test.ts:16-32`) | §1        |
| `markHibernated` clears the PID-registry override for that key                                                                                                                                                 | `tests/sessions-store.test.ts` (existing)                                                                                                                   | row #13   |
| a real completion still notifies, badges and pushes (regression)                                                                                                                                               | `tests/session-notify-store.test.ts`, `tests/push-relay.test.ts` (existing)                                                                                 | BUG-70 §5 |
| no non-gesture path calls `ptyCreate` for a hibernated key — asserted as a **structural** test over the call graph, not a runtime mock: `drainBgBoot` skips non-synthetics, `activate` has exactly two callers | `tests/sessions-store.test.ts` for the store half (`insertAgentSession` never selects an existing id); the pane half is an e2e                              | §4        |
| parked row copy renders the age from the ledger                                                                                                                                                                | `tests/system-monitor-format.test.ts` (existing)                                                                                                            | §5        |

**Honest gap:** the pane-level assertions (`liveTerminals`, `activate` callers) cannot be
unit-tested — same limitation recorded in BUG-69 §5. The end-to-end proof is
`tests/e2e/os-notifications.spec.ts` extended with a park case: park a live session, assert
zero notifications for 30 s, assert the process is gone, then click the row and assert exactly
one wake in the ledger.

## 7. Contracts touched

- `CHANGELOG.md` — **Changed** ("parked sessions no longer make noise; a parked row now shows
  what waking costs").
- `design.md` §6 — parked row copy, edited **before** the Vue (design contract).
- i18n — new keys in **both** `en.json` and `pt-BR.json`.
- `docs/capy-features.md` — **not** agent-facing: no verb, no ACK field. `get_fleet` already
  discloses `hibernated` (T119 §6) and its meaning is unchanged.
- `docs/user/` — no new component or top-level main file; `no-user-docs` unless §5 grows one.

## 8. Definition of done

- [ ] BUG-70 and BUG-69 landed first
- [ ] the §3 table is in this file and every "needs a guard" row (#8, #13) is implemented
- [ ] §0.2 filed as its own bug card (inert `pending-approval` immunity + unpruned approvals)
- [ ] §4's verdict recorded on the card; the "not in scope / unproven" paragraph closed
- [ ] `tests/hibernation-silence.test.ts` green; the real-completion regression tests green
- [ ] `design.md` §6 + i18n parity + `CHANGELOG.md`
- [ ] `npm run typecheck` and `npm run build` pass
