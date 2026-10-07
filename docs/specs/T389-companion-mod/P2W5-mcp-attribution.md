# T389 P2W5 — MCP caller attribution

## 1. Status

**Specified (not implemented)** · 2026-10-02 · Epic T389 · Wave P2W5 · No fact family ·
Feature `stamp.mcp`.
Master: [`00-master.md`](00-master.md) · Contract: [`01-contract.md`](01-contract.md) (§18
reserves the stamp field) · ADR: [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md)
(D8) · [ADR-0013](../../adr/0013-orchestrator-arm-addressing.md) (stays open).
Verified against CLI 2.1.287, `@modelcontextprotocol/sdk` 1.29.0 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository).

## 2. Depends on / Unblocks

- **Depends on (hard):** P1W3 (binding, `conn`, re-hello, `session.rebound`), P1W4 (the `stamp`
  key and the ledger), P1W5 (the `permissionMode` state key). Base branch: the P1 tip.
- **Slices that stack higher:** the `orchestrator_arm` / `orchestrator_disarm` slice stacks on
  P2W4 (which lands first; both edit "Arming the guard live", `tool-catalog.ts:1248` and
  `tests/mcp-orchestrator-arm-handler.test.ts`); the `message_session` sender slice stacks on P2W3.
- **Interfaces used** (master §12, the owner's signatures): P1W1
  `companionHost.verifyStamp(handle, nonce, tool, mac)` and `markProven(b, 'stamp.mcp')`; P1W4
  `registerPrefsKey('stamp', …)`, `prefsKey('stamp')`, `recordFact('stamp', …)`,
  `registerFeaturePolicy`; P1W3 `ensureHello($)`, `enabled(feature)`, `reportModError(where, err)`;
  P2W4 `setOrchestratorRole(…)` and its `ArmResult`.
- **Unblocks:** nothing. The core slice may run in parallel with P2W1.
- **Offers** (master §12.1): `resolveCaller(tool, meta)`, `HandlerCtx.caller`,
  `liftCallerStamp(body)`, consumed by P2W3 and P2W4. Profile `external` (P4W3) is not stamped.

## 3. Summary

Harnu's MCP transport carries no caller identity (ADR-0013 §1), so every verb that needs to know
"which session is this?" takes a self-declared `sessionId`, and `docs/harnu-features.md:767` says
so. The companion can do better without pretending to authenticate: a `tool.call` hook on
`mcp__harnu__*` (and the legacy alias `mcp__capy__*`, which the control server still accepts) adds a field the model never sees (smoke B5), carrying a proof derived from the
binding's `conn` and the subagent's `agentId`. The MCP server strips the field at the HTTP border,
resolves it to the binding's **current** session id, and hands every handler a
`CallerAttribution`. Handlers **prefer** the stamped id over the declared one, record
`attributed: 'stamped' | 'declared'`, and never grant anything because a stamp is present.

## 4. Evidence

| Smoke / source             | Verdict    | What this wave takes from it                                                                                                                       |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| B5                         | CONFIRMED  | A `tool.call` rewrite adds a key; it overwrites a model-supplied value; it is forwarded to a tool whose schema forbids extra keys.                 |
| B5                         | CONFIRMED  | The model reports only the arguments it typed; the transcript keeps the original input.                                                            |
| B5                         | CONFIRMED  | A subagent's call is stamped too; it shares the parent's `$.session.id()`; `e.agentId` tells them apart.                                           |
| B5                         | CONFIRMED  | Every `tools/call` already carries `_meta: {"claudecode/toolUseId": "toolu_…"}`, with no mod.                                                      |
| B4                         | CONFIRMED  | `tool.call` on MCP tools is safe with worktree-isolated agents; only a Bash matcher breaks them.                                                   |
| D6                         | REFUTED    | A same-tier sibling reads and rewrites the same call and `$.state`: the stamp is forgeable in-process.                                             |
| §9 "Not tested" (Q18, Q19) | open       | `auto` permission mode; whether a server that echoes its arguments leaks the stamp.                                                                |
| CLI troubleshooting doc    | documented | In auto mode a call whose input a hook changed is denied: "a hook changed this call's input after the model wrote it". Not smoke-tested (CQ10).    |
| types L11928               | API fact   | `tool`, `tool_use_id` and `agentId` are reserved in `tool.call`: a rewrite of any is refused. The stamp therefore uses its own key.                |
| types L5477                | API fact   | A matcher value may be a `RegExp`.                                                                                                                 |
| types L13829-13835         | API fact   | The hooks worker exposes `crypto.subtle.digest` only (no `sign`), plus `crypto.randomUUID`.                                                        |
| `mcp/server.ts:1326`       | code       | The tool callback is registered as `(rawArgs) => handleToolCall(def, rawArgs)`; the SDK's second argument (`extra`, with `_meta`) is unused today. |
| `pty.ts:736-766`           | code       | Read-only and agent-controlled spawns get no `--mcp-config`.                                                                                       |

## 5. Deviations from the study

| #   | Study said                         | This spec                                                                                       | Decision | Evidence       |
| --- | ---------------------------------- | ----------------------------------------------------------------------------------------------- | -------- | -------------- |
| 1   | Row 10: stamping "solves" ADR-0013 | Attribution only. Target-side checks stay; ADR-0013 stays open                                  | D8       | smoke D6       |
| 2   | Row 10: stamp the real session id  | Stamp a proof derived from `conn`; the server resolves it. A bare session id is never the stamp | D8       | security paper |

## 6. Scope / Non-goals

**In scope.** The stamp hook; proof format; border stripping; server-side resolution;
`CallerAttribution` in the handler context and the audit record; per-verb use; the `observe` →
`prefer` rollout; `auto`-mode handling.

**Non-goals.**

- No authentication. Nothing a verb refuses today becomes allowed (SEC-9g).
- No Harnu MCP for read-only or agent-controlled spawns, and no route around that
  (`$.mcp.call`, `$.tool.register`) in the companion (SEC-9b).
- No stamping in headless sessions (contract §16.1 enables sensors only) or external bindings.
- No change to the MCP bearer, port or config file.
- No caller-based refusal other than the self-message refusal of §7.4.

## 7. Design

### 7.1 Mod

`resources/companion/hooks/stamp-core.ts` (pure, zero imports) and wiring in `register.ts`.

```ts
on('tool.call', { tool: /^mcp__(harnu|capy)__/ }, stampHook)

async function stampHook($, e, next) {
  try {
    await ensureHello($)
    if (!enabled('stamp.mcp') || !conn) return next(e)
    const mode = (await $.state.get(PERMISSION_MODE)).value // P1W5's key; null = unseen
    if (mode === 'auto' || (await $.state.get(STAMP)).value?.suspended) return next(e)
    const nonce = e.tool_use_id ?? crypto.randomUUID()
    const proof = await makeProof(conn, nonce, e.tool)
    const r = await next({
      ...e,
      _harnuCaller: { proof, ...(e.agentId ? { agentId: e.agentId } : {}) }
    })
    if (r?.deny && INPUT_CHANGED_RE.test(r.deny)) await suspend($)
    return r
  } catch (err) {
    reportModError('stamp.mcp', err)
    return next(e)
  }
}
```

- `_harnuCaller` is spread **last**, so it overwrites a value the model typed (smoke B5).
- The mode is read from the `$.state` key `permissionMode` (contract §22, owned by P1W5): the
  `permission_mode` of the most recent `classic.*` payload (types L682). `null` (unseen, which is
  permanent under `sec-default`) is treated as "not auto": the mod stamps and suspends on the
  first refusal (contract §24). This differs on purpose from P2W3, where an unseen mode counts as
  `bypassPermissions` and the delivery is refused: a refused stamp costs one retried call, while
  a message delivered into the wrong mode cannot be undone.
- `suspend($)` writes `{ suspended: true }` to the declared `$.state` key `stamp` and queues
  `mod.error { where: 'stamp.mcp', kind: 'abort', message: 'input rewrite refused' }`. The
  engine's deny tells the model to issue the call again as recorded; the retry is then unstamped.
  Suspension lasts for the process.
- Failure of any step returns `next(e)` unchanged (MOD-2): an unstamped call is today's call.

**Proof.**

```
handle = hex(SHA256("harnu-stamp-handle\n" + conn))[0..12]
mac    = hex(SHA256("harnu-stamp-v1\n" + conn + "\n" + nonce + "\n" + tool))[0..32]
proof  = "v1." + handle + "." + nonce + "." + mac
```

`conn` never leaves the process in clear (SEC-8). The digest is `crypto.subtle.digest`; the input
has a fixed layout and the output is truncated, so length extension does not apply. `handle` lets
the server find the binding; `nonce` binds the proof to one call.

### 7.2 Host: border

New pure file `src/main/mcp/caller-stamp-core.ts`:

```ts
const STAMP_ARG = '_harnuCaller'
const STAMP_META = 'run.harnu/caller'

/** Mutates nothing; returns a body safe to hand to the SDK transport. */
function liftCallerStamp(body: unknown): unknown
```

For every JSON-RPC message in `body` (single or batch) with `method === 'tools/call'`:

1. Delete `params._meta[STAMP_META]` if a client sent one.
2. If `params.arguments[STAMP_ARG]` exists, delete it from the arguments. If it is an object with
   a string `proof` of at most 160 chars and an optional string `agentId` of at most 64, set
   `params._meta[STAMP_META]` to that object; otherwise drop it.

`handleHttp` (`mcp/server.ts:1394`) calls it between `readBody` and `transport.handleRequest`
(`:1408-1433`). The field therefore never reaches zod validation, `handleToolCall`, plan input,
the audit summary or an error message. `registerTools` (`:1314-1329`) passes the SDK's `extra`:

```ts
;(rawArgs, extra) => handleToolCall(def, rawArgs, resolveCaller(def.name, extra?._meta))
```

### 7.3 Host: resolution

New `src/main/companion/stamp-resolver.ts` (shell) over `stamp-core` (shared with the mod).

```ts
interface CallerAttribution {
  attributed: 'stamped' | 'declared'
  /** The binding's current sid when stamped; undefined when declared (handlers read their arg). */
  sessionId?: string
  sessionKey?: string
  agentId?: string
  toolUseId?: string // _meta["claudecode/toolUseId"]
  stamp:
    | 'verified'
    | 'absent'
    | 'malformed'
    | 'unknown-binding'
    | 'bad-mac'
    | 'replayed'
    | 'mismatch'
    | 'no-lease'
    | 'off'
}
```

`resolveCaller(tool, meta)`:

1. No stamp → `{ attributed: 'declared', stamp: 'absent' }`.
2. Parse `v1.<handle>.<nonce>.<mac>`; else `malformed`.
3. `companionHost.verifyStamp(handle, nonce, toolName, mac)` (`toolName` is the tool as called: `"mcp__harnu__" + verb`, or `"mcp__capy__" + verb` for the legacy alias) (master §12.1). `conn`
   and the nonce ring never leave P1W1's table. It answers `'unknown-binding'` (the host
   restarted and no re-hello yet, or a superseded `conn`), or the binding with a verdict. The
   table records the nonce only on `verified`, so a forged `mac` cannot burn a real call's nonce.
4. Verdict `bad-mac` (the table recomputed the `mac` and compared in constant time) → `bad-mac`.
5. Verdict `replayed` (the nonce is already in the binding's ring of `STAMP_NONCE_RING`) →
   `replayed`.
6. `meta["claudecode/toolUseId"]` present and different from the nonce → `mismatch`.
7. Lease not live → `no-lease`. Profile `external` or `headless`, or the `stamp` key `off` → `off`.
8. Otherwise `verified`: `attributed: 'stamped'`, `sessionId = binding.sid`, `sessionKey`,
   `agentId`. `markProven(b, 'stamp.mcp')` (contract §11.2).

Every non-`verified` outcome is `attributed: 'declared'`. Outcomes other than `absent` and
`verified` add one `recordFact('stamp', …)` row and one audit record with the outcome; none is an error to
the caller.

`HandlerCtx` gains `caller: CallerAttribution`. `AuditRecord` (`mcp/audit-log.ts:13`) gains
optional `caller?: { attributed; sessionId?; agentId?; stamp }`; the proof is never recorded.

### 7.4 Per-verb use

Rule for every row: when the `stamp` key is `prefer` and `caller.attributed === 'stamped'`, the
caller id is `caller.sessionId`; otherwise it is the declared argument, exactly as today. A
declared value that differs from a verified stamp is recorded (`declaredMismatch: true` in the
audit) and overridden, never refused. Target-side checks are not touched in any row.

| Verb (catalog line)                                           | The `sessionId` argument is… | With a verified stamp                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notify` (`:793`), `speak` (`:820`)                           | the speaker (optional)       | Speaker = stamped session; the argument may be omitted.                                                                                                                                 |
| `mission_create` (`:1274`), `mission_import_legacy` (`:1594`) | the owner                    | Owner = stamped session; the argument becomes optional. With neither, `BAD_SESSION_ID` as today.                                                                                        |
| `mission_request_close` (`:1575`)                             | the requester (optional)     | Requester = stamped session.                                                                                                                                                            |
| `mission_verify_step` (`:1538`)                               | the verifier                 | Verifier = stamped session, so the `verified` / `self-verified` label follows the real caller. A subagent shares its parent's session and is recorded with its `agentId`.               |
| `mission_get { ownerSessionId }` (`:1322`)                    | a lookup key                 | Unchanged. The caller is audited only.                                                                                                                                                  |
| `mission_link_child` (`:1420`)                                | a reference to a child       | Unchanged.                                                                                                                                                                              |
| `message_session` (`:1042`)                                   | the **recipient**            | Recipient predicates unchanged (`tool-handlers.ts:1860-1889`). Sender = stamped session: recorded in the audit, handed to P2W3 as `from`, and a self-message is refused `SELF_MESSAGE`. |
| `orchestrator_arm` / `orchestrator_disarm` (`:1248`, `:1263`) | the **target**               | The argument may be omitted and then means the stamped session. `resolveArmTarget` runs on the result unchanged: an operator-owned caller is still `TARGET_OPERATOR_OWNED`.             |
| `get_session` (`:491`)                                        | the target                   | Unchanged.                                                                                                                                                                              |
| every other verb                                              | —                            | Audit record only.                                                                                                                                                                      |

ACKs of the first four rows, `message_session` and the two orchestrator verbs gain
`caller: { attributed, sessionId? }`. Nothing else of the attribution is returned, and no ACK,
error or log ever contains `proof`, `handle` or `nonce`.

`tool-catalog.ts` changes: `sessionId` becomes optional for `mission_create`,
`mission_verify_step`, `orchestrator_arm` and `orchestrator_disarm`, and each description says
"omit it when Harnu can attribute the call; a value you pass is used only when it cannot". With
no stamp and no argument the handler refuses with the code it uses today (`BAD_SESSION_ID`,
`SESSION_NOT_FOUND`).

### 7.5 Contract additions

None — merged into `01-contract.md` §24 (the stamp field, the proof format, the nine outcomes,
the three levels, the rule for `auto` and for an unseen mode), §7.2 (`STAMP_NONCE_RING`,
`STAMP_ARG`, `STAMP_PROOF_VERSION`), §22 (the `stamp` state key), §11.2 (proof of `stamp.mcp`:
the first `verified` resolution) and §11.5 (the `stamp` key). No endpoint, event or command: the
stamp travels on the MCP transport, not on the companion socket. Host-side signatures
(`resolveCaller`, `HandlerCtx.caller`, `liftCallerStamp`, `companionHost.verifyStamp`) are in
master §12.1.

## 8. Arbitration & fallback

There is no legacy rival actuator: the fallback for every failure is today's behaviour, the
declared argument.

| Condition                                                 | Result                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mod absent, CLI < 2.1.287, mode `off`, policy blocks mods | `stamp: absent` → declared                                                                                                                        |
| `stamp` key `off`                                         | `stamp.mcp` not enabled; the mod does not rewrite                                                                                                 |
| `stamp` key `observe` (allowed in every family mode)      | the mod stamps, the server resolves and records, handlers use the declared argument                                                               |
| `sec-default`                                             | works (`tool.call` passes); the permission mode is unknown without `classic.*` → §7.1 detection                                                   |
| Lease lost mid-session                                    | `no-lease` → declared, sticky with the binding (ARB-4)                                                                                            |
| Kill switch turned off mid-session                        | `conn` revoked, re-hello answered `enable: []`: the mod stops stamping; a stamp made with the old `conn` is `unknown-binding` → declared, at once |
| CLI above the tested ceiling                              | the `stamp` key is capped at `observe`: recorded, handlers use the declared argument                                                              |
| Host restart                                              | `unknown-binding` until the re-hello; then a new `conn`, new handle                                                                               |
| Hot reload                                                | the mod stamps with the `conn` from `$.state`; after the re-hello the old one is `unknown-binding`                                                |
| `/clear`, in-session `/resume`                            | same `conn`; the stamp resolves to `binding.sid`, which follows `session.rebound`                                                                 |
| Stamp arrives before the rebound is processed             | attributed to the previous `sid`; audit carries the `toolUseId` for correction                                                                    |
| Headless `-p` (scheduler ticks)                           | not stamped → declared                                                                                                                            |
| Read-only or agent-controlled spawn                       | no Harnu MCP at all (`pty.ts:736-766`); unchanged                                                                                                 |
| `auto` permission mode                                    | not stamped (known mode), or one refused call then suspended (unknown mode)                                                                       |
| A sibling mod wedges the worker                           | that call is unstamped → declared                                                                                                                 |
| Another mod's `$.mcp.call`, or `curl` with the bearer     | unstamped, or `bad-mac` → declared                                                                                                                |
| Server off (`SERVER_DISABLED`) or blocked folder          | refused before attribution matters; unchanged                                                                                                     |

## 9. Security requirements

SEC-3, SEC-8 and SEC-9b/9g apply as written. Wave-specific:

- **S1. Attribution, not authentication.** A verified stamp says "this call passed through a
  `tool.call` hook in a process Harnu spawned and holds that binding's `conn`". It does not say
  the companion is unmodified, nor which mod produced it (smoke D6). No refusal is lifted and no
  gate (`planToolCall`, the blocked-folder check, `sessionOwnedByHarnu`, `isMessageableOwner`) reads
  `ctx.caller`.
- **S2. Only narrowing uses.** The stamp may replace a self-declared id, default an omitted one,
  and trigger the `SELF_MESSAGE` refusal. A handler branch of the form "stamped → allow what is
  otherwise refused" is forbidden; a static test asserts that `caller.attributed` is never read
  inside a refusal's negation in `tool-handlers.ts` (AC-P2W5-14).
- **S3. The stamp is never echoed.** It is removed at the HTTP border and replaced in `_meta`;
  `liftCallerStamp` also deletes a client-sent `_meta` key so the lifted value cannot be forged
  from outside the mod path. The resolved session id may be returned (it is the caller's own);
  proof material may not (Q19).
- **S4. The bearer does not help.** A caller holding only the MCP bearer cannot compute a proof;
  a replayed proof fails on the nonce ring and on the `toolUseId` comparison.
- **S5. No new reach.** The companion registers no tool, calls no MCP tool, and the stamp hook
  matches `mcp__harnu__` and the legacy alias `mcp__capy__` only (MOD-3).

## 10. UX & copy

No new component. One existing surface changes: the MCP pane's audit list (`McpServerPane.vue`) already prints a record's
summary; when `caller` is present it appends, in `text-text-4`:

| Key (both locales)               | English                     |
| -------------------------------- | --------------------------- |
| `mcpServer.audit.callerStamped`  | "from {session}"            |
| `mcpServer.audit.callerAgent`    | "from {session} (subagent)" |
| `mcpServer.audit.callerDeclared` | "says it is {session}"      |

"says it is" is the honest wording for a declared id (SEC-7). No badge, no colour. `design.md` §6
"Control server (MCP) pane" gains the line.

## 11. Acceptance criteria

```
AC-P2W5-1 [mod-test] Given stamp.mcp enabled and a conn, When the model calls mcp__harnu__notify,
  Then next receives the input with _harnuCaller.proof matching v1.<handle>.<nonce>.<mac>.
  Evidence: resources/companion/tests/stamp.test.ts › "stamps a harnu verb"

AC-P2W5-2 [mod-test] Given the model supplied its own _harnuCaller, Then the forwarded value is the mod's.
  Evidence: resources/companion/tests/stamp.test.ts › "overwrites a model-supplied stamp"

AC-P2W5-3 [mod-test] Given a subagent's call, Then _harnuCaller.agentId equals e.agentId and the
  reserved keys tool, tool_use_id and agentId are forwarded unchanged.
  Evidence: resources/companion/tests/stamp.test.ts › "carries the subagent id under its own key"

AC-P2W5-4 [mod-test] Given a tool that is neither mcp__harnu__* nor the legacy alias mcp__capy__*, Then the hook is not invoked; given mcp__capy__notify, Then it is stamped exactly like mcp__harnu__notify.
  Evidence: resources/companion/tests/stamp.test.ts › "matches harnu verbs only"

AC-P2W5-5 [mod-test] Given the permissionMode state key is "auto", Then next receives the original input.
  Evidence: resources/companion/tests/stamp.test.ts › "does not rewrite in auto mode"

AC-P2W5-6 [mod-test] Given next resolves to a deny naming a changed input, Then the stamp state
  becomes suspended and the following call is forwarded unstamped.
  Evidence: resources/companion/tests/stamp.test.ts › "suspends after a refused rewrite"

AC-P2W5-7 [live-verify] Given a session in auto permission mode, When it calls a harnu verb twice,
  Then at most the first call is refused and the second succeeds (Q18, CQ10).
  Evidence: LV-P2W5-b

AC-P2W5-8 [unit] Given a tools/call body with arguments._harnuCaller and a client-sent
  _meta["run.harnu/caller"], When liftCallerStamp runs, Then the arguments have no _harnuCaller and
  the meta value is the one from the arguments.
  Evidence: tests/mcp-caller-stamp-core.test.ts › "lifts the stamp and drops a forged meta"

AC-P2W5-9 [unit] Given a verified stamp for a binding whose sid was re-keyed by /clear,
  Then caller.sessionId is the new sid.
  Evidence: tests/companion/stamp-resolver.test.ts › "resolves to the current session id"

AC-P2W5-10 [unit] Given the same proof twice, Then the second resolution is replayed and attributed declared.
  Evidence: tests/companion/stamp-resolver.test.ts › "refuses a replayed nonce"

AC-P2W5-11 [unit] Given a proof computed with a different conn, Then the outcome is bad-mac and
  the handler receives the declared argument.
  Evidence: tests/companion/stamp-resolver.test.ts › "a forged proof falls back to declared"

AC-P2W5-12 [unit] Given a verified stamp for session A and a declared sessionId B, When
  mission_verify_step runs in prefer mode, Then the verifier recorded is A and the audit has declaredMismatch.
  Evidence: tests/mcp-mission-verify-attribution.test.ts › "the stamp overrides a declared verifier"

AC-P2W5-13 [unit] Given a verified stamp from an operator-owned session and no sessionId,
  When orchestrator_arm runs, Then it is refused TARGET_OPERATOR_OWNED.
  Evidence: tests/mcp-orchestrator-arm-handler.test.ts › "self-targeting keeps the target checks"
  Guards: ADR-0013

AC-P2W5-14 [unit] No gate predicate and no refusal branch in src/main/mcp reads ctx.caller to allow a call.
  Evidence: tests/mcp-caller-never-widens.test.ts › "attribution is not an authority input"

AC-P2W5-15 [integration] Given a real session with the companion, When the model calls an echoing
  test verb and is asked for the arguments it sent, Then neither the tool result nor the answer
  contains "_harnuCaller" or a proof (Q19).
  Evidence: tests/cli/stamp.cli.test.ts › "the stamp is invisible to the model"

AC-P2W5-16 [unit] Across every handler ACK and steerError text, the strings proof, handle and nonce
  of a stamp never appear.
  Evidence: tests/mcp-caller-stamp-core.test.ts › "no handler output carries proof material"

AC-P2W5-17 [unit] Given mode observe, Then handlers receive the declared argument and the ledger
  has one row with both ids.
  Evidence: tests/companion/stamp-resolver.test.ts › "observe records and does not act"

AC-P2W5-18 [integration] Given a session with no companion (mode off), When it calls notify with a
  declared sessionId, Then the ACK equals today's plus caller.attributed "declared".
  Evidence: tests/cli/stamp.cli.test.ts › "an unstamped call is unchanged"

AC-P2W5-19 [unit] Given an agent-controlled spawn, Then its argv has no --mcp-config and the staged
  companion's api-surface lists neither mcp.call nor tool.register.
  Evidence: tests/companion/api-surface.test.ts › "no route to the Harnu MCP"

AC-P2W5-20 [unit] Given a stamp whose binding lost its lease, Then the outcome is no-lease.
  Evidence: tests/companion/stamp-resolver.test.ts › "a dead lease attributes nothing"

AC-P2W5-21 [integration] Given an Agent(isolation: "worktree") subagent in a session with the stamp
  hook loaded, Then the subagent's Bash runs inside its worktree.
  Evidence: tests/cli/stamp.cli.test.ts › "worktree isolation survives the stamp hook"
  Guards: #92533

AC-P2W5-22 [live-verify] Before this wave changes the sender, send one message_session on the
  legacy socket and record the envelope's from-session value against the sender's and the
  recipient's session keys (finding F4).
  Evidence: LV-P2W5-c

AC-P2W5-23 [unit] Given the kill switch is turned off, Then the binding's conn is revoked, a stamp
  made with it resolves unknown-binding and the handler receives the declared argument.
  Evidence: tests/companion/stamp-resolver.test.ts › "kill switch ends attribution at once"

AC-P2W5-24 [unit] Given a CLI above the tested ceiling and the stamp key at prefer, Then handlers
  receive the declared argument (the key is capped at observe).
  Evidence: tests/companion/stamp-resolver.test.ts › "above the ceiling the stamp only observes"

AC-P2W5-25 [live-verify] Given a real session over the Harnu MCP transport with the stamp key at
  prefer, When the model calls mission_create with a made-up sessionId, Then mission_get names the
  session's real id as the owner (the stamp crossed the SDK's _meta, CQ16).
  Evidence: LV-P2W5-a (settles CQ16 and OQ4)
```

Cost cap for the model-turn L4 suites (QA-8): haiku, at most three model calls per run, behind
`HARNU_CLI_LIVE=1`, 0.05 USD per run; never in `npm test`.

**LV-P2W5-a (attribution end to end).**

1. Second isolated Harnu, the `stamp` key at `prefer`, one folder.
2. In a session, ask the model to call `mission_create` with a made-up `sessionId`.
3. `mission_get`: the owner is the session's real id; the audit row shows `declaredMismatch`.
4. Ask the model which arguments it sent: no stamp is mentioned.

**LV-P2W5-b (auto mode).** Start the session with `--permission-mode auto`. Call `get_fleet`
twice. Record the first call's result text and the second's; inspect the debug file for the
refusal line and the host audit for `mod.error stamp.mcp`.

**LV-P2W5-c (legacy envelope, finding F4).** With the Harnu mod off, have session A call
`message_session` for session B. In B's transcript, read the peer envelope's `from-session`
attribute and record whether it names A or B (`messaging.ts:195` passes the recipient's key).

## 12. Docs deliverables

| Deliverable                       | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                    | `Changed`: Harnu can attribute an agent's verb call to the session that made it; a wrong self-declared session id is overridden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `docs/harnu-features.md` + marker | (1) Replace "Every session id you pass is self-declared and unauthenticated" (line 757) with: Harnu attributes your calls when it can; read `caller.attributed` in the ACK; `sessionId` may be omitted on the listed verbs when it says `stamped`; a declared id is still required otherwise. (2) "Arming the guard live": "there is no bare arm-me call" becomes "omit `sessionId` to mean yourself when attributed", and says the call can come back with `contract: "unavailable"` (the brake is armed, the contract was not delivered to the running session; P2W4 §7.1). (3) `message_session`: a self-message is refused `SELF_MESSAGE` when Harnu can tell. (4) State that attribution is not authority. Bump the marker. |
| `docs/user/agent-control.md`      | A short "Who made this call" section: attributed versus declared, in plain words, and the audit wording.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `design.md` §6                    | Control server pane: the caller fragment of an audit row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| i18n                              | the three `mcpServer.audit.*` keys in both locales.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ADR-0013                          | An addendum line: option (c) is now available as attribution; the decision stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `01-contract.md`, `contract.ts`   | Already merged (§24); this wave lands `contract.ts` to match (DOC-7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 13. Rollout & parity gate

- **Family:** none, so no family's `shadow` governs it (contract §11.5). One key, registered
  with `registerPrefsKey('stamp', { default: 'off', observeCap: 'observe', … })`:
  `'off' | 'observe' | 'prefer'`, invalid reads as `off`. `stamp.mcp` is enabled when the key is
  not `off`, the companion mode is not `off` and the lease is live. `observe` is allowed in every
  family mode; above the tested ceiling the key is capped at `observe`.
- **Ships as `off`**; flips to `observe` once LV-P2W5-b and AC-P2W5-21 pass on the tested CLI.
- **Comparison (`observe`).** One `recordFact('stamp', …)` row per stamped call:
  `{ verb, stampedSid, declaredSid?, stamp, toolUseId }`, ids hashed in committed fixtures.
- **Gate to `prefer`:** 300 stamped calls from at least 20 sessions with zero unexplained
  `bad-mac`, `mismatch` or `replayed`; zero tool calls refused because of the rewrite outside
  auto mode; every `declaredSid ≠ stampedSid` row classified (a model's mistake, or a legitimate
  "on behalf of" use that must then keep a declared path).
- **Demotes nothing.** Declared arguments stay accepted for good.

## 14. Open questions

| #   | Question                                                                                                                                                                                               | Default until settled                                                                                                         | Owner |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----- |
| OQ1 | In auto mode, is the rewrite refused on every call, and does the retry "as recorded" succeed once the hook stops rewriting? (CQ10)                                                                     | suspend on first refusal; `stamp.mcp` unproven there                                                                          | P2W5  |
| OQ2 | Does any legitimate flow create a mission or verify a step on behalf of another session?                                                                                                               | no: the stamp overrides; the gate reviews the rows                                                                            | P2W5  |
| OQ3 | Should headless sessions stamp? It needs no long-poll, and scheduler ticks are unattended callers.                                                                                                     | no in protocol 1: headless sessions, scheduler ticks included, stay `declared` (contract §16.1, §24); the question stays open | P2W5  |
| OQ4 | Does the SDK version in use pass `params._meta` through to `extra._meta` for keys it does not know?                                                                                                    | assumed (typed `RequestMeta`); AC-P2W5-25 proves it on the real transport (contract CQ16)                                     | P2W5  |
| OQ5 | Can a second `next()` with the original input recover a refused rewrite inside the same hook?                                                                                                          | not relied on                                                                                                                 | P2W5  |
| OQ6 | Finding F4 (master §14): `messaging.ts:195` passes the recipient's key as `fromSession`, so the legacy envelope's `from-session` names the recipient. Not fixed by this wave outside the sender slice. | AC-P2W5-22 records it; the attributed sender replaces the value on the companion transport only                               | P2W5  |

## 15. Risks

| Risk                                                                       | Sev    | Mitigation                                                           |
| -------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| The stamp is read as caller identity and a check is relaxed on it (R6)     | High   | S1, S2, AC-P2W5-13, AC-P2W5-14; docs say "attributed"                |
| The rewrite breaks every harnu verb in auto mode                           | High   | mode check, suspension, `observe` gate, LV-P2W5-b before any default |
| A sibling mod forges or strips the stamp                                   | Medium | conceded (D6); a stripped stamp is today's behaviour                 |
| The override surprises a model that passed another session's id on purpose | Medium | ACK carries `caller`; OQ2; ledger classification before `prefer`     |
| Proof material leaks through an echo or a log                              | Medium | border strip, AC-P2W5-15, AC-P2W5-16                                 |
| SDK upgrade changes how `_meta` reaches handlers                           | Low    | one integration test on the real transport                           |
