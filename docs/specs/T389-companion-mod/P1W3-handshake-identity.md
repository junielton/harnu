# T389 P1W3 — Handshake and identity

## 1. Status

**Specified (not implemented)** · 2026-10-02 · Epic T389 · Wave P1W3
**Reads:** [`00-master.md`](00-master.md) · [`01-contract.md`](01-contract.md) ·
[ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) ·
[`P1W1-host-server.md`](P1W1-host-server.md) ·
[`P1W2-mod-skeleton-and-harness.md`](P1W2-mod-skeleton-and-harness.md) ·
`docs/studies/T389-smoke-evidence.md` · `docs/lessons/synthetic-sessions/001`–`003`
**Verified against:** repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository); Claude Code CLI 2.1.287.

## 2. Depends on / Unblocks

- **Depends on:** P1W1 (server, `SessionTable`, bus, `companionHost`), P1W2 (skeleton, staging,
  spawn token in the env, `cliGate`, the L3/L4 harness).
- **Unblocks:** P1W4, P1W5, P1W6, P2W1, P2W5, P4W3.
- **Interfaces this wave gives later waves:**
  - `companionHost.bindingForSession(key)` / `bindingForSid(sid)` now return real bindings; this
    wave adds `companionHost.sessionKeyForSid(sid)` (master §12.1, "Identity").
  - The mod runtime helpers of master §12.2, defined in §7.2–§7.3: `ensureHello($)`,
    `emit($, event)`, `enabled(feature)`, `boundSid()`, `reportModError(where, err, cmd?)`.
  - `IdentityParityRecord` and the `via` labels (§7.7, §13), which P1W4's `identity` parity rule reads.
  - A `pty:rekey` of a bound PTY fires `onBindingChange` (§7.6), so later waves subscribe.
- **Conforms to:** P1W1's `setEnablePolicy`, `markProven`, `BindingView`, `bus`; P1W2's
  `cliGate(v, ceiling): CliGate`; P1W4's `familyMode('identity', folder)` (P1W1's global seam
  until P1W4 lands), its `recordFact('identity', …)` ledger entry point and its sticky rule (ARB-4c).

## 3. Summary

The mod learns to say hello: lazily, idempotently, at the head of every hook, bounded so a slow
host cannot hold the first prompt. The host redeems the spawn token, binds the `claude` process to
its PTY, and from then on knows the session's real id without guessing. The identity adapter turns
that fact into a **claim** the renderer honours when the transcript appears on disk: the exact
synthetic row becomes the real session through the existing migration code, instead of the
oldest-correlation and time-window heuristics. `/clear`, in-session `/resume`, wake after
hibernation, hot reload, a listener restart and process death are each given one defined path.
The family `identity` ships in `shadow` (compare only).

## 4. Evidence

| Smoke id | Verdict   | What this wave takes from it                                                                                                                                                                                                                                                                               |
| -------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2       | CONFIRMED | Hello reaches the host 657–827 ms after spawn; `session.start` is awaited before the first prompt (a 4 s hold delayed it to 4.8 s); the id equals the transcript file name; `--resume <id>` keeps the id and fires `session.start`; exit reasons arrive (`prompt_input_exit`, `other` for SIGTERM/SIGHUP). |
| A2       | CONFIRMED | `/clear`: `session.end {reason: clear}` then `classic.SessionStart {source: clear, session_id: NEW}` 8 ms later, **no `session.start`**, module state survives, `$.session.id()` already returns the new id.                                                                                               |
| A2       | CONFIRMED | In-session `/resume <other>`: `classic.SessionStart {source: resume, session_id: OTHER}` while `$.session.id()` **still returns the old id inside that hook** (C10).                                                                                                                                       |
| A5       | CONFIRMED | Hot reload wipes module variables and re-fires `session.start`; a counter survived turns, subagents and `/clear`; a throwing hook is skipped and shown once.                                                                                                                                               |
| C2       | CONFIRMED | The un-awaited loop survives turns and `/clear`; on reload the old request closes and a new `session.start` runs 0.8–10 s later; `$.clock.every` did not delay `-p` exit; `session.end` read a 5 000 ms budget (types say 1.5 s, C13).                                                                     |
| A4       | CONFIRMED | `$` calls in flight die with a denied or aborted turn: events stay in the ring until acknowledged.                                                                                                                                                                                                         |
| D6       | REFUTED   | A sibling mod reads and forges `$.env.get`, `$.http.fetch` (request and response) and reads `$.state`. Identity is correlated, not authenticated (C4).                                                                                                                                                     |
| B6       | CONFIRMED | A wedge unloads only its culprit but skips the chain for that call; silence is the only signal. A hook body that throws is skipped: every body here is wrapped (MOD-2).                                                                                                                                    |

Types (CLI 2.1.287): `$.session.id()` L2575; `$.session.version()` L2642;
`$.fs.read` L3017; `$.state.get` / `set` L3175 / L3191 ("survives a hot reload", L3152–3153;
"reads any value; its owner alone writes it", L3157); `$.env.get` L3373; `$.clock.every` L3239;
`$.http.fetch` L3265; `session.start` input `{cwd, surface, isInteractive}` L10951–10965;
`session.end` bound "1.5 s by default" L10329; "`clear` … the process goes on under a new session
id, and no `session.start` fires" L10338; `classic.*` payload base `{session_id, transcript_path,
cwd}` L674; `crypto.subtle` exists L19.

Harnu code read for this wave (all under the repo root):

- `src/renderer/src/stores/sessions.ts`: `fireMigrate` `:1726-1763`; `reportMaterialized` `:3106-3112`;
  `tryBindAgentMigration` `:3219-3269` (oldest armed correlation of the folder, `:3220-3228`);
  `reloadModelOnce` snapshot rule `:4552-4563`; `backfillMigratedSessionMeta` `:4868-4890`;
  `collapseSyntheticInto` `:4917-4967` (newest synthetic of the folder, `:4935-4942`);
  `reconcileSessionAdded` `:5021-5045`; `collapseResolvedSynthetics` `:5072-5115` (5-minute
  window, `:5051-5052`); the watcher subscription `:5248`.
- `src/renderer/src/components/TerminalPane.vue:1166` (the migrate handler is the one caller of
  `ptyRekey`); `:597` (`sessionKey: sessionId` at `ptyCreate`).
- `src/main/pty.ts`: `applyRekeyToRecord` `:364-370` (promotes `claude-new`/`claude-fork` to
  `claude-resume`); `pty:rekey` `:1003-1033`; `hibernateSession` `:570-595`.
- `src/main/fleet-policy.ts:72` (`isParkable(kind) === 'claude-resume'`).
- `src/main/hook-bridge.ts:491-494` (`hooks:stateFor`), `src/main/hook-state.ts:62` (`SessionEnd`
  with matcher `clear` folds to `idle`).

## 5. Deviations from the study

| Deviation                                                                                                                                                                                                                                                         | Decision | Evidence                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| The study sends the handshake once, from `session.start`. Here hello is lazy and idempotent, because `session.start` re-fires on reload and never fires after `/clear` or `/resume`.                                                                              | D3       | smoke A2, A5, C2                                                |
| The study re-keys from `$.session.id()`. Here the `classic.SessionStart` payload is the source of truth, and `$.session.id()` is used only when `classic.*` is not dispatched.                                                                                    | D3, C10  | smoke A2                                                        |
| The study treats the handshake as proof of who is calling. It is correlation.                                                                                                                                                                                     | D2, C4   | smoke D6                                                        |
| The study (and the master's example AC) re-key the row "when hello arrives". Here hello creates a **claim**; the row is re-keyed when the transcript exists on disk. Re-keying earlier produces a ghost row and a parkable session with nothing to resume (§7.1). | D4       | `sessions.ts:4557-4563`, `pty.ts:355-370`, `fleet-policy.ts:72` |

## 6. Scope / Non-goals

**In scope.** Mod: `hooks/register.ts`, `hooks/lib/{ring,rendezvous-parse}.ts`, tests and
fixtures. Host: `src/main/companion/{identity-core,identity-adapter,identity-parity-core,enable-policy}.ts`,
one field in the spawn ledger, `companion:identity*` IPC. Renderer:
`src/renderer/src/lib/identity-claims.ts` (pure) and the edits to `stores/sessions.ts` listed in
§7.6. Events `session.snapshot`, `session.rebound`, `session.end`, `mod.error`. Feature
`sense.identity`.

**Non-goals.**

- No `poll`, no `ask`, no command (P2W1, P3W1). `HelloResponse.commands` stays unset.
- No task-state, usage or attention event (P1W5, P1W6); `session.snapshot` carries neutral values for them.
- No per-folder ramp, no persisted ledger, no UI (P1W4).
- No external binding class: a process with no spawn token goes dormant (P4W3 changes that).
- `hello.proof` is **not** implemented (decided in §7.9).
- No deletion or rewrite of the three legacy binders; they are narrowed in `active` mode only.

## 7. Design

### 7.1 Why the row is not re-keyed at hello

Hello lands before the first prompt (smoke A2), and the CLI writes the transcript only once the
conversation has content. Between the two, a row re-keyed to the real id would be:

1. **Dropped by the next reload.** `reloadModelOnce` re-injects only rows with `synthetic === true`
   or shell terminals; a migrated row with a blank `fullPath` is "left entirely to the ordinary
   per-folder reconcile … if not, it is correctly dropped" (`sessions.ts:4557-4563`, the BUG-88
   fix). Three watcher events fire a reload within about 150 ms of a new session (lesson 003).
2. **Parkable with nothing to resume.** `pty:rekey` runs `applyRekeyToRecord`, which promotes the
   PTY to `claude-resume` on the stated ground that "the rekey event IS the proof the transcript
   now exists on disk" (`pty.ts:355-359`). The hibernation policy parks `claude-resume` only
   (`fleet-policy.ts:72`); waking would run `claude --resume` on a transcript that is not there.

So identity is delivered in two steps. **Hello → claim** (main knows `sid` for that PTY at once;
later waves key their events by it). **Transcript on disk → migration** (the existing
`session:added` event, now resolved by the claim instead of by a guess).

### 7.2 Mod: state and `ensureHello`

Module variables (wiped on reload) and their durable twins in `$.state`. The five keys are
declared in `types/index.d.ts` by this wave's change; their shapes are contract §22:

| Module variable                                                            | `$.state` key | Notes                                                                     |
| -------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| `conn`                                                                     | `conn`        | never in `$.store`, a file, a log or a payload (SEC-8)                    |
| `bootId`, `proto`, `enabled`                                               | `bootId`      | `enabled` and `config` are re-fetched by the resume hello                 |
| `sidBound`                                                                 | `sid`         | the id the host has; **not** re-read from `$.session.id()` after a reload |
| `boot` = `{ cwd, surface, isInteractive }`                                 | `boot`        | captured in `session.start`; a resume hello needs it                      |
| `probes`                                                                   | `probes`      | `classic` flips on the first `classic.*` dispatch                         |
| `seq`, `ring`, `dormant`, `inert`, `helloFlight`, `nextTryAt`, `backoffMs` | —             | rebuilt; a new `conn` restarts `seq` at 1                                 |

All functions that take `$` are declared at the top of `register.ts` (MOD-1).

```
ensureHello($):
  if dormant or inert: return
  if conn (memory):
    maybeDriftCheck($)                        # §7.4, only while probes.classic is false
    return
  if helloFlight: return await raceWithTimer(helloFlight, HELLO_WAIT_MS)
  if now < nextTryAt: return
  helloFlight = doHello($)                    # single flight
  return await raceWithTimer(helloFlight, HELLO_WAIT_MS)

doHello($):
  saved = await $.state.get(conn)             # survives a hot reload
  if saved.value: body.resume = { conn: saved.value }; sid = (await $.state.get(sid)).value
  else:
    token = await $.env.get("HARNU_SPAWN_TOKEN")
    if !token: dormant = true; return         # not spawned by Harnu (external profile: P4W3)
    body.spawn = token; sid = await $.session.id()
  body.cli = { version: (await $.session.version()).version }
  ep = parseEndpoint(await $.fs.read(RENDEZVOUS_PATH))     # re-read on every attempt (contract §2.5)
  if !ep or no protocol overlap: scheduleRetry(); return
  res = await $.http.fetch(url(ep, 'hello'), { method: 'POST', socketPath | none, headers, body })
  on transport failure or non-200 or unparseable: scheduleRetry(); return
  on Failure PROTO_UNSUPPORTED | UNAUTHORIZED | UNKNOWN_SESSION | FEATURE_DISABLED: dormant = true; return
  on Failure HOST_SHUTTING_DOWN | SLOW_DOWN: scheduleRetry(retryAfterMs); return
  on ok: conn, bootId, proto, enabledSet, config ← res; sidBound ← sid; seq ← 0
         await $.state.set(conn, …), set(bootId, …), set(sid, …)
         if res.enable is empty: inert = true; stopHeartbeat(); clear the ring; return
         emit($, session.snapshot { reason: 'hello', … })          # first use of conn spends the token
         startHeartbeatOnce($)
  finally: helloFlight = null
```

- **Bounded wait.** `raceWithTimer` resolves after `HELLO_WAIT_MS` (2 500) even if the fetch has
  not answered; the hook then returns `next(e)`. The fetch keeps running un-awaited and adopts the
  `conn` when it lands. A hung host therefore costs the first prompt at most 2.5 s, not the
  engine's 30 s abort (R9).
- **Retry.** `scheduleRetry` sets `nextTryAt = now + backoffMs` and doubles `backoffMs` from
  `BACKOFF_MIN_MS` to `BACKOFF_MAX_MS`. Retries are driven by the next `ensureHello` call and by
  the heartbeat timer; there is no loop and no sleep (MOD-2).
- **Dormant** is for the life of the process: every hook returns `next(e)`, no request is sent.
  `FEATURE_DISABLED` on `hello` is dormant too (contract §5.1, §13).
- **Inert** (an `ok` hello with `enable: []`): the mod behaves as if no feature exists — no sensor
  event, no heartbeat, no further request — and keeps `conn`. This is how the kill switch reaches
  a running session: its `conn` is revoked, the next request answers `STALE_CONN`, the mod sends a
  `resume` hello (a revoked `conn` is accepted there) and is answered `enable: []` (contract §3
  item 9; conformance row 25). Turning the switch back on applies to new sessions only.
- **`raceWithTimer(p, ms)`** is `Promise.race` of `p` and a `$.clock.after(ms)` wait.
- **`declared`.** Each `on()` is called inside a `try`; `sense.identity` is declared only when
  `session.start`, `session.end` and `classic.SessionStart` all registered. A failed registration
  is reported as `mod.error {kind: 'registration'}` after the hello.

Hooks registered in this wave:

| Hook                   | Body (after `ensureHello`, everything wrapped, always `return next(e)`)                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.start`        | store `boot` (memory and `$.state`); **await** `ensureHello`.                                                                                                                     |
| `classic.SessionStart` | set `probes.classic`; `source` `clear` or `resume` with `session_id ≠ sidBound` → rebound (§7.4); `compact`, `startup` → nothing for identity. `ensureHello` is not awaited here. |
| `session.end`          | `reason` `clear` or `resume` → nothing (the classic hook follows). Otherwise `emit` `session.end {reason}` and send `bye` (§7.5).                                                 |

### 7.3 Mod: runtime helpers, ring, pump, heartbeat

The helpers every later wave calls, with the signatures of master §12.2. All are declared at the
top of `register.ts`:

```ts
function ensureHello($): Promise<void>
/** Queues into the ring and starts the pump; edge events flush at once. Never awaited on a turn's path. A no-op when dormant, inert or the event's feature is not enabled. */
function emit($, event: { t: EventName; d: unknown; turnId?: string; agentId?: string }): void
function enabled(feature: FeatureId): boolean // false when dormant or inert
function boundSid(): Sid // `sidBound`: the bound sid of contract §15, what the envelope carries
/** Wraps a caught error as `mod.error` (message capped at 512 chars, `where` a wire-level name) and emits it. */
function reportModError(where: string, err: unknown, cmd?: CmdId): void
```

`emit` assigns `seq` and `ts`, calls `ring.push` and then `pump($)`. Wherever this spec says an
event is "queued", it goes through `emit`.

`hooks/lib/ring.ts` (pure, `$`-free): `push(ev)`, `batch(maxEvents, maxBytes)`, `ack(seq)`,
`overflow()` implementing contract §6 (coalescable first, then oldest; count in `dropped`).

`pump($)` is single-flight and never awaited by a hook: while the ring has unacknowledged events,
POST `events` with `{ v, sid: sidBound, conn, sentAt, events, dropped? }`; on `ok` → `ring.ack(ackSeq)`,
and `resync: true` → `emit` `session.snapshot {reason: 'resync'}`; on `STALE_CONN` → drop `conn`
from memory, `doHello` with `resume`, then re-number and re-send what is still in the ring; on a
transport failure → `scheduleRetry`, keep the ring; on `BAD_ENVELOPE` → drop that batch and call
`reportModError`; on `TOO_LARGE` → halve the batch. A changed `bootId` in the rendezvous file read
after a failure is handled the same as `STALE_CONN`.

Every event of this wave is an edge event (flushed at once). The heartbeat is
`$.clock.every(HEARTBEAT_MS, …)`, started once per load: if nothing was sent in the last
`HEARTBEAT_MS` it sends an empty `events` batch, which renews the lease (contract §11.3) for both
profiles until P2W1 adds the poll. The same tick retries a pending hello and runs the drift check.

`session.snapshot` in this wave: `activeTurnId: null`, `openAttention: []`,
`runningSubagents: 0`, `probes: { classic, toolCheck: false }`. It is re-sent with
`reason: 'probe'` when `probes.classic` flips.

### 7.4 Re-key rules (contract §15) on both sides

| Case                                  | Mod                                                                                                                                                                                                          | Host (`identity-adapter.ts`)                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Process start, `--resume`, fork, wake | hello with `spawn`                                                                                                                                                                                           | bind; classify (§7.6)                                                                    |
| Hot reload                            | no `conn` in memory → `$.state` → hello with `resume`; `sidBound` from `$.state`                                                                                                                             | rotate `conn`, keep binding, lease clock and claim                                       |
| `/clear`                              | in `classic.SessionStart {source: clear}`: `prev = sidBound; sidBound = e.session_id`; `emit` `session.rebound {prevSid: prev, sid, cause: 'clear'}`; write `conn`, `bootId`, `sid` to `$.state` again (CQ3) | `table.rebind(b, sid)`; new claim `{key, sid, cause: 'clear'}`                           |
| In-session `/resume <other>`          | same, `cause: 'resume'`, id **from the payload only**                                                                                                                                                        | rebind; if `sid` is live under another key → `conflict`                                  |
| `classic.*` never dispatched (pinned) | drift check: at most once per second in `ensureHello` and on each heartbeat, **only while `probes.classic` is false**: `cur = await $.session.id()`; `cur ≠ sidBound` → rebound with `cause: 'unknown'`      | same as above                                                                            |
| Compaction                            | nothing                                                                                                                                                                                                      | —                                                                                        |
| Listener restart                      | transport failure → re-read rendezvous → new `bootId` → hello with `resume`                                                                                                                                  | table survived in memory (P1W1 §7.5): accept                                             |
| Harnu main restart                    | cannot happen for a live Harnu-spawned process (its PTY died with main)                                                                                                                                      | `UNKNOWN_SESSION` → dormant                                                              |
| `rebound.prevSid ≠ binding.sid`       | —                                                                                                                                                                                                            | `sid === binding.sid` → duplicate, ignore; else accept the new `sid`, count `reboundGap` |

The drift check is disabled once `classic.*` has been seen because `$.session.id()` can be stale
after an in-session `/resume` (C10): trusting it there would re-key the binding back to the old id.

### 7.5 `bye` and process death

`session.end` with a reason other than `clear`/`resume`: build `ByeRequest {reason, events: ring
contents + session.end}`, fire it, and wait at most `BYE_BUDGET_MS` (1 000) with the same
timer race; never retried. Host: `table.end` → lease `lost` at once → bus `end`.

Death without `bye` (SIGKILL, crash): the PTY exits → `releaseSpawn(owner, 'pty-exit')` → binding
`closed` (P1W1 §7.7). Lease expiry covers the remaining case, a process that lives on with an
unloaded or wedged mod.

Parking (`hibernateSession`, `pty.ts:570`) is a PTY kill: same path. The adapter ignores any bus
event whose binding is `closed`, so a late request from the dying process cannot re-animate a
parked row (the companion-side twin of the `isHibernated` guard, ARB-5).

### 7.6 Host: enable policy, classification, claims

```ts
// enable-policy.ts (pure)
export function enableFor(b: Readonly<BindingView>, mode: CompanionMode, gate: CliGate): FeatureId[]
// mode 'off' or gate 'below' → []; gate 'unknown' is treated as 'below'
// otherwise → declared ∩ { 'sense.identity' }

// identity-core.ts (pure)
export type IdentityFact =
  | { kind: 'confirmed'; key: string; sid: Sid } // key === sid (resume, wake)
  | { kind: 'claim'; key: string; sid: Sid; cause: 'spawn' | 'clear' | 'resume' | 'unknown' }
  | { kind: 'conflict'; key: string; sid: Sid; heldBy: string } // sid is live under another key
  | { kind: 'none' } // tick owner, or no key
export function classifyIdentity(x: {
  key: string | null // sessionKeyOf(owner) now
  sid: Sid
  cause: 'spawn' | 'clear' | 'resume' | 'unknown'
  ownerKind: 'pty' | 'tick'
  liveKeyForSid: string | null // another live PTY already keyed by this sid
}): IdentityFact
export function mayAct(x: {
  mode: CompanionMode
  gate: CliGate
  lease: 'live' | 'lost'
  fact: IdentityFact
}): boolean // 'active' && gate === 'ok' && lease === 'live' && fact.kind === 'claim'   (ARB-3, ARB-7b)
```

`enableFor` is registered as the first `EnablePolicy` through `companionHost.setEnablePolicy`:
`(b) => enableFor(b, getCompanionMode(), cliGate(parseClaudeVersion(b.cliVersion), ceiling))`.
P1W4 replaces it through the same call with its `computeEnable`, and later waves add their rows
with P1W4's `registerFeaturePolicy`; none edits this function. The gate is evaluated per binding
on `hello.cli.version`, because a live session keeps the binary it started with (P1W2 §7.6).

`sense.identity` is **proven** by a hello that redeemed a spawn token (contract §11.2): on the
`hello` bus event of kind `spawn` the adapter calls `markProven(b, 'sense.identity')` (P1W1's
table method, master §12.1).

Two additions to **P1W1's module**, made in this wave's change and in P1W1's style:
`companionHost.sessionKeyForSid(sid: Sid): string | null`, and the spawn ledger entry's
`expiresAt = mintedAt + SPAWN_REDEEM_WINDOW_MS`; a redemption after it is `UNAUTHORIZED` (§9).

**`pty:rekey` is a binding change.** This wave adds one line to the `pty:rekey` handler
(`pty.ts:1003`): after the index moves, the host fires `onBindingChange` for the binding of that
PTY, whose `sessionKey` now reads the new key. Later waves subscribe to `onBindingChange` (P2W2
re-keys its start-prompt claim, P4W4 its plan store); none is called from this wave.

Adapter flow, on bus `hello`, on `session.rebound`, on `end`, on `lease`, and on `onBindingChange`:

1. Recompute the fact for the binding.
2. Keep `claims: Map<bindingKey, { key, sid, cause, act }>`. A claim is **satisfied** and removed
   when `sessionKeyOf(owner) === sid` (the renderer migrated and `pty:rekey` moved the index).
3. Push the whole list to the renderer: `webContents.send('companion:identity', { claims })`.
   The renderer can also pull it (`ipcMain.handle('companion:identityClaims')`) at store init, so
   a window reload loses nothing.
4. On `conflict`: no claim; count it; record an `IdentityParityRecord` with verdict `conflict`. The PTY stays under
   its old key, which is today's behaviour.

`companionHost.sessionKeyForSid(sid)` answers from bindings (claimed or bound). P1W5 and P1W6 use
it to address a row that is still synthetic, replacing the `hooks:stateFor` resync for owned
sessions.

### 7.7 Renderer: honouring a claim through the existing migration path

`src/renderer/src/lib/identity-claims.ts` (pure): `claimFor(sid)`, `isClaimedKey(key)`,
`claimOfKey(key)`, `replaceAll(list)`.

Edits in `stores/sessions.ts`:

1. **Extract** the body of `tryBindAgentMigration` from the rename to the report
   (`:3246-3267`) into `migrateSyntheticInPlace(synth, realId, folder, via)`. Both callers use it;
   behaviour of the legacy caller is unchanged.
2. **`fireMigrate(fromId, toId, via)`** gains a label. The three legacy binders report
   `'agent-correlation'`, `'collapse'` or `'resolved-window'`; a bind by claim reports
   `'companion'`. After its existing work it calls
   `window.api.companionIdentityOutcome?.({ fromKey, sid: toId, via })` — the **outcome**. Main
   compares it with the claim and records parity (§13): an outcome with a legacy label fills
   `IdentityParityRecord.legacy.via` (three values); an outcome `via: 'companion'` means no
   legacy binder ran, so `legacy` is `null` and the verdict is `companion-only`. No behaviour change.
3. **`reconcileSessionAdded(slug, sessionId)`** starts with:

   ```
   const c = claimFor(sessionId)
   if (c?.act && (await bindByClaim(c, sessionId))) return
   ```

   `bindByClaim`:
   - `row = findSessionById(c.key)`; no row → `false` (fall through to legacy).
   - `sessionId` already a live key or in `bornSyntheticIds` → `true` (idempotent).
   - `row.synthetic === true` → `migrateSyntheticInPlace(row, sessionId, folderOf(row), 'companion')`:
     the row keeps its object, slot and PTY; `fireMigrate` re-keys the panes, whose handler calls
     `ptyRekey` (`TerminalPane.vue:1166`); `backfillMigratedSessionMeta` fills the blank fields
     (BUG-88); `reportMaterialized` fires for an agent-controlled row; the row's armed correlation,
     if any, is cleared. The folder comes from the row, **not** from the slug (lesson 003).
   - `row` is a real session (a `/clear` or `/resume` rebound) → `await reloadModel()` so the new
     transcript surfaces as its own row, then `fireMigrate(c.key, sessionId, 'companion')` and move
     the selection if it was on `c.key`. No row object is renamed: the old id stays as an ordinary
     cold row backed by its transcript; the live PTY now belongs to the new id.

4. **A `resume` claim whose target already exists on disk** fires no `session:added`. When the
   claim list arrives, for each acting claim with `cause: 'resume'` and an existing non-synthetic,
   non-live row for `sid`: `fireMigrate(c.key, sid, 'companion')` at once.
5. **Narrowing the heuristics, in `active` only** (`c.act`): a synthetic whose key carries a claim
   for a different `sid` is skipped by `collapseSyntheticInto`'s newest-synthetic pick
   (`:4935-4942`), by `tryBindAgentMigration`'s oldest-correlation pick (`:3220-3228`) and by
   `collapseResolvedSynthetics` (`:5078`), and a real row that is some claim's `sid` is not offered
   as a twin to another synthetic (`:5084-5085`). In `shadow` and `off` these four sites behave exactly
   as today. This is the demotion of "FIFO plus the collapse window" to sessions with no hello.

What this fixes, by reading the code (to be shown live, LV-P1W3-c): today nothing re-keys a live
row on `/clear`. `reconcileSessionAdded` finds no synthetic, reloads, and the new transcript
appears as a second row while the PTY index still holds the old id (`sessions.ts:5036-5044`);
opening that row misses the dedup of `pty:create` and resumes a transcript another process is
writing.

### 7.8 Developer aid

`companionDevRestartListener()` (preload; handler registered only when `!app.isPackaged`, as in
P1W1 §7.8) stops and starts the listener, for LV-P1W3-g. It is a developer aid only and is
unrelated to the kill switch, which revokes `conn`s and leaves the listener up.

### 7.9 Contract additions

None on the wire — merged into `01-contract.md`:

| Item of this wave                                                                                                  | Now in             |
| ------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `HELLO_WAIT_MS`, `SPAWN_REDEEM_WINDOW_MS`, `DRIFT_CHECK_MIN_MS`, `BYE_BUDGET_MS`                                   | contract §7.1      |
| The bounded hello wait; inert and dormant outcomes                                                                 | contract §5.1, §13 |
| Spawn-token expiry                                                                                                 | contract §3 item 1 |
| Claim at hello, migration at `session:added`; drift check only without `classic.*`; rebound with another `prevSid` | contract §15       |
| `hello.proof`: reserved, not implemented in protocol 1                                                             | contract §18       |
| `$.state` keys `conn`, `bootId`, `sid`, `boot`, `probes`                                                           | contract §22       |

Still host-internal and not in the contract (master §12.1 names it "contract-free"): the parity
record of family `identity`, which P1W4's ledger rule consumes.

```ts
interface IdentityParityRecord {
  family: 'identity'
  at: number
  shape: 'new' | 'fork' | 'resume' | 'agent' | 'clear' | 'in-session-resume' | 'tick'
  companion: { keyHash: string; sidHash: string; helloAfterSpawnMs: number } | null
  legacy: {
    keyHash: string
    via: 'agent-correlation' | 'collapse' | 'resolved-window'
    afterSpawnMs: number
  } | null
  verdict: 'match' | 'mismatch' | 'companion-only' | 'legacy-only' | 'conflict'
}
```

## 8. Arbitration & fallback

Family `identity`. Required feature: `sense.identity`. One writer per (session, family) (ARB-2):
in `active` with a live lease and a proven feature the claim decides and the heuristics stand
aside for that row; otherwise the heuristics decide and the claim is only compared.

| Condition                                              | What happens                                                                                                                                                       | Identity source                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Mode `off`                                             | no token, no mod; adapter idle                                                                                                                                     | legacy                                                      |
| Mode `shadow` (default from P1W4)                      | claim recorded, `act: false`; heuristics bind; parity recorded                                                                                                     | legacy                                                      |
| Kill switch turned off mid-session (P1W4)              | the `conn` is revoked; the mod's next request answers `STALE_CONN`; its `resume` hello is answered `enable: []`; the mod is inert; pending claims get `act: false` | legacy at once, no TTL wait; a row already migrated is kept |
| Mod absent (old CLI, policy, `--safe-mode`, `--bare`)  | no hello; token expires or is released at exit                                                                                                                     | legacy                                                      |
| CLI above the tested ceiling                           | hello served; `act: false`                                                                                                                                         | legacy                                                      |
| Host down at spawn                                     | no token minted → mod dormant                                                                                                                                      | legacy                                                      |
| Host hangs during hello                                | hook returns after `HELLO_WAIT_MS`; late answer adopted                                                                                                            | claim if it lands before the transcript, else legacy        |
| Hello lands **after** the heuristic already bound      | `fireMigrate` already ran; claim is satisfied if the keys agree, else `mismatch` is recorded and nothing is undone (first binder wins)                             | whichever bound first                                       |
| Lease lost before the transcript appears               | `act` turns false; the claim is still compared                                                                                                                     | legacy                                                      |
| Lease lost after the row was migrated                  | nothing to undo (ARB-4d)                                                                                                                                           | kept                                                        |
| Hot reload                                             | resume hello; claim untouched                                                                                                                                      | unchanged                                                   |
| Listener restart                                       | resume hello on the new `bootId`                                                                                                                                   | unchanged                                                   |
| `/clear`                                               | rebound → claim → re-key at the next transcript `add`                                                                                                              | claim (`active`); today's behaviour otherwise               |
| In-session `/resume` to a session live elsewhere       | `conflict`: no re-key                                                                                                                                              | unchanged row; counted                                      |
| `classic.*` pinned (`sec-default`)                     | drift check sends `cause: 'unknown'` within one heartbeat                                                                                                          | claim                                                       |
| Headless tick                                          | binding with a `tick:` key; no renderer row; no claim                                                                                                              | —                                                           |
| Wake after hibernation                                 | new token, hello with the same id → `confirmed`                                                                                                                    | key already equals `sid`                                    |
| Resume picker or login screen (no `session.start` yet) | no hello until passed; past 10 min the token is dead → dormant                                                                                                     | legacy                                                      |
| Untrusted folder                                       | the mod loads only after the trust answer (CLI docs; P1W2 OQ-1)                                                                                                    | legacy until hello                                          |
| A sibling mod wedges the worker during `session.start` | the chain is skipped for that dispatch; `ensureHello` runs on the next hook or heartbeat                                                                           | claim, later                                                |
| Renderer reloads                                       | claims pulled again at store init                                                                                                                                  | unchanged                                                   |

## 9. Security requirements

Inherits SEC-1 to SEC-9. Wave-specific:

- **SEC-3 / C4.** A binding means "some code in a process Harnu spawned said this id". The only
  thing a claim can do is choose **which of Harnu's own rows** becomes a given transcript; it cannot
  create a row, reach another folder or grant a capability. The renderer applies a claim only to a
  row that exists, and only for an id that a watcher event (or an existing disk row) confirms.
- **Token lifetime.** The token is spent by the first request after hello, before the first prompt
  (contract §3.2). When the mod never loads (policy), the token would sit in the environment of
  every tool subprocess for the life of the PTY; `SPAWN_REDEEM_WINDOW_MS` bounds how long a
  subprocess could redeem it and pose as that session's sensor.
- **SEC-8.** `conn` lives in module memory and `$.state` only. Any plugin can read `$.state`
  (types L3157): accepted, and the reason nothing is authorized by `conn`. Parity records carry
  hashes of ids, never ids, paths or text.
- **SEC-4.** The rendezvous path comes from `coords.gen.ts`; the endpoint file's content is
  validated (`v`, transport, absolute socket path under the rendezvous directory or a loopback
  port) before use. A `socketPath` that is not inside the directory of `RENDEZVOUS_PATH` is refused.
- **SEC-1.** No hook in this wave returns anything but `next(e)`.
- `api-surface.json` after this wave: hooks `session.start`, `session.end`, `classic.SessionStart`;
  calls `session.id` (first hello, drift check), `session.version` (`hello.cli.version`),
  `env.get`, `fs.read` (the rendezvous file), `http.fetch`, `state.get`, `state.set`,
  `clock.every` (heartbeat), `clock.after` (`raceWithTimer`); `envReads: ["HARNU_SPAWN_TOKEN"]`;
  `stateKeys: ["conn", "bootId", "sid", "boot", "probes"]`. `$.session.cwd()` is not called: the
  cwd comes from the `session.start` input.

## 10. UX & copy

No new surface and no strings. Observable change once the family is `active`: a new session's row
turns into its real session without a second "New session" row appearing beside it, and a session
that ran `/clear` stays one live row. P1W4 shows the Harnu mod state (`live` / `legacy` / `off`).

## 11. Acceptance criteria

Test files: `resources/companion/tests/hello.test.ts`, `rekey.test.ts`, `ring.test.ts` (L3);
`tests/companion/identity-core.test.ts` (IC), `tests/companion/identity-adapter.test.ts` (IA),
`tests/companion/identity-parity.test.ts` (IP), `tests/identity-claims.test.ts` (CL),
`tests/sessions-store.test.ts` (SS, existing file, new cases); `tests/cli/handshake.cli.test.ts`
(L4, real `startCompanionServer` in a temp directory).

```
AC-P1W3-1 [mod-test] Given a conn in module memory, When any hook runs, Then no hello request is made.
  Evidence: hello.test.ts › "ensureHello is a no-op with a conn (conformance row 4)"

AC-P1W3-2 [mod-test] Given no conn in memory and one in $.state, When session.start is dispatched,
  Then exactly one hello is sent and it carries resume, not spawn.
  Evidence: hello.test.ts › "re-hello with resume after a reload (conformance row 4)"
  Guards: R10, smoke A5

AC-P1W3-3 [mod-test] Given a host stub that never answers, When session.start is dispatched with
  the mock clock advanced by HELLO_WAIT_MS, Then the hook has returned next(e)'s result.
  Evidence: hello.test.ts › "a hung host does not hold the prompt"
  Guards: R9

AC-P1W3-4 [mod-test] Given hello answers UNAUTHORIZED, Then later hooks send no request at all.
  Evidence: hello.test.ts › "dormant after an unrecoverable failure"

AC-P1W3-5 [mod-test] Given no HARNU_SPAWN_TOKEN and no saved conn, Then no request is sent and
  every hook returns next(e).
  Evidence: hello.test.ts › "not spawned by Harnu: dormant"

AC-P1W3-6 [mod-test] Given two hooks dispatched while a hello is in flight, Then one hello request exists.
  Evidence: hello.test.ts › "single flight"

AC-P1W3-7 [mod-test] Given classic.SessionStart {source: clear, session_id: NEW}, Then a
  session.rebound {prevSid: OLD, sid: NEW, cause: clear} is posted on the same conn and conn is
  written to $.state again.
  Evidence: rekey.test.ts › "/clear rebounds from the payload (conformance row 15)"

AC-P1W3-8 [mod-test] Given classic.SessionStart {source: resume, session_id: OTHER} while the
  session.id stub still returns OLD, Then the rebound carries sid OTHER.
  Evidence: rekey.test.ts › "/resume uses the payload id, not $.session.id() (conformance row 15)"
  Guards: C10

AC-P1W3-9 [mod-test] Given probes.classic is true and session.id returns a different id, Then no rebound is sent.
  Evidence: rekey.test.ts › "no drift check with classic"

AC-P1W3-10 [mod-test] Given an events fetch that rejects, Then the same events are sent again
  with the same seq after the backoff, and are removed only after an ack.
  Evidence: ring.test.ts › "ring keeps events until acknowledged (conformance row 6)"

AC-P1W3-11 [mod-test] Given session.end {reason: clear}, Then no bye is sent.
  Evidence: hello.test.ts › "no bye on clear"

AC-P1W3-12 [mod-test] Given STALE_CONN on events, Then the mod re-hellos with resume and re-sends
  the unacknowledged events numbered from 1.
  Evidence: ring.test.ts › "stale conn re-hello and renumber"

AC-P1W3-13 [mod-test] Given an endpoint file whose socketPath is outside the rendezvous
  directory, Then no request is sent.
  Evidence: hello.test.ts › "endpoint outside the rendezvous directory is refused"

AC-P1W3-14 [unit] Given key synthetic and sid real → claim; key === sid → confirmed; sid live
  under another key → conflict; tick owner → none.
  Evidence: IC › "classification table"

AC-P1W3-15 [unit] Given mode shadow, or gate above, or lease lost, Then mayAct is false.
  Evidence: IC › "a claim acts only when owned (ARB-3)"

AC-P1W3-16 [unit] Given a bound session, When an events request arrives with another sid and no
  rebound, Then the claim list is unchanged.
  Evidence: IA › "re-key only on session.rebound (conformance row 16)"

AC-P1W3-17 [unit] Given a spawn token minted 10 min and 1 ms ago, Then its redemption is UNAUTHORIZED.
  Evidence: tests/companion/session-table.test.ts › "redeem window"

AC-P1W3-18 [unit] Given a binding whose PTY exited, When a late event arrives, Then no claim and
  no identity push is produced.
  Evidence: IA › "closed bindings are inert"
  Guards: hibernation guard (ARB-5)

AC-P1W3-19 [unit] Given an acting claim (S1 → R1) and a session:added for R1, Then the row S1
  becomes R1 in place, ptyRekey is called once with (S1, R1), and the folder has no second row.
  Evidence: SS › "claim binds the exact synthetic in place"
  Guards: BUG-65

AC-P1W3-20 [unit] Given two agent synthetics S1, S2 in one folder with acting claims S1 → R1 and
  S2 → R2, When session:added arrives for R2 first, Then S2 becomes R2 and S1 is untouched.
  Evidence: SS › "claims beat the oldest-correlation order"
  Guards: BUG-59, BUG-65

AC-P1W3-21 [unit] Given an acting claim and no session:added yet, When reloadModel runs, Then the
  row is still present and still synthetic.
  Evidence: SS › "no early re-key: the row survives a reload before the transcript exists"
  Guards: BUG-88, lesson synthetic-sessions/001

AC-P1W3-22 [unit] Given a claim-driven migration, Then fullPath and firstPrompt are backfilled
  from disk and the label is not the unnamed fallback.
  Evidence: SS › "claim migration backfills metadata"
  Guards: BUG-88

AC-P1W3-23 [unit] Given a folder path containing dashes whose slug does not decode to it, When an
  acting claim exists, Then the migration still binds in place.
  Evidence: SS › "claim needs no slug resolution" (folder TASK-1234-feature-alpha)
  Guards: lesson synthetic-sessions/003

AC-P1W3-24 [unit] Given an agent-controlled synthetic bound by claim, Then
  notifySessionMaterialized is called once with (S, R, folder).
  Evidence: SS › "claim migration reports materialization"
  Guards: BUG-59, ADR-0003

AC-P1W3-25 [unit] Given a claim with act false (shadow), Then the legacy binder runs unchanged
  and companionIdentityOutcome reports the key it bound.
  Evidence: SS › "shadow never acts, always reports"

AC-P1W3-26 [unit] Given a rebound claim (R1 → R2, cause clear) and session:added for R2, Then the
  live terminal is keyed R2, R1 remains as a row with no live terminal, and selection moved to R2.
  Evidence: SS › "/clear moves the live session to the new id"

AC-P1W3-27 [unit] Given companion {S1 → R1} and legacy bound S1 → R1 → match; legacy bound
  S2 → R1 → mismatch; no legacy bind → companion-only; no hello → legacy-only.
  Evidence: IP › "identity comparator" (replays tests/fixtures/companion-parity/identity/*.ndjson)

AC-P1W3-28 [unit] Then every IdentityParityRecord field that derives from an id is a hash and no
  record contains a path.
  Evidence: IP › "records are scrubbed (QA-9)"

AC-P1W3-29 [integration] Given the real server and a minted token, When claude -p "/harnu-probe"
  runs with the companion, Then the binding's sid equals the id the probe printed and the hello
  arrived before the probe command ran.
  Evidence: tests/cli/handshake.cli.test.ts › "binds the real id"
  Guards: BUG-65

AC-P1W3-30 [integration] Given the fake host answering garbage, a closed socket, and nothing at
  all, Then each run exits 0 with the probe's output and the debug file has no "hook skipped".
  Evidence: tests/cli/handshake.cli.test.ts › "host failures never surface in the session"

AC-P1W3-31 [integration] Given a fresh start, Then the first session.snapshot records whether
  probes.classic was already true (CQ2) and whether the startup classic.SessionStart payload
  carries a permission_mode (read by P2W3 and P2W5), and the bye request records
  next.budget.remainingMs (CQ1).
  Evidence: tests/cli/handshake.cli.test.ts › "records CQ1, CQ2 and the startup permission_mode" (values written to the evidence addendum)

AC-P1W3-32 [integration] Given a tick-shaped spawn with a token for a tick owner, Then a binding
  with a tick: key exists and no identity push was produced.
  Evidence: tests/cli/handshake.cli.test.ts › "tick binds without a row"
  Guards: P1W2 OQ-8

AC-P1W3-33 [integration] Given claude --resume <src> --fork-session with a token, Then the test
  records whether hello.sid is the fork's new id or the source id.
  Evidence: tests/cli/handshake.cli.test.ts › "fork id at hello" (OQ-1)

AC-P1W3-34 [live-verify] Given mode shadow, When a new session is opened and prompted, Then
  diagnostics shows one binding with a live lease and the parity sink holds one match record.
  Evidence: LV-P1W3-a

AC-P1W3-42 [live-verify] Given mode off, When /clear is run and a prompt sent, Then the recipe
  records today's behaviour: how many rows exist for the two ids and which key the PTY index holds (F3).
  Evidence: LV-P1W3-c run with the mode off (steps 1–2, observation only), before the active run
  Guards: F3 (sessions.ts:5036-5044)

AC-P1W3-43 [mod-test] Given a hello answered ok with enable: [], Then no events request and no
  heartbeat is sent afterwards (conformance row 25).
  Evidence: hello.test.ts › "inert after an empty enable"

AC-P1W3-44 [mod-test] Given hello answers FEATURE_DISABLED, Then later hooks send no request.
  Evidence: hello.test.ts › "dormant on FEATURE_DISABLED"

AC-P1W3-35 [live-verify] Given mode active, When /clear is run and a prompt sent, Then exactly
  one PTY exists, keyed by the new id, and the old conversation is a separate row that is not live.
  Evidence: LV-P1W3-c

AC-P1W3-36 [live-verify] Given mode active, When /resume <other> is run in a session, Then the
  row re-keys to the other id, and the recipe records $.session.id() read afterwards outside the
  hook (CQ4).
  Evidence: LV-P1W3-d

AC-P1W3-37 [live-verify] Given a parked session, When it is woken, Then the binding is confirmed
  with the same id and no second row appears.
  Evidence: LV-P1W3-e

AC-P1W3-38 [live-verify] Given dev mode, When register.ts is saved during a session, Then the
  binding count is unchanged, conn rotated, and events resume from seq 1.
  Evidence: LV-P1W3-f
  Guards: R10

AC-P1W3-39 [live-verify] Given a live binding, When the listener is restarted, Then the session
  re-hellos within BACKOFF_MAX_MS plus one heartbeat and the lease is live again.
  Evidence: LV-P1W3-g
  Guards: the stale-port orphaning (hook-bridge.ts:451, mcp/server.ts:1467-1477)

AC-P1W3-40 [live-verify] Given a live binding, When the claude process is killed with SIGKILL,
  Then the binding is closed within 2 s and no bye was received.
  Evidence: LV-P1W3-h
  Guards: Q7

AC-P1W3-45 [mod-test] Given probes.classic is false and session.id returns a different id, Then one rebound with cause unknown is sent.
  Evidence: rekey.test.ts › "drift check without classic"

AC-P1W3-46 [mod-test] Given session.end {reason: other}, Then one bye carrying session.end is sent.
  Evidence: hello.test.ts › "bye on a real end"

AC-P1W3-47 [mod-test] Given session.end {reason: other}, Then the hook returns within BYE_BUDGET_MS.
  Evidence: hello.test.ts › "bye within budget"

AC-P1W3-48 [mod-test] Given a hello answered ok with enable: [], Then conn is still in $.state.
  Evidence: hello.test.ts › "inert keeps conn"

AC-P1W3-49 [mod-test] Given an inert mod, When a STALE_CONN arrives, Then one resume hello is sent (conformance row 25).
  Evidence: hello.test.ts › "revoked conn resumes"
```

**Live-verify recipes** (isolated second instance; `window.api.companionDiagnostics()` over CDP;
record `claude --version`; isolate the legacy bridge latency per QA-8 by noting whether the
global hooks were installed).

- **LV-P1W3-a — bind a new session (shadow).** 1. Mode file `shadow`; launch. 2. "+ New session"
  in a test folder. 3. Before typing: diagnostics shows a binding, `lease: 'live'`, `proven`
  includes `sense.identity`; the sidebar row is still the synthetic. 4. Send "say ok". 5. Pass: one
  row, now real; one parity record `match`; `helloAfterSpawnMs` under 2 000.
- **LV-P1W3-b — crossed agent sessions (active).** 1. Mode file `active`. 2. From an orchestrator
  session call `create_session` three times in one folder. 3. Pass: three rows, each showing its
  own first prompt; three `companionIdentityOutcome` calls with `via: 'companion'`, hence three
  parity records with verdict `companion-only` (`legacy: null`); no `mismatch`.
- **LV-P1W3-c — `/clear`.** 0. First run steps 1–2 with the mode `off` and record what happens
  today (AC-P1W3-42, F3). 1. Mode `active`; open a session, send a prompt. 2. Type `/clear`,
  then send a prompt. 3. Pass: `window.api.ptyListLive()` has one entry for the folder, keyed by the
  new id; the sidebar shows the new id live and the old conversation as a cold row; selecting the
  old row spawns a second process for the **old** id only.
- **LV-P1W3-d — in-session `/resume`.** 1. Two finished sessions A and B in one folder; open A. 2. Type `/resume`, pick B. 3. Pass: the live row is B; A is cold. 4. Run `/harnu-probe` (the L4
  probe mod loaded through Claude Boot extra args) and record the printed `$.session.id()` (CQ4). 5. Repeat with B already live in another tab: pass is "no re-key, one `conflict` counted".
- **LV-P1W3-e — wake.** 1. Park a session from the System Monitor. 2. Select it. 3. Pass: a new
  binding with the same `sid`, `sessionKey === sid`, no claim, one row.
- **LV-P1W3-f — hot reload.** 1. Launch with `HARNU_COMPANION_DEV=1`. 2. Open a session; note the
  binding. 3. Add a comment to `hooks/register.ts` and save. 4. Pass: the transcript shows the
  reload line; diagnostics shows the same binding, `counters.requests` still growing, `lease: 'live'`.
- **LV-P1W3-g — listener restart.** 1. Open a session. 2. Call
  `window.api.companionDevRestartListener()`. 3. Pass: a new `bootId` in `endpoint.json`; within
  25 s the binding's `lastRequestAgoMs` drops below 10 000.
- **LV-P1W3-h — SIGKILL.** 1. Open a session; read its pid from the System Monitor. 2. `kill -9`. 3. Pass: the binding leaves diagnostics (or reads `closed`) within 2 s; no row is duplicated.

**Human ACs**

```
AC-P1W3-41 [human] Given a day of ordinary use in mode active, Then no "New session" row lingers
  beside its real session and no session appears twice.
  Evidence: operator sign-off noted in the Delivery Report, with the parity summary attached
  Guards: BUG-65, lesson synthetic-sessions/003
```

## 12. Docs deliverables

| Contract                 | Deliverable                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`           | Nothing while the family is `shadow` (PR label `no-changelog`). **When `identity` flips to `active`:** `### Fixed` — "New sessions no longer leave a duplicate 'New session' row, and a session keeps a single row after `/clear`." |
| `docs/harnu-features.md` | None (not agent-facing: no verb, ACK or grant changes).                                                                                                                                                                             |
| `docs/user/`             | None in this wave (no new top-level component, main file or verb). `docs/user/sessions.md` gains one sentence on `/clear` at the flip.                                                                                              |
| `design.md`, i18n        | None.                                                                                                                                                                                                                               |
| `01-contract.md`         | Already merged (§7.9); `contract.ts` and fixtures land with this wave's code (DOC-7); CQ1–CQ4 answered from AC-P1W3-31, -36 and LV-P1W3-c.                                                                                          |
| Lessons                  | `docs/lessons/synthetic-sessions/004-claim-not-rekey-before-transcript.md`: why a row is never re-keyed before its transcript exists.                                                                                               |
| Smoke evidence           | Addendum: CQ1, CQ2, CQ3, CQ4, the fork id (OQ-1).                                                                                                                                                                                   |

## 13. Rollout & parity gate

- **Fact family:** `identity`. Default after P1W4: `shadow`.
- **Shadow comparison.** For every Harnu-spawned session one `IdentityParityRecord`: the companion
  side is the claim; the legacy side is the `via` and key reported by `fireMigrate`. Records go to
  an in-memory ring of 500 plus diagnostics counters in this wave; from P1W4 on they go through
  `recordFact('identity', …)` and its `identity` parity rule (the persisted ledger). Scrubbed samples are committed under
  `tests/fixtures/companion-parity/identity/` and replayed by `identity-parity-core.ts` (QA-9).
- **Gate to `active`** (ARB-6c), all of:
  1. **N = 200** consecutive Harnu-spawned sessions in the ledger, with at least 30 of each shape
     `new`, `fork`, `agent`, and at least 20 `clear`.
  2. **Zero unexplained `mismatch`.** A mismatch is explained only when the transcript shows the
     legacy binder was wrong (the companion's id equals the transcript the PTY actually wrote).
  3. **Bind rate:** `companion` non-null in at least 97 % of records whose CLI passed the gate
     (ADR-0018 kill criterion 1 is the complement).
  4. `helloAfterSpawnMs` p95 under 2 000.
  5. LV-P1W3-c, -d, -e green on the release build; AC-P1W3-41 signed.
  6. OQ-1 (fork id) answered; if hello reports the source id on a fork, shape `fork` stays `shadow`.
- **Demotes** (never deletes; P5W1 owns retirement): the oldest-correlation pick of
  `tryBindAgentMigration`, the newest-synthetic pick of `collapseSyntheticInto` and the time window
  of `collapseResolvedSynthetics`, to sessions with no acting claim. `hooks:stateFor` is untouched.
- **Merge bar:** `local-pipeline.sh --base <P1W2 branch> --with-cli --labels no-changelog`.

## 14. Open questions

| #    | Question (contract / master id)                                                                                                                          | Owner | Settled by                                                      | Fallback already designed                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| OQ-1 | On `--fork-session`, is the id at `session.start` the fork's new id or the source's?                                                                     | P1W3  | AC-P1W3-33                                                      | A claim whose `sid` is an existing session other than the key is a `conflict` or waits for a rebound; the fork shape stays `shadow`. |
| OQ-2 | CQ1: `session.end` bound, 1.5 s or 5 s?                                                                                                                  | P1W3  | AC-P1W3-31                                                      | `bye` budgets 1 s either way.                                                                                                        |
| OQ-3 | CQ2: does `classic.SessionStart {source: startup}` fire on a fresh start?                                                                                | P1W3  | AC-P1W3-31                                                      | `probes.classic` flips at the first `classic.*` of any kind.                                                                         |
| OQ-4 | CQ3: is `$.state` reset by `/clear`, and is it ever on disk?                                                                                             | P1W3  | LV-P1W3-c plus a reload                                         | Re-written after every rebound; `conn` treated as tier-visible.                                                                      |
| OQ-5 | CQ4: `$.session.id()` after an in-session `/resume`, outside the hook.                                                                                   | P1W3  | AC-P1W3-36                                                      | Payload id only; drift check off once `classic.*` is seen.                                                                           |
| OQ-6 | Does a `$.state` write issued inside `classic.SessionStart` survive when the turn that follows is aborted?                                               | P1W3  | `rekey.test.ts` cannot show it; LV-P1W3-c with an immediate Esc | After a reload with no saved `conn` the spawn hello is `UNAUTHORIZED` → dormant → legacy.                                            |
| OQ-7 | Master Q28: should a `conflict` re-key anyway and close the other tab?                                                                                   | P1W4  | product decision                                                | No re-key; counted and shown in diagnostics.                                                                                         |
| OQ-8 | Master Q7 remainder: a process that survives with the mod unloaded sends no `bye` and has a live PTY.                                                    | P1W4  | lease expiry (ARB-4)                                            | Lease lost within 20 s plus one sweep.                                                                                               |
| OQ-9 | F3 (master §14): today `/clear` leaves a second row and the PTY index keeps the old id (`sessions.ts:5036-5044`); read from code, not yet observed live. | P1W3  | AC-P1W3-42                                                      | The `active` path (AC-P1W3-35) does not depend on the answer; T389 does not fix the legacy path.                                     |

## 15. Risks

| Risk                                                                            | Sev    | Mitigation                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R10: hot reload wipes module state mid-session                                  | Medium | `conn`, `sid`, `boot` in `$.state`; resume hello; production never reloads (immutable stage).                                                 |
| R9: hello blocks the first prompt                                               | Medium | `HELLO_WAIT_MS`; P1W1 answers from memory.                                                                                                    |
| A claim binds the wrong row                                                     | High   | the key comes from the PTY that carried the token, not from the request; shadow first; gate of §13.                                           |
| A sibling mod forges a rebound and moves a live row to another transcript       | Medium | a claim only re-keys among Harnu's own rows and needs the transcript to exist; `conflict` when it is live; conceded at the same tier (SEC-7). |
| The narrowing of the heuristics strands a synthetic whose claim never completes | Medium | narrowing applies only while `act` is true; lease loss or PTY exit turns it off and legacy resumes.                                           |
| The renderer and main disagree on the claim list after a window reload          | Low    | full-list push plus pull at init; claims are derived from the table, never stored twice.                                                      |
| ADR-0018 kill criterion 1: the handshake binds too few spawns                   | High   | bind rate is a gate metric; below 97 % the family stays `shadow` and the epic is re-evaluated.                                                |
| `$.session.id()` semantics change in a later CLI                                | Medium | used in two places only (first hello, drift check); L4 pins both; ceiling forces `shadow`.                                                    |
