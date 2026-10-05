# T389 P3W1 — Approval hold

## 1. Status

**Specified (not implemented)** · 2026-10-02 · Epic T389 · Wave P3W1 · Fact family `approval` ·
Feature `gate.approval`.
Master: [`00-master.md`](00-master.md) · Contract: [`01-contract.md`](01-contract.md) (§5.4,
§10) · ADR: [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) (D5, C2, C3,
C9, C12) · Legacy: `docs/hook-bridge-integration.md`, `docs/user/approval-inbox.md`.
Verified against CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository).

## 2. Depends on / Unblocks

- **Depends on:** P1W4, P1W5, P2W3 (the stand-down option), P1W1, P1W3. Base branch: P2W3, so
  this wave no longer starts from the P1 tip in parallel with P2.
- **Interfaces used** (master §12, the owner's signatures):
  - P1W1: `companionHost.registerAskKind('permission', fn)`, `hold(b)` (a parked tranche keeps the
    lease), `bindingForSid(sid)`, `markProven` / `revokeProof`.
  - P1W4: `owns(sessionKeyOrSid, 'approval')`, `onOwnershipChange(fn)`, `recordFact('approval', …)`,
    `familyMode('approval', folder)`.
  - P1W5: the five shared registrations this wave adds steps to (contract §11.4): `tool.check`,
    `classic.PermissionRequest`, `classic.PostToolUse`, `turn.complete`, and the optional
    `classic.PostToolUseFailure`; the `fleet.checks` record and the `permissionMode` key
    (contract §22); the `attention.*` events.
  - P2W3: `startHookServer({ standDown })`, `Resolver.parks`, `shouldStandDown(req, facts)`.
  - P1W1: `appendAudit(rec)` (record kind `ask`).
  - P1W3: `ensureHello($)`, `emit($, event)`, `enabled(feature)`, `reportModError(where, err)`.
- **Offers** (master §12): `askBroker.heldFor(sessionKeyOrSid)`,
  `askBroker.coverageOf(sessionKeyOrSid)`, IPC `approval:coverage`; the mod helper
  `ask($, req)` (first-lander with P4W2).
- **Unblocks:** P3W2 (Sentinel on the ask payload), P5W1.
- **Uses when present:** P4W1's static audit of co-loaded mods (one `contested` signal). The
  wave is complete without it.

## 3. Summary

Today the Approval Inbox parks a tool call inside an HTTP hook for at most 3.5 s
(`RESPONDER_DEADLINE_MS`, `hook-bridge.ts:51`; mirrored for the countdown at
`approval-resolver.ts:25`) and then falls open to the terminal. It parks on `PreToolUse` with
matcher `*` (`hook-installer.ts:49`), so in `active` mode every tool call of an on-ramp folder
pays that window, whether or not the engine would have asked.

This wave moves the hold into the `claude` process. The mod lets `tool.check` pass and records
the `tool_use_id` of every `ask`; it holds the following `classic.PermissionRequest` through the
`ask` endpoint in tranches of at most 20 s. The engine's dialog stays open and usable the whole
time; an answer from Harnu closes it; whoever answers first wins. The host runs the **existing**
resolver chain on the ask, without the deadline, and the legacy bridge stands down for that
session. The Inbox says, per session, whether an approval is actually held.

## 4. Evidence

| Smoke               | Verdict                  | What this wave takes from it                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1.1                | REFUTED                  | One `$.http.fetch` aborts at exactly 30 000 ms; there is no timeout option.                                                                                                                                                                                                                                                                                                                                      |
| B1.2                | CONFIRMED                | A 20 s `pending` loop held 900 s for about 11 ms of hook budget; both verdicts honoured.                                                                                                                                                                                                                                                                                                                         |
| B1.3                | CONFIRMED                | A hold in `tool.check` shows only a spinner: no dialog, no `Notification`.                                                                                                                                                                                                                                                                                                                                       |
| B1.4                | CONFIRMED                | Esc aborts `next.signal` at once; a fetch issued from the abort listener still goes out; one issued later from the body does not.                                                                                                                                                                                                                                                                                |
| B1.5                | CONFIRMED                | Host down, dead port or a garbage body: the hook's `catch` returns the engine verdict and the normal dialog is there within about 3 s.                                                                                                                                                                                                                                                                           |
| B1.6                | CONFIRMED                | Headless matrix: `tool.check` sees `ask` under `default` and `dontAsk`, `allow` under `acceptEdits` and `bypassPermissions`; `plan` produced no call. Interactive matrix not run.                                                                                                                                                                                                                                |
| B1.7                | CONFIRMED                | Hold in `classic.PermissionRequest`: dialog usable; remote allow/deny closes it (held 900 s); a local "Yes" does **not** cancel the hook; "No"/Esc abort it; works in `-p` and for subagents; payload has `agent_id`, no `tool_use_id`.                                                                                                                                                                          |
| B1.8                | CONFIRMED                | `classic.PreToolUse` fires **before** the engine verdict and for every matching call.                                                                                                                                                                                                                                                                                                                            |
| B1.9                | —                        | A returned `tool.check` cannot be re-entered; B1.7 is the only way to answer an open dialog.                                                                                                                                                                                                                                                                                                                     |
| B2                  | CONFIRMED / NOT OBSERVED | Status and toast are hidden while the engine dialog is open; `$.ui.notice` never rendered.                                                                                                                                                                                                                                                                                                                       |
| B6                  | CONFIRMED / REFUTED      | A throw is skipped (fail-open). A sibling's worker wedge skips the whole chain for that call (C9).                                                                                                                                                                                                                                                                                                               |
| D6                  | REFUTED                  | A same-tier mod can read and forge the ask and its answer.                                                                                                                                                                                                                                                                                                                                                       |
| A4                  | CONFIRMED                | No "dialog answered" event; after a user "No" there is no `PostToolUse`, the turn ends with `reason: "answer"`.                                                                                                                                                                                                                                                                                                  |
| smoke §11 (2.1.289) | CONFIRMED / new          | The 60 s `classic.PermissionRequest` long-poll and the remote allow and deny reproduce with the bridge isolated (R4). New: on a managed machine a managed deny or ask rule on a nested part of a compound shell command wins over a mod's allow (2.1.289); `tool.check` results may carry `hook` (types l.12298); 2.1.288 makes the engine block a call when hook matching or serialisation fails (§11.4, §11.5) |
| §9 Not tested       | open                     | `auto` mode; interactive mode matrix; identical parallel calls; holds past 15 min; a hold across `/clear`, `--resume`, reload; `PostToolUseFailure`.                                                                                                                                                                                                                                                             |

## 5. Deviations from the study

| #   | Study said                                           | This spec                                                                   | Decision | Evidence              |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------- | -------- | --------------------- |
| 1   | Row 1: hold in `tool.check`                          | Hold in `classic.PermissionRequest`; `tool.check` passes and records        | D5       | smoke B1.3, B1.7      |
| 2   | Row 1: one long fetch per approval                   | Tranches of at most 20 s, idempotent on `askId`                             | D3       | smoke B1.1, B1.2      |
| 3   | Row 1: the engine dialog cannot be answered remotely | It can (C12); only redrawing it is impossible                               | C12      | smoke B1.7            |
| 4   | Tickets retire on `PostToolUseFailure`               | Never depended on; exits are `PostToolUse`, abort, turn end, orphan timeout | C3       | smoke A4, evidence §7 |

## 6. Scope / Non-goals

**In scope.** The ask broker and ticket lifecycle; the mod's correlate-and-hold; mapping onto the
resolver chain; bridge stand-down; the coverage state and its copy; sound and attention; behaviour
per permission mode, for subagents and under policy.

**Non-goals.**

- No hold in headless sessions (MOD-5, contract §16): `-p` and scheduler ticks behave as today,
  although smoke B1.7 shows the hook would work there.
- No "always allow", no input amendment, no rule edits from Harnu: the hook never returns
  `updatedInput`, `updatedPermissions` or `interrupt` (types L7005-7013). Those stay with the
  native dialog.
- No redraw or suppression of the dialog. The dialog-suppressing variant is Appendix A only.
- No remote "approve": only renderer IPC resolves a ticket (SEC-2).
- No change to the Interceptor's `off | shadow | active` mode or its folder ramp
  (`responder-registry.ts:115`): they still decide **whether** a call is held. This wave decides
  **which transport** holds it.
- No guarantee. The Inbox offers a hold (SEC-7).

## 7. Design

### 7.1 Mod

`resources/companion/hooks/approval-core.ts` (pure: correlation, ticket bookkeeping) and wiring in
`register.ts`. Five signals are used, all through registrations P1W5 owns; this wave adds its
step to each body, in the order of contract §11.4, behind the `gate.approval` enable:

| Shared hook                         | This wave's step (contract §11.4)                                     |
| ----------------------------------- | --------------------------------------------------------------------- |
| `tool.check`                        | step 3: the pushed record also carries `inputKey`                     |
| `classic.PermissionRequest`         | step 2: the hold                                                      |
| `classic.PostToolUse`               | step 2: `ask.settled { cause: 'tool-ran' }`                           |
| `turn.complete`                     | step 2: `ask.settled { cause: 'turn-ended' }` for that loop's tickets |
| `classic.PostToolUseFailure` (opt.) | as `PostToolUse`, with `tool-failed`; never relied on                 |

**The mod's ask client** (this wave lands it; P3W2 and P4W2 reuse it, master §12.2):

```ts
ask<K extends AskKind>($, req: { askId: AskId; kind: K; d?: AskPayloads[K] }): Promise<AskResponse<K> | null>
// null = transport failure. One request per call; the caller loops on 'pending'.
```

**Ask record.** There is one shared list, `fleet.checks` in `$.state`, owned by P1W5 and capped
at `ASK_RECORD_MAX` (contract §22): `{ toolUseId; tool; inputKey?; at; claimedBy? }`. This wave
adds `inputKey` (SHA256 of the canonical JSON of `e.input`) and `claimedBy` (the `AskId`). The
list survives a hot reload; the open tickets (module memory) do not.

**`tool.check` (pass-through).**

```ts
const r = await next(e) // step 1
// step 2 is P3W2's: a host Sentinel deny may end the body here (contract §10.1)
if (e.tool_use_id && r.decision === 'ask')
  pushCheck({ toolUseId: e.tool_use_id, tool: e.tool, inputKey, at })
return r // never altered by this wave's step
```

`e.tool_use_id` is absent on another plugin's `$.tool.check` dry run (types L12085-12089): those
are never recorded.

**`classic.PermissionRequest` (the hold).**

```ts
async function holdPermission($, e, next) {
  let askId: AskId | undefined
  try {
    await ensureHello($)
    if (!enabled('gate.approval') || !isInteractive) return next(e)
    if (e.permission_mode === 'dontAsk') return next(e) // §8
    const c = correlate(e.tool_name, e.tool_input)
    const { toolUseId, ambiguous } = c
    askId = c.askId
    open.set(askId, { toolUseId, agentId: e.agent_id, turnId })
    next.signal.addEventListener('abort', () => settle(askId, 'aborted'), { once: true })
    let d: AskPayloads['permission'] | undefined = payloadOf(e, toolUseId, ambiguous)
    for (;;) {
      if (next.signal.aborted) return next(e)
      const res = await ask($, { askId, kind: 'permission', d })
      d = undefined
      if (!res || !res.ok) return next(e) // transport failure or a Failure
      if (res.state === 'pending') continue
      if (res.state === 'decided') {
        return res.decision.behavior === 'allow'
          ? { decision: { behavior: 'allow' } }
          : { decision: { behavior: 'deny', message: res.decision.message } }
      }
      return next(e) // released
    }
  } catch {
    return next(e) // transport failure, bad body, abort: the engine's own verdict (SEC-1)
  } finally {
    if (askId) open.delete(askId)
  }
}
```

**Correlation.** `correlate(tool, input)` takes the oldest unclaimed record with the same `tool`
and `inputKey` not older than `ASK_CORRELATE_WINDOW_MS`:

- found → `askId = "ask_" + toolUseId`, record marked claimed;
- none → `askId = "ask_x" + counter`, `toolUseId` undefined;
- **two or more** unclaimed records share the key → `ambiguous: true` on every ticket of that
  group. Pairing is first-in-first-out and may be wrong; §7.3 shows why that cannot turn into a
  wrong allow.

**Retirement** (`settle(askId, cause)` emits the edge event `ask.settled` and drops the ticket):

| Signal                                                        | Tickets settled                                                                                    | Cause                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- |
| `classic.PostToolUse { tool_use_id }`                         | the open ticket with that `toolUseId`; in an ambiguous group, a decided one first, else the oldest | `tool-ran`                      |
| `classic.PostToolUse` matching no id                          | the oldest open `ask_x` ticket with the same tool and `inputKey`                                   | `tool-ran`                      |
| `next.signal` abort (Esc, dialog "No")                        | that hook's ticket, from the abort listener                                                        | `aborted`                       |
| `turn.complete` (main loop, or with `agentId` for a subagent) | every open ticket of that loop                                                                     | `turn-ended`                    |
| `classic.PostToolUseFailure`, if it ever fires                | as `PostToolUse`                                                                                   | `tool-failed` (never relied on) |

A hot reload wipes the open tickets and cancels the pending fetch (the `fleet.checks` records
survive in `$.state`); nothing is settled by the mod and the host's orphan timer retires the
ticket (§7.2).

### 7.2 Host

New under `src/main/companion/`: `ask-core.ts` (pure state machine), `ask-broker.ts` (shell:
tranche parking, resolver chain, IPC), `coverage-core.ts` (pure).

The broker registers with `companionHost.registerAskKind('permission', handler)` and parks each
tranche under `hold(b)`, so a parked tranche counts as a live lease. It handles the kind
`permission` only: `sentinel` (P3W2) and `status` (P4W2) register separately on the host. It
exports, for P4W2 and P3W2 (master §12.1):

```ts
askBroker: {
  heldFor(sessionKeyOrSid: string): number
  coverageOf(sessionKeyOrSid: string): { coverage: Coverage; reason: CoverageReason }
}
```

An external binding has no `sessionKey`: both are keyed by `sid` there.

**Ticket.**

```ts
type TicketState = 'open' | 'pending' | 'decided' | 'delivered' | 'released'

interface AskTicket {
  askId: AskId
  requestId: string // the id the renderer already uses (hook:respond)
  sessionKey: string | null // null for an external binding
  sid: Sid
  payload: AskPayloads['permission']
  state: TicketState
  createdAt: number
  lastTrancheAt: number
  decision?: AskDecisions['permission']
  by?: string // resolver id
  release?: ReleaseReason
}
```

| From        | Event                                                         | To          | Answer to the mod                                              |
| ----------- | ------------------------------------------------------------- | ----------- | -------------------------------------------------------------- |
| —           | first tranche; family not `active`, or not owned              | `released`  | `released: shadow` / `abstain`, before the resolver chain runs |
| —           | first tranche; a decision already exists for that `toolUseId` | `delivered` | `decided` (dedupe, ARB-9a)                                     |
| —           | first tranche; owned                                          | `open`      | chain runs (below)                                             |
| `open`      | a synchronous resolver decides (Sentinel deny)                | `delivered` | `decided`                                                      |
| `open`      | the chain abstains (off-ramp, Interceptor not `active`)       | `released`  | `released: abstain`                                            |
| `open`      | the Inbox resolver parks                                      | `pending`   | `pending` every `ASK_TRANCHE_MS`                               |
| `pending`   | `hook:respond` from the renderer                              | `decided`   | `decided` on the parked or next tranche                        |
| `decided`   | a tranche returned it                                         | `delivered` | —                                                              |
| any live    | `ask.settled`                                                 | `released`  | `released: settled`                                            |
| any live    | no tranche for `ASK_ORPHAN_MS`                                | `released`  | — (`expired`)                                                  |
| any live    | lease lost, host shutdown                                     | `released`  | `released: host-shutdown` if asked                             |
| `delivered` | `ask.settled`, or `ASK_ORPHAN_MS`                             | retired     | —                                                              |

A tranche for an unknown `askId` without `d` answers `released: expired`. Decisions are returned
for every later tranche of the same `askId` (contract §6).

**Resolver chain, without the deadline.** The broker builds the same `HookRequest` the bridge
builds (`responder-dispatch.ts:28-40`):

```ts
{ sessionId: sid, event: 'PermissionRequest', toolName: payload.tool,
  toolInput: payload.input as Record<string, unknown>,
  raw: { cwd: payload.cwd, permission_mode: payload.permissionMode, agent_id: payload.agentId,
         agent_type: payload.agentType, tool_use_id: payload.toolUseId, transport: 'companion',
         tool_name: payload.tool, tool_input: payload.input, session_id: sid } }
```

and calls `runResolvers(req, responderRegistry.list(), ticketSignal, onError)`
(`responder-dispatch.ts:150`). `ticketSignal` is aborted when the ticket is released, not by a
3.5 s timer. Nothing in the chain is forked:

- **Sentinel** (priority 20, `sentinel-resolver.ts:31`) answers synchronously, as today.
- **Approval Inbox** (priority 50, `approval-resolver.ts:46`) applies `rampActionFor(raw.cwd)`.
  `preview` logs a would-gate entry and abstains; `park` creates the wire and waits. Its
  `onAbort` path settles the parked promise with reason `'superseded'` instead of `'timeout'`
  when `raw.transport === 'companion'`.
- `respondApproval` (`approval-resolver.ts:106`) and the `hook:respond` IPC (`:127`) are
  unchanged and remain the only resolver of a ticket.

`PendingApprovalWire` (`approval-parse.ts`) gains optional fields; the bridge transport leaves
them unset:

```ts
transport?: 'bridge' | 'companion'
toolUseId?: string
agentType?: string // a subagent's call
permissionMode?: string
ambiguous?: boolean
// deadlineMs === 0 means "no deadline" (companion); the bridge keeps now + 3500
```

**Deny message** (reaches the model bare, smoke B1.7; MOD-8): "The operator denied this tool call
in Harnu. Do not retry it unchanged; ask what to do instead." Sentinel's message is P3W2's.

**Bridge stand-down (ARB-9a, contract §11.6).** The stand-down is not a new check inside
`approvalResolver.resolve`. P2W3 introduces the mechanism: `startHookServer` takes
`standDown?: (req: HookRequest) => boolean`, a resolver may declare `parks: true`, and one pure
predicate `shouldStandDown(req, facts)` (`bridge-standdown-core.ts`) decides per request. When it
answers true the bridge skips every resolver that parks and still runs the synchronous ones. This
wave:

1. marks the Approval Inbox resolver `parks: true` (`approval-resolver.ts:46`);
2. adds clause 2 of contract §11.6 to `shouldStandDown`: a `PreToolUse` or `PermissionRequest`
   POST stands down when `owns(sessionKeyOrSid, 'approval')`;
3. records `recordFact('approval', 'legacy', sid, 'legacy-stood-down', { event, tool, toolUseId })`
   for each stood-down POST. In `shadow` nothing stands down and the row reads
   `would-stand-down` with the measured park time.

The Sentinel is synchronous, so a catastrophic call is still denied on the legacy hook. This is
what removes the 3.5 s tax from owned sessions. The decision is taken from **ownership state**,
not from the existence of a ticket: the legacy `PreToolUse` arrives before `tool.check`
(smoke B1.8), so no ticket exists yet.

**The double-ask hazard.** The two holds can never overlap on one call (the legacy POST completes
before `tool.check` runs), but they can follow each other: a legacy park that timed out, then a
companion ticket for the same call. Rules:

1. One Inbox row per `toolUseId`: a companion wire replaces a bridge wire with the same id.
2. A decision the operator gave on the legacy row for a `toolUseId` is returned immediately to a
   companion ask for that id.
3. The host refuses to hold for a session it does not own, so a stale mod cannot add a second
   hold on top of an active legacy bridge.

**Coverage difference (operator decision point OD-2, master §13; risk R22).** The legacy bridge
parks every tool call of an on-ramp folder for 3.5 s, including calls the engine would allow; the
companion sees only what the engine asks.

- **Default, implemented by this spec:** hold only when the engine would ask. An owned session in
  `acceptEdits` or `bypassPermissions` loses today's 3.5 s window on every call and shows no
  Inbox row for a call the engine allows. The Sentinel deny is preserved (the legacy hook, or
  P3W2's `tool.check` query).
- **Alternative:** also hold in `tool.check` for those modes. That is the deferred
  dialog-suppressing variant of Appendix A, with its band line.

The default is stated in the UI copy, the user docs and the CHANGELOG, and parity compares asks
only (§13). The operator's answer is recorded in the master plan before this wave ships.

**Coverage state** (`coverage-core.ts`, pure):

```ts
type Coverage = 'gated' | 'contested' | 'not-gated'
type CoverageReason =
  | 'held' // gated
  | 'other-mod'
  | 'bypassed' // contested
  | 'legacy-window'
  | 'interceptor-off'
  | 'off-ramp'
  | 'policy'
  | 'companion-off'
  | 'lease-lost'
  | 'headless'
  | 'no-process' // not gated
```

| State       | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gated`     | `approval` owned (ARB-3), Interceptor `active` and the folder on the ramp, no contest signal.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `contested` | Owned, and any of: P4W1's `permissionHookers(folder)` (P4W1 §7.5: a lower bound, cached analyses only) lists a co-loaded mod with the `permissions` or `tool-calls` chip (`other-mod`; P4W1 owns the chip set, so a mod that only hooks `http.fetch` shows an `other-mods` chip and does not by itself contest); a permission `attention.raised` arrived with no ask; a delivered deny was followed by `tool-ran`; a worker-wedge `mod.error` in this session (`bypassed`). Sticky for the session. |
| `not-gated` | Everything else, with its reason. A legacy `active` on-ramp session is `not-gated / legacy-window`: Harnu gets 3.5 s, then the terminal asks.                                                                                                                                                                                                                                                                                                                                                       |

The broker pushes `approval:coverage { sessionKey, sid, coverage, reason }` on every change.

### 7.3 Why a wrong pairing cannot allow the wrong thing

Two parallel calls with identical tool and input produce two dialogs with identical content and
two hooks. A decision is only ever returned by the hook whose `askId` was decided, so allowing
one row allows exactly one of two identical calls, whichever dialog it belongs to. The failure
left is cosmetic: `PostToolUse` may retire the other row early; its hook then gets `released`
and its dialog stays native. Rows of an ambiguous group say so (§10).

### 7.4 Contract additions

None — merged into `01-contract.md`: §10 and §10.1 (`AskPayloads.permission.ambiguous`, the
`dontAsk` rule, the release reasons; an orphaned ticket uses `expired`), §7.2
(`ASK_CORRELATE_WINDOW_MS`, `ASK_RECORD_MAX`, `ASK_INPUT_MAX_BYTES`), §22 (`fleet.checks` with
`inputKey` and `claimedBy`), §11.4 (the step order inside the shared hooks), §11.6 (stand-down)
and §11.2 (proof of `gate.approval`). Conformance row 13 now reads "`tool-failed` is defined, not
required". When `permission_mode` is `dontAsk` the shared hook returns `next(e)` without asking;
the registration itself is shared and stays. Host-side signatures (`askBroker`, `Coverage`,
`approval:coverage`) are in master §12.1.

## 8. Arbitration & fallback

Ownership of `approval` needs `gate.approval` proven (`probes.classic` and `probes.toolCheck`
both true), a live lease and mode `active` for the folder (ARB-3). A `permission` ask is itself
proof of `probes.classic`, and its `toolUseId` of `probes.toolCheck` (contract §11.2); the proof
is revoked by a permission `attention.raised {source: 'request'}` with no ask.

In `shadow` the broker answers `released` before the resolver chain runs (contract §10.1), so
neither the Inbox resolver nor the Sentinel evaluates the ask there; P3W2 takes its shadow corpus
from the legacy hook and from its own `tool.check` query.

| Condition                                      | What holds the approval                                                                                                                         | Coverage                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Mod absent, CLI too old, companion `off`       | legacy bridge (3.5 s) if the Interceptor is `active` on the ramp                                                                                | `not-gated / legacy-window` or `companion-off` |
| Family mode `shadow`                           | legacy bridge; every ask answered `released: shadow` and recorded                                                                               | `not-gated / legacy-window`                    |
| `sec-default` (`classic.*` pinned)             | legacy bridge; proof never arrives                                                                                                              | `not-gated / policy`                           |
| Lease lost mid-session                         | open tickets released; bridge parks again from the next POST; sticky                                                                            | `not-gated / lease-lost`                       |
| Kill switch turned off mid-session             | `conn` revoked, re-hello answered `enable: []`: open tickets released, the hook returns `next(e)`, the bridge parks again at once (no TTL wait) | `not-gated / companion-off`                    |
| CLI above the tested ceiling                   | family forced to `shadow`: legacy bridge                                                                                                        | `not-gated / legacy-window`                    |
| Host down or restarting mid-hold               | fetch fails → `next(e)` → native dialog (smoke B1.5: about 3 s)                                                                                 | recomputed after re-hello                      |
| Host restart with tickets open                 | tickets are memory only; the re-asked tranche has no `d` → `released: expired` → native dialog                                                  | —                                              |
| Hot reload mid-hold                            | hook gone; dialog stays native; ticket orphaned after `ASK_ORPHAN_MS`                                                                           | unchanged                                      |
| `/clear` or `--resume` mid-hold                | the turn is aborted → `aborted`; else orphan timeout                                                                                            | re-keyed with the binding                      |
| A sibling mod wedges the worker                | that call: no ask; native dialog; `attention.raised` with no ask → `contested / bypassed`                                                       | `contested`                                    |
| A hook above answers `PermissionRequest` first | the companion's hook is never reached, or its answer is overridden                                                                              | `contested` once detected                      |
| Headless `-p`                                  | nothing (as today)                                                                                                                              | `not-gated / headless`                         |
| Agent-controlled spawn                         | legacy global hook only (master §8)                                                                                                             | `not-gated / legacy-window`                    |
| Parked session                                 | no process                                                                                                                                      | `not-gated / no-process`                       |

**Permission modes.** Interactive behaviour is an AC (Q20); the table states the design.

| Mode                               | Engine verdict at `tool.check` | `PermissionRequest`   | Companion                                                             |
| ---------------------------------- | ------------------------------ | --------------------- | --------------------------------------------------------------------- |
| `default`                          | `ask`                          | fires                 | holds                                                                 |
| `acceptEdits`, `bypassPermissions` | `allow` for covered calls      | does not fire         | nothing to hold; the legacy `PreToolUse` Sentinel still sees the call |
| `plan`                             | `allow` for the plan file only | —                     | nothing to hold                                                       |
| `dontAsk`                          | `ask`, then the mode denies    | unknown               | never holds and never allows: the operator chose "do not ask me"      |
| `auto`                             | `ask` goes to the classifier   | unknown (Q18)         | holds only if the event fires; never pre-empts the classifier         |
| subagent call                      | as the parent's mode           | fires with `agent_id` | holds; the row names the agent type                                   |

## 9. Security requirements

SEC-1, SEC-2, SEC-3c/d, SEC-6, SEC-7, SEC-9c/e apply as written. Wave-specific:

- **S1.** Every non-`decided` outcome of the hold returns `next(e)`. There is no code path in
  the mod that constructs an allow other than from `state: 'decided'` with `behavior: 'allow'`
  (static test, AC-P3W1-9).
- **S2.** The broker creates a decision only from `respondApproval` (renderer IPC) or a
  synchronous deny resolver. No endpoint, verb or command reaches it; `get_approval` stays
  read-only.
- **S3.** The ask payload is untrusted input: size cap, schema check, and `sid` must equal the
  binding's. The row shows what the mod sent; a sibling mod can alter it (D6), which is why a
  session with such a mod is `contested`.
- **S4.** One audit record per ticket: ask id, session, tool, input hash, decision, `by`, the
  delivery outcome and the retire cause.
- **S5.** The hook returns only `behavior`. It never returns rule updates, an input rewrite or
  `interrupt`.
- **S6.** Copy never says "nothing runs without approval" or "approve from anywhere".
- **S7.** An `allow` is never read as "the tool ran". On a managed machine a managed deny or ask rule on a nested part of a
  compound shell command still wins over a mod's approval (CLI 2.1.289, smoke §11.5). Only `classic.PostToolUse` says a
  call ran; a ticket that retires on `turn-ended` after a remote allow is shown as "allowed, then blocked by policy" (§10).
- **S8.** The hold keeps its own `try/catch` that returns `next(e)`. Since CLI 2.1.288 the engine blocks a call when matching
  or serialising a PreToolUse or PermissionRequest hook fails (smoke §11.5); that is the engine's guarantee for its own
  step, and a hold that throws inside our code is made safe only by this wrapper (AC-P3W1-43).

## 10. UX & copy

`design.md` is edited first: §6 "Inbox rail" (row anatomy, the coverage line), "Safety confirms —
sound + attention (T44 S4c)" (extended to held approvals), and "Hook responder — interceptor
mode" (what `active` now means for a session with the Harnu mod). Tokens only; no new token.

**`ApprovalRow.vue`.** A third meta fragment after `<folder> · <session>`, 11px:

| Coverage / case | Fragment (key under `approvalInbox.coverage`)   | Colour         |
| --------------- | ----------------------------------------------- | -------------- |
| `gated`         | `held`: "Held for you"                          | `text-text-4`  |
| `contested`     | `contested`: "Held, but another mod can decide" | `text-warning` |
| bridge row      | `window`: "3.5 s, then the terminal asks"       | `text-text-4`  |
| subagent        | `agent`: "Subagent: {agentType}" (prefix)       | `text-text-4`  |
| `ambiguous`     | `ambiguous`: "One of several identical calls"   | `text-text-4`  |

Companion rows show elapsed time ("held 2m") instead of a countdown. A hint under the buttons,
`approvalInbox.moreInTerminal`: "Always allow and edits are in the terminal dialog."

**`InboxRail.vue`.** At the top of "Needs you", when at least one on-ramp session is not `gated`,
one quiet line (`text-text-4`, 11px) that expands to the list:
`approvalInbox.coverage.summary`: "{count} sessions are not held by Harnu". Each entry reads
`<session> — <reason>`:

| Reason                                                       | Copy (`approvalInbox.coverage.reason.*`)    |
| ------------------------------------------------------------ | ------------------------------------------- |
| `legacy-window`                                              | "running on hooks: 3.5 s window"            |
| `policy`                                                     | "Blocked by your organization's policy"     |
| `lease-lost`                                                 | "Harnu mod unloaded"                        |
| `other-mod`                                                  | "another mod can decide"                    |
| `bypassed`                                                   | "a call skipped the hold"                   |
| `headless`                                                   | "headless run"                              |
| `interceptor-off`, `off-ramp`, `companion-off`, `no-process` | not listed (nothing is expected to be held) |

**Resolution toasts.** `approvalInbox.expired` keeps its text for a bridge row. New
`approvalInbox.answeredInTerminal` ("Already answered in the terminal.") when `hook:respond`
returns `{ ok: false }` for a companion row.

**Allowed, then blocked by policy.** A remote allow is not final on a managed machine (S7). After the broker returned an
allow, the ticket stays open until `classic.PostToolUse` (`tool-ran`: nothing to say) or `turn.complete` (`turn-ended`). On
`turn-ended` with no `PostToolUse`, a toast and the Activity entry read `approvalInbox.blockedByPolicy` ("Allowed, then
blocked by policy: {tool} did not run.") when the machine reports managed settings (the `claude-policy-probe` of P4W3), else
`approvalInbox.noResult` ("Allowed from Harnu, but {tool} reported no result."). The row copy never says "allowed" without
the outcome once it is known, and the audit record stores `outcome: 'ran' | 'no-result'` with `policy: boolean`.

**Sound and attention.** A ticket that becomes `pending` always fires the safety-confirm set
(`design.md` "Safety confirms — sound + attention"): `playNotificationSound()`,
`requestAttention()`, a native notification with `activate: 'inbox'`, and a `needs-input` push;
once per `askId`, independent of the notification switches, exactly as
`session-mcp-confirms.ts:89-116` does for agent confirms. The task-state `needs-input`
notification that P1W5 raises for the same session within 10 s keeps its toast and skips its
chime, so one approval chimes once.

## 11. Acceptance criteria

```
AC-P3W1-1 [mod-test] Given tool.check resolves ask for a real call and no Sentinel deny, Then this
  wave's step returns the verdict unchanged and one fleet.checks record with that tool_use_id and
  an inputKey exists.
  Evidence: resources/companion/tests/approval.test.ts › "tool.check passes and records"

AC-P3W1-2 [mod-test] Given a tool.check event with no tool_use_id, Then nothing is recorded.
  Evidence: resources/companion/tests/approval.test.ts › "ignores a dry-run query"

AC-P3W1-3 [mod-test] Given a record and a PermissionRequest with the same tool and input,
  Then the ask carries askId "ask_<tool_use_id>" and toolUseId.
  Evidence: resources/companion/tests/approval.test.ts › "correlates the request with its check"

AC-P3W1-4 [mod-test] Given no matching record, Then the ask id starts with "ask_x" and the hold proceeds.
  Evidence: resources/companion/tests/approval.test.ts › "holds an uncorrelated request"

AC-P3W1-5 [mod-test] Given two records with identical tool and input and two PermissionRequests,
  When the host decides allow for the first ask only, Then exactly one hook returns an allow (CQ9).
  Evidence: resources/companion/tests/approval.test.ts › "identical parallel asks allow exactly one"

AC-P3W1-6 [mod-test] Given the host answers pending twice and then decided deny, Then the hook
  returns {decision: {behavior: "deny", message}} after three ask requests with the same askId.
  Tranches are idempotent on askId (conformance row 12).
  Evidence: resources/companion/tests/approval.test.ts › "re-issues tranches until decided"

AC-P3W1-7 [mod-test] Given the fetch rejects, returns a non-JSON body, or a Failure, Then the hook
  returns next(e) unchanged in each case.
  Evidence: resources/companion/tests/approval.test.ts › "every failure returns the engine verdict"

AC-P3W1-8 [mod-test] Given next.signal aborts during a tranche, Then ask.settled {cause: "aborted"}
  is queued from the abort listener and the hook returns next(e).
  Evidence: resources/companion/tests/approval.test.ts › "abort retires the ticket"

AC-P3W1-9 [unit] The companion source contains exactly one site that returns behavior "allow",
  guarded by state === "decided".
  Evidence: tests/companion/api-surface.test.ts › "one allow site in the approval hook"

AC-P3W1-10 [mod-test] Given a held ask and classic.PostToolUse with its tool_use_id, Then
  ask.settled {cause: "tool-ran"} is queued.
  Evidence: resources/companion/tests/approval.test.ts › "a local yes retires the ticket"

AC-P3W1-11 [mod-test] Given a held ask and turn.complete with no PostToolUse, Then ask.settled
  {cause: "turn-ended"} is queued.
  This is the only exit after a user "No" (correction C3; conformance row 13).
  Evidence: resources/companion/tests/approval.test.ts › "a local no retires at turn end"

AC-P3W1-12 [mod-test] Given isInteractive false, or permission_mode "dontAsk", Then no ask request is sent.
  Evidence: resources/companion/tests/approval.test.ts › "never holds headless or dontAsk"

AC-P3W1-13 [unit] Given an owned session on the ramp, When the first tranche arrives, Then a
  PendingApprovalWire with transport "companion" and deadlineMs 0 is sent to the renderer.
  Evidence: tests/companion/ask-broker.test.ts › "parks through the existing resolver"

AC-P3W1-14 [unit] Given a pending ticket, When 60 s pass on the mock clock with tranches re-issued,
  Then the ticket is still pending (no 3.5 s deadline).
  Evidence: tests/companion/ask-broker.test.ts › "no responder deadline on a ticket"
  Guards: the 3.5 s fail-open

AC-P3W1-15 [unit] Given a pending ticket and no tranche for ASK_ORPHAN_MS, Then it is released
  and hook:approval:resolved is sent.
  Evidence: tests/companion/ask-core.test.ts › "orphan timeout"

AC-P3W1-16 [unit] Given mode shadow, Then the first tranche answers released/shadow, no wire is
  sent, and a ledger row is written.
  Evidence: tests/companion/ask-broker.test.ts › "shadow never holds"

AC-P3W1-17 [unit] Given an owned session, When the bridge receives its PreToolUse POST in active
  mode on the ramp, Then shouldStandDown is true, the parking resolver is skipped and the POST is
  answered at once.
  Evidence: tests/companion/bridge-standdown-core.test.ts › "stands down for a session that owns approval"
  Guards: R7

AC-P3W1-18 [unit] Given the same owned session and a catastrophic Bash command on that POST,
  Then the response is a Sentinel deny.
  Evidence: tests/responder-bridge.test.ts › "sentinel still denies during stand-down"

AC-P3W1-19 [unit] Given a session whose lease is lost, Then its next PreToolUse POST parks on the
  bridge again and its open tickets are released.
  Evidence: tests/companion/ask-broker.test.ts › "lease loss hands approvals back to the bridge"

AC-P3W1-20 [unit] Given an ask from a session the host does not own, Then it answers
  released/abstain and creates no ticket.
  Evidence: tests/companion/ask-broker.test.ts › "refuses to hold what it does not own"

AC-P3W1-21 [unit] Given a legacy decision recorded for tool_use_id X, When a companion ask for X
  arrives, Then it is answered with that decision and no second row is created.
  Evidence: tests/companion/ask-broker.test.ts › "one decision per tool_use_id"

AC-P3W1-22 [unit] No HTTP route, MCP handler or companion command imports respondApproval.
  Evidence: tests/companion/ask-authority.test.ts › "only renderer IPC resolves a ticket"

AC-P3W1-23 [unit] coverage-core returns contested/bypassed after a permission attention.raised with no ask.
  Evidence: tests/companion/coverage-core.test.ts › "an unasked permission contests the session"

AC-P3W1-24 [unit] coverage-core returns not-gated/policy when probes.classic stays false.
  Evidence: tests/companion/coverage-core.test.ts › "policy pin is not gated"

AC-P3W1-25 [unit] Given a ticket becomes pending, Then the renderer plays the chime and calls
  requestAttention once for that askId, with notification sound switched off.
  Evidence: tests/session-approvals.test.ts › "a held approval always chimes once"

AC-P3W1-26 [integration] Given a real session and a fake host that answers allow after two tranches,
  Then the Write runs and the debug file has no "hook skipped".
  Evidence: tests/cli/approval-hold.cli.test.ts › "remote allow closes the dialog"

AC-P3W1-27 [integration] Given the fake host is stopped mid-hold, Then the session reaches the
  native ask and the tool has not run.
  Evidence: tests/cli/approval-hold.cli.test.ts › "host down falls to the engine verdict"

AC-P3W1-28 [live-verify] Interactive matrix: default, acceptEdits, bypassPermissions, plan, dontAsk
  and auto each behave as the table in §8, and the auto and dontAsk rows are filled in (Q18, Q20).
  Evidence: LV-P3W1-b

AC-P3W1-29 [live-verify] A hold of 60 minutes ends with the remote answer honoured (Q20).
  Evidence: LV-P3W1-c

AC-P3W1-30 [live-verify] A hold across a hot reload, /clear and --resume leaves the native dialog
  usable or the turn ended, and the Inbox row disappears within ASK_ORPHAN_MS (CQ8, Q20).
  Evidence: LV-P3W1-d

AC-P3W1-31 [live-verify] For a tool call that fails after being allowed, record whether
  classic.PostToolUseFailure fired (CQ12); the ticket retires either way.
  Evidence: LV-P3W1-e

AC-P3W1-32 [live-verify] A subagent's ask shows "Subagent: <type>" and a remote allow is honoured.
  Evidence: LV-P3W1-a

AC-P3W1-35 [live-verify] With the engine's permission dialog open during a hold, record whether an
  AbovePrompt band drawn by a test mod is visible (master Q26, asked by P4W2).
  Evidence: LV-P3W1-f

AC-P3W1-36 [live-verify] In auto mode, record whether a tool.check deny returned by a test mod wins
  over the classifier (master Q27, asked by P3W2).
  Evidence: LV-P3W1-b

AC-P3W1-37 [unit] Given the kill switch is turned off with a ticket pending, Then the ticket is
  released, hook:approval:resolved is sent and the session's next PreToolUse POST parks on the bridge.
  Evidence: tests/companion/ask-broker.test.ts › "kill switch hands approvals back at once"

AC-P3W1-38 [mod-test] Given a hello answered enable: [], When classic.PermissionRequest fires,
  Then no ask is sent and next(e) is returned.
  Evidence: resources/companion/tests/approval.test.ts › "an inert mod never holds"

AC-P3W1-39 [unit] Given the approval family in shadow, When a permission ask arrives, Then the
  resolver chain is not run and one recordFact row is written.
  Evidence: tests/companion/ask-broker.test.ts › "shadow releases before the chain"

AC-P3W1-40 [integration] Given a remote allow was returned for a Write and no classic.PostToolUse arrives
  before turn.complete, When the ticket retires, Then the audit record has outcome no-result, the toast
  reads "Allowed, then blocked by policy" when the policy probe reports managed settings and "reported no
  result" otherwise, and no row, toast or record says the tool ran.
  Evidence: tests/companion/ask-core.test.ts › "allow without PostToolUse never reads as ran" (S7)

AC-P3W1-41 [live-verify] Given a machine with a managed deny rule on a nested part of a compound Bash command
  (CLI 2.1.289), When a held approval for that command is allowed from the Inbox, Then the evidence file
  records whether the tool ran, the terminal text, and what the mod saw (PostToolUse, turn.complete).
  Evidence: LV-P3W1-g (OQ7)

AC-P3W1-42 [unit] Given tool.check results with hook "PreToolUse" and with no hook, When the asks are raised,
  Then the first carries askedBy hook and hook "PreToolUse" and the second askedBy engine, and the pairing
  and the decision are identical in both cases.
  Evidence: resources/companion/tests/approval.test.ts › "hook label does not change pairing"

AC-P3W1-43 [mod-test] Given input that cannot be serialised or a throw inside the hold, When the
  classic.PermissionRequest hook runs, Then it returns next(e) and never throws, so the engine's own
  verdict and dialog apply.
  Evidence: resources/companion/tests/approval.test.ts › "hold failure returns next" (S8)
```

**Human**

```
AC-P3W1-33 [human] With a held approval, the terminal dialog is usable, the row reads
  "Held for you", and pressing 1 in the terminal removes the row without a toast.
  Evidence: screenshots LV-P3W1-a-held.png, LV-P3W1-a-local.png

AC-P3W1-34 [human] With Harnu unfocused, a held approval plays the chime and flashes the taskbar.
  Evidence: recording LV-P3W1-a-attention
```

**LV-P3W1-a (hold, both exits, subagent).**

1. Second isolated Harnu; companion `approval` `active` and the Interceptor `active` for one
   folder; global hooks pointing at this instance only (QA-8).
2. Ask for a Write. Confirm the dialog and an Inbox row "Held for you" with elapsed time.
3. Wait 90 s. Click Allow. The dialog closes and the terminal's tool row reads
   `Allowed by PermissionRequest hook`.
4. Repeat; press `1` in the terminal. The row disappears when the tool finishes.
5. Repeat; press Esc. The row disappears at once.
6. Repeat with Deny: the model quotes the deny sentence.
7. Ask for a subagent that writes a file; allow from Harnu.
8. Measure one allowed tool call's latency against a non-owned session (the 3.5 s tax is gone).

**LV-P3W1-b** runs steps 2–3 once per permission mode; in `auto` it also loads a test mod whose
`tool.check` hook returns `deny` for one command and records what the model receives (Q27).
**LV-P3W1-c** holds 60 minutes. **LV-P3W1-d** triggers a reload (touch the dev plugin dir; this
needs the opt-in `HARNU_COMPANION_DEV=1`, since the staged directory is immutable otherwise),
`/clear` and a `--resume` relaunch during a hold. **LV-P3W1-f** loads a test mod that draws an
`AbovePrompt` band and captures the pane while the dialog of step 2 is open (Q26). **LV-P3W1-e** allows a Bash command that exits non-zero and a Write to an
unwritable path. **LV-P3W1-g** needs a machine with a managed deny rule on a nested part of a compound Bash command
(CLI 2.1.289): allow the held call from the Inbox and record the outcome (AC-P3W1-41).

## 12. Docs deliverables

| Deliverable                       | Change                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                    | `Changed`: approvals for sessions running the Harnu mod are held with no time limit while the terminal dialog stays usable; only calls the engine asks about appear. `Fixed`: no 3.5 s delay per tool call there.                                                          |
| `docs/harnu-features.md` + marker | Approval Inbox paragraph (lines 10-12): a pending approval may be held in Harnu and also answerable in the terminal; a deny from Harnu arrives as the sentence in §7.2; never tell the user an approval is guaranteed. Bump the marker.                                    |
| `docs/user/approval-inbox.md`     | "Intercepting Claude Code's own prompts": held versus the 3.5 s window; the coverage line and each reason; always-allow stays in the terminal; what is not held (headless, `dontAsk`, allowed-by-mode calls).                                                              |
| `docs/user/troubleshooting.md`    | "An approval was not held": the reasons table.                                                                                                                                                                                                                             |
| `docs/hook-bridge-integration.md` | The stand-down rule.                                                                                                                                                                                                                                                       |
| `design.md`                       | §6 Inbox rail (row fragments, coverage line), Safety confirms, Hook responder; §8 the copy above.                                                                                                                                                                          |
| i18n                              | `approvalInbox.coverage.{held,contested,window,agent,ambiguous,summary}`, `approvalInbox.coverage.reason.*`, `approvalInbox.moreInTerminal`, `approvalInbox.answeredInTerminal`, `approvalInbox.blockedByPolicy`, `approvalInbox.noResult`, in `en.json` and `pt-BR.json`. |
| `01-contract.md`, `contract.ts`   | Already merged (§7.4); this wave lands `contract.ts` and the fixtures to match (DOC-7).                                                                                                                                                                                    |

## 13. Rollout & parity gate

- **Family:** `approval`. `off` → bridge only. `shadow` → the mod asks, the host answers
  `released: shadow`; the bridge is authoritative. `active` (per folder) → §7.
- **Shadow comparison, asks only.** Ledger rows: companion `{askId, toolUseId?, tool, inputKey,
at, settledCause}`; legacy `{event: PermissionRequest | PreToolUse, tool, inputKey, toolUseId?,
at, parked, outcome}`. The comparator pairs a legacy `PermissionRequest` POST with a companion
  ask on `(sid, tool, inputKey)` within 2 s. A legacy `PreToolUse` park with no engine ask is
  **out of scope** and counted separately as "legacy-only coverage".
- **Gate 1, to `active` for a folder:** 200 asks from at least 15 sessions; every legacy
  `PermissionRequest` paired and every companion ask paired or explained; zero unexplained
  `ask_x` ids; AC-P3W1-26 and -27 green; LV-P3W1-a, -b, -d attached.
- **Gate 2, to default `active`:** 100 delivered decisions in the ledger with a consistent
  outcome (allow → `tool-ran`; deny → no `tool-ran`), zero `decided` tickets lost to an orphan
  timeout, one hold over 60 s, LV-P3W1-c, and the operator's answer to OD-2. Then the operator
  confirmation point (ARB-6d, master §13).
- **Kill condition for P3 alone** (ADR-0018): a hold that drops on hot reload with no recoverable
  signal. The orphan timer is the signal; AC-P3W1-30 proves it.
- **Demoted, never deleted:** the 3.5 s park, for owned sessions only. `hook-bridge.ts`, the
  resolver chain and Sentinel stay (ARB-8).

## 14. Open questions

| #   | Question                                                                                                                                                             | Default until settled                                                                     | Owner |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| OQ1 | Does `classic.PermissionRequest` fire in `auto` and `dontAsk` modes? (Q18)                                                                                           | hold only if it fires in `auto`; never in `dontAsk`                                       | P3W1  |
| OQ2 | Does a module's `classic.PermissionRequest` hook run before or after the settings HTTP hook of the same event?                                                       | either works: the bridge answers that POST at once                                        | P3W1  |
| OQ3 | Should the Inbox hold for the session the operator is looking at? The product paper said no for a dialog-suppressing hold; with the dialog usable it is harmless.    | hold                                                                                      | P3W1  |
| OQ4 | Master Q31: without P4W1, `other-mod` cannot be detected statically.                                                                                                 | only the runtime signals contest a session                                                | P4W1  |
| OQ5 | Should headless sessions be held on an opt-in (smoke B1.7 works in `-p`)? It needs a non-polling ask.                                                                | no                                                                                        | later |
| OQ6 | CQ8, CQ9, CQ12 of the contract                                                                                                                                       | AC-P3W1-30, -5, -31                                                                       | P3W1  |
| OQ7 | On a managed machine, what does the mod observe after a remote allow that policy then overrides: no `PostToolUse` only, or another event? (CLI 2.1.289, smoke §11.5) | `turn-ended` without `PostToolUse` is shown as in §10; AC-P3W1-41 records the real signal | P3W1  |
| OQ8 | Does `hook` on a `tool.check` result separate a policy-hook ask from an engine ask reliably, and should the Inbox show it? (types l.12298, smoke §11.4)              | Label and audit only (contract §10.1); pairing unchanged                                  | P3W1  |

## 15. Risks

| Risk                                                                                                    | Sev  | Mitigation                                                                             |
| ------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| The Inbox is read as a gate (R3)                                                                        | High | coverage state, SEC-7 copy, `contested` is sticky                                      |
| Double ask on one call (R7)                                                                             | High | stand-down by ownership; one row and one decision per `toolUseId`                      |
| A failure becomes an allow                                                                              | High | S1, AC-P3W1-7, -9, -27                                                                 |
| Master R22, OD-2: operators relying on the legacy "every call" window lose it in `acceptEdits`/`bypass` | High | stated in CHANGELOG, docs and the Hook responder copy; legacy-only count in the ledger |
| Wrong pairing of identical parallel asks                                                                | Low  | §7.3; `ambiguous` label                                                                |
| Chime fatigue from "always"                                                                             | Low  | one chime per ticket; only held tickets chime                                          |
| A held hook leaks after a local "Yes" on a call that never finishes                                     | Low  | `turn-ended`, then `ASK_ORPHAN_MS`                                                     |
| A remote allow is read as "the tool ran" on a managed machine (CLI 2.1.289)                             | High | S7, AC-P3W1-40, -41; only `PostToolUse` says a call ran                                |

## Appendix A — deferred: dialog-suppressing hold

Not built in this epic. It is the **alternative of OD-2** (master §13): the operator may choose
it to keep a hold on calls the engine allows by mode. Recorded so a later wave extends this one
instead of forking it.

- **Shape.** Hold in `tool.check` (returning `allow` or `deny` itself), with an `AbovePrompt`
  band ("Held in Harnu · {tool} · Enter to answer here") racing the remote answer; "answer here"
  returns `ask` and opens the native dialog (smoke B2: band buttons and the race both work).
- **Why deferred.** The terminal shows only a spinner without the band (B1.3); `tool.check` has
  no `agentId`; the band needs `.tsx` and a declared `$.state` key; under `sec-default` a user-tier
  `tool.check` hook still runs but a settings deny rule holds over its allow (its README, not yet
  run on a managed machine, master Q8); it removes "always allow" until released.
- **What it would reuse.** The same `ask` kind, ticket machine, resolver chain and coverage
  state. It would add one ask field (`surface: 'band'`) and one feature id; it must not add a
  second broker.
- **Precondition.** A true remote-only mode with its own consent, and P4W2's band.
