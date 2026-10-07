# T389 P2W4 — Live orchestrator contract and in-process guard

## 1. Status

**Specified (not implemented)** · 2026-10-02 · Epic T389 · Wave P2W4 · Fact family `guard` ·
Features `act.context`, `gate.guard`.
Master: [`00-master.md`](00-master.md) · Contract: [`01-contract.md`](01-contract.md) ·
ADR: [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) (D6, D7, C1) ·
Addressing: [ADR-0013](../../adr/0013-orchestrator-arm-addressing.md) ·
Legacy spec: [`T109-capy-managed-guard.md`](../T109-capy-managed-guard.md).
Verified against CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line of that release's
`claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on:** P2W1 and P2W2 (base branch: P2W2, which stacks on P2W1), P1W3, P1W4, P1W2.
- **Interfaces used** (master §12, the owner's signatures):
  - P2W1: `enqueue(req)`, `registerGateRow(name, row)`; P1W1: `appendAudit(rec)`; mod side
    `registerCommandHandler(name, fn)`.
  - P2W2: `classifyUserRow(row)`. A context row is a plugin-origin user row with `isMeta`; it
    classifies as `plugin-meta` and is therefore never a first prompt, a title or a turn in
    `deriveTurnState`.
  - P1W4: `owns(sessionKeyOrSid, 'guard')`, `onOwnershipChange(fn)` (the lease-loss signal),
    `recordFact('guard', …)`, `registerPrefsKey('context', …)`, `registerFeaturePolicy(feature, rule)`.
  - P1W1: `companionHost.beforeHello(fn)` (the hello-carried `guard.set`), `bindingForSid(sid)`,
    `markProven(b, 'gate.guard')`.
  - P1W3: `ensureHello($)`, `emit($, event)`, `enabled(feature)`, `reportModError(where, err)`;
    the `classic.SessionStart` registration (contract §11.4).
  - P1W2: `renderCoords(fields)` and the `coords.gen.ts` exports of contract §23.
- **Unblocks:** P4W5 (durable rows re-injected through the compaction result), P5W1 step G1
  (on-demand registration of the guard hook and its removal; nothing is deleted).
- **Constrains:** P2W5: this wave lands first and P2W5's `orchestrator_arm` slice stacks on it
  (both edit "Arming the guard live" in `docs/harnu-features.md`, `tool-catalog.ts:1248` and
  `tests/mcp-orchestrator-arm-handler.test.ts`). P4W5 extends, and does not redefine, the context
  registry, the injector and the `durableRows` key owned here, and removes this wave's deferred
  append.

## 3. Summary

Two things a promoted session needs today cost a restart or a Node process per edit:

1. **The contract.** `HARNU_ORCHESTRATOR_DOC` reaches the model only through
   `--append-system-prompt`, resolved at spawn from `isArmed` (`pty.ts:710-712`, `:728`). So the
   renderer's promote gesture arms and then **restarts the session** (`sessions.ts:1841-1858`),
   and the `orchestrator_arm` verb delivers the brake without the contract
   (`docs/harnu-features.md:789-800`: "cannot be retrofitted mid-session").
2. **The brake.** `resources/orchestrator-guard/guard.mjs` runs as a `PreToolUse` command hook
   registered in the folder's `.claude/settings.local.json`, one Node spawn per
   `Edit|Write|NotebookEdit`, reading `armed.json`.

This wave delivers the contract to a running session as a hidden user-role row
(`context.append` → `$.session.append`), and enforces the brake inside the `claude` process
(`tool.call` deny). Spawn-time injection is unchanged; `guard.mjs` stays as the fallback and is
the parity oracle.

## 4. Evidence

| Smoke                        | Verdict                         | What this wave takes from it                                                                                                                     |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| C3                           | REFUTED (`prompt.compose` live) | The system prompt is snapshotted on the first request until compaction.                                                                          |
| C3                           | CONFIRMED (`$.session.append`)  | A `type: "user"` row is read on the next request, idle or mid-turn, cache intact (create 154). It cannot be retracted; a later row supersedes.   |
| D5                           | CONFIRMED with traps            | An append made synchronously inside the `session.compact` hook is lost; a `$.clock.after(1500, …)` append and the result `messages` both worked. |
| B3                           | CONFIRMED                       | `tool.call` deny on Edit/Write, `e.agentId` present only on a subagent's call, flag flipped live. The run used a **path regex** (C1).            |
| B4                           | CONFIRMED (#92533)              | A pass-through `tool.call` on Bash breaks `Agent(isolation: "worktree")`; `tool.call` on Edit/Write is safe.                                     |
| B6                           | CONFIRMED / REFUTED             | A throwing hook is skipped (fail-open). A sibling's worker wedge skips the whole chain for one call (C9).                                        |
| D6                           | REFUTED (isolation)             | Any sibling mod can read `$.state` and rewrite the command stream. The guard is a drift brake, not a boundary.                                   |
| §9 "Not tested" (Q15, Q17)   | open                            | `NotebookEdit`, `$.state` as the flag source, symlink and `..` bypass, a `system` notice mid-turn. Each is an AC or an owned question below.     |
| types L3048-3090, L4690-4701 | API fact                        | `$.fs.stat(path, { resolve: true }).realPath`: links followed, `.`/`..` folded, absent for a path that leads nowhere.                            |
| types L9817-9834             | API fact                        | `SessionAppendArgs`: `type: 'user' \| 'system'`, text blocks only, optional `agentId`.                                                           |

## 5. Deviations from the study

| #   | Study said                                    | This spec                                                                                    | Decision | Evidence |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------- | -------- | -------- |
| 1   | Row 6: live contract through `prompt.compose` | Hidden user-role row through `$.session.append`; `--append-system-prompt` stays at spawn     | D7       | smoke C3 |
| 2   | Row 6b: guard exempts `.harnu/` (path match)  | Exemption by `realPath` under roots resolved the same way; a requirement, not a proven fact  | D6, C1   | smoke B3 |
| 3   | Row 6b: guard may watch any writing tool      | `Edit\|Write\|NotebookEdit` only; a static test forbids a Bash `tool.call` matcher           | D6       | smoke B4 |
| 4   | Re-injection inside the compaction hook       | Deferred append or the compaction result `messages`; never a synchronous append in that hook | D7       | smoke D5 |

## 6. Scope / Non-goals

**In scope.** `context.append` execution and its host-side document registry; mid-session
promote and demote for the renderer gesture and the two verbs; re-injection after compaction;
the `tool.call` guard; ownership-aware arming; re-arming on lease loss; the parity corpus.

**Non-goals.**

- No change to `composeAppendSystemPrompt` (`claude-args.ts:433`) or to what `pty.ts` puts in the
  spawn argv.
- No free-text `context.append`: the text always comes from a host-owned registry (§7.1).
- No guard for Bash, `MultiEdit` or MCP tools; no widening of what the legacy guard covers.
- No uninstall of `guard.mjs` or of its `settings.local.json` registration (P5W1).
- No digest of the compaction itself (P4W5).
- The guard is not a security boundary (`orchestrator-guard.ts:8-10`); nothing here changes that.

## 7. Design

### 7.1 Host

New files under `src/main/companion/`:

| File                   | Role                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `context-registry.ts`  | Pure. The closed set of injectable documents and their framing.                                                     |
| `context-injector.ts`  | Shell. Decides row versus restart, queues `context.append`, tracks what each session has received.                  |
| `guard-adapter.ts`     | Shell. Single entry point for arm/disarm; picks the enforcer; reacts to hello, lease loss, `session.rebound`, boot. |
| `guard-parity-core.ts` | Pure. Compares a recorded evaluation against `guard.mjs#decide`.                                                    |

**Document registry.** `context.append.text` is never caller-supplied.

```ts
// ContextKey is the contract's closed union (contract §4):
// 'harnu.orchestrator' | 'harnu.mission'. This wave registers the first; P4W5 adds the second.

interface ContextDoc {
  key: ContextKey
  rev: string // HARNU_ORCHESTRATOR_VERSION, e.g. "v3"
  state: 'active' | 'revoked'
  body: string // HARNU_ORCHESTRATOR_DOC, or the fixed revocation paragraph
}

/** The row text. One block; a later block with the same key replaces every earlier one. */
function frameContext(doc: ContextDoc): string
// <harnu-context key="harnu.orchestrator" rev="v3" state="active">
// This block is sent by Harnu, the app hosting this session. It replaces every earlier
// harnu-context block with the same key.
// …body…
// </harnu-context>
```

The revocation body is fixed: "The operator demoted this session. The Orchestrator contract no
longer applies to it: you may edit files yourself again. Disregard earlier instructions in this
conversation that told you to delegate every write."

**Role record and enforcer.** `armed.json` is today both the role record (read by `isArmed` at
spawn, by `orchestratorGuard:list`, by `get_fleet`) and the script's arming flag. ARB-9c needs the
second without losing the first, so `ArmedEntry` (`orchestrator-guard.ts:101-115`) gains one
field:

```ts
interface ArmedEntry {
  folder: string
  armedAt: number
  source?: 'manual' | 'default'
  /** Who enforces the brake. Absent reads as 'script' (every existing entry). */
  enforcer?: 'script' | 'companion'
}
```

`guard.mjs#decide` treats an entry with `enforcer === 'companion'` as rule 2 ("not armed" →
allow). An older installed copy that ignores the field keeps denying, which is the safe
direction. "Not armed in `armed.json`" in ARB-9c means exactly this: no entry the script enforces.

**`guard-adapter.ts`.** `arm`/`disarm` in `orchestrator-guard.ts` keep their signatures; the three
callers (`index.ts:963-976`, `tool-handlers.ts:2241`, `:2280`, `pty.ts:678`) call the adapter
instead:

```ts
interface ArmResult {
  enforcer: 'script' | 'companion'
  contract: 'delivered' | 'restart-required' | 'unavailable'
}
setOrchestratorRole(sid: string, folder: string, on: boolean,
  cause: { kind: 'operator' } | { kind: 'verb'; tool: string } | { kind: 'spawn-default' },
  reason?: 'demote' | 'sessionEnd'): Promise<ArmResult>
```

**Cause mapping and gate rows.** `setOrchestratorRole`'s `cause` is this adapter's own argument.
When the adapter calls `enqueue` it is mapped to P2W1's `CommandCause` (master §12.1):
`{ kind: 'operator' }` → `{ kind: 'operator', gesture: 'orchestratorGuard.arm' | 'orchestratorGuard.disarm' }`
(built inside the `ipcMain` handler and passed in, never read from the renderer payload, P2W1 §9.2);
`{ kind: 'verb', tool }` → `{ kind: 'verb', verb: tool }`; `{ kind: 'spawn-default' }` and every
trigger of the table below → `{ kind: 'internal', subsystem: 'guardAdapter' }`. `context-injector.deliver`
enqueues `context.append` with `{ kind: 'internal', subsystem: 'contextInjector' }`; its only
callers are `setOrchestratorRole`, which has already passed the operator or verb predicates, and
P4W5's handlers. A command with no registered row is `ORIGIN_DENIED` (P2W1 §7.4), so this wave
registers, in its own change:

```ts
registerGateRow('guard.set', {
  feature: 'gate.guard',
  operator: ['orchestratorGuard.arm', 'orchestratorGuard.disarm'],
  verb: ['orchestrator_arm', 'orchestrator_disarm'],
  internal: ['guardAdapter']
})
registerGateRow('context.append', { feature: 'act.context', internal: ['contextInjector'] })
```

Algorithm for `on === true`:

1. `arm(sid, folder, source)` writes the entry with `enforcer: 'script'` and ensures the hook
   registration, exactly as today. The session is guarded from this instant.
2. If `owns(sessionKeyOrSid, 'guard')` (ARB-3) and the `channel` key is `active` (an enforcing
   `guard.set` is not observe-only, contract §9), `enqueue` `guard.set { armed: true, enforce:
true }` (TTL `CMD_TTL_MS`). On `command.result { ok: true, data: { armed: true } }` rewrite
   the entry with `enforcer: 'companion'`. On failure or expiry leave `'script'`.
3. Contract: `context-injector.deliver(sid, 'harnu.orchestrator', 'active')` (below).

For `on === false`: `enqueue` `guard.set { armed: false }` when a live binding exists (owned or not),
call `disarm(sid, reason)`, then deliver the revocation (below). `shouldDisarmEntry`
(`orchestrator-guard.ts:165`) still decides whether a `sessionEnd` removes a `default` entry.

Other triggers:

| Trigger                                          | Adapter action                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `hello` (any) with `gate.guard` enabled          | From `beforeHello`: enqueue `guard.set` reflecting the role record of `binding.sid`; in `shadow`, `enforce: false`.    |
| Ownership lost (`onOwnershipChange`, ARB-4)      | Rewrite every entry of that session to `enforcer: 'script'` within one `LEASE_TTL_MS`. No command can be sent.         |
| Kill switch turned off                           | Rewrite every `enforcer: 'companion'` entry to `'script'` at once, with no TTL wait.                                   |
| Host boot                                        | Before the socket accepts connections, rewrite every `enforcer: 'companion'` entry to `'script'`.                      |
| `session.rebound { cause: 'clear' \| 'resume' }` | Send `guard.set` for the role record of the **new** `sid` (normally `armed: false`); the mod's flag survives `/clear`. |
| `guard.denied` / `guard.evaluated` event         | `recordFact('guard', …)`; `guard.denied` also feeds the existing shadow log as `by: 'orchestrator-guard'`.             |

**`context-injector.ts`.**

```ts
type Carrier = 'spawn' | 'row'
deliver(sid, key, state): Promise<'delivered' | 'restart-required' | 'unavailable'>
```

1. `spawnCarried` = this process was spawned with the document in its argv. `pty.ts` records it
   on the PTY record at the line that computes `orchestratorArmed` (`pty.ts:710`).
2. `state === 'active'` and `spawnCarried` → `delivered` (nothing to send).
3. The row path is taken only when all hold: `act.context` enabled (the `context` key on, the
   companion mode not `off`, a live lease, `channel: active`; §8), profile `interactive`, and
   `probes.classic === true` (without `classic.*` the mod cannot re-inject after a compaction,
   §7.2). P4W5 lifts this last precondition: its `session.compact` hook re-injects without
   `classic.*` (P4W5 §7.5). Otherwise → `restart-required` for an operator gesture (the renderer
   keeps today's `reloadSession`) and `unavailable` for a verb.
4. Skip the send when the ledger says this `sid` already holds the same `(key, rev, state)`.
5. `enqueue` `context.append { key, text: frameContext(doc), durable: true }`, wait
   up to `CONTEXT_APPEND_WAIT_MS` for the result. `ok` → record it, return `delivered`. Anything
   else → as step 3.
6. `state === 'revoked'` and `spawnCarried` → `restart-required`: a user-role row arguing with a
   system prompt that still carries the contract is not relied on (open question OQ2).

**Renderer.** `window.api.orchestratorArm`/`orchestratorDisarm` return `ArmResult`.
`toggleOrchestrator` (`sessions.ts:1841`) calls `reloadSession` only when
`contract === 'restart-required'`. No new component; one toast (§10).

**Verbs.** `orchestrator_arm` and `orchestrator_disarm` keep ADR-0013's target predicates
(`resolveArmTarget`, `tool-handlers.ts:2208`) untouched. Their ACKs gain
`enforcer` and `contract`. The `orchestrator_arm` description in `tool-catalog.ts:1248` drops
"it does not inject the orchestrator contract".

### 7.2 Mod

All in `resources/companion/hooks/`: the pure decision in `guard-core.ts` (zero imports, also
imported by the host's parity tests), wiring in `register.ts`.

**State keys.** This wave owns three keys of the registry in contract §22 and declares them in
the plugin's `types` contract (MOD-1): `guard`, `durableRows`
(`{ sid: Sid; rows: Partial<Record<ContextKey, string>> }`, the framed text per key) and
`reinject`. The `rev` of a row stays host-side, in the injector's ledger. `durableRows` and
`reinject` are **cleared when `sid` changes** on a rebound, so a compaction in the new
conversation cannot re-inject a row that belonged to the old one.

**`guard.set` handler.** Write `guard`; answer `command.result { ok: true, data: { armed } }`.

**Guard hook.** `on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, guardHook)`.

```ts
async function guardHook($, e, next) {
  try {
    await ensureHello($)
    if (!enabled('gate.guard')) return next(e) // includes a kill switch turned off
    if (e.agentId) return next(e) // rule 1: a subagent's call
    const g = (await $.state.get(GUARD)).value
    if (!g?.armed) return next(e) // rule 2
    if (now() - lastHostOkAt > GUARD_FLAG_TTL_MS) return next(e) // stale flag, §8
    const raw = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
    if (typeof raw !== 'string' || raw === '') return next(e) // legacy: cannot determine → allow
    const real = await place($, raw) // undefined = cannot be placed
    const exempt = real === undefined ? null : exemptSurface(real, await roots($))
    if (!g.enforce) { emit($, { t: 'guard.evaluated', d: … }); return next(e) }
    if (exempt) return next(e) // rule 3
    emit($, { t: 'guard.denied', d: { tool: e.tool, path: rel(raw), toolUseId: e.tool_use_id } })
    return { deny: GUARD_DENY_REASON } // rule 4
  } catch (err) {
    reportModError('gate.guard', err)
    return next(e) // rule 5: fail open
  }
}
```

`lastHostOkAt` is module memory, set by every successful host response; after a reload it is 0
until `ensureHello` completes, and the hello response carries the current `guard.set`.

**`place($, raw)`** — where the path lands, without folding anything itself:

1. `stat = await $.fs.stat(raw, { resolve: true })`; if it resolves, return `stat.realPath`
   (absent → `undefined`).
2. On `ENOENT`, cut the last segment textually and repeat on the parent, collecting the cut
   segments. At most `GUARD_WALK_MAX` levels.
3. If any collected segment is `""`, `"."` or `".."`, return `undefined`.
4. Return `<parent realPath>/<collected segments joined>`.
5. A rejection other than `ENOENT` is thrown (rule 5).

**`roots($)`**, resolved once and cached in module memory, from the baked exports of contract
§23:

| Surface (legacy `guard.mjs`)                                                                                 | Root in the mod                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<folder>/.harnu/`, or the legacy `.capy/` alias (`DATA_DIRS`, `guard.mjs:32`, `isHarnuDir`, `guard.mjs:54`) | each name of `EXEMPT_CWD_DIRS` (`['.harnu', '.capy']`; `.capy` is the legacy alias, kept because a stale session may still be editing under it) under `realPath(<session cwd>)`; cwd from `session.start`, never from env |
| `/tmp/claude-*` scratchpad (`isScratchpad`, `guard.mjs:41`)                                                  | a child named `claude-*` under one of `SCRATCH_PARENTS` (real paths baked at staging)                                                                                                                                     |
| `~/.claude/projects/<slug>/memory/` (`isMemorySurface`, `guard.mjs:46`)                                      | `CLAUDE_PROJECTS_ROOT` (real path baked at staging), second segment `memory`                                                                                                                                              |

The staged directory is shared by every folder, so a per-folder path cannot be baked: the
directory **name** is baked and resolved under the session's own cwd.

`exemptSurface(real, roots)` is pure: `real === root || real.startsWith(root + SEP)` per surface.
An unplaceable path is **not exempt**: when armed it is denied.

`GUARD_DENY_REASON` (stands alone, MOD-8): "This session is an Orchestrator and may not edit
files itself. Delegate this write to a subagent or an executor session, or write under .harnu/.
The contract is in docs/harnu-orchestrator.md."

**`context.append` handler.**

1. `$.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })`, fired
   un-awaited from the poll loop, result reported when it settles (MOD-6).
2. `{ deny }` or a rejection → `command.result { ok: false, code: 'CMD_FAILED' }`.
3. On success, `durable: true` stores the framed text under `durableRows.rows[key]` (with the
   bound `sid`); `durable: false` appends without storing and never deletes a stored row
   (`context.drop`, P4W5, is the only removal path). A revocation is sent `durable: true`: the
   revoked block replaces the stored active block under the same key, so a compaction
   re-injects the revocation, never the demoted contract. `retainOnly: true` (P4W5's addition,
   contract §9) stores without appending; this wave never sends it. `CONTEXT_MAX_CHARS` is the
   only size cap, durable rows included.

**Re-injection after compaction.** The `classic.SessionStart` registration is P1W3's; this wave
adds step 2 of its body (contract §11.4): on `source === 'compact'`, set `reinject = true`, then
`$.clock.after(REINJECT_DELAY_MS, reinject)`. `reinject()` appends every `durableRows.rows` entry
whose `sid` is the bound one and clears the flag. P4W5 removes that step and the `reinject` key
when it moves re-injection into the compaction result; `REINJECT_DELAY_MS` stays the one delay
constant (P4W5 reuses it). `ensureHello` also runs `reinject()` when the flag is set (a hot reload cancels
timers, smoke A5). The mod never appends inside a `session.compact` hook and does not register
one in this wave.

### 7.3 Contract additions

None — merged into `01-contract.md`:

| Item                                                                                                                                                                     | Where        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `guard.set { armed, enforce? }`, `context.append { key, text, durable, retainOnly? }`                                                                                    | §9           |
| `guard.evaluated`, `guard.denied`                                                                                                                                        | §8           |
| `ContextKey`                                                                                                                                                             | §4           |
| `GUARD_FLAG_TTL_MS`, `GUARD_WALK_MAX`, `CONTEXT_MAX_CHARS`, `CONTEXT_APPEND_WAIT_MS`, `REINJECT_DELAY_MS`, `DURABLE_MAX_ROWS` (4; a set beyond it is `CMD_PRECONDITION`) | §7.2         |
| State keys `guard`, `durableRows`, `reinject`                                                                                                                            | §22          |
| `EXEMPT_CWD_DIRS`, `SCRATCH_PARENTS`, `CLAUDE_PROJECTS_ROOT`                                                                                                             | §23          |
| The `classic.SessionStart` step and the `Edit\|Write\|NotebookEdit` registration                                                                                         | §11.4        |
| Proof of `gate.guard`; the `context` key; `guard.set { enforce: false }` as observe-only                                                                                 | §11.2, §11.5 |

`guard.evaluated` is emitted only with `enforce: false`. Host-side shapes (`ArmedEntry.enforcer`,
`ArmResult`, `setOrchestratorRole`, `deliver`, `frameContext`) are in master §12.1.

## 8. Arbitration & fallback

Family `guard` is **owned** when `gate.guard` is proven by a successful `guard.set` result
(contract §11.2), the lease is live and the mode is `active` (ARB-3). Enforcing also needs the
`channel` key `active` (contract §11.1); with `channel: shadow` the brake stays `guard.mjs`.

Live context has no fact family, so the `guard` family's `shadow` does not govern it (contract
§11.5). `act.context` has the feature key `context` (boolean, default on), registered by this
wave with `registerPrefsKey('context', …)`, and needs: the key on, the companion mode not `off`,
a live lease and `channel: active`. In the table, the Contract column of a row that names a
`guard` mode describes the row path's own preconditions, not that mode.

| Condition                                     | Brake                                                                                                                         | Contract                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mod absent, CLI < 2.1.287, mode `off`, policy | `guard.mjs` (entry `script`)                                                                                                  | spawn-time; promote restarts the session (today)                                                                        |
| Family `guard` in `shadow`                    | `guard.mjs`; mod evaluates with `enforce: false` and reports                                                                  | not governed by this mode: row if `act.context` is enabled, else restart                                                |
| `context` key off, or `channel` not `active`  | unaffected                                                                                                                    | spawn-time; restart                                                                                                     |
| Kill switch turned off mid-session            | `conn` revoked, re-hello answered `enable: []`: the hook returns `next(e)`; entry rewritten to `script` at once (no TTL wait) | rows already delivered stay; a new promote restarts                                                                     |
| CLI above the tested ceiling                  | `guard.mjs` (family forced to `shadow`)                                                                                       | restart (`context` capped to off, contract §11.5)                                                                       |
| `sec-default` (no `classic.*`)                | mod (`tool.call` passes); M\* in the master's legend (§8: companion only once proven)                                         | restart (`probes.classic` false) until P4W5 lifts the precondition; then M\*                                            |
| `guard.set` not answered by `expiresAt`       | stays `script`                                                                                                                | independent                                                                                                             |
| Lease lost mid-session                        | entry rewritten to `script` ≤ 20 s; the mod's flag expires after `GUARD_FLAG_TTL_MS`                                          | already delivered rows stay; new promote → restart                                                                      |
| Demote during the lease-loss window           | script stops at once; the mod may deny up to `GUARD_FLAG_TTL_MS` longer                                                       | restart                                                                                                                 |
| Host down or restarting                       | mod keeps denying while its flag is fresh; boot rewrites entries to `script`                                                  | restart                                                                                                                 |
| Hot reload                                    | flag read from `$.state`; hello returns the current `guard.set`                                                               | `reinject` flag replays a cancelled timer                                                                               |
| `/clear`, in-session `/resume`                | host sends `guard.set` for the new `sid`; legacy disarms a `manual` entry on `SessionEnd`                                     | rows are gone with the conversation; `durableRows` and `reinject` are cleared with the `sid`, so nothing is re-injected |
| Headless `-p`                                 | `guard.mjs` (§16: no commands)                                                                                                | spawn-time                                                                                                              |
| Agent-controlled or read-only spawn           | never armed (`shouldArmAtSpawn`, `orchestrator-guard.ts:488`)                                                                 | —                                                                                                                       |
| A sibling mod wedges the worker               | that one call is not denied by either enforcer (entry is `companion`); accepted, fail-open by design                          | —                                                                                                                       |
| `$.session.append` refused by a mod above     | —                                                                                                                             | `CMD_FAILED` → restart / `unavailable`                                                                                  |

Double enforcement (entry `script` while the mod is armed) is harmless: the mod's `tool.call`
deny returns before the `PreToolUse` command hook runs.

## 9. Security requirements

SEC-1, SEC-4, SEC-5, SEC-6, SEC-9a/d apply as written. Wave-specific:

- **S1.** `context.append` text comes only from `context-registry.ts`. No IPC, verb or wire
  field carries row text into the queue. (SEC-5; risk R1.)
- **S2.** `context.append` and `guard.set` are queued only from: the renderer's
  `orchestratorGuard:arm`/`disarm` IPC, a verb that passed ADR-0013's predicates and the
  blocked-folder gate, the spawn-default path, or the adapter's own triggers in §7.1.
- **S3.** One audit record per command: cause, target `sid`, command, `(key, rev, state)` or
  `armed`, text hash, ordinal, outcome (SEC-6).
- **S4.** The guard reads no path, root or flag from env, cwd files or a command argument; roots
  come from `coords.gen.ts` and the `session.start` payload (SEC-4).
- **S5.** No `tool.call` matcher other than the three file tools and P2W5's RegExp matcher
  `/^mcp__(harnu|capy)__/` (SEC-9d, MOD-3).
- **S6.** UI and docs call the guard a brake. A forged `guard.set { armed: false }` from a
  sibling mod disarms it (smoke D6); that is stated, not mitigated.

## 10. UX & copy

No new surface. Behaviour change: promoting or demoting a session when the Harnu mod is live no
longer restarts it. This is operator decision point **OD-6** (master §13): the default is
promotion and demotion in place, with a toast; the alternative keeps today's restart on every
promote and demote, in which case `deliver()` always answers `restart-required` for a gesture.

| Key (both locales)          | English                                                | When                              |
| --------------------------- | ------------------------------------------------------ | --------------------------------- |
| `orchestrator.promotedLive` | "Promoted to Orchestrator. The session keeps running." | `contract: delivered`, no restart |
| `orchestrator.demotedLive`  | "Demoted. The session can edit files again."           | demote by row                     |

Toasts are `info`. The `restart-required` path keeps today's behaviour, including the existing
`orchestrator.disclosure` on enable, and shows no new toast. `design.md` §6 "Session
orchestrator role (toggle Promote to orchestrator, T98)" is edited first: its "Mechanics"
paragraph says the restart happens only when the contract cannot be delivered to the running
session, and the brake keeps the word "blocks", never "prevents" or "guarantees".

## 11. Acceptance criteria

```
AC-P2W4-1 [unit] Given the registry, When frameContext builds the active orchestrator row,
  Then the text is one harnu-context block carrying key, rev and the verbatim document.
  Evidence: tests/companion/context-registry.test.ts › "frames the orchestrator contract"

AC-P2W4-2 [mod-test] Given a context.append command, When the mod executes it,
  Then $.session.append is called once with a type "user" text row and a command.result ok follows.
  The command runs once per cmd across re-delivery (conformance row 10).
  Evidence: resources/companion/tests/context.test.ts › "appends a hidden user row"

AC-P2W4-3 [integration] Given an idle session with a live lease, When the operator promotes it,
  Then the next model request contains the harnu-context block and the PTY pid is unchanged.
  Evidence: tests/cli/live-contract.cli.test.ts › "promote without restart"

AC-P2W4-4 [live-verify] Given a session mid tool loop, When context.append lands,
  Then the model's next request in that same turn carries the row (Q15).
  Evidence: LV-P2W4-a

AC-P2W4-5 [unit] Given a session spawned with the contract in argv, When it is demoted,
  Then deliver() returns restart-required and queues no row.
  Evidence: tests/companion/context-injector.test.ts › "revocation of a spawn-carried contract restarts"

AC-P2W4-6 [mod-test] Given durableRows holds one row, When classic.SessionStart {source: "compact"} fires,
  Then no append happens inside that hook and one append happens after REINJECT_DELAY_MS.
  Evidence: resources/companion/tests/context.test.ts › "re-injects after compaction, deferred"

AC-P2W4-7 [mod-test] Given reinject is true and the timer was cancelled by a reload,
  When the next hook runs ensureHello, Then the durable rows are appended once and the flag clears.
  Evidence: resources/companion/tests/context.test.ts › "replays a cancelled re-injection"

AC-P2W4-8 [mod-test] Given guard {armed: true, enforce: true}, When the main loop calls Edit on a
  path outside every exempt root, Then the hook returns {deny: GUARD_DENY_REASON} and queues guard.denied.
  Evidence: resources/companion/tests/guard.test.ts › "denies a main-loop edit"

AC-P2W4-9 [mod-test] Given the same state, When the call carries e.agentId, Then next(e) is returned.
  Evidence: resources/companion/tests/guard.test.ts › "exempts a subagent"

AC-P2W4-10 [mod-test] Given the armed flag, When the tool is NotebookEdit with notebook_path outside
  the roots, Then the call is denied (Q17).
  Evidence: resources/companion/tests/guard.test.ts › "covers NotebookEdit"

AC-P2W4-11 [mod-test] Given .harnu/link is a symbolic link to a directory outside .harnu,
  When Write targets .harnu/link/x, Then the call is denied (C1).
  Evidence: resources/companion/tests/guard.test.ts › "symlink out of .harnu is not exempt"

AC-P2W4-12 [mod-test] Given a target spelled .harnu/../src/x.ts, When Edit runs,
  Then the call is denied (C1).
  Evidence: resources/companion/tests/guard.test.ts › "dot-dot out of .harnu is not exempt"

AC-P2W4-13 [mod-test] Given a Write to .harnu/new/dir/file.md where new/ does not exist,
  Then the call is allowed.
  Evidence: resources/companion/tests/guard.test.ts › "places a file in a folder not there yet"

AC-P2W4-14 [mod-test] Given $.fs.stat rejects with a non-ENOENT error, Then next(e) is returned and
  a mod.error is queued (fail-open).
  Evidence: resources/companion/tests/guard.test.ts › "fails open on an internal error"

AC-P2W4-15 [mod-test] Given the armed flag and no host answer for longer than GUARD_FLAG_TTL_MS,
  Then next(e) is returned.
  Evidence: resources/companion/tests/guard.test.ts › "ignores a stale flag"

AC-P2W4-16 [live-verify] Given a live armed session, When the flag is flipped by guard.set with no
  restart, Then the next Edit follows the new flag and the flag is read from $.state (Q17).
  Evidence: LV-P2W4-b

AC-P2W4-17 [unit] Given an entry with enforcer "companion", When guard.mjs decide() runs,
  Then it allows.
  Evidence: tests/orchestrator-guard-script.test.ts › "an entry enforced by the companion is not armed for the script"

AC-P2W4-18 [unit] Given an owned armed session, When the lease is lost, Then its entry is rewritten
  to enforcer "script" within LEASE_TTL_MS.
  Evidence: tests/companion/guard-adapter.test.ts › "re-arms the script on lease loss"

AC-P2W4-19 [unit] Given entries with enforcer "companion" on disk, When the host boots,
  Then all are "script" before the socket listens.
  Evidence: tests/companion/guard-adapter.test.ts › "boot re-arms the script"

AC-P2W4-20 [unit] Given mode shadow, When hello arrives for an armed session,
  Then the response carries guard.set {armed: true, enforce: false} and the entry stays "script".
  Evidence: tests/companion/guard-adapter.test.ts › "shadow observes, never enforces"

AC-P2W4-21 [contract] Given the recorded corpus, When each row is replayed through guard.mjs decide()
  and the mod's decision core, Then every divergence is of class stricter-realpath.
  Evidence: tests/companion/guard-parity.test.ts › "matches guard.mjs on the corpus"

AC-P2W4-22 [unit] The companion source registers no tool.call hook whose matcher can match Bash.
  Evidence: tests/companion/api-surface.test.ts › "no Bash tool.call matcher"
  Guards: #92533

AC-P2W4-23 [unit] Given orchestrator_arm on an operator-owned session, Then TARGET_OPERATOR_OWNED is
  returned and no command is queued.
  Evidence: tests/mcp-orchestrator-arm-handler.test.ts › "target checks precede the companion path"

AC-P2W4-24 [integration] Given no companion (mode off), When the operator promotes a session,
  Then the session restarts and guard.mjs denies its next Edit.
  Evidence: tests/cli/live-contract.cli.test.ts › "legacy promote is unchanged"

AC-P2W4-25 [unit] Given session.rebound {cause: "clear"} for an armed session, Then guard.set
  {armed: false} is queued for the binding.
  Evidence: tests/companion/guard-adapter.test.ts › "clear resets the in-process flag"

AC-P2W4-27 [unit] Given a transcript whose first user row is a harnu-context row, Then
  classifyUserRow returns plugin-meta and the row is not the first prompt, not the title and not a
  turn in deriveTurnState.
  Evidence: tests/claude-reader-derive.test.ts › "a context row is never a prompt, a title or a turn"

AC-P2W4-28 [live-verify] With the Harnu mod off, promote a session by restart and record whether
  the resumed process's first request carries the contract in its system prompt (finding F2).
  Evidence: LV-P2W4-c

AC-P2W4-29 [unit] Given an owned armed session, When the kill switch is turned off, Then its entry
  is "script" before the call returns and the next hello is answered with no guard.set.
  Evidence: tests/companion/guard-adapter.test.ts › "kill switch hands the brake back at once"

AC-P2W4-30 [mod-test] Given durableRows holds a row for sid A, When the bound sid becomes B and
  classic.SessionStart {source: "compact"} fires, Then nothing is appended.
  Evidence: resources/companion/tests/context.test.ts › "a rebound clears the durable rows"

AC-P2W4-32 [unit] Given each cause of setOrchestratorRole (operator arm, operator disarm, verb,
  spawn-default) on an owned session, When the adapter enqueues guard.set and context.append,
  Then no enqueue is refused ORIGIN_DENIED.
  Evidence: tests/companion/guard-adapter.test.ts › "causes map onto the registered gate rows"

AC-P2W4-31 [mod-test] Given gate.guard is not enabled (hello answered enable: []), When the main
  loop calls Edit with a stored armed flag, Then next(e) is returned.
  Evidence: resources/companion/tests/guard.test.ts › "an inert mod does not deny"
```

**Human**

```
AC-P2W4-26 [human] Promote a busy session from the session menu: no restart, the toast reads
  "Promoted to Orchestrator. The session keeps running.", and its next edit is refused with the
  guard sentence.
  Evidence: screenshot LV-P2W4-a-toast.png
```

Cost cap for the model-turn L4 suites (QA-8): haiku, at most three model calls per run, behind
`HARNU_CLI_LIVE=1`, 0.05 USD per run; never in `npm test`.

**LV-P2W4-a (row mid-turn, promote without restart).**

1. Start a second isolated Harnu (`docs/dev/live-verify-second-instance.md`), companion mode
   `active` for one folder, the legacy bridge disabled for the run (QA-8).
2. Open a session there; note the PTY pid over CDP.
3. Ask for a task that runs several tool calls; while it runs, promote the session.
4. Confirm: same pid; the toast; `command.result ok` in the host audit.
5. Ask "may you edit files yourself?"; the answer cites the contract.
6. `/compact`; ask again; the answer still cites it (re-injection).

**LV-P2W4-b (live toggle).** Arm; Edit is refused; `orchestrator_disarm`; Edit succeeds; inspect
the debug file for `state.get` on the `guard` key before each decision.

**LV-P2W4-c (snapshot on resume, OQ1, finding F2).** Promote by restart with the companion off; check whether
the resumed process's first request carries the contract in its system prompt.

## 12. Docs deliverables

| Deliverable                       | Change                                                                                                                                                                                                                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                    | `Changed`: promoting or demoting a session no longer restarts it when the Harnu mod is live. `Fixed`: the brake follows symbolic links out of `.harnu/`.                                                                                                                                  |
| `docs/harnu-features.md` + marker | Rewrite "Arming the guard live": `orchestrator_arm` now also delivers the contract when the ACK says `contract: "delivered"`; new ACK fields `enforcer`, `contract`. Bump the marker.                                                                                                     |
| `docs/user/agent-control.md`      | The two verbs' new ACK fields (the user-docs gate fires on `tool-catalog.ts`).                                                                                                                                                                                                            |
| `docs/user/sessions.md`           | Promote/demote: when it restarts and when it does not. Says plainly: with a Claude Code newer than the version Harnu has tested, promotion restarts the session and the orchestrator contract is not re-injected after a compaction, until Harnu's tested version moves (contract §11.5). |
| `design.md` §6                    | "Session orchestrator role": conditional restart, the two toasts.                                                                                                                                                                                                                         |
| i18n                              | `orchestrator.promotedLive`, `orchestrator.demotedLive` in `en.json` and `pt-BR.json`.                                                                                                                                                                                                    |
| `01-contract.md`, `contract.ts`   | Already merged in the contract (§7.3); this wave lands `contract.ts` and the fixtures to match (DOC-7).                                                                                                                                                                                   |

## 13. Rollout & parity gate

- **Family:** `guard`. `off` → nothing. `shadow` → `guard.set { enforce: false }`,
  `guard.evaluated` rows in the ledger, `guard.mjs` authoritative. `active` → §7.1.
- **Corpus.** `tests/fixtures/companion-parity/guard/*.ndjson`: the ledger rows (path
  relativised, QA-9) plus a hand-written adversarial set (symlink, `..`, missing parents, blank
  path, each exempt surface, subagent).
- **Flip gate to `active`:** 200 evaluated calls from at least 10 armed sessions with zero
  unexplained divergences (the only explained class is `stricter-realpath`), AC-P2W4-21 green,
  LV-P2W4-a and -b attached. Default-`active` is an operator confirmation point (ARB-6d, master
  §13).
- **Live context** has no legacy rival to compare. Its switch is the `context` key (default on),
  and it acts only with `channel: active`; the in-place promotion it enables is OD-6 and ships
  once LV-P2W4-a passes. LV-P2W4-c decides whether the restart path stays the fallback or gets a
  warning.
- **Demoted, never deleted:** `guard.mjs`, `armed.json` arming and the `settings.local.json`
  registration, for owned sessions only.

## 14. Open questions

| #   | Question                                                                                                                                                                   | Default until settled                                   | Owner |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----- |
| OQ1 | Finding F2 (master §14): under the default prompt snapshot, does a `--resume` with a changed `--append-system-prompt` take effect (smoke C3 text)? Not fixed by this wave. | assume yes; AC-P2W4-28 records the answer               | P2W4  |
| OQ2 | Does a revocation row override a contract still present in the system prompt?                                                                                              | no: demote of a spawn-carried contract restarts         | P2W4  |
| OQ3 | A `type: "system"` notice mid-turn (Q15): not used by this wave. Should promotion leave one for the ctrl+o view?                                                           | no notice                                               | P2W4  |
| OQ4 | Master Q23 / contract CQ20: does `classic.SessionStart {source: "compact"}` fire for an auto-triggered compaction?                                                         | assumed; P4W5 verifies and replaces the deferred append | P4W5  |
| OQ5 | Contract CQ3: is `$.state` reset by `/clear`? The design sends `guard.set` on rebound either way.                                                                          | treat as surviving                                      | P1W3  |
| OQ6 | Hard links and case aliases keep their own spelling (types L4696): a hard link into `.harnu/` is exempt.                                                                   | accepted; documented as a brake                         | P2W4  |

## 15. Risks

| Risk                                                                                    | Sev    | Mitigation                                                                         |
| --------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| A row is injected into the wrong session (R1 class)                                     | High   | S1, S2, S3; text is registry-only; the binding is resolved host-side               |
| The mod keeps denying after a demote it never heard about                               | Medium | `GUARD_FLAG_TTL_MS`; `guard.set` in every hello                                    |
| Stricter `realPath` rule surprises an orchestrator that relied on a link under `.harnu` | Low    | CHANGELOG `Fixed`; the deny sentence names the way out                             |
| Contract seen twice (row, then system prompt after a respawn)                           | Low    | same text and `rev`; framing says the newest block wins                            |
| Compaction drops the row and re-injection misses (reload, pinned `classic.*`)           | Medium | `reinject` flag; row path refused without `probes.classic`; P4W5 result `messages` |
| A summarizer treats the re-injected block as an injection (R18)                         | Medium | the block is appended after compaction, never passed as a compaction instruction   |
