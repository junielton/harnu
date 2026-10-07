# P4W4 — Resume micro-plan

## 1. Status

Specified, not implemented · 2026-10-02 · Epic T389 · Late wave: the product panel paper asked to
defer this idea. It is specified in full, scheduled last in P4, and ships behind a switch that is
**off** by default.

Verified against Claude Code CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line of
that release's `claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on:** P2W1 (command channel, `command.result`, audit record), P1W4 (task-state hub,
  `companion-prefs.json`), P1W5 (`turn.started` / `turn.completed`), P1W6 (the spend ledger, the
  last known context size), P1W3 (`session.rebound` deletes the plan; the store subscribes to
  `onBindingChange`). Base branch: P2W2 or P2W1.
- **Interfaces used** (master §12): `enqueue`, `registerGateRow` and `registerCommandHandler`
  (P2W1); `registerPrefsKey('plan', …)` and `prefsKey` (P1W4); `recordAuxSpend` and
  `lastContextTokens` (P1W6); `companionHost.onBindingChange` and `bindingForSession` (P1W1).
  This wave owns `requestPark`.
- **Unblocks:** nothing.
- **Constrains:** every park goes through the coordinator of §7.2. No other wave calls
  `hibernateSession` directly.

## 3. Summary

Before Harnu parks a session it asks the companion for three lines — where the work stopped, the
next step, what is blocked — produced by `$.model.fork` over the session's own transcript. Harnu
stores the text; the transcript is untouched. The plan is shown where the operator resumes: the
session hover preview and the Folder View.

A park is never delayed past a fixed bound and never cancelled by a failed capture. The capture
spends tokens on the session's own model without the operator asking, so it is opt-in, its cost is
stated next to the switch, and its spend is accounted apart from turn usage.

## 4. Evidence

| Source                                                                                        | What it shows                                                                                                                                                                    | Verdict                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| smoke D4                                                                                      | Fork from a `turn.complete` hook: 1881 ms, `input 33, output 179, cache_read 50989, cache_creation 243`, a correct 3-line plan, no transcript rows; 3270 ms from a slash command | CONFIRMED              |
| smoke D4                                                                                      | `$.model.complete` on haiku with a `system` prompt: 730 ms, `input 467, output 12`; without `system` it continued the text instead of titling it                                 | CONFIRMED              |
| smoke D7                                                                                      | Fork and complete spend is in no `turn.complete`                                                                                                                                 | CONFIRMED              |
| types L2398–2416                                                                              | The fork re-sends the main thread's last request, every tool denied; "the prefix billed afresh once the entry lapsed or after `/model`"                                          | documented, not smoked |
| types L5953–5966                                                                              | `nothing-to-fork` before the first response, after `/clear`, on a resume that starts afresh; also `api-error`, `empty-reply`, `aborted`                                          | documented, not smoked |
| smoke A5, D6                                                                                  | A reload wipes module state; a same-tier mod can read another mod's `$` calls and results                                                                                        | CONFIRMED / REFUTED    |
| `fleet-policy.ts:58-62`                                                                       | Park thresholds are 15 and 60 minutes of idleness: when the policy decides to park, the prompt cache is usually cold                                                             | code                   |
| operator research, 2026-07-05 (local `memories/sessions/`, untracked, not in this repository) | A brief resume plan has the best cost-to-evidence ratio of the corpus; a plan the operator only reads resembles the ineffective condition                                        | basis for slice S2     |

Smoke D4 measured a **warm** fork only. The cold cost is read from the types, not measured.

## 5. Deviations from the study

| Study claim (new item 4)                                                                                     | Deviation                                                                                                                                                                                                                                                                                       | Basis                                               |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| "Before hibernating, the mod records …" (capture **before parking**), "a cheap question … it uses the cache" | C21: cheap only while the cache is warm. A capture at park time is usually cold and re-bills the whole context, so the default mode `idle` captures about three minutes after a turn ends and reuses the plan at park; capture-at-park stays as the mode `park`, under a context ceiling (§7.3) | C21; types L2402–2404; `fleet-policy.ts:58-62`; D11 |
| "the mod records where I stopped"                                                                            | The mod records nothing; it answers `plan.capture` and Harnu stores the text                                                                                                                                                                                                                    | smoke A5, D6; SEC-8                                 |
| Implied: every park gets a plan                                                                              | Off by default; skipped when not eligible, over budget or out of time                                                                                                                                                                                                                           | R19, R21                                            |

## 6. Scope / Non-goals

**In scope.** The park coordinator; the capture decision core; the plan store; the mod's
`plan.capture` handler; the plan block in the hover preview and the Folder View; the switch and
cost statement in Settings → Hibernation policy; the optional title (slice S3).

**Non-goals.**

- No change to **who** is parked: `evaluateFleet` and `isEligible` are untouched. A `working`
  claim is still parked only after `hardIdleMs` of PTY silence (`fleet-policy.ts:115`), and such a
  session is never forked (rule E4).
- No plan in any MCP verb, push notification, voice line or digest (OQ3).
- No injection of the plan into the resumed session.
- No capture without a live lease, for headless sessions, shells or synthetics. No retry.

## 7. Design

### 7.1 Modules

| Path                                                                        | Kind      | Responsibility                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/companion/plan-capture-core.ts`                                   | new, pure | `decideCapture`, `normalizePlan`, `revalidatePark`; injected clock                                                                                                                                      |
| `src/main/companion/park-coordinator.ts`                                    | new       | `requestPark`, the pending-park table, the wait timer, the warm timer per binding                                                                                                                       |
| `src/main/companion/plan-store.ts`                                          | new       | `<userData>/companion/resume-plans.json`, mode `0600`, atomic write, cap and TTL                                                                                                                        |
| `src/main/pty.ts`                                                           | change    | `runPolicy` (`:602-606`) and `pty:park` (`:958-960`) call `requestPark`; `hibernateSession` (`:570-595`) unchanged                                                                                      |
| `companion-prefs.json` (P1W4)                                               | change    | the key `plan: { enabled, mode, title }`, registered with `registerPrefsKey('plan', …)` (contract §11.5); `policy-store.ts` is not touched, although the switch is drawn in the Hibernation policy pane |
| `resources/companion/hooks/register.ts`                                     | change    | `runPlanCapture($, cmd)`, declared at the top of the file (MOD-1) and registered with `registerCommandHandler('plan.capture', …)`                                                                       |
| `src/preload/index.ts`, `stores/sessions.ts`                                | change    | `plansFor`, `planEdit`, `planClear`, `onPlanChanged`, `onPtyParking`; `Session.resumePlan?`, `Session.parking?`                                                                                         |
| `SessionPreview.vue`, `FolderViewSessions.vue`, `HibernationPolicyPane.vue` | change    | §10                                                                                                                                                                                                     |

### 7.2 Park flow

```
runPolicy(trigger) / pty:park ──► requestPark(sessionKey, cause: 'cap' | 'sweep' | 'manual')
   decideCapture(...)
   ├─ 'park-now' or 'reuse' ───────────────────────────► hibernateSession(sessionKey)
   └─ 'capture'
        pending.set(sessionKey, { ptyId, cause, requestedAt });  send pty:parking
        queue plan.capture (expiresAt = requestedAt + PLAN_CAPTURE_WAIT_MS);  arm the timer
           │ first of: command.result · timer · lease lost · pty exit · turn.started
           ▼
        finalize: store the plan if any → revalidatePark → park, or cancel
```

The coordinator queues the command with `enqueue({ sessionKey, name: 'plan.capture', args,
cause: { kind: 'internal', … }, ttlMs: PLAN_CAPTURE_WAIT_MS })` and registers its gate row with
`registerGateRow('plan.capture', …)`: only the cause `internal` passes (SEC-5c).

`requestPark` returns at once. Under the `cap` trigger the new session spawns immediately and the
fleet stays one over `maxLive` for at most `PLAN_CAPTURE_WAIT_MS`: the cap never blocks a spawn
(T119 §3.5).

`decideCapture` returns the first matching row:

| #   | Condition                                                                                                                                                                                                             | Result     | Reason            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------- |
| E1  | `plan.enabled` off, companion mode `off` (the kill switch included), or blocked folder                                                                                                                                | `park-now` | `disabled`        |
| E2  | no binding, lease not live, profile `headless` or `external`, the key `channel` not `active`, or `act.plan` not enabled or failed its proof                                                                           | `park-now` | `no-companion`    |
| E3  | a stored plan is fresh (no `turn.started` after its `capturedAt`)                                                                                                                                                     | `reuse`    | `fresh`           |
| E4  | hub state `working` or `needs-input` (an active turn, or `backgroundSubagents > 0`, which holds the state as working); or other background tasks are running (they do not change the state and only skip the capture) | `park-now` | `busy`            |
| E5  | no main-thread `turn.completed` seen in this process                                                                                                                                                                  | `park-now` | `nothing-to-fork` |
| E6  | mode `idle-only`                                                                                                                                                                                                      | `park-now` | `mode`            |
| E7  | cache presumed cold and the last known context exceeds `PLAN_COLD_MAX_CONTEXT_TOKENS`, or the context is unknown                                                                                                      | `park-now` | `too-costly-cold` |
| E8  | more than `PLAN_MAX_PER_SESSION_PER_HOUR` captures                                                                                                                                                                    | `park-now` | `rate`            |
| E9  | a capture is already pending                                                                                                                                                                                          | no-op      | —                 |
| E10 | otherwise                                                                                                                                                                                                             | `capture`  | —                 |

"Presumed cold" is `now - lastMainTurnCompletedAt > PLAN_CACHE_WARM_MS`. The host may learn a
longer lifetime from a fork that came back warm later than that, never a shorter one.

`revalidatePark` runs after the wait. It does **not** re-run `isEligible`: a capture may make the
PTY emit bytes, which would refresh `lastActivityAt`, cancel the park and trigger a new capture at
the next sweep. It checks only that (1) the session still has the same `ptyId`; (2) no
`turn.started` arrived since `requestedAt`; (3) for `cap` and `sweep`, the session is not selected
and holds no pending ask. A failed check cancels the park (`pty:parking { cancelled: true }`); the
plan is kept only if check 2 passed.

### 7.3 Capture modes

| `plan.mode`              | A capture is issued                                                                                                                                                                                                                                              | Cost profile                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `idle` (default when on) | `PLAN_WARM_AFTER_MS` after a main-loop `turn.completed` with no turn since, when E1–E5 and E8 pass (E7 is not evaluated: the cache is warm by construction, since the timer is shorter than `PLAN_CACHE_WARM_MS`); at park time `reuse`, else a capture under E7 | cache read; some plans are never used          |
| `idle-only`              | as `idle`, never at park time                                                                                                                                                                                                                                    | cache read only                                |
| `park`                   | only at park time, under E7                                                                                                                                                                                                                                      | usually cold: the whole context at input price |

The warm timer is armed on each main-loop `turn.completed` that is idle by D12's rule, and cleared
by `turn.started`, lease loss or exit. A warm capture uses the same command and finalize path with
`cause: 'idle'` and no park. The mode value is `idle-only`; its label key is `mode.idleOnly` (i18n
keys are camel-case).

### 7.4 Mod

```ts
// resources/companion/hooks/register.ts — top-level (MOD-1)
const PLAN_PROMPT = 'In 3 lines: where did we stop, what is the next step, what is blocked'

async function runPlanCapture($: Api, cmd: Command<'plan.capture'>): Promise<void> {
  // 1. fleet.activeTurnId !== null (an active turn) → command.result CMD_PRECONDITION, no model call
  // 2. r = await $.model.fork({ prompt: PLAN_PROMPT })
  // 3. args.title === true and r.isAnswered → the title step of §7.5
  // 4. queue command.result { ok: true, data } (edge flush)
}
```

- The prompt is the wording smoke D4 ran and a constant of the mod: the command carries no text
  (SEC-5a). A wording change is a mod version bump.
- The command executor fires `runPlanCapture` and does not await it (MOD-6).
- Every fork outcome is `ok: true`, with `data.text` set, or `null` plus `data.reason`. `ok: false`
  is a thrown `$` call (`CMD_FAILED`) or the refusal of step 1.
- The handler is registered with `registerCommandHandler('plan.capture', runPlanCapture)`. The
  in-flight `cmd` is recorded in P2W1's `channel.started` before the fork starts (contract §22),
  so a hot reload during the fork starts no second one; the host's timer finalizes. The
  active-turn test reads `fleet.activeTurnId` (P1W5: set by `turn.started`, back to `null` by
  `turn.completed`, contract §22). It must not read `channel.turnId`: that key is P2W1's, holds
  the last turn id for `turn.abort` and is never cleared (contract §11.4), so it would read as
  "a turn is running" for the rest of the session and refuse every capture (RB-2). When
  `sense.turn` is not enabled the `fleet` key is not maintained; the host then has no
  `turn.completed` either, and E5 already answers `park-now`.
- The mod writes the plan nowhere: not `$.store`, `$.state`, `$.ui` or a log.
- New `$` surface (MOD-3): `$.model.fork`; with slice S3, `$.model.complete`.

### 7.5 Optional title (slice S3)

| Path                                                  | Cost                                                                                               | Works when                  | New surface                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------- |
| A. `$.model.complete` on haiku, inside `plan.capture` | smoke D4: 730 ms, 467 input and 12 output tokens                                                   | the process is alive        | one `$` method, one boolean                    |
| B. `runHaiku` in main (`haiku.ts:86`), fed the plan   | one `claude -p --model haiku` child with the CLI's own system prompt, 20 s timeout (`haiku.ts:27`) | any time, also after a park | none; the plan leaves through a second process |

Decision: **A**, off unless `plan.title` is on. The title is made from the fork's answer in
the same command, with a fixed `system` prompt (without one the model continues the text),
`maxTokens: 40`, `timeoutMs: 8000`. A failed title never fails the capture; an org that does not
allow the haiku alias gets no title. The title heads the plan block and never renames the session.
`haiku:autoname` (`haiku.ts:108-125`) keeps naming new sessions from their first prompt and is not
touched; the companion is not injected into that probe (D1).

### 7.6 Contract additions

None — merged into `01-contract.md`: `CommandArgs['plan.capture']` and `PlanCaptureData` (§9),
`AuxUsage` (§8, shared with `compact.done`), the named text fields (§8 rules), the feature row
`act.plan` (§11.1), the key `plan` (§11.5), and the constants `PLAN_CAPTURE_WAIT_MS` (8 000) and
`PLAN_TEXT_MAX_CHARS` (600) (§7.2). `act.plan` is attempt-proven: the proof is the first
`command.result` with `ok: true`.

Host-only values, not contract constants:

| Value                            | Default       | Meaning                                          | Basis                                      |
| -------------------------------- | ------------- | ------------------------------------------------ | ------------------------------------------ |
| `PLAN_WARM_AFTER_MS`             | 180 000       | idle time before a warm capture                  | design; below `PLAN_CACHE_WARM_MS`         |
| `PLAN_CACHE_WARM_MS`             | 270 000       | idle time after which the cache is presumed cold | design; five-minute lifetime assumed (OQ1) |
| `PLAN_COLD_MAX_CONTEXT_TOKENS`   | 60 000        | largest context a cold capture may re-bill       | design                                     |
| `PLAN_MAX_PER_SESSION_PER_HOUR`  | 4             | spend ceiling per session                        | design                                     |
| `PLAN_STORE_MAX` / `PLAN_TTL_MS` | 500 / 30 days | store bounds                                     | design                                     |

### 7.7 Host data

```ts
interface ResumePlan {
  sessionId: string // the real session id, never a synthetic key
  lines: string[] // 1–3 lines from normalizePlan
  title?: string
  capturedAt: number
  cause: 'idle' | 'cap' | 'sweep' | 'manual'
  warm: boolean // cacheReadTokens > inputTokens + cacheCreationTokens
  usage: AuxUsage // contract §8
  editedLines?: string[] // slice S2
}
```

- `normalizePlan`: split on newlines, strip list markers, drop empty lines, keep three, cut each
  to 240 characters. Zero lines is `empty-reply`.
- **Staleness.** A `turn.started` after `capturedAt` deletes the plan and any edit; for a session
  on legacy the hub's `UserPromptSubmit` edge does the same. A plan always describes the last stop.
- **Re-key.** The store follows `pty:rekey` (`pty.ts:1003`). A `session.rebound` (`/clear`,
  in-session `/resume`), seen through `companionHost.onBindingChange`, deletes the plan.
- **Lifetime.** Removed with the session, by "Clear stored plans", by TTL and by the cap.
- **Spend.** `usage` and `titleUsage` go to P1W6's ledger through
  `recordAuxSpend({ kind: 'fork' | 'complete', sid, usage, ts })`, keyed by `sid`, tokens only:
  whether the fork's dollars are already inside `session.measure.cost.usd` is OQ2, and until then
  no USD is derived. The context size of rule E7 is `lastContextTokens(sid)`.

## 8. Arbitration & fallback

`act.plan` has no fact family and no legacy rival, so no family's `shadow` governs it (contract
§11.5). A capture needs four things: `plan.enabled`, the companion mode not `off`, a live lease,
and the key `channel` at `active`. The fallback is today's behaviour: a park with no plan, and a
preview that shows `awaySummary` / `whatsHappening` as now.

| Situation                                                                                                                           | Behaviour                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mod absent, CLI < 2.1.287, managed policy                                                                                           | E2: park at once, exactly as today                                                                                                                                                                      |
| Companion mode `off` at decision time                                                                                               | E1 (`disabled`): park at once                                                                                                                                                                           |
| Kill switch turned off mid-session                                                                                                  | the `conn` is revoked and the re-hello is answered `enable: []`: the mod is inert at once, with no TTL wait. A pending capture finalizes as `lease-lost` and the park proceeds; later decisions take E1 |
| The key `channel` is `shadow` or `off` (the command channel refuses), or the CLI is above the tested ceiling (`plan` capped to off) | E2: no capture                                                                                                                                                                                          |
| `nothing-to-fork`, `aborted`, `api-error`, `empty-reply`                                                                            | park proceeds; nothing stored; the reason is counted                                                                                                                                                    |
| Lease lost during the wait                                                                                                          | finalize at once (`lease-lost`); park proceeds                                                                                                                                                          |
| No result within `PLAN_CAPTURE_WAIT_MS`                                                                                             | finalize (`timeout`); park proceeds; `act.plan` records a failed proof (contract §11.2)                                                                                                                 |
| The operator selects the session during the wait                                                                                    | `cap` / `sweep`: cancelled, plan kept · `manual`: parked                                                                                                                                                |
| A turn starts during the wait                                                                                                       | cancelled; a late result is discarded                                                                                                                                                                   |
| Host restart during the wait                                                                                                        | the pending table is lost; the session stays live; the next sweep decides again                                                                                                                         |
| Hot reload during the fork                                                                                                          | no second fork; the timer finalizes                                                                                                                                                                     |
| Headless (`-p`, scheduler ticks)                                                                                                    | never parked (`fleet-policy.ts:72-74`), never polled (contract §16)                                                                                                                                     |
| App quit                                                                                                                            | no capture; `killAllPtys` as today                                                                                                                                                                      |
| A sibling mod intercepts `model.fork`                                                                                               | the text may be forged or empty; it is display-only and never executed (SEC-3d)                                                                                                                         |

## 9. Security requirements

SEC-1 to SEC-9 apply. Wave-specific:

1. **The plan is model output about the user's work.** It stays on this machine in one file under
   `<userData>/companion/`, mode `0600`. It is never written to a log, the parity ledger, the
   command audit, the shadow log, a push or voice payload, project memory or a fixture (SEC-8).
   Audit records (SEC-6) hold `cause`, `reason`, the text length, a sha256 prefix and token counts.
2. **Rendered as text only**: no HTML, Markdown or link detection.
3. **Never an instruction.** No code path feeds a stored plan to a session, an agent or a verb, so
   a forged plan (smoke D6) cannot steer a later turn.
4. **Origin** (SEC-5c): only the park coordinator queues `plan.capture`; its causes are the policy,
   the idle timer and the operator's "Park now". No verb queues it.
5. **Tier visibility is conceded**: a sibling mod can read the fork's reply, as it can read the
   transcript. No new exposure class is created and none is claimed away (SEC-7).

## 10. UX & copy

`design.md` first (DOC-4): §6 "Hibernation policy pane", "Hover preview", "Folder View — sessions
section"; §8 for the strings. No new component, no new token.

**Settings → Hibernation policy**: a group under the three existing fields (`ToggleSwitch`,
`SegmentedControl`, `SettingHint`).

| Key (`hibernationPolicy.plan.*`)            | English                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `label`                                     | Resume plan                                                                                                                                            |
| `hint`                                      | Before a session is parked, ask it for three lines: where it stopped, the next step, what is blocked. Shown when you hover the session.                |
| `cost`                                      | This uses the session's own model and your plan usage. A capture while the session is still warm is cheap; a cold one re-reads the whole conversation. |
| `mode.idle` / `mode.park` / `mode.idleOnly` | While warm / When parking / While warm only                                                                                                            |
| `spent`                                     | Last 7 days: {count} plans, {tokens} tokens                                                                                                            |
| `unavailable`                               | Needs the Harnu mod. Sessions on legacy are parked without a plan.                                                                                     |
| `clear`                                     | Clear stored plans                                                                                                                                     |

**Hover preview** (`SessionPreview.vue`): a block after the away recap (`:195-219`), in the same
form (`border-accent-line`, `bg-accent-soft`, `text-text-2`). Heading `preview.planLabel` "Resume
plan · {time}"; up to three lines; `preview.planEdited` "edited" when edited.

**Folder View** (`FolderViewSessions.vue`): a parked row with a plan shows the plan's second line
as a muted, truncated secondary line. If `design.md` has no two-line row variant, the plan stays
in the preview only.

**Sidebar row**: unchanged; the moon glyph (`SidebarFolder.vue:746-755`) stays. While a capture is
pending its label reads `session.statusParking` "Parking…". No toast and no sound (T178).

**Slice S2 — confirm or edit.** An "Edit" control in the preview turns the lines into a text
field; saving stores `editedLines`, shown in place of the captured ones. S1 is read-only and the
user docs say so.

The user docs state that the plan is written by the model and can be wrong.

## 11. Acceptance criteria

```
AC-P4W4-1 [unit] Given the switch off, When requestPark runs, Then hibernateSession is called in
  the same tick and no command is queued.
  Evidence: tests/companion/plan-capture-core.test.ts › "disabled parks at once"

AC-P4W4-2 [unit] Given an eligible session in mode `park`, When requestPark runs, Then one
  plan.capture is queued with expiresAt = requestedAt + PLAN_CAPTURE_WAIT_MS.
  Evidence: tests/companion/park-coordinator.test.ts › "captures before parking"

AC-P4W4-3 [unit] Given a pending capture, When the wait elapses with no result, Then the session
  is parked and no plan is stored.
  Evidence: tests/companion/park-coordinator.test.ts › "timeout parks without a plan"
  Guards: BUG-69

AC-P4W4-4 [unit] Given a pending `cap` capture, When pty:create continues, Then the new PTY is
  spawned before the capture finalizes.
  Evidence: tests/companion/park-coordinator.test.ts › "cap never delays a spawn"

AC-P4W4-5 [unit] Given each of rows E1–E10, When decideCapture runs, Then it returns that row's
  result and reason.
  Evidence: tests/companion/plan-capture-core.test.ts › "decision table"

AC-P4W4-6 [unit] Given hub state `working`, When requestPark runs, Then no plan.capture is queued.
  Evidence: tests/companion/plan-capture-core.test.ts › "busy sessions are not forked"
  Guards: BUG-1

AC-P4W4-7 [unit] Given a pending capture, When turn.started arrives, Then the park is cancelled
  and a later result is discarded.
  Evidence: tests/companion/park-coordinator.test.ts › "a new turn cancels the park"

AC-P4W4-8 [unit] Given a pending `sweep` capture, When PTY bytes arrive and no turn starts, Then
  the session is still parked at finalize.
  Evidence: tests/companion/park-coordinator.test.ts › "capture output does not cancel"

AC-P4W4-9 [unit] Given a stored plan, When a later turn.started arrives, Then the plan is deleted.
  Evidence: tests/companion/plan-store.test.ts › "a new turn invalidates the plan"

AC-P4W4-10 [unit] Given a fresh stored plan, When requestPark runs, Then the session is parked at
  once and no command is queued.
  Evidence: tests/companion/plan-capture-core.test.ts › "reuse spends nothing"

AC-P4W4-11 [unit] Given a lease lost during the wait, When the host detects it, Then the park
  completes with reason `lease-lost`.
  Evidence: tests/companion/park-coordinator.test.ts › "lease loss finalizes"

AC-P4W4-22 [unit] Given a pending capture, When the kill switch is turned off and the binding is
  revoked, Then the capture finalizes as `lease-lost`, the session is parked, and the next
  decideCapture answers `disabled`.
  Evidence: tests/companion/park-coordinator.test.ts › "kill switch mid-capture"

AC-P4W4-23 [unit] Given `plan.enabled` on and the key `channel` at `shadow`, When requestPark runs,
  Then the session is parked at once and no command is queued.
  Evidence: tests/companion/plan-capture-core.test.ts › "channel shadow means no capture"

AC-P4W4-12 [unit] Given a result with text, When the audit log and the logger are inspected, Then
  neither holds the text and both hold its length and sha256 prefix.
  Evidence: tests/companion/plan-privacy.test.ts › "text never reaches audit or logs"

AC-P4W4-13 [mod-test] Given `model.fork` stubbed to each of an answer, `nothing-to-fork`,
  `api-error`, `empty-reply` and `aborted`, When the mod receives plan.capture, Then the result is
  ok with the matching text or reason.
  Evidence: resources/companion/tests/plan-capture.test.ts › "maps every fork outcome"

AC-P4W4-14 [mod-test] Given an active turn, When the mod receives plan.capture, Then it answers
  CMD_PRECONDITION and the fork stub was not called.
  Evidence: resources/companion/tests/plan-capture.test.ts › "refuses mid-turn"

AC-P4W4-15 [mod-test] Given the same cmd delivered twice across a simulated reload, When both are
  processed, Then `model.fork` is called once.
  Evidence: resources/companion/tests/plan-capture.test.ts › "one fork per cmd"

AC-P4W4-16 [contract] Given the plan.capture fixtures, When host and mod validate them, Then
  PlanCaptureData and the `plan.capture` arguments pass on both sides.
  Evidence: tests/companion/contract.plan.test.ts › "plan.capture fixtures"

AC-P4W4-17 [integration] Given an idle interactive session with one completed turn, When a fake
  host queues plan.capture, Then a result with text arrives and the transcript has no new row.
  Evidence: tests/cli/plan-capture.cli.test.ts › "fork from the poll loop" (haiku, 2 calls)

AC-P4W4-18 [live-verify] Given a session idle longer than PLAN_CACHE_WARM_MS, When a capture runs,
  Then its usage and the session.measure cost before and after are recorded (OQ1, OQ2).
  Evidence: LV-P4W4-b

AC-P4W4-19 [live-verify] Given the switch on and a leased idle session, When "Park now" is used,
  Then the row parks within the wait and the hover preview shows the plan block.
  Evidence: LV-P4W4-a, screenshot

AC-P4W4-20 [live-verify] Given companion mode `off`, When "Park now" is used, Then the session
  parks with no wait and the preview has no plan block.
  Evidence: LV-P4W4-a step 6

AC-P4W4-24 [unit] (slice S2) Given a stored plan, When the operator saves an edit through
  `planEdit`, Then the preview shows the edited lines (at most three, each cut to 240 characters),
  `editedLines` is stored beside the captured `lines`, which stay untouched, and no command is queued.
  Evidence: tests/companion/plan-store.test.ts › "an edit is shown and the captured lines are kept"

AC-P4W4-25 [unit] (slice S2) Given a plan with `editedLines`, When a `turn.started` arrives for
  the session, Then the plan and its edit are both deleted.
  Evidence: tests/companion/plan-store.test.ts › "a new turn deletes the edit with the plan"

AC-P4W4-26 [mod-test] (slice S3) Given `plan.title` on and `model.complete` stubbed to fail or to
  time out, When the mod receives plan.capture and the fork answers, Then the result is ok with the
  plan text and no title.
  Evidence: resources/companion/tests/plan-capture.test.ts › "a failed title never fails the capture"

AC-P4W4-27 [mod-test] (slice S3) Given `plan.title` off, When the mod receives plan.capture, Then
  `model.complete` is not called.
  Evidence: resources/companion/tests/plan-capture.test.ts › "no title call while the title switch is off"
```

**Human**

```
AC-P4W4-21 [human] Given five real parked sessions, When the operator reads each plan before
  resuming, Then the operator records whether each was correct enough to act on.
  Evidence: Delivery Report table "plan usefulness"
```

**LV-P4W4-a** (second isolated Harnu, `docs/dev/live-verify-second-instance.md`)

1. Launch with companion mode `active` for a scratch folder; turn "Resume plan" on, mode "When
   parking".
2. Start a haiku session, send one short prompt, wait for the turn to end.
3. Select another session; System Monitor → "Park now" on the first.
4. Record the time from the click to `pty:hibernated`: under 8 s.
5. Hover the parked row: three lines. Screenshot. Check the store file's mode and grep the app log
   for the first plan line: no hit.
6. Set companion mode `off`, restart the session, repeat steps 2–4: no wait, no block.

**LV-P4W4-b** (`HARNU_CLI_LIVE=1`, haiku, three model calls, cap USD 0.25)

1. In a session with about 20 k context tokens, capture 30 s after a turn; record `usage`.
2. Wait six minutes; capture again; record `usage`.
3. Record `session.measure.cost.usd` around each capture and whether the terminal printed anything.
4. Add the rows to the evidence doc; change `PLAN_CACHE_WARM_MS` only if step 2 was warm.

## 12. Docs deliverables

| Deliverable              | Content                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`           | `Added`: "Resume plan: before parking a session Harnu can ask it for three lines on where it stopped. Off by default; uses your plan usage."                                            |
| `docs/harnu-features.md` | No change, no marker bump: no verb returns the plan and the session cannot act on it (changes only if OQ3 is taken)                                                                     |
| `docs/user/`             | `settings.md` (switch, modes, cost, "can be wrong", "needs the Harnu mod"); `sessions.md` (the plan block; legacy sessions get none; S1 is read-only); `usage.md` (spend counted apart) |
| `design.md`              | §6 Hibernation policy pane, Hover preview, Folder View sessions; §8 copy                                                                                                                |
| i18n                     | `hibernationPolicy.plan.*`, `preview.planLabel`, `preview.planEdited`, `session.statusParking` in `en.json` and `pt-BR.json`                                                            |
| `01-contract.md`         | already merged (§7.6); `contract.ts` and the fixtures land with the code (DOC-7)                                                                                                        |

## 13. Rollout & parity gate

- **Fact family:** none; no shadow comparison, no parity gate. The feature follows its own key
  `plan` (contract §11.5) and is capped to off above the tested ceiling.
- **Ship gate:** AC-P4W4-17 passes and LV-P4W4-b is recorded. If the fork cannot run from the poll
  loop, the wave ships the coordinator alone, which is behaviour-neutral with the switch off.
- **Default:** `plan.enabled` is off. Default-on is one of the further confirmation points of
  master §13 (the `plan` switch, ARB-6d); its inputs are AC-P4W4-21 and a week of the `spent`
  counter.
- **Slices:** S1 coordinator, store, capture, read-only block (AC-P4W4-1 to -23) · S2 edit
  (AC-P4W4-24, -25) · S3 title (AC-P4W4-26, -27).
- **Demotes:** nothing.

## 14. Open questions

| #   | Question                                                                                                                           | Default until settled                           | Owner                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| OQ1 | What does a cold fork cost, and how long is the cache warm for a subscription session?                                             | cold after 270 s; cold captures capped at 60 k  | P4W4 (AC-P4W4-18)                        |
| OQ2 | Is fork and complete spend already inside `session.measure.cost.usd`?                                                              | the ledger stores tokens only                   | P4W4 (AC-P4W4-18)                        |
| OQ3 | Should `get_session` return the plan to an orchestrator agent?                                                                     | no                                              | product                                  |
| OQ4 | Contract CQ19: does `$.model.fork` work from the poll loop, with no hook on the stack?                                             | attempt-proven; a failed proof disables capture | P4W4 (AC-P4W4-17)                        |
| OQ5 | Does a fork make the terminal print, or extend the cache lifetime?                                                                 | revalidation ignores PTY bytes                  | P4W4 (LV-P4W4-b)                         |
| OQ6 | Master Q8: does `sec-default` pin `model.fork`? (its README lists `model.*` among the events it passes: read from source, not run) | attempt-proven per session                      | P1W4 runs it; this wave reads the answer |

## 15. Risks

| Risk                                                                            | Sev    | Mitigation                                                                             |
| ------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| A cold capture re-bills a large context on an expensive model (R21; R19)        | High   | default mode `idle`; E7; E8; the `spent` line; off by default                          |
| The plan is wrong and the operator trusts it                                    | Medium | labelled as model output; slice S2; AC-P4W4-21                                         |
| The capture cancels its own park and loops                                      | Medium | `revalidatePark` ignores activity; E3; AC-P4W4-8                                       |
| Plan text leaks through a log, an audit row or a trace                          | Medium | §9 rule 1; AC-P4W4-12; LV-P4W4-a step 5                                                |
| A new park path leaves a row flagged parked with a live terminal (BUG-69 class) | Medium | `hibernateSession` stays the only killer; the coordinator only decides when to call it |
