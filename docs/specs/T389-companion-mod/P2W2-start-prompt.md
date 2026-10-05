# T389 P2W2 — Start-prompt delivery

## 1. Status

**Status:** specified (not implemented) · **Date:** 2026-10-02 · **Epic:** T389 · **Wave:** P2W2
**Master:** [`00-master.md`](00-master.md) · **Contract:** [`01-contract.md`](01-contract.md) ·
**ADR:** [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) (D9)
**Verified against:** Claude Code CLI 2.1.287 (mods API types, "types L<n>"); repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository).

## 2. Depends on / Unblocks

- **Depends on:** P2W1 (`enqueue()`, `registerGateRow`, `CommandOutcome`, the `command` audit record,
  `registerCommandHandler`; `appendAudit` is P1W1's), P1W2 (the spawn provider and `plan.mintToken(owner)`), P1W5 (the
  shared `prompt.submit` and `turn.start` registrations, `turn.started {cmd}`). Through them
  P1W1, P1W3 and P1W4.
- **Base branch:** P2W1, rebased onto P1W5.
- **Unblocks:** P2W3 and P2W4, which stack on this wave (they use its row classifier, its result
  type and its own-submit queue), and P5W1 (shrinking the paste gate to the no-lease path).

Interfaces this wave consumes, with the owner's signatures (master §12):

| Owner | Interface                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1W2  | `CompanionSpawnPlan.mintToken(owner: SpawnOwner)` in `pty.ts`: the claim is registered beside that call, keyed by the same `owner`. The claim never holds the token               |
| P1W1  | `companionHost.beforeHello(fn)`: synchronous, after the binding exists and before `commands` is read. This wave enqueues there                                                    |
| P1W1  | `companionHost.onBindingChange(fn)`, `spawnRecord(owner)` (`trust`, `state`), `BindingView.owner`, `.sessionKey`, `.profile`                                                      |
| P1W3  | identity (ruling 1): a hello only claims; the row migrates at `session:added`. The claim follows `BindingView.sessionKey` through `onBindingChange` only (a `pty:rekey` fires it) |
| P1W4  | `familyMode('startPrompt', folder)`; `registerFeaturePolicy('act.prompt', rule)`; `recordFact('startPrompt', …)`                                                                  |
| P1W5  | step 3 of the shared `prompt.submit` registration and the `cmd` on `turn.started` (contract §11.4, §8)                                                                            |
| P2W1  | `registerGateRow('prompt.submit', { feature: 'act.prompt', internal: ['startPrompt'], debug: true })`; `CMD_RESULT_GRACE_MS`; the `channel` state key's `started` list            |

This wave owns, for later waves (master §12): `startPromptClaims`, `classifyUserRow`,
`stripPluginFrame`, and the mod helper `noteOwnSubmit(cmd)`.

## 3. Summary

Today a starting prompt reaches a fresh session in one of two ways. At or under 24 000 characters
it is the argv positional (`AGENT_PREPROMPT_ARGV_MAX_CHARS`, `sessions.ts:663`;
`claude-args.ts:578`). Above that it is queued in the renderer and pasted into the PTY once a gate
believes the composer is ready (`prompt-inject-gate.ts`, `prompt-submit.ts`, the watchdog in
`injection-watchdog.ts`). The second path is the one behind BUG-9, BUG-17, BUG-61, BUG-64 and
BUG-85.

This wave replaces **the paste path** for sessions with a live companion. Main keeps a one-shot
claim per spawn; the first hello turns it into a `prompt.submit` command delivered in the hello
response; the legacy gate asks main before it pastes, so exactly one of the two delivers. The argv
positional is untouched and stays the default.

**Honest size of the win.** Only prompts over the argv budget take the paste path today. This
wave makes that minority deterministic; it does not change the common case.

## 4. Evidence

| Smoke / source  | What it shows                                                                                                                                                                     | Verdict             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| C1              | `$.prompt.submit` from `session.start`, nothing typed: turn starts 857–906 ms after launch                                                                                        | CONFIRMED           |
| C1              | 30 000 chars arrive intact; the whole text is printed in the transcript, not collapsed                                                                                            | CONFIRMED           |
| C1              | Text beginning with `/` is rejected, with or without `asUser`, with or without a leading space                                                                                    | REFUTED             |
| C1              | `$.command.run` runs an installed skill command: screen shows `❯ /<command> …` with no plugin marker; unknown name rejects; a mod cannot run its own                              | CONFIRMED           |
| C1              | `@file` is sent literally, not expanded                                                                                                                                           | REFUTED             |
| C1              | Without `asUser` the model reads "The <name> plugin sent a message: … Address the message above."; with it, bare text. The screen shows `› Prompt from the <name> plugin` in both | CONFIRMED           |
| C1              | Transcript: `queue-operation` enqueue/dequeue rows, then a `type:"user"` row with `origin {kind:"plugin", name, asUser?}`                                                         | CONFIRMED           |
| C1              | Resume picker: no `session.start` while it is up; after Enter it fires with the resumed id. Login screens: no `session.start` at all                                              | CONFIRMED           |
| C1              | Trust dialog                                                                                                                                                                      | COULD-NOT-TEST → AC |
| C1              | In `-p` the boot prompt runs as an extra turn before the positional prompt                                                                                                        | CONFIRMED           |
| C2              | `prompt.submit` mid-turn queues and runs when the turn ends; a panel command blocked `$.command.run` for 33 s                                                                     | CONFIRMED           |
| A5, C2          | `session.start` re-fires on hot reload                                                                                                                                            | CONFIRMED           |
| §9 "not tested" | `$.command.run` mid-turn                                                                                                                                                          | NOT TESTED → AC     |

API: `$.prompt.submit` L2728; `PromptSubmitArgs.asUser` L8368; `origin {kind:'plugin', asUser?}`
L8305–8322; event `prompt.submit` L3843; `$.command.run` L2855 ("queued and run once the session
is idle"); `$.command.list` L2843; `CommandInfo.source` L1561, `CommandSource` L1698.

Harnu code read for this spec: `prompt-inject-gate.ts` (the gate and `requireComposerReadyHook`,
lines 184–352), `prompt-submit.ts`, `prompt-inject.ts` (`pasteAndSubmit`, line 36),
`TerminalPane.vue:1256` (`armInjectGate`) and `:1386` (`tickInjectionWatchdog`),
`stores/injection-watchdog.ts:95`, `sessions.ts:1381` (`pendingAgentPrompts`), `:1596`
(`markPromptUndelivered`), `:3071` and `:3177` (the argv/paste split),
`mcp/injection-escalation-registry.ts`, `src/main/index.ts:989-1001`, `spawn-spec.ts:93`
(`resumeBootOverride`), `docs/specs/BUG-85-generate-prompt-not-delivered.md`,
`docs/reports/2026-07-20-orphan-spawn-postmortem.md`.

## 5. Deviations from the study

| Study (row 8)                                           | This spec                                                                                      | Basis             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------- |
| `$.prompt.submit` at `session.start` replaces the paste | it replaces the paste **path only**; the argv positional stays the default                     | D9                |
| any prompt text                                         | `/`-prefixed text goes through `$.command.run` (`via: 'command'`); `@file` prompts stay legacy | D9; smoke C1      |
| the mod fetches the prompt                              | the host pushes it in the hello response as a command; one-shot claim keyed by the spawn owner | D9; contract §5.1 |
| implied for every session                               | interactive only; headless keeps the argv positional                                           | contract §16      |

## 6. Scope / Non-goals

**In scope.** The claim table in main; eligibility classification; delivery through
`prompt.submit`; the legacy gate's "may I paste" handshake; the renderer's ledger and watchdog
integration; the `asUser` rule; every transcript reader that meets a plugin-origin row; fact
family `startPrompt`.

**Non-goals.**

- Changing the argv positional path or its 24 000-character budget (ARB-8).
- Inlining `@file` content. Main would have to read files named by a prompt an agent may have
  written; the legacy paste expands them natively (§7.3).
- Prompts injected into an already-running session (the lesson-result paste in
  `MarkdownPane.vue:240`). Same command, different origin; it needs its own gate row and spec.
- Deleting the gate, the submitter or the watchdog. They are demoted, not removed (P5W1).
- Changing the `create_session` ACK. Delivery state keeps surfacing through `get_session`
  (`failureReason: 'prompt_undelivered'`), so this wave is not agent-facing.

## 7. Design

### 7.1 Modules

| File                                            | Kind  | Change                                                                                                                |
| ----------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `src/main/companion/start-prompt-claim-core.ts` | pure  | new: the claim state machine and eligibility classifier                                                               |
| `src/main/companion/start-prompt-claims.ts`     | shell | new: the table keyed by `SpawnOwner`, timers, IPC, `enqueue` call, audit                                              |
| `src/main/pty.ts`                               | shell | `CreateOpts.startPrompt?: { text: string }`; `startPromptClaims.register(owner, plan)` beside `plan.mintToken(owner)` |
| `src/preload/index.ts`                          | —     | `startPromptClaimLegacy(sessionKey)`, `onStartPromptState(cb)`                                                        |
| `src/renderer/src/components/TerminalPane.vue`  | shell | passes `startPrompt` at `ptyCreate`; the gate's `inject` asks main first; handles state events                        |
| `src/renderer/src/stores/injection-ledger.ts`   | pure  | events `companion-claimed`, `companion-delivered`, `companion-released`                                               |
| `src/main/claude-reader-derive.ts`              | pure  | new `classifyUserRow`, `stripPluginFrame` (§7.7)                                                                      |
| `resources/companion/hooks/register.ts`         | mod   | `registerCommandHandler('prompt.submit', …)`; `noteOwnSubmit`; step 3 of the shared `prompt.submit` hook              |
| `resources/companion/hooks/lib/prompt-core.ts`  | pure  | slash parsing, command eligibility, result shaping                                                                    |

### 7.2 The claim

```ts
type ClaimState =
  | 'open' // registered at spawn; nobody has taken it
  | 'companion' // a prompt.submit command was issued for it
  | 'delivered' // command.result ok (the engine accepted the prompt)
  | 'confirmed' // a turn started from it
  | 'legacy' // handed to the paste gate (terminal for the companion)
  | 'undelivered' // ambiguous or failed with no safe fallback; surfaced to the operator
  | 'void' // PTY exited before anything took it

interface StartPromptClaim {
  owner: SpawnOwner // the key; the claim never holds the spawn token (SEC-8)
  sessionKey: string // follows the row's re-key, through onBindingChange only
  folder: string
  cause: 'operator' | 'agent' // the spawn record's trust class, §7.5
  plan: {
    via: 'prompt' | 'command'
    text: string
    command?: string
    args?: string
    asUser: boolean
  }
  state: ClaimState
  cmd?: CmdId
  legacyReadyAt?: number
}
```

Transitions (pure, `start-prompt-claim-core.ts`):

| From        | Event                                                                                                                                                | To            | Side effect                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------- |
| `open`      | `beforeHello` runs for the binding whose `owner` holds the claim; `startPrompt` owned-capable (§8); `enqueue` ok                                     | `companion`   | command rides on the hello response; notify the renderer              |
| `open`      | hello, but `enqueue` refuses                                                                                                                         | `legacy`      | —                                                                     |
| `open`      | the legacy gate asks and `START_PROMPT_CLAIM_WAIT_MS` passes with no hello                                                                           | `legacy`      | answer the gate `go: true`                                            |
| `companion` | `command.result` ok                                                                                                                                  | `delivered`   | notify the renderer (it drops its queued copy)                        |
| `companion` | `command.result` not ok with `data.submitted === false`, outcome `expired`, or outcome `dropped` with `delivered: false` (the mod never received it) | `legacy`      | notify; the paste gate proceeds                                       |
| `companion` | outcome `lost`, outcome `dropped` with `delivered: true`, or result with `submitted: 'unknown'`                                                      | (wait)        | wait `START_PROMPT_CONFIRM_MS` for a confirmation, else `undelivered` |
| `delivered` | `turn.started {cmd}`, or a transcript row with `origin.kind: 'plugin'` and the companion's name                                                      | `confirmed`   | ledger record                                                         |
| `delivered` | `mod.error {cmd}` (a late rejection), or no confirmation in `START_PROMPT_CONFIRM_MS`                                                                | `undelivered` | `markPromptUndelivered` in the renderer                               |
| any waiting | a confirmation arrives                                                                                                                               | `confirmed`   | —                                                                     |
| non-final   | PTY exit                                                                                                                                             | `void`        | timers cleared                                                        |

Rules:

- A claim is registered only when the session is a fresh interactive spawn (`claude-new` or
  `claude-fork`) with a paste-path prompt, the spawn's trust class is `operator` or `agent`, the
  companion is injected, `familyMode('startPrompt', folder)` is `active`, the `channel` key is
  `active`, and the prompt is eligible (§7.3). Otherwise nothing is registered and the legacy path runs exactly as today.
- A claim is created once per spawn owner and never re-opened. `legacy`, `confirmed`,
  `undelivered` and `void` are final for the companion.
- The claim survives a hot reload: a re-hello with `resume` keeps the binding (contract §15) and
  finds the claim already in `companion`. The command is re-sent only by the queue's own rule
  (no result, not expired); the mod's dedupe keeps it from running twice (§7.4).
- A claim never survives a host restart. The table is in memory; after a restart the session's
  renderer queue is gone as well, so nothing is delivered by either path, as today.

**Never both, by construction.** The legacy gate cannot paste without `go: true`, and main
answers `go: true` only from `open` (moving it to `legacy`) or when already `legacy`. The
companion path can only start from `open`. Both transitions happen on the main process's single
thread.

### 7.3 Eligibility (`classifyStartPrompt`)

Evaluated at spawn, in this order. Anything not `prompt` or `command` registers no claim.

| #   | Condition                                                                              | Result                                   |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | empty after trim                                                                       | none                                     |
| 2   | longer than `PROMPT_MAX_CHARS` (30 000)                                                | legacy (larger sizes are untested, CQ15) |
| 3   | `trimStart()` begins with `/` and matches `^/([A-Za-z0-9_:-]{1,64})(?:\s+([\s\S]*))?$` | `command` with `command`, `args`         |
| 4   | begins with `/` and does not match                                                     | legacy                                   |
| 5   | contains an expandable file mention                                                    | legacy                                   |
| 6   | otherwise                                                                              | `prompt`                                 |

Rule 5: tokens matching `(?:^|\s)@(\S+)` (at most 64; more → legacy), trailing punctuation
stripped, resolved against the session cwd; if any names an existing file or directory the prompt
is legacy. This is a `stat`, never a read, and its result only chooses the transport. A token that
names nothing (an npm scope, a handle) does not block the companion path, and the paste path
would not have expanded it either.

The mod re-checks rule 3 at run time: the command must be in `$.command.list()`, its `source`
must not be `builtin` (a panel command blocks until dismissed, smoke C1), and its `plugin` must
not be `harnu-companion`. A failed check is `CMD_PRECONDITION` with `submitted: false`, which
releases the claim to the legacy gate.

### 7.4 Mod

`runCommand` for `prompt.submit` (never awaited by its caller, MOD-6):

1. Preconditions from contract §9: interactive; `text` ≤ `PROMPT_MAX_CHARS`; `via: 'prompt'` with
   text starting `/` → `CMD_PRECONDITION`.
2. Write `cmd` to `channel.started` in `$.state` **before** the `$` call (P2W1 §7.7).
3. `via: 'prompt'` → `p = $.prompt.submit(asUser ? { text, asUser: true } : { text })`.
   `via: 'command'` → `p = $.command.run({ command, args })`.
4. Result on whichever comes first: `p` settles, or `CMD_ACCEPT_MS` passes without a rejection.
   Resolved or timed out → `ok: true, data: { submitted: true }`. Rejected in the window →
   `CMD_FAILED` (or `CMD_PRECONDITION` for the engine's "host check" texts) with
   `data: { submitted: false }`.
5. A rejection after the result was sent → `mod.error { where: 'act.prompt', kind: 'throw', cmd }`.
6. A `cmd` found in `started` but not in flight (the load that submitted it was reloaded) answers
   `CMD_FAILED` with `data: { submitted: 'unknown' }` and is not run again.

Commands that arrive in a hello response are executed by the same `runCommand`, started after
`ensureHello` returns (step 3 of the shared `session.start` body, contract §11.4) and not awaited
by the hook, so the hook returns at once and
the engine proceeds to the first prompt (smoke C1 did exactly this for `prompt.submit`).

**Turn tagging.** The mod keeps a queue of its own unconfirmed submits in module memory (not
`$.state`; a reload empties it, which is why the host also accepts a transcript row as
confirmation). This wave exposes `noteOwnSubmit(cmd: CmdId): void` (master §12.2): every
`$.prompt.submit` and `$.command.run` the mod fires is noted before the call, P2W3's
`message.deliver` included. Step 3 of the shared `prompt.submit` event registration (contract
§11.4) pops the queue for an event whose `origin` is `{ kind: 'plugin', name: 'harnu-companion' }`,
and the next `turn.started` carries that `cmd`. The body returns `next(e)` unchanged.

### 7.5 `asUser`: the decision

`asUser` is decided by main from a fact main observed at spawn, never from the prompt's author:

```ts
cause = spawnRecord(owner).trust // 'operator' | 'agent'; set from CreateOpts.agentControlled (pty.ts:236)
asUser = cause === 'operator' // 'read-only' and 'tick' spawns never get a claim
```

| Case                                                                | Wire                             | The model reads                                                                  | The terminal shows                                              | Transcript row `origin`                                |
| ------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------ |
| Operator-caused spawn (card Dispatch, Generate, the manifest drain) | `via: 'prompt'`, `asUser: true`  | the bare text, as with the paste or the argv positional                          | `› Prompt from the harnu-companion plugin`, then the whole text | `{kind:'plugin', name:'harnu-companion', asUser:true}` |
| Agent-controlled spawn (`create_session` from an untrusted caller)  | `via: 'prompt'`, `asUser: false` | "The harnu-companion plugin sent a message: <text> … Address the message above." | the same header, then the framed text                           | `{kind:'plugin', name:'harnu-companion'}`              |
| Slash prompt, either cause                                          | `via: 'command'`                 | the command's expansion, as if typed                                             | `❯ /<command> <args>`, no plugin marker                         | command rows; `command.run` origin is the plugin       |
| Legacy paste (fallback)                                             | —                                | the bare text                                                                    | the pasted text                                                 | `{kind:'human'}`                                       |

Why:

1. **Parity where the trust is the operator's.** A non-agent-controlled spawn already runs with
   the operator's permissions and the Harnu MCP; its starting prompt is today delivered as typed
   input by both legacy paths, and for the Generate flow the operator saw it verbatim before the
   launch. Framing it would change what the model reads for no gain in honesty.
2. **Provenance where the caller is untrusted.** An agent-controlled spawn exists because an MCP
   caller Harnu cannot identify asked for it (`pty.ts:758-766`). Presenting that caller's text as
   the person's own words is the laundering the security panel paper forbids ("`asUser` false
   unless the operator typed it"). The frame still tells the model to address the message.
3. **Server-observed, not declared.** `agentControlled` is set by the renderer path that created
   the session and enforced at spawn; no MCP argument can flip it.

Consequences stated plainly: for agent-controlled spawns the model's first message differs between
the companion path (framed) and both legacy paths (bare). The transcript and every hook still see
`origin.kind: 'plugin'` in both `asUser` cases, so no reader may treat the row as human-typed.
The terminal prints the whole prompt rather than a collapsed paste.

### 7.6 The legacy gate asks first

`TerminalPane.vue`'s `armInjectGate` keeps its structure. Three changes:

1. `ptyCreate` carries `startPrompt: { text }` when `sessions.hasAgentPrompt(sessionKey)` is true.
   The renderer queue is **not** consumed; it stays the legacy holder.
2. The gate's `inject` callback becomes: `const g = await window.api.startPromptClaimLegacy(id)`.
   `g.go === true` → `pasteAndSubmit(...)` as today. Otherwise nothing is pasted, the prompt text
   is parked in a module map `companionPending`, the ledger records `companion-claimed`, and the
   session id stays in `armedInjectGates` so the watchdog reads `gateArmed` and freezes its budget
   (`injection-watchdog.ts:102`).
3. `onStartPromptState`: `delivered` → drop the parked text, record `companion-delivered` (the
   ledger's `wasInjected` becomes true, so the watchdog verdict is `delivered`); `legacy` →
   `sessions.requeueAgentPrompt`, record `companion-released`, clear `armedInjectGates`, and let
   the watchdog's next retry re-arm the gate, whose ask now returns `go: true` at once;
   `undelivered` → `sessions.markPromptUndelivered(id)`.

`startPromptClaimLegacy` in main:

| Claim for the session                 | Answer                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| none registered                       | `{ go: true }` immediately. A session with no claim pays no extra latency                                                                           |
| `legacy`                              | `{ go: true }`                                                                                                                                      |
| `open`                                | record `legacyReadyAt`; wait up to `START_PROMPT_CLAIM_WAIT_MS` for a hello; then `legacy` → `{ go: true }`, or `{ go: false, state: 'companion' }` |
| `companion`, `delivered`, `confirmed` | `{ go: false, state }`                                                                                                                              |
| `undelivered`, `void`                 | `{ go: false, state }`                                                                                                                              |

The wait starts when the **legacy gate has its own ready signal**, not at spawn. Behind the resume
picker, a login screen or the trust dialog neither path has a signal: no `session.start` fires
(smoke C1), no composer-ready hook arrives, and nothing is delivered until the screen is passed.
After it, both signals arrive close together and the companion wins if its hello lands inside the
wait. The gate's own caps are unchanged (`INJECT_HOOK_WAIT_MS` 30 s, `INJECT_READY_CAP_MS` 2.5 s,
`TerminalPane.vue:1176-1197`), and so is the path to `prompt_undelivered`.

The operator's "Retry" on a `prompt_undelivered` session (`retryPromptInjection`,
`sessions.ts:1702`) always takes the paste path: the claim is final by then.

### 7.7 Transcript readers

Plugin prompts are `type:"user"` rows that only `origin.kind` tells apart, plus
`queue-operation` rows (smoke C1). One classifier, in `claude-reader-derive.ts`, is used by every
reader below:

```ts
type UserRowKind =
  | 'human' // no origin, or origin.kind 'human'
  | 'plugin-as-user' // origin.kind 'plugin' && origin.asUser === true
  | 'plugin-framed' // origin.kind 'plugin', no asUser, not meta
  | 'plugin-meta' // origin.kind 'plugin' && isMeta === true (P2W4 context rows)
  | 'harnu-peer' // origin.kind 'plugin' and the text opens with the peer envelope (P2W3 implements the branch)
  | 'peer' // origin.kind 'peer'
  | 'tool-result' // content is tool_result blocks only

function classifyUserRow(row: Record<string, unknown>): UserRowKind
function stripPluginFrame(text: string): string // removes "The <name> plugin sent a message:" and the trailing engine paragraph; returns the input when the anchors do not match
```

Precedence for a plugin-origin row (master §12.1): `plugin-meta`, then `harnu-peer`, then
`plugin-as-user`, then `plugin-framed`.

| Reader                                                                                                                  | Today                                 | Required behaviour                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript-truth.ts:186` `deriveTurnState`                                                                             | any `user` row → `working`            | unchanged for `plugin-as-user` and `plugin-framed` (a turn starts); `plugin-meta` is **not** a chain participant                                                                                                |
| `transcript-truth.ts:240` `last-prompt` titles                                                                          | text as written                       | pass through `stripPluginFrame`                                                                                                                                                                                 |
| `claude-reader.ts:598-612` header scan (`turnCount`, `userMessageCount`, first prompt)                                  | first `user` text → `firstRealPrompt` | `plugin-as-user` → the text; `plugin-framed` → `stripPluginFrame` first; `plugin-meta` and `peer` are skipped as candidates                                                                                     |
| `claude-reader.ts:1313-1322` task label                                                                                 | first `user` text                     | same rule                                                                                                                                                                                                       |
| `claude-watcher.ts:628` live first prompt (`firstPromptCandidate`, via `firstRealPrompt`, `claude-reader-derive.ts:47`) | first `user` text                     | same rule (`firstRealPrompt` is the one canonical helper; the renderer mirror `src/renderer/src/lib/first-prompt.ts` that the study cites no longer exists, see `docs/specs/2026-10-02-sidebar-liveness.md` C3) |
| `sessions.ts:4801` `meta.task`                                                                                          | first `user` text                     | same rule                                                                                                                                                                                                       |
| `usage-bi-core.ts:130` user-turn count                                                                                  | non-meta, non-sidechain `user` rows   | unchanged: a plugin prompt is a turn; `userText` goes through `stripPluginFrame`                                                                                                                                |
| `memory-digest.ts:295-342`, `mcp/digest-core.ts:285/354/411`                                                            | `firstPrompt` / `lastPrompt` strings  | fed by the readers above, so already stripped; one fixture proves it                                                                                                                                            |
| every JSONL line parser                                                                                                 | ignores unknown `type`                | `queue-operation` rows stay ignored; a test pins that they are never counted as turns                                                                                                                           |

`stripPluginFrame` depends on engine wording. An L4 test asserts the two anchors against a real
CLI run, and the function degrades to the unstripped text, never to an empty title.

### 7.8 Contract additions

None — merged into `01-contract.md`: §7.2 (`CMD_ACCEPT_MS`, `START_PROMPT_CLAIM_WAIT_MS`,
`START_PROMPT_CONFIRM_MS`), §8 (`mod.error.cmd`), §9 (`SubmitResultData`, the `via: 'command'`
precondition on `CommandInfo.source`, the accept rule), §6 commands rule 5 (`submitted:
'unknown'` after a reload) and §11.4 (the own-submit step of the `prompt.submit` registration).

## 8. Arbitration & fallback

`startPrompt` is **owned** by the companion for a session when `act.prompt` is enabled, the lease
is live and the family's mode is `active` for the folder (ARB-3). `act.prompt` is enabled only
when the `startPrompt` family is `active` **and** the `channel` key is `active` (contract §11.1,
§11.5). `act.prompt` is attempt-proven
(contract §11.2): the hello that redeemed the spawn token is enough to attempt, and the
`command.result` is the proof. ARB-9d is §7.2's "never both".

| Condition                                                                           | Path                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt ≤ 24 000 chars                                                               | argv positional, always; no claim                                                                                                                                                                                                                             |
| Kill switch turned off mid-session                                                  | the `conn` is revoked, the re-hello is answered `enable: []`, the mod is inert. A claim still `open` goes `legacy` at once (no wait); one in `companion` follows the `dropped: revoked` outcome (`delivered: false` → `legacy`, else the confirmation window) |
| Mode `off` / `shadow`, `channel` not `active`, CLI < 2.1.287, CLI above the ceiling | no claim registered; legacy paste gate, no added wait                                                                                                                                                                                                         |
| Org blocks user mods, `--safe-mode`, `--bare`                                       | claim registered (the mod was injected), no hello → the gate's ask waits 2 s once, then pastes                                                                                                                                                                |
| `disableSideloadFlags` respawn (P1W2)                                               | the respawn carries no `--plugin-dir` → no claim                                                                                                                                                                                                              |
| `sec-default`                                                                       | `$.prompt.submit` is a call, not a pinned hook; attempt it; a rejection is `submitted: false` → legacy                                                                                                                                                        |
| Resume picker, login, trust dialog                                                  | nothing happens until passed; then companion if the hello lands within the wait, else legacy (Q1 for the trust dialog)                                                                                                                                        |
| Untrusted folder                                                                    | legacy until Q1 is settled: P1W2 reports whether the mod loads there; this wave registers no claim if it does not                                                                                                                                             |
| Hot reload between issue and result                                                 | no second submit; `submitted: 'unknown'` → confirmation window → `confirmed` or `undelivered`                                                                                                                                                                 |
| Lease lost after `companion`, before a result                                       | the queue settles the command `dropped`: `delivered: false` → `legacy` (the mod never received it); `delivered: true` → confirmation window, then `undelivered` (badge, operator Retry pastes)                                                                |
| Host down at spawn time                                                             | no hello → the ask waits 2 s → legacy paste                                                                                                                                                                                                                   |
| Host restart mid-claim                                                              | claim and renderer queue are both gone; as today                                                                                                                                                                                                              |
| `/clear` before delivery                                                            | the queued command is dropped by P2W1 (`rebound`): `delivered: false` → `legacy`; `delivered: true` → confirmation window → `undelivered`                                                                                                                     |
| Headless (`-p`, scheduler)                                                          | never a claim; argv only (contract §16)                                                                                                                                                                                                                       |
| Agent-controlled spawn                                                              | companion with `asUser: false`, else paste                                                                                                                                                                                                                    |
| Parked session woken                                                                | a resume carries no starting prompt (`spawn-spec.ts:93`); nothing to deliver                                                                                                                                                                                  |
| PTY exits before delivery                                                           | `void`; the gate's own `cancel` requeues as today (BUG-85)                                                                                                                                                                                                    |

## 9. Security requirements

Inherited: SEC-1, SEC-3, SEC-4, SEC-5, SEC-6, SEC-8. Wave-specific:

1. A `prompt.submit` for a start prompt is enqueued only by `start-prompt-claims.ts`, with cause
   `{ kind: 'internal', subsystem: 'startPrompt' }`, and only for a claim created at a spawn main
   itself performed. A hello cannot create a claim; a spawn token with no claim yields no command.
2. The text comes from the `ptyCreate` IPC payload of that spawn. Nothing the mod sends can
   change it, and the mod never chooses `asUser`.
3. `asUser` follows §7.5. An agent-controlled spawn never gets `asUser: true`.
4. The audit row is P2W1's `CommandAuditRecord`: `args` holds the text length and a 12-hex
   sha256, never the text; the claim's cause, `via` and `asUser` go in its `meta` field
   (P2W1 §7.5).
5. `via: 'command'` runs only a command that exists in the session, is not built in and is not
   the companion's own. It is not a generic "run": the name and arguments are the operator's or
   the dispatching agent's starting prompt, which the legacy path would have typed anyway.
6. Rule 5 of §7.3 performs `stat` only and discloses nothing to any caller.

## 10. UX & copy

No new Harnu surface and no new string. What the operator can notice:

- The terminal shows `› Prompt from the harnu-companion plugin` above a companion-delivered prompt
  and prints it in full.
- The "Prompt not delivered" badge (`promptUndelivered`, `en.json:784`) and its Retry are
  unchanged and now also cover the `undelivered` claim state.
- The injection trail gains three events. Their ids (`companion-claimed`, …) are internal; where
  the trail renders them, the label says "Harnu mod". `design.md` is untouched.

## 11. Acceptance criteria

```
AC-P2W2-1 [unit] Given an open claim, When a hello redeems its spawn token and enqueue succeeds,
  Then the state is companion and a later legacy ask answers go: false.
  Evidence: tests/companion/start-prompt-claim-core.test.ts › "hello takes an open claim"
  Guards: BUG-64, BUG-85

AC-P2W2-2 [unit] Given an open claim, When the legacy gate asks and no hello arrives within
  START_PROMPT_CLAIM_WAIT_MS, Then the state is legacy and a later hello issues no command.
  Evidence: start-prompt-claim-core.test.ts › "unclaimed timeout hands over once"
  Guards: BUG-17

AC-P2W2-3 [unit] Given every ordered pair of events on a claim, Then at most one of
  {command issued, go: true} ever occurs.
  Evidence: start-prompt-claim-core.test.ts › "never both (exhaustive)"

AC-P2W2-4 [unit] Given a result with submitted: false, Then the claim becomes legacy.
  Evidence: start-prompt-claim-core.test.ts › "a proven non-delivery releases"

AC-P2W2-5 [unit] Given a delivered claim, When no turn.started{cmd} and no plugin-origin row
  arrive within START_PROMPT_CONFIRM_MS, Then the state is undelivered.
  Evidence: start-prompt-claim-core.test.ts › "unconfirmed delivery escalates"
  Guards: BUG-61

AC-P2W2-6 [unit] Given the texts "/skill a b", " /skill", "/bad name!", "x @README.md" with the
  file present, "x @scope/pkg" with nothing on disk, and 30 001 chars, Then the classifier returns
  command, command, legacy, legacy, prompt, legacy.
  Evidence: start-prompt-claim-core.test.ts › "eligibility table"

AC-P2W2-7 [unit] Given agentControlled true, Then asUser is false.
  Evidence: start-prompt-claim-core.test.ts › "agent-controlled is framed"

AC-P2W2-8 [unit] Given a session with no claim, When the legacy gate asks, Then go: true is
  returned without a timer.
  Evidence: tests/companion/start-prompt-claims.test.ts › "no claim, no wait"

AC-P2W2-9 [unit] Given the row's synth→real migration at session:added, When the gate asks by
  the new key, Then it reaches the same claim.
  Evidence: start-prompt-claims.test.ts › "claim follows the rekey"
  Guards: BUG-85

AC-P2W2-10 [mod-test] Given prompt.submit with via 'prompt', Then $.prompt.submit is called once
  with asUser only when requested, and the result carries submitted: true.
  Evidence: resources/companion/tests/prompt.test.ts › "submits once"

AC-P2W2-11 [mod-test] Given $.prompt.submit rejects inside CMD_ACCEPT_MS, Then the result is not
  ok with submitted: false.
  Evidence: prompt.test.ts › "early rejection is a proven non-delivery"

AC-P2W2-12 [mod-test] Given via 'command' and a command that is missing, built in, or the
  companion's own, Then $.command.run is not called and the result is CMD_PRECONDITION with
  submitted: false.
  Evidence: prompt.test.ts › "command preconditions"

AC-P2W2-13 [mod-test] Given a cmd in started from a previous load, When it is delivered again,
  Then nothing is submitted and the result carries submitted: 'unknown'.
  Evidence: prompt.test.ts › "reload never resubmits"

AC-P2W2-14 [mod-test] Given isInteractive false, When a prompt.submit command arrives, Then no $
  call runs and the result is FEATURE_DISABLED.
  Evidence: prompt.test.ts › "headless refuses"

AC-P2W2-15 [unit] Given rows of every UserRowKind, Then classifyUserRow returns the kind and the
  first-prompt readers skip plugin-meta and peer and strip the frame of plugin-framed.
  Evidence: tests/claude-reader-derive.test.ts › "plugin-origin rows"

AC-P2W2-16 [unit] Given a transcript whose last chain row is a plugin-meta user row after an
  idle checkpoint, Then deriveTurnState is idle, not working.
  Evidence: tests/transcript-truth.test.ts › "meta rows do not start a turn"

AC-P2W2-17 [unit] Given a transcript with queue-operation rows, Then turnCount and the BI user
  turn count ignore them.
  Evidence: tests/claude-reader.test.ts › "queue-operation is not a turn"

AC-P2W2-18 [integration] Given a real claude with the mod, a fake host and a 25 000-char prompt,
  Then one turn starts, the transcript has one user row with origin.kind plugin, and the frame
  anchors of stripPluginFrame match it.
  Evidence: tests/cli/start-prompt.cli.test.ts › "delivers once and the frame is known"

AC-P2W2-19 [integration] Given the same run with the mod file touched right after the hello,
  Then still exactly one user row with origin.kind plugin exists.
  Evidence: start-prompt.cli.test.ts › "hot reload does not double submit"

AC-P2W2-20 [live-verify] Given an operator-dispatched card with a 26 000-char prompt in an
  active folder, Then the turn starts, the row has asUser true, nothing is pasted (no
  paste-written ledger event) and the session never shows the undelivered badge.
  Evidence: LV-P2W2-a
  Guards: BUG-9, BUG-17, BUG-85

AC-P2W2-21 [live-verify] Given an agent-controlled create_session with a 26 000-char prompt,
  Then the row has no asUser and the model's first reply addresses the task.
  Evidence: LV-P2W2-a

AC-P2W2-22 [live-verify] Given the companion mode off for the folder, Then the legacy paste
  delivers and the ledger shows no companion event.
  Evidence: LV-P2W2-b

AC-P2W2-23 [live-verify] Given the host socket unreachable at spawn, Then the legacy paste
  delivers about START_PROMPT_CLAIM_WAIT_MS after its ready signal and the prompt appears once.
  Evidence: LV-P2W2-b

AC-P2W2-24 [live-verify] Given a folder that shows the trust dialog, Then nothing is delivered
  while it is up, and after it is accepted the prompt is delivered exactly once.
  Evidence: LV-P2W2-c (settles Q1 for this wave)
  Guards: BUG-64

AC-P2W2-25 [live-verify] Given a long prompt beginning with a bundled skill's slash command,
  Then the terminal shows the command line with no plugin marker and the skill runs once.
  Evidence: LV-P2W2-d

AC-P2W2-26 [live-verify] Given a session mid-turn, When a prompt.submit with via 'command' is
  debug-enqueued, Then the observed behaviour (queued, rejected or run) is recorded.
  Evidence: LV-P2W2-d (settles Q15 for $.command.run)

AC-P2W2-27 [unit] Given a claim in companion whose command was delivered, When the lease is lost
  and no confirmation arrives, Then the state is undelivered and never legacy.
  Evidence: start-prompt-claim-core.test.ts › "lease loss does not paste blindly"

AC-P2W2-29 [unit] Given a claim in companion and a command settled dropped with delivered false,
  Then the claim becomes legacy.
  Evidence: start-prompt-claim-core.test.ts › "a dropped undelivered command releases the claim"

AC-P2W2-28 [unit] Given an open claim, When the kill switch revokes the binding, Then the claim
  is legacy at once and the gate's ask answers go: true with no wait.
  Evidence: start-prompt-claims.test.ts › "kill switch hands over at once"

AC-P2W2-30 [unit] Given a result with submitted: 'unknown', Then the claim does not become legacy.
  Evidence: start-prompt-claim-core.test.ts › "unknown is not a release"

AC-P2W2-31 [unit] Given a command outcome lost, Then the claim does not become legacy.
  Evidence: start-prompt-claim-core.test.ts › "lost is not a release"

AC-P2W2-32 [unit] Given agentControlled absent, Then asUser is true.
  Evidence: start-prompt-claim-core.test.ts › "operator spawns are bare"
```

Cost cap for the model-turn L4 suites (QA-8): haiku, at most three model calls per run, behind
`HARNU_CLI_LIVE=1`, 0.05 USD per run; never in `npm test`.

### Live-verify recipes

Second isolated Harnu, legacy bridge on, model `haiku`, at most three model calls per recipe.
Long prompts are a short instruction padded with numbered filler lines and a final sentinel line
(`FINALWORD_93`).

**LV-P2W2-a — both causes.**

1. Set `startPrompt` to `active` for the folder. Dispatch a card whose prompt is 26 000 chars.
2. Confirm: the turn starts; the reply quotes the sentinel; the JSONL has one `type:"user"` row
   with `origin.asUser: true`; the injection trail shows `companion-claimed`,
   `companion-delivered` and no `paste-written`.
3. Through the MCP server, call `create_session` with a 26 000-char `prePrompt`. Confirm the row
   has no `asUser` and the reply addresses the task.
4. Read `get_session` for both: no `failureReason`.

**LV-P2W2-b — fallbacks.**

1. Mode `off` for the folder; repeat step 1 of recipe a; confirm a `paste-written` event and one
   delivery.
2. Mode `active`; rename the host socket before the spawn; dispatch; confirm one delivery by
   paste and the time between `gate-fired` and `paste-written`.
3. Restore the socket.

**LV-P2W2-c — screens before the composer.**

1. Dispatch a long prompt into a fresh, untrusted worktree. Do not answer the dialog for 20 s.
2. Confirm nothing was delivered and the claim is `open`.
3. Accept the dialog. Confirm exactly one delivery and record which path made it.
4. Repeat with a spawn that opens the resume picker.

**LV-P2W2-d — slash prompts.**

1. Enable one bundled skill for the folder. Dispatch a prompt of `/<skill> ` plus 25 000 chars.
2. Confirm the terminal line, one run, and `command.result` with `submitted: true`.
3. Start a long answer; debug-enqueue a `prompt.submit` with `via: 'command'`; record what
   happens. (The debug route of P2W1 §7.6 admits `prompt.submit` under gesture `debug`; it is
   absent in a normal run.)

## 12. Docs deliverables

| Contract                 | Deliverable                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CHANGELOG (DOC-1)        | `### Fixed` — long starting prompts are submitted by the Harnu mod instead of being pasted, when the family is `active`                                                                          |
| `docs/harnu-features.md` | none (no ACK change); re-check if implementation adds a field to `create_session`                                                                                                                |
| `docs/user/` (DOC-3)     | `sessions.md`: how a starting prompt is delivered, and that the engine-drawn line "Prompt from the harnu-companion plugin" is the Harnu mod; `troubleshooting.md`: "Prompt not delivered" causes |
| `design.md`              | none                                                                                                                                                                                             |
| i18n                     | none                                                                                                                                                                                             |
| Contract (DOC-7)         | already merged (§7.8); `contract.ts` and the fixtures land with the code                                                                                                                         |
| `api-surface.json`       | adds `$.prompt.submit`, `$.command.run`, `$.command.list`                                                                                                                                        |

## 13. Rollout & parity gate

**Fact family:** `startPrompt` (`off | shadow | active`, per-folder ramp).

**Shadow.** In `shadow` the family has no authority (ARB-6b, contract §11.5): no claim is
registered and the paste gate delivers. The
host records, per paste-path spawn, a ledger row with: hello time relative to spawn, the legacy
gate's ready time, the trigger that fired it (`hook`, `quiescence`, `cap`), whether the hello
would have been inside `START_PROMPT_CLAIM_WAIT_MS`, the eligibility class, and the legacy outcome
(`delivered` or `prompt_undelivered`). Prompt text is hashed (QA-9).

**Gate to `active` (per folder first, then the default):**

1. Shadow: 40 paste-path spawns with the hello inside the wait in at least 95 %, and every miss
   classified (picker, login, trust, policy).
2. Active on ramped folders: 40 companion deliveries with zero double submits, zero
   `undelivered`, and zero legacy pastes after a `companion` state.
3. AC-P2W2-24 and AC-P2W2-19 passed on the current tested ceiling.

The population is small by nature (prompts over the argv budget), so the counts may include
recipe runs across at least three folders; the ledger marks them. The flip is an operator
confirmation point (ARB-6d). Whether a manifest drain counts as operator-caused for `asUser` is
operator decision point OD-4 (master §13); the default is yes.

**Demotes:** the paste gate, the submitter and the injection watchdog to the no-lease path.
Nothing is deleted.

## 14. Open questions

| #    | Question                                                                                                                              | Default until settled                                 | Owner             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------- |
| OQ-1 | Q1: does the trust dialog block `session.start`, and does the mod load in an untrusted folder?                                        | legacy; AC-P2W2-24                                    | P1W2, P2W2        |
| OQ-2 | Q15: `$.command.run` mid-turn                                                                                                         | not used mid-turn by this wave; AC-P2W2-26 records it | P2W2              |
| OQ-3 | Does a framed start prompt lower first-turn compliance on small models (smoke D1 saw Haiku refuse peer messages, not plugin prompts)? | framed for agent-controlled spawns; watch the ledger  | P2W2              |
| OQ-4 | Should the manifest drain count as operator-caused for `asUser`?                                                                      | yes (not agent-controlled)                            | OD-4 (master §13) |
| OQ-5 | Does the engine write a `last-prompt` entry for a plugin prompt, and with or without the frame?                                       | strip defensively                                     | P2W2              |

Moved: when the `$.prompt.submit` promise settles and whether a prompt over `PROMPT_MAX_CHARS`
arrives intact are contract CQ15 (this wave settles them in AC-P2W2-18 and LV-P2W2-a); agent
prompts under the argv budget are master Q32 (P5W1); the Desktop surface (upstream #96336) is
master Q22 (P4W3).

## 15. Risks

| Risk                                                                         | Sev      | Mitigation                                                                                       |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| Double submit (master R12)                                                   | Medium   | single-threaded claim; release only on `submitted: false`; AC-P2W2-3, AC-P2W2-19                 |
| Never submitted, silently                                                    | Medium   | confirmation window → `undelivered` → the existing badge and `get_session` failure reason        |
| Remote prompt submission is code execution in the session's mode (master R1) | Critical | claim created only at a spawn main performed; no hello or verb can create one; audit             |
| An agent's text read as the user's words                                     | Medium   | `asUser` from `agentControlled`, server-observed (§7.5)                                          |
| Engine frame wording changes and titles show the frame                       | Low      | anchors asserted in L4; degrade to unstripped text                                               |
| A policy-blocked mod adds 2 s to every paste-path prompt                     | Low      | one bounded wait; P1W4's Harnu mod state can later skip claims for sessions known to be `legacy` |
| The small population hides regressions                                       | Medium   | recipe-driven evidence; ledger rows for every paste-path spawn in `shadow`                       |
