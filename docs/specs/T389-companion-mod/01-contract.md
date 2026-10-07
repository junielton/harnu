# T389 — Companion protocol contract (v1)

**Status:** specified (not implemented) · **Date:** 2026-10-02 · **Epic:** T389
**Reconciled:** 2026-10-02, against the nineteen wave specs (the additions each wave listed are
merged below; a wave spec that disagrees with this file is wrong).
**Decided in:** [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) ·
**Master spec:** [`00-master.md`](00-master.md) ·
**Evidence:** `docs/studies/T389-smoke-evidence.md` (cited below as "smoke A2", "smoke B1.7", …)
**Verified against:** Claude Code CLI 2.1.287 (minimum CLI; tested ceiling 2.1.289, smoke §11). "types L<n>" is a line in that release's
`claude-code.d.ts` (the mods API types).

This document is **normative**. MUST, MUST NOT, SHOULD and MAY carry their usual meaning. It is the
wire contract between the **mod** (`harnu-companion`, running inside `claude`) and the **host** (the
companion server in Harnu main). Every wave spec extends this file in the same change that extends
the code (DOC-7); no wave defines wire shapes anywhere else.

The canonical machine form is `resources/companion/hooks/contract.ts`: one file, zero imports,
imported by the mod (relative import inside the plugin dir) and by the host. When this document and
that file disagree, that is a defect in both: fix them together.

"Wave" columns name the wave that owns an item: it defines the shape, and every other wave
conforms (master §12).

## 1. Roles and vocabulary

- The mod is the only client. It opens every request; the host never connects to the mod.
- The wire vocabulary is Harnu-owned. Raw CLI event names (`turn.start`, `classic.Stop`, …) MUST
  NOT appear as wire event or command names (D3). The "derived from" columns below are the only
  place the two vocabularies meet, so a CLI rename changes the mod and not the host. Strings the
  CLI reports as data (a tool name, a mod's `uses` list in `mod.admitted`) are carried as data
  and never interpreted as wire names.
- A **binding** is the host's record for one `claude` process: spawn owner, `conn`, current `sid`,
  Harnu `sessionKey`, profile, enabled features, lease.
- "Companion" is the internal name. Every user-visible string says **"Harnu mod"** (master §15).

## 2. Transport and rendezvous

1. The host MUST serve HTTP/1.1 on a Unix domain socket at `<userData>/companion/c.sock`, mode
   `0600`, inside a `0700` directory. `$.http.fetch(url, { socketPath })` reaches it from an
   embedded PTY and from `-p` (smoke A2: 0–9 ms per POST).
2. The host MUST fall back to TCP on `127.0.0.1` with a persisted port when the platform has no
   Unix sockets or the absolute socket path exceeds `SOCKET_PATH_MAX_BYTES`. The engine's limit is
   "near 100 B" (types L4897); 90 is a design margin.
3. The host MUST write the rendezvous file `<userData>/companion/endpoint.json` atomically (temp
   file plus rename), mode `0600`, on every boot, before it accepts connections.
4. The mod MUST learn the rendezvous path from the generated module `hooks/coords.gen.ts`, written
   at staging (D2, §23). It MUST NOT read coordinates from env, cwd or any project file (SEC-4).
5. The mod MUST re-read the rendezvous file on every connect failure (`ECONNREFUSED`, `ENOENT`,
   any HTTP status other than 200, a changed `bootId`) and MUST NOT cache coordinates across a
   failure. This is what removes the per-boot-token orphaning of the legacy bridge
   (`hook-bridge.ts:451`).
6. All routes are `POST /v1/<endpoint>` with a JSON UTF-8 body and
   `Authorization: Bearer <endpoint.token>`. With `socketPath` the URL host is `harnu`
   (`http://harnu/v1/hello`); over TCP it is `127.0.0.1:<port>`.

```ts
/** <userData>/companion/endpoint.json */
interface EndpointFile {
  v: 1
  transport: 'unix' | 'tcp'
  socketPath?: string // transport 'unix'
  port?: number // transport 'tcp', always 127.0.0.1
  token: string // endpoint token; defence in depth only, see §17
  bootId: BootId // changes on every host boot
  protoMin: number
  protoMax: number
  writtenAt: number // epoch ms
}
```

HTTP status carries transport-level outcomes only. The guard follows `mcp/http-guard.ts`, in its
order:

| Status | When                                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404`  | unknown route                                                                                                                                             |
| `405`  | a method other than `POST`                                                                                                                                |
| `403`  | a bad endpoint token; over TCP, a `Host` that is not loopback or an `Origin` that is neither absent, `null` nor loopback; over Unix, a `Host` not `harnu` |
| `413`  | a declared or actual body over `BODY_MAX_BYTES`                                                                                                           |
| `200`  | every parsed request, success or protocol failure (§12); a body that is not JSON is `200` with `BAD_ENVELOPE`                                             |

There is no `401`. The mod MUST treat anything other than a parseable `200` body as a transport
failure.

## 3. Binding: spawn token → `conn` (correlation, not authentication)

The spawn token and `conn` **bind a PTY to a session, survive restarts and reloads, and keep the
model from guessing its way onto the channel**. They are not a defence against a hostile mod in
the same process (smoke D6; D2 as corrected by C4): a same-tier sibling can read and forge both.
The host therefore MUST NOT grant any capability because a request carries them; capability comes
from the host's own origin gating and the binding's trust class (SEC-3, SEC-5).

1. Harnu main mints one **spawn token** per PTY spawn (and per scheduler tick) and passes it as the
   single env var `HARNU_SPAWN_TOKEN`. The mod reads it with the literal
   `$.env.get("HARNU_SPAWN_TOKEN")`. A token not redeemed within `SPAWN_REDEEM_WINDOW_MS` of its
   minting is dead. The host keeps the token in its ledger only: no record handed to another
   module, no log and no diagnostics view carries it (SEC-8).
2. The mod redeems it in its first `hello`. The host answers with a per-connection token `conn`.
   The first hello is awaited inside the `session.start` hook, which the engine awaits before the
   first prompt (smoke A2: hello lands 657–827 ms after spawn; a 4 s hold delayed the prompt), so
   the token is spent before the model can run a tool that could read it from the environment.
3. The spawn token is **one-time**. The host MUST accept a second redemption only while the `conn`
   it issued for that token has never been used by any request (a lost hello response); it then
   issues a fresh `conn` and invalidates the first. After the first request carrying that `conn`,
   the spawn token is dead and any redemption returns `UNAUTHORIZED`.
4. Every later request carries `conn` in the envelope. The host resolves `conn` → binding → PTY →
   current `sid`. A `conn` the host does not know, or one it has superseded or revoked, returns
   `STALE_CONN`.
5. A re-hello (hot reload, listener restart, `STALE_CONN`) presents `resume: { conn }`. The host
   issues a new `conn` for the same binding and invalidates the old one. A `resume.conn` equal to
   the binding's **previous** `conn` is accepted while the current `conn` has never been used (a
   lost resume response; the mirror of item 3).
6. The mod MUST keep `conn` only in module memory and in `$.state` (it survives a hot reload,
   types L3152–3153). It MUST NOT write `conn` or the spawn token to `$.store`, a file, a log or a
   wire event payload (SEC-8).
7. A request without a known `conn` (or a redeemable first-hello spawn token, or an admitted
   tokenless claim, §21) MUST be refused. The endpoint token and the MCP bearer are never
   sufficient by themselves, and no token of any kind is sufficient for an actuation (SEC-3).
8. **No `conn` persistence for Harnu-spawned sessions.** `before-quit` kills every PTY and a
   main-process crash closes the PTY masters, so a Harnu-spawned `claude` never outlives the table
   that knows it; a listener restart inside one main process keeps the in-memory table. A `resume`
   the table does not know is `UNKNOWN_SESSION`. For the external profile (§21) the host MAY
   persist a hash of each live `conn`; without it the mod's recovery is the fresh tokenless hello
   of §21.
9. **Revocation.** When the rollout turns off for a binding (the kill switch, §11.2) the host
   revokes its `conn`: every request carrying it answers `STALE_CONN`, and a `hello` with
   `resume` of that `conn` is still accepted and answered with `enable: []`. Turning the switch
   off never stops a running listener: the host stays up so those re-hellos are answered.
   Turning it back on reaches new sessions only: protocol 1 has no host-to-mod signal that
   re-enables an inert mod, so a running session stays inert until it ends.

What this binding does and does not establish is in §17.

## 4. Ids

| Id                               | Format                                                                                                             | Minted by | Wave       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------- | ---------- |
| `Sid`                            | the CLI session uuid (equals the transcript file name, smoke A2)                                                   | CLI       | —          |
| `SpawnToken`                     | `sp_<uuid>`                                                                                                        | host      | P1W1       |
| `Conn`                           | `c_<32 hex>`                                                                                                       | host      | P1W1       |
| `BootId`                         | `b_<uuid>`                                                                                                         | host      | P1W1       |
| `sessionKey`                     | Harnu's row key; `tick:<workerId>:<runId>` for a scheduler tick; `null` for an external binding. Opaque to the mod | host      | P1W1, P4W3 |
| `CmdId`                          | `cmd_<ulid>`                                                                                                       | host      | P2W1       |
| `AskId`, kind `permission`       | `ask_<tool_use_id>` when the ask is correlated with a `tool.check` record, else `ask_x<counter>`                   | mod       | P3W1       |
| `AskId`, kind `sentinel`         | `ask_s<tool_use_id>`                                                                                               | mod       | P3W2       |
| `AskId`, kind `status`           | `ask_q<counter>`                                                                                                   | mod       | P4W2       |
| `msgId`                          | `msg_<ulid>`                                                                                                       | host      | P2W3       |
| `Ticket`                         | `o_<22 base64url chars>` (128 random bits): the open-link ticket; correlation only                                 | host      | P4W2       |
| Stamp proof                      | `v1.<handle>.<nonce>.<mac>`, at most 160 chars (§24)                                                               | mod       | P2W5       |
| `ContextKey`                     | closed union: `'harnu.orchestrator' \| 'harnu.mission'`                                                            | contract  | P2W4, P4W5 |
| `turnId`, `agentId`, `toolUseId` | opaque CLI strings, passed through unchanged                                                                       | CLI       | —          |
| Event identity                   | `<conn>:<seq>`                                                                                                     | mod       | P1W1       |
| `FeatureId`                      | dotted lower-case, `<class>.<name>` (§11)                                                                          | contract  | —          |

## 5. Endpoints

```ts
/** Carried by every request except hello. */
interface Envelope {
  v: number // negotiated protocol version
  sid: Sid // the mod's bound session id (§15)
  conn: Conn
  sentAt: number // epoch ms, mod clock
}

type Failure = { ok: false; code: ErrorCode; message?: string; retryAfterMs?: number }
```

### 5.1 `hello`

Idempotent and lazy: the mod calls `ensureHello($)` at the head of every hook and it is a no-op
while a `conn` is held in module memory (D3). `session.start` re-fires on hot reload and does not
fire after `/clear` or an in-session `/resume` (smoke A2, A5), so it cannot be the only trigger.

```ts
interface HelloRequest {
  protoMin: number
  protoMax: number
  sid: Sid
  spawn?: SpawnToken // first hello of a Harnu-spawned process
  resume?: { conn: Conn } // re-hello
  cli: { version: string } // $.session.version().version
  mod: { version: string }
  surface: string | null // session.start.surface; null for -p and the SDK
  isInteractive: boolean
  cwd: string
  declared: FeatureId[] // only features whose hooks actually registered (§11)
  sentAt: number
}

type HelloResponse =
  | {
      ok: true
      proto: number
      conn: Conn
      bootId: BootId
      sessionKey: string | null // Harnu's row key; null for an external binding (§21)
      profile: 'interactive' | 'headless' | 'external'
      enable: FeatureId[] // subset of `declared`
      config: Config
      opts?: ModOptions
      commands?: Command[] // e.g. the claimed start prompt, guard.set, sentinel.set
    }
  | Failure

interface Config {
  flushMs: number
  batchMaxEvents: number
  batchMaxBytes: number
  ringMax: number
  pollHoldMs: number
  askHoldMs: number
  heartbeatMs: number
}

/** Per-hello options the mod cannot derive from `enable`. Additive; unknown keys are ignored. */
interface ModOptions {
  compactSummary?: boolean // P4W5: put `compact.done.summary` on the wire (the `recap` key)
}
```

- **At most one** of `spawn` and `resume` is present. A hello with neither is the **external
  claim** of §21; a hello with both is `BAD_ENVELOPE`.
- The host MUST answer `hello` within `HELLO_SLA_MS`; it blocks the session's first prompt. It is
  answered from memory, with no awaited I/O.
- The mod waits for a hello at most `HELLO_WAIT_MS`; after that the hook returns `next(e)`. The
  request is not cancelled (`$.http.fetch` has no timeout option, types L4878) and its late answer
  is adopted.
- On `PROTO_UNSUPPORTED`, `UNAUTHORIZED` or `UNKNOWN_SESSION` the mod MUST go **dormant** for the
  life of the process: every hook returns `next(e)` and no further request is sent. The single
  exception is the tokenless mod of §21 on `UNKNOWN_SESSION`. `FEATURE_DISABLED` on `hello` (the
  external profile is off) also makes the mod dormant.
- An `ok` answer with `enable: []` makes the mod **inert**: it MUST behave as if no feature
  exists (no sensor event, no heartbeat, no poll, no ask) while keeping `conn`. This is how the
  kill switch reaches a running session (§3 item 9).
- Commands in `commands` are executed by the same executor as polled commands, started after
  `ensureHello` returns and never awaited by the `session.start` hook.

### 5.2 `events`

```ts
interface EventsRequest extends Envelope {
  events: WireEvent[] // may be empty (heartbeat)
  dropped?: number // events the mod discarded since the last accepted batch
  bootId?: BootId // non-polling profiles only: the boot the cursor belongs to
  cursor?: number // non-polling profiles only: highest Command.n recorded (§16, §21)
}

interface WireEvent<N extends EventName = EventName> {
  seq: number // monotonic per conn, starts at 1
  t: N
  ts: number // epoch ms, when the CLI event fired
  turnId?: string // MUST be set on turn.started and turn.completed
  agentId?: string // present for a subagent's event
  d: EventPayloads[N]
}

type EventsResponse = { ok: true; ackSeq: number; resync?: boolean; commands?: Command[] } | Failure
```

### 5.3 `poll`

The command long-poll. It doubles as the lease heartbeat for interactive sessions.

```ts
interface PollRequest extends Envelope {
  bootId: BootId // the boot the cursor belongs to
  cursor: number // highest Command.n the mod has recorded for that boot
}

type PollResponse = { ok: true; commands: Command[]; resync?: boolean } | Failure

interface Command<N extends CommandName = CommandName> {
  cmd: CmdId
  n: number // ordinal per binding and boot, starts at 1
  name: N
  args: CommandArgs[N]
  issuedAt: number
  expiresAt: number
}
```

- The host holds the request up to `POLL_HOLD_MS` and answers `commands: []` on timeout.
- **One parked poll per binding.** A second `poll` on a binding supersedes the first, which is
  answered `commands: []` at once: a hot reload or a duplicated loop never leaves two holds.
- A `bootId` that is not the host's, or an envelope `sid` that is not the bound `sid`, answers
  `{ ok: true, commands: [], resync: true }`. No command is released to an unsettled id.
- The mod runs it as an un-awaited loop started once per load (smoke C2: 0–2 ms from enqueue to
  mod, no measurable CPU cost, survives turns and `/clear`). It MUST send the bound `sid` of §15,
  not a fresh `$.session.id()` read: that call tracks `/clear` (verified) but not an in-session
  `/resume`, where the hook payload is the source of truth (C10).
- The mod MUST NOT poll when the profile is `headless` or `external` (§16, §21).

### 5.4 `ask`

A blocking question from the mod that needs the host's (for `permission`, the operator's) answer.

```ts
interface AskRequest<K extends AskKind = AskKind> extends Envelope {
  askId: AskId
  kind: K
  d?: AskPayloads[K] // MUST be present on the first tranche; MAY be omitted afterwards
}

type AskResponse<K extends AskKind = AskKind> =
  | { ok: true; state: 'pending' }
  | { ok: true; state: 'decided'; decision: AskDecisions[K] }
  | { ok: true; state: 'released'; reason: ReleaseReason }
  | Failure

type ReleaseReason = 'abstain' | 'shadow' | 'settled' | 'expired' | 'host-shutdown'
```

- The host holds each `permission` request up to `ASK_TRANCHE_MS` and answers `pending`; the mod
  re-issues the same `askId` until the state is `decided` or `released`, checking `next.signal`
  between tranches. A single fetch cannot hold past 30 s (smoke B1.1); a 20 s tranche loop held 15
  minutes at about 11 ms of hook budget (smoke B1.2, B1.7). `sentinel` and `status` asks are
  never parked: they are answered at once (§10).
- A kind the host has no handler for answers `FEATURE_DISABLED`.
- A tranche for an `askId` the host does not know that carries no `d` (a host restart with
  tickets open) answers `released` with reason `expired`.
- `released`, any `Failure`, a transport failure, a malformed body or an abort MUST make the hook
  return the engine's own verdict (`next(e)` unchanged). No failure path returns an allow (SEC-1).
- The mod MUST NOT call `ask` when `isInteractive === false` (§16).

### 5.5 `bye`

```ts
interface ByeRequest extends Envelope {
  reason: string // session.end.reason
  events?: WireEvent[] // the final flush, including `session.end`
}
type ByeResponse = { ok: true } | Failure
```

Best-effort, sent from the `session.end` hook only when `reason` is neither `clear` nor `resume`.
The mod MUST NOT retry it and MUST budget `BYE_BUDGET_MS`. A session that dies without `bye`
(SIGKILL) is detected by the PTY exit for a Harnu-spawned session and by lease expiry otherwise.

## 6. Ordering, idempotency, batching, backpressure

**Events (mod → host): at-least-once.**

1. `seq` is per `conn`, starts at 1 and increases by one per event. A new `conn` restarts at 1.
2. The host MUST drop an event whose `seq` is at or below the binding's `lastSeq` (a re-send). It
   MUST answer `ackSeq` = the **highest `seq` it has received**, also after a gap: the missing
   events were dropped by the mod and cannot be re-sent, so an `ackSeq` held at the pre-gap value
   would pin the post-gap events in the ring for ever.
3. On a gap, or when `dropped > 0`, the host accepts what arrived and answers `resync: true`. The
   mod MUST then send a `session.snapshot`. The gap is closed by the resync.
4. An event of an unknown type still advances `seq`; it is counted and not delivered (§8).
5. Events carry state rather than deltas wherever possible, so a lost event is recoverable.
6. `$` calls in flight are aborted when a turn is denied or aborted (smoke A4). The mod MUST keep
   every event in its ring until a response acknowledges it, and re-send otherwise.

**Batching.** The mod flushes when the oldest queued event is `flushMs` old, or the batch reaches
`batchMaxEvents` or `batchMaxBytes`. **Edge events flush immediately**: `turn.started`,
`turn.completed`, `attention.raised`, `attention.cleared`, `session.rebound`, `session.end`,
`ask.settled`, `command.result`, `ui.action`, `compact.done`. A flush is never awaited on a
turn's path; only `hello` and `ask` are awaited (MOD-6). The one awaited flush outside a turn's
path is the `ui.action` of `/harnu-link open`, awaited by its own `command.run` hook.

**Backpressure.**

- The mod holds at most `ringMax` unacknowledged events. Over that it drops coalescable events
  first (`usage.measured`: keep the newest, every figure in it is cumulative), then the oldest
  event, and reports the count in `dropped`.
- The host MUST reject a body over `BODY_MAX_BYTES` with HTTP 413 and MAY answer `SLOW_DOWN` with
  `retryAfterMs`. The mod MUST honour `retryAfterMs`. The host's rate bucket is
  `RATE_MAX_REQUESTS` per `RATE_WINDOW_MS` per binding, `hello` exempt.
- On a transport failure the mod re-reads the rendezvous file and backs off from
  `BACKOFF_MIN_MS` to `BACKOFF_MAX_MS` (doubling). While disconnected, sensors buffer and gates
  return `next(e)`.

**Commands (host → mod): at-least-once.**

1. Commands arrive in `poll` responses, and MAY be piggybacked on `hello` and `events` responses.
   A profile that does not poll receives them only that way, and sends its cursor in `events`.
2. The mod MUST dedupe on `cmd`, keeping the cursor and the started and resulted ids in `$.state`
   (key `channel`, §22, at most `CMD_DONE_MAX` ids each), and MUST answer every command exactly
   once with a `command.result` event (also for a refused or expired one). It writes the cursor
   **before** it starts the command.
3. The host re-sends a command whose `n` is above the request's `cursor` and that has no result
   and has not expired. The cursor acknowledges **delivery**, the result acknowledges **execution**.
4. A command past `expiresAt` MUST NOT be **started**; the result is `CMD_EXPIRED`. `expiresAt`
   gates the start only: the host waits for the result until `expiresAt +
CMD_RESULT_GRACE_MS[name]` and then records the command as lost (a failed proof, §11.2).
5. A command a previous load started and did not finish (its id is in `started`, not in
   `resulted`, and nothing is in flight) is answered `CMD_FAILED` with the message
   `interrupted by reload` and is never run again. For `prompt.submit` and `message.deliver` the
   result carries `data: { submitted: 'unknown' }`: a reload after the `$` call is not a proof of
   non-delivery.
6. The command queue is in memory, at most `CMD_QUEUE_MAX` live commands per binding. After a host
   restart (`bootId` changes) queued commands are dropped and never replayed; the mod resets its
   cursor to 0. A `session.rebound` drops the commands queued for the previous `sid`, except
   `flush` and `config.update`.

**Asks: idempotent on `askId`** within a binding. Re-asking returns the current state. A decision,
once given, is returned for every later tranche of that `askId`.

## 7. Constants

Defaults live in `contract.ts`. Those marked _config_ are sent in `hello.config` and may be
changed with `config.update` inside `CONFIG_BOUNDS`; the rest are compile-time. "design" means no
live evidence fixes the value. Host-only constants are listed because both sides test against
them or because another wave reads them; they never travel.

### 7.1 Transport, lease, batching

| Constant                 | Value     | Meaning                                                          | Wave | Evidence                                                               |
| ------------------------ | --------- | ---------------------------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| `FETCH_HARD_CAP_MS`      | 30 000    | Engine abort of any single `$.http.fetch`                        | P0   | smoke B1.1, C2 (`no complete answer within 30000ms`); not configurable |
| `POLL_HOLD_MS`           | 25 000    | Host hold of one `poll` (_config_ `pollHoldMs`)                  | P0   | smoke C2: 25 s holds ran for minutes; 25–30 s untested (CQ7)           |
| `ASK_TRANCHE_MS`         | 20 000    | Host hold of one `permission` tranche (_config_ `askHoldMs`)     | P0   | smoke B1.2, B1.7: 20 s tranches held 15 min                            |
| `HELLO_SLA_MS`           | 2 000     | Host must answer `hello`                                         | P0   | design; hello blocks the first prompt (smoke A2)                       |
| `HELLO_WAIT_MS`          | 2 500     | Mod: longest a hook waits for a hello before returning `next(e)` | P1W3 | design; a 4 s hold delayed the prompt to 4.8 s (smoke A2)              |
| `SPAWN_REDEEM_WINDOW_MS` | 600 000   | Host: an unredeemed spawn token is dead after this               | P1W3 | design                                                                 |
| `DRIFT_CHECK_MIN_MS`     | 1 000     | Mod: floor between two `$.session.id()` drift reads (§15)        | P1W3 | design                                                                 |
| `BYE_BUDGET_MS`          | 1 000     | Mod budget for `bye`; designed for the 1.5 s bound               | P0   | types L10329 (1.5 s); smoke C2 read 5 000 ms; unresolved, C13 (CQ1)    |
| `LEASE_TTL_MS`           | 20 000    | Lease freshness window (§11.3)                                   | P0   | D4; covers a hot reload (0.6–10 s, smoke A5, C2)                       |
| `LEASE_SWEEP_MS`         | 5 000     | Host: period of the lease edge detection                         | P1W1 | design                                                                 |
| `HEARTBEAT_MS`           | 10 000    | Empty `events` when nothing else renews the lease (_config_)     | P0   | design; `$.clock.every` does not delay `-p` exit (smoke C2)            |
| `FLUSH_MS`               | 250       | Max age of a queued event (_config_ `flushMs`)                   | P0   | design; one POST costs 2 ms median, 14 ms p90 (smoke A4)               |
| `BATCH_MAX_EVENTS`       | 32        | Events per batch (_config_)                                      | P0   | design                                                                 |
| `BATCH_MAX_BYTES`        | 65 536    | Bytes per batch (_config_)                                       | P0   | design                                                                 |
| `RING_MAX`               | 256       | Unacknowledged events kept by the mod (_config_)                 | P0   | design                                                                 |
| `BODY_MAX_BYTES`         | 1 048 576 | Host body cap                                                    | P0   | design                                                                 |
| `SOCKET_PATH_MAX_BYTES`  | 90        | Longest Unix socket path before the TCP fallback                 | P1W1 | types L4897 ("near 100 B"); 90 is a design margin (CQ6)                |
| `RATE_WINDOW_MS`         | 10 000    | Host rate bucket window                                          | P1W1 | design (settles CQ11)                                                  |
| `RATE_MAX_REQUESTS`      | 200       | Requests per binding per window; `hello` exempt                  | P1W1 | design (settles CQ11)                                                  |
| `BACKOFF_MIN_MS`         | 500       | First reconnect delay                                            | P0   | design                                                                 |
| `BACKOFF_MAX_MS`         | 15 000    | Reconnect delay ceiling                                          | P0   | design                                                                 |
| `HOOK_BUDGET_MS`         | 10 000    | Engine budget per dispatch; stops during a `$` call              | —    | types L4776; smoke B1.2                                                |
| `WEDGE_MS`               | 5 000     | Engine heartbeat: a spinning hook unloads its mod                | —    | smoke B6                                                               |

### 7.2 Commands and asks

| Constant                         | Value                                    | Meaning                                                                        | Wave | Evidence                                                       |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------- |
| `CMD_TTL_MS`                     | 30 000                                   | Default `expiresAt - issuedAt`; a wave may set its own                         | P0   | design                                                         |
| `CMD_QUEUE_MAX`                  | 64                                       | Live commands per binding                                                      | P2W1 | design                                                         |
| `CMD_DONE_MAX`                   | 64                                       | Started and resulted ids the mod remembers in `$.state`                        | P2W1 | design                                                         |
| `CMD_RESULT_GRACE_MS`            | default 5 000; `session.compact` 120 000 | Host wait for a result after `expiresAt`, per command name                     | P2W1 | smoke C2: an idle compaction answers after 14–37 s             |
| `CMD_ACCEPT_MS`                  | 1 000                                    | Mod: a fired prompt with no rejection for this long is reported accepted       | P2W2 | design (CQ15)                                                  |
| `PROMPT_MAX_CHARS`               | 30 000                                   | Largest `prompt.submit.text`                                                   | P0   | smoke C1: 30 000 chars arrived intact; larger untested         |
| `START_PROMPT_CLAIM_WAIT_MS`     | 2 000                                    | Host: how long the legacy paste gate waits for a hello                         | P2W2 | design                                                         |
| `START_PROMPT_CONFIRM_MS`        | 15 000                                   | Host: wait for `turn.started {cmd}` or a plugin-origin transcript row          | P2W2 | design                                                         |
| `MESSAGE_TTL_MS`                 | 10 000                                   | `expiresAt - issuedAt` of `message.deliver`                                    | P2W3 | design                                                         |
| `MESSAGE_RESULT_WAIT_MS`         | 5 000                                    | Host: how long the verb waits for the command's outcome                        | P2W3 | design                                                         |
| `MESSAGE_HELLO_GRACE_MS`         | 3 000                                    | Host: after a wake, how long to prefer the companion over a ready socket       | P2W3 | design                                                         |
| `MESSAGE_MAX_CHARS`              | 4 096                                    | Largest `message.deliver.text`                                                 | P2W3 | the existing verb cap (`messaging-socket.ts:218`)              |
| `CONTEXT_MAX_CHARS`              | 20 000                                   | Largest `context.append.text`, durable or not                                  | P2W4 | design; the orchestrator contract (about 8 200 chars) must fit |
| `CONTEXT_APPEND_WAIT_MS`         | 5 000                                    | Host wait for the append result before falling back                            | P2W4 | design                                                         |
| `REINJECT_DELAY_MS`              | 1 500                                    | Mod: delay of a deferred append after a compaction                             | P2W4 | smoke D5 variant B                                             |
| `DURABLE_MAX_ROWS`               | 4                                        | Durable rows the mod keeps per session                                         | P2W4 | design                                                         |
| `GUARD_FLAG_TTL_MS`              | 60 000                                   | Mod ignores its armed flag this long after the last host answer                | P2W4 | design                                                         |
| `GUARD_WALK_MAX`                 | 16                                       | Parent levels the guard climbs to place a path that does not exist yet         | P2W4 | design                                                         |
| `STAMP_NONCE_RING`               | 512                                      | Host: replay window of stamp nonces per binding                                | P2W5 | design                                                         |
| `ASK_ORPHAN_MS`                  | 45 000                                   | Host releases an ask nobody re-asked                                           | P0   | design: two tranches plus margin                               |
| `ASK_CORRELATE_WINDOW_MS`        | 5 000                                    | Oldest `tool.check` record a `PermissionRequest` may claim                     | P3W1 | design                                                         |
| `ASK_RECORD_MAX`                 | 64                                       | `tool.check` records the mod keeps; the oldest is dropped                      | P3W1 | design                                                         |
| `ASK_INPUT_MAX_BYTES`            | 65 536                                   | Cap of an ask's `input`                                                        | P3W1 | design                                                         |
| `SENTINEL_CHECK_BUDGET_MS`       | 500                                      | Mod: longest wait for a `sentinel` answer                                      | P3W2 | design; one POST costs 2 ms median, 14 ms p90 (smoke A4)       |
| `SENTINEL_TOOLS_MAX`             | 32                                       | Tool names in one `sentinel.set`                                               | P3W2 | design                                                         |
| `STATUS_SLA_MS`                  | 1 000                                    | Host must answer a `status` ask                                                | P4W2 | design; the command blocks the prompt line until it answers    |
| `STATUS_TEXT_MAX`                | 400                                      | Mod: longest `/harnu-link status` output, in characters                        | P4W2 | design; the row is model-visible (smoke C4)                    |
| `BAND_TTL_MS`                    | 90 000                                   | Mod clears a band line this long after it was set                              | P4W2 | design                                                         |
| `BAND_REFRESH_MS`                | 60 000                                   | Host keep-alive re-send of a standing band line                                | P4W2 | design                                                         |
| `BAND_DEBOUNCE_MS`               | 500                                      | Host debounce before a changed band line is sent                               | P4W2 | design                                                         |
| `OPEN_MIN_INTERVAL_MS`           | 5 000                                    | Host: at most one window focus per binding per interval                        | P4W2 | design                                                         |
| `EXTERNAL_MAX_BINDINGS`          | 32                                       | Live external bindings                                                         | P4W3 | design                                                         |
| `EXTERNAL_CORROBORATE_MS`        | 30 000                                   | An external binding not corroborated this long after its first turn is dropped | P4W3 | design                                                         |
| `PLAN_CAPTURE_WAIT_MS`           | 8 000                                    | Longest a park waits for `plan.capture`; also its `expiresAt - issuedAt`       | P4W4 | design; a warm fork took 1.9–3.3 s (smoke D4)                  |
| `PLAN_TEXT_MAX_CHARS`            | 600                                      | Mod: cap of `plan.capture`'s `data.text`                                       | P4W4 | design                                                         |
| `COMPACT_SUMMARY_WIRE_MAX_CHARS` | 16 000                                   | Largest `compact.done.summary`                                                 | P4W5 | design; smoke D5: about 1 036 output tokens                    |
| `PLAN_USAGE_STALE_MS`            | 90 000                                   | No leased `usage.measured` for this long → `/usage` poll                       | P0   | D11; `usage.ts` `POLL_INTERVAL_MS`                             |

```ts
/** Bounds for `config.update`; a value outside them is CMD_PRECONDITION (P2W1). */
const CONFIG_BOUNDS: Record<keyof Config, [min: number, max: number]> = {
  flushMs: [50, 5_000],
  batchMaxEvents: [1, 256],
  batchMaxBytes: [1_024, 524_288],
  ringMax: [32, 1_024],
  pollHoldMs: [1_000, 25_000],
  askHoldMs: [1_000, 20_000],
  heartbeatMs: [2_000, 15_000]
}

const STAMP_ARG = '_harnuCaller' // P2W5
const STAMP_PROOF_VERSION = 'v1' // P2W5
```

Host-only values that stay in their wave spec and are **not** contract constants: `HELLO_GRACE_MS`
(P1W4), `COST_SETTLE_MS` (P1W6), the `PLAN_*` policy values other than the two above (P4W4), the
recap and summary-classifier limits (P4W5), the Sentinel lexer limits (P3W2), `RETIRE_SOAK_DAYS`
(P5W1).

A `FETCH_HARD_CAP_MS` abort is a normal reconnect, never an error (D3).

## 8. Events (mod → host)

```ts
interface EventPayloads {
  'session.snapshot': {
    reason: 'hello' | 'resync' | 'flush' | 'probe'
    activeTurnId: string | null
    openAttention: { kind: AttentionKind; toolUseId?: string }[]
    runningSubagents: number
    probes: { classic: boolean; toolCheck: boolean } // §11.2
  }
  'session.rebound': { prevSid: Sid; sid: Sid; cause: 'clear' | 'resume' | 'unknown' }
  'session.end': { reason: string }
  'mod.error': {
    where: string // a feature id or a hook-level tag (`compact.reinject`), never a payload
    kind: 'throw' | 'timeout' | 'abort' | 'registration'
    message: string // capped at 512 chars
    cmd?: CmdId // the command the error belongs to, when it arrives after the result
  }
  'turn.started': { origin: 'human' | 'plugin' | 'peer' | 'unknown'; cmd?: CmdId }
  'turn.completed': {
    reason: 'answer' | 'aborted' | 'refusal' | 'error'
    isAborted: boolean
    durationMs: number
    usage?: TurnUsage
    backgroundTasks?: number // informational: every running background task
    backgroundSubagents?: number // running subagents at the end of a main turn; this one holds the state
    failure?: { type: string } // classic.StopFailure.error, e.g. "rate_limit"
  }
  'attention.raised': {
    kind: AttentionKind
    source: 'check' | 'request' | 'notification'
    toolUseId?: string
    tool?: string
  }
  'attention.cleared': {
    kind: AttentionKind
    toolUseId?: string
    cause: 'tool-settled' | 'ask-resolved' | 'turn-completed' | 'prompt'
  }
  'subagent.started': { agentType: string; agentId?: string }
  'subagent.stopped': { agentType: string; agentId?: string }
  'usage.measured': {
    source: 'measure' | 'read' // 'read' = the mod asked $.session.usage(): a full state re-send
    context?: { window: number; tokens?: number; percent?: number }
    rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
    costUsd?: number
    changed: ('context' | 'rateLimits' | 'cost')[]
    startedAt?: number // epoch ms, only on 'read'
    model?: string // $.session.model(), only on 'read'; opaque
  }
  'command.result': {
    cmd: CmdId
    ok: boolean
    code?: ErrorCode
    message?: string
    data?: CommandResultData[CommandName] // §9
  }
  'message.sent': {
    origin: 'model' | 'plugin'
    plugin?: string
    to: string
    delivered: boolean
    reason?: string // capped at 200 chars
    bytes: number
    hash?: string // 12 hex chars of SHA256(text); omitted when the digest is unavailable
  }
  'message.received': {
    originKind: string // e.origin.kind; the sender's claim, never a guard
    plugin?: string
    fromName?: string
    from?: string // the envelope's from address, when present
    bytes: number
    hash?: string
    outcome: 'queued' | 'consumed' | 'rewritten'
  }
  'guard.denied': { tool: string; path: string; toolUseId?: string }
  'guard.evaluated': {
    tool: string
    path: string // relative to the session cwd when inside it, else absolute
    subagent: boolean
    decision: 'allow' | 'deny'
    exempt?: 'harnu' | 'scratch' | 'memory'
    toolUseId?: string
  }
  // 'tool-failed' is defined, not required: see the rules below (C3)
  'ask.settled': { askId: AskId; cause: 'tool-ran' | 'tool-failed' | 'aborted' | 'turn-ended' }
  'ui.action': { name: 'open' }
  'compact.done': {
    trigger: 'manual' | 'auto' | 'plugin'
    via: 'hook' | 'command' | 'classic' // which mod path observed it
    tokensBefore?: number // optional in the engine's result (types L10050–10059)
    tokensAfter?: number
    usage?: AuxUsage // the summarizer's own request; absent when core made none
    summary?: string // only when `opts.compactSummary` is set; cut to COMPACT_SUMMARY_WIRE_MAX_CHARS
    summaryTruncated?: boolean
    summaryChars: number // always present
    reinjected: number // durable rows returned through `messages` or queued for the deferred append
  }
  'mod.admitted': {
    name: string
    tier: 'prepend' | 'user' | 'append' | 'builtin'
    root: string // absolute; host-side only, never written to a ledger
    version?: string
    provenance: string // `<name>@inline`, `<name>@<marketplace>`, `<name>@skills-dir`
    uses: {
      events: string[]
      calls: string[]
      env: { reads: string[]; writes: string[] }
      state: { reads: { plugin: string; key: string }[]; writes: { plugin: string; key: string }[] }
    }
  }
}

type AttentionKind = 'permission' | 'idle' | 'input'

/** A model request's token counts. Fork, complete and compaction results carry no model. */
interface AuxUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

interface TurnUsage extends AuxUsage {
  model: string
}
```

| Event               | Derived from (CLI 2.1.287; unchanged on 2.1.289 unless noted)                                                                                                                                                                                                                           | Feature           | Wave |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---- |
| `session.snapshot`  | mod state; sent after hello, on `resync`, on `flush`, and when a probe flips. Before `sense.turn` exists the turn fields carry neutral values                                                                                                                                           | `sense.identity`  | P1W3 |
| `session.rebound`   | `classic.SessionStart {source: clear \| resume}.session_id`; fallback: `$.session.id()` drift (§15)                                                                                                                                                                                     | `sense.identity`  | P1W3 |
| `session.end`       | `session.end` with a reason other than `clear`/`resume`                                                                                                                                                                                                                                 | `sense.identity`  | P1W3 |
| `mod.error`         | a hook's own `catch`; a failed `on()` registration; a refused stamp rewrite; a late command rejection                                                                                                                                                                                   | `sense.identity`  | P1W3 |
| `turn.started`      | `turn.start`; `origin` from the preceding `prompt.submit` event's `origin.kind` (smoke C1, D1); `cmd` from the mod's own queue of submitted commands (§11.4)                                                                                                                            | `sense.turn`      | P1W5 |
| `turn.completed`    | `turn.complete` (main loop and, with `agentId`, subagents); `backgroundTasks` and `backgroundSubagents` from `classic.Stop.background_tasks` (`type === 'subagent'`, types L641) and the mod's own subagent counter; `failure` from `classic.StopFailure.error`                         | `sense.turn`      | P1W5 |
| `attention.raised`  | `tool.check` → `ask` (`source: check`, has `toolUseId`); `classic.PermissionRequest` (`request`); `classic.Notification` (`notification`: `permission_prompt` and `worker_permission_prompt` → `permission`, `elicitation_dialog` → `input`, `idle_prompt` → `idle`; other types: none) | `sense.attention` | P1W5 |
| `attention.cleared` | `classic.PostToolUse` (`tool-settled`); the mod's own ask resolution (`ask-resolved`, P3W1); `turn.complete` (`turn-completed`); the next `prompt.submit` event (`prompt`)                                                                                                              | `sense.attention` | P1W5 |
| `subagent.started`  | `classic.SubagentStart`                                                                                                                                                                                                                                                                 | `sense.subagent`  | P1W5 |
| `subagent.stopped`  | `classic.SubagentStop`; the stray one with `agent_type: ""` MUST be dropped (smoke A4)                                                                                                                                                                                                  | `sense.subagent`  | P1W5 |
| `usage.measured`    | `session.measure` (`source: measure`); an un-awaited `$.session.usage()` and `$.session.model()` after a hello, a `resync` and a `flush` (`source: read`)                                                                                                                               | `sense.usage`     | P1W6 |
| `command.result`    | the mod's own execution of a command                                                                                                                                                                                                                                                    | `act.channel`     | P2W1 |
| `message.sent`      | `session.send` event (native SendMessage shows `origin.kind: "model"`, smoke D1)                                                                                                                                                                                                        | `sense.message`   | P2W3 |
| `message.received`  | `session.receive` event                                                                                                                                                                                                                                                                 | `sense.message`   | P2W3 |
| `guard.denied`      | the guard's own `tool.call` deny                                                                                                                                                                                                                                                        | `gate.guard`      | P2W4 |
| `guard.evaluated`   | the guard's verdict when `guard.set.enforce` is `false`: recorded, never applied                                                                                                                                                                                                        | `gate.guard`      | P2W4 |
| `ask.settled`       | `classic.PostToolUse`; `next.signal` abort; `turn.complete`                                                                                                                                                                                                                             | `gate.approval`   | P3W1 |
| `ui.action`         | the mod's own `/harnu-link open` command                                                                                                                                                                                                                                                | `ui.command`      | P4W2 |
| `compact.done`      | the result of `next(e)` in the `session.compact` hook (`messages[0].text` is the summary, smoke D5); the mod's own `$.session.compact()` result (`via: command`, `trigger: plugin`); `classic.PostCompact.compact_summary` when neither ran                                             | `sense.compact`   | P4W5 |
| `mod.admitted`      | `plugin.register`, after `next(e)` allows. Not an edge event                                                                                                                                                                                                                            | `sense.mods`      | P4W1 |

Rules for every event:

- There is **no "dialog answered" event** in the CLI (smoke A4). `attention.cleared` is therefore
  late for a locally approved call: it arrives when the tool finishes. Consumers MUST NOT read the
  absence of `attention.cleared` as "still waiting on a human" once a turn has completed.
- `attention.raised` with `source: 'check'` is **record-only**: under `dontAsk` and in `-p` the
  hook sees an `ask` verdict and no dialog follows (smoke B1.6), so a consumer MUST NOT fold it
  into a waiting state. It exists for its `toolUseId`.
- **Teammates (CLI 2.1.289, smoke §11.4).** `AgentInfo` gains `teammateId` (`<name>@<team>`), `AgentSpawnInput` gains
  `isTeammate`, and `AgentStatus` is a union with `waiting` and `idle` (smoke §11.5). A teammate is a distinct agent kind, not a
  subagent: `subagent.started`/`subagent.stopped` and `runningSubagents`/`backgroundSubagents` keep their meaning, no
  consumer may treat every agent id as a subagent, and fleet state and attribution are keyed on the agent id (P1W5, OQ).
- `classic.PostToolUseFailure` was never observed firing (C3). The mod MAY hook it and map it to
  `tool-settled` / `tool-failed`, but no exit may depend on it: after a user "No" there is no
  `PostToolUse` at all and the exit is `turn.completed` (smoke A4).
- `message.sent` cannot audit a failed `{sessionId}` lookup: it never reaches the `session.send`
  hook (smoke D1; ADR C7).
- A main-loop `turn.completed` is **not** idle while `backgroundSubagents > 0` (D12).
  `backgroundTasks` is informational and does not hold the state: no edge ends a background
  shell, monitor or workflow, so holding on them would turn into a false "stuck". A user "No"
  produces `turn.completed {reason: "answer"}` with no stop event (smoke A4).
- A `usage.measured` with `source: 'read'` is a state re-send; the host MUST NOT treat it as a
  moved unit. `rateLimits[].kind` is a string because the CLI types it as one (types L10571): the
  host maps `five_hour` and `seven_day`, records `spend_limit` and ignores the rest.
- `turn.step` is not hooked in protocol 1 (D12). `turn.progress` is reserved (§18).
- Payloads MUST NOT carry prompt text, tool input, file content or secrets unless the payload type
  above names the field. The named exceptions are `compact.done.summary`, an ask's `input`, and
  the `text` and `title` of `plan.capture`'s result. `guard.denied.path` is relative to the
  session cwd.
- The host MUST ignore an unknown `t` (counting it) and unknown fields.

## 9. Commands (host → mod)

```ts
interface CommandArgs {
  flush: Record<string, never>
  'config.update': { config: Partial<Config> }
  'turn.abort': { turnId?: string }
  'session.compact': Record<string, never> // protocol 1: no instructions (smoke D5)
  'ui.toast': { text: string }
  'ui.status': { text: string | null }
  'prompt.submit': {
    text: string
    asUser: boolean
    via: 'prompt' | 'command'
    command?: string // via 'command': the slash command name, without "/"
    args?: string
  }
  'message.deliver': { msgId: string; from: { name: string; sessionKey?: string }; text: string }
  'context.append': { key: ContextKey; text: string; durable: boolean; retainOnly?: boolean }
  'context.drop': { key: ContextKey }
  'guard.set': { armed: boolean; enforce?: boolean } // enforce defaults to true
  'sentinel.set': { tools: string[] } // exact tool names; [] turns the query off
  'ui.band.set': { line: string | null; parts?: BandParts; link?: BandLink }
  'plan.capture': { title?: boolean }
}

interface BandParts {
  lead: string // at most 32 chars
  detail?: string // at most 48 chars
  hint?: string // at most 32 chars
}
interface BandLink {
  label: string // at most 16 chars
  href: string // http://localhost:<port>/o/<Ticket> only; a refused href drops the link, not the line
}

/**
 * `command.result.data`, keyed by command name. Commands not listed carry no data. These are
 * RESULT shapes; a key here repeats a CommandArgs key on purpose (the same command, other side).
 */
interface CommandResultData {
  'session.compact': { tokensBefore?: number; tokensAfter?: number } | { skipped: true }
  'prompt.submit': SubmitResultData
  'message.deliver': SubmitResultData & { reason?: 'permission-mode' }
  'guard.set': { armed: boolean } // result: the flag the mod stored; the args also carry `enforce`
  'plan.capture': PlanCaptureData
}

interface SubmitResultData {
  submitted: true | false | 'unknown' // 'unknown': fired by a load that was reloaded
}

interface PlanCaptureData {
  text: string | null // the fork's reply, cut to PLAN_TEXT_MAX_CHARS by the mod
  reason?: 'nothing-to-fork' | 'api-error' | 'empty-reply' | 'aborted' // when text is null
  status?: number | null // api-error only
  usage?: AuxUsage // absent when no request was made
  title?: string | null
  titleUsage?: AuxUsage
  ms: number // wall time of the fork
}

/** Pure, in contract.ts: the frame of a peer message (mod, fixtures and transcript readers share it). */
declare function framePeerMessage(args: CommandArgs['message.deliver']): string
```

| Command           | Mod action                                                                                                                                               | Preconditions and refusals                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Profiles                        | Feature         | Wave |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | --------------- | ---- |
| `flush`           | flush the ring, send `session.snapshot`                                                                                                                  | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | interactive, headless, external | `act.channel`   | P2W1 |
| `config.update`   | apply `Config` fields, all or none                                                                                                                       | a value outside `CONFIG_BOUNDS` → `CMD_PRECONDITION`                                                                                                                                                                                                                                                                                                                                                                                                                                           | interactive, headless, external | `act.channel`   | P2W1 |
| `turn.abort`      | `$.turn.abort({turnId})`, using the id from its own `turn.start` hook when omitted                                                                       | no running turn → `CMD_PRECONDITION` (smoke C2: "no turn is running")                                                                                                                                                                                                                                                                                                                                                                                                                          | interactive                     | `act.turn`      | P2W1 |
| `session.compact` | `$.session.compact()`, fired un-awaited from the poll loop                                                                                               | **rejects mid-turn** → `CMD_PRECONDITION` (smoke C2); never from a `command.run` hook (smoke D5). A compaction another hook vetoed is `ok: true` with `data: { skipped: true }`. The args are `{}` in protocol 1: no `instructions` (smoke D5: an instruction can make the summarizer refuse)                                                                                                                                                                                                  | interactive                     | `act.compact`   | P2W1 |
| `ui.toast`        | `$.ui.toast`                                                                                                                                             | text ≤ 200 chars; the text comes from a constant table in main, never from a caller                                                                                                                                                                                                                                                                                                                                                                                                            | interactive                     | `act.ui`        | P2W1 |
| `ui.status`       | `$.ui.status`; `null` clears                                                                                                                             | text ≤ 200 chars; same constant table                                                                                                                                                                                                                                                                                                                                                                                                                                                          | interactive                     | `act.ui`        | P2W1 |
| `prompt.submit`   | `via: prompt` → `$.prompt.submit({text, asUser})`; `via: command` → `$.command.run`                                                                      | `text` ≤ `PROMPT_MAX_CHARS`; `via: prompt` with text starting `/` → `CMD_PRECONDITION` (the engine rejects it, smoke C1); `via: command` needs a command that exists, is not the companion's own and whose `CommandInfo.source` is not `builtin` (a panel command blocks the call until dismissed, smoke C1); `@file` is not expanded; mid-turn it queues until the turn ends (smoke C2)                                                                                                       | interactive                     | `act.prompt`    | P2W2 |
| `message.deliver` | submit `framePeerMessage(args)` with `$.prompt.submit`, never `asUser`                                                                                   | `text` ≤ `MESSAGE_MAX_CHARS`; **bypass-parity rule**: the last `permission_mode` the mod saw is `bypassPermissions`, or it has seen none → `CMD_PRECONDITION` with `data: { submitted: false, reason: 'permission-mode' }`; success means "written", never "read" (D10)                                                                                                                                                                                                                        | interactive                     | `act.message`   | P2W3 |
| `context.append`  | `$.session.append` of a hidden user-role row; `durable` also stores the row under `key`; `retainOnly` stores without appending                           | `text` > `CONTEXT_MAX_CHARS` → `CMD_PRECONDITION`; `retainOnly` requires `durable`; more than `DURABLE_MAX_ROWS` keys → `CMD_PRECONDITION`; the text is built by the host from a closed registry, never caller-supplied; a row cannot be retracted, a later row with the same `key` supersedes it (smoke C3); `durable: false` appends without storing and never deletes a stored durable row (`context.drop` is the only removal path); never synchronously inside the `session.compact` hook | interactive                     | `act.context`   | P2W4 |
| `context.drop`    | remove the stored durable row for `key`, the only removal path; no transcript effect                                                                     | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | interactive                     | `act.context`   | P4W5 |
| `guard.set`       | store `{armed, enforce}` in `$.state`; the guard hook reads it per call                                                                                  | none; the hook itself denies only `Edit\|Write\|NotebookEdit`, exempting subagents and the surfaces of §23 by `realPath` (D6; C1). With `enforce: false` the hook reports `guard.evaluated` and returns `next(e)`                                                                                                                                                                                                                                                                              | interactive                     | `gate.guard`    | P2W4 |
| `sentinel.set`    | replace the set of watched tool names                                                                                                                    | more than `SENTINEL_TOOLS_MAX` names, or a non-string → `CMD_PRECONDITION`; names only (SEC-5a)                                                                                                                                                                                                                                                                                                                                                                                                | interactive                     | `gate.sentinel` | P3W2 |
| `ui.band.set`     | store the band line in `$.state`; the `AbovePrompt` hook draws it. Never applied as `$.ui.status`: when `ui.band` could not be declared there is no line | the band wraps `next(e)`; a line stands at most `BAND_TTL_MS`; a lower `n` never overwrites a higher one                                                                                                                                                                                                                                                                                                                                                                                       | interactive, external           | `ui.band`       | P4W2 |
| `plan.capture`    | `$.model.fork` with a prompt fixed in the mod; `title: true` adds one `$.model.complete`                                                                 | a running turn → `CMD_PRECONDITION`, no model call. Every fork outcome is `ok: true`: `data.text` is the reply, or `null` with `data.reason` (the engine returns `nothing-to-fork` before the first response and after `/clear`; types L2407 "always a result, never null"). A lapsed prompt cache does not fail the call: it re-bills the whole prefix (types L2404)                                                                                                                          | interactive                     | `act.plan`      | P4W4 |

Rules for every command:

- The enum is **closed**. There is no command that takes a path, a shell string, code or a file to
  read, and none will be added (SEC-5). There is no command that resolves an approval (SEC-2).
- The mod answers an unknown `name` with `CMD_UNSUPPORTED` and a command for a feature the host
  did not enable with `FEATURE_DISABLED`.
- **Tokenless second lock.** A mod whose hello carried no spawn token answers every command other
  than `flush`, `config.update` and `ui.band.set` with `CMD_UNSUPPORTED`, without looking at
  `enable`. A forged or rewritten response therefore cannot make an outside session run a prompt
  (SEC-3d, §21).
- The host MUST gate the origin of every command server-side and write an audit record before it
  queues the command (SEC-5, SEC-6). The mod's log is not an audit.
- The mod MUST NOT await `prompt.submit`, `session.compact`, `$.command.run`, `$.session.append`
  or `$.model.fork` inside the poll loop (smoke C2); it fires them and reports the result when
  they settle. A prompt fired with no rejection within `CMD_ACCEPT_MS` is reported
  `submitted: true`; a rejection that arrives later is a `mod.error` carrying `cmd`.
- A `/`-prefixed start prompt travels as `prompt.submit` with `via: 'command'`. There is no
  separate "run command" wire command (D13).
- **Observe-only commands** are `flush`, `config.update`, `guard.set` with `enforce: false`,
  `sentinel.set` and `ui.band.set` (display-only, with no legacy rival). They are the only commands
  the host may issue while the command channel is in `shadow` (§11.5).

## 10. Asks (mod → host)

```ts
type AskKind = 'permission' | 'sentinel' | 'status'

interface AskPayloads {
  permission: {
    tool: string
    input: unknown // JSON, capped at ASK_INPUT_MAX_BYTES
    inputTruncated?: boolean
    toolUseId?: string // from the pass-through tool.check record
    ambiguous?: boolean // two or more identical asks were open at correlation time
    askedBy?: 'engine' | 'hook' // 'hook' when the correlated tool.check result carried `hook` (CLI 2.1.289)
    hook?: string // the classic hook event that decided the ask, verbatim from tool.check `hook`
    agentId?: string
    agentType?: string
    permissionMode: string
    cwd: string
    suggestions?: unknown
  }
  sentinel: {
    tool: string
    input: unknown // capped at ASK_INPUT_MAX_BYTES; a truncated input is answered `released`
    inputTruncated?: boolean
    toolUseId: string
    verdict: 'allow' | 'ask' | 'deny' // the engine's, for the ledger
    cwd: string
  }
  status: { columns: number; isFullscreen: boolean } // from command.run `presentation`
}

interface AskDecisions {
  permission: { behavior: 'allow' } | { behavior: 'deny'; message: string }
  sentinel: { behavior: 'deny'; message: string } // there is no allow
  status: StatusReport
}

/** Enums and integers only: the mod builds closed-vocabulary text from it (the row is model-visible). */
interface StatusReport {
  companion: 'live' | 'shadow' // 'shadow': no fact family of this binding is in `active`
  profile: 'interactive' | 'external' // a headless mod never asks
  coverage: 'gated' | 'contested' | 'not-gated'
  held: number // asks held for this session
  mission: {
    from: number
    to: number
    of: number
    complete: boolean
    verified: number
    waitingOnOperator: number
  } | null
}
```

### 10.1 `permission` (P3W1, feature `gate.approval`)

Raised from the `classic.PermissionRequest` hook, not from `tool.check` (D5, smoke B1.7). The
native dialog stays open and usable while the ask is pending, a remote answer closes it, and the
first answer wins natively.

- `tool.check` is pass-through: it records `{tool, toolUseId, inputKey, at}` when the verdict is
  `ask` and returns the verdict unchanged, **except a host Sentinel deny** (§10.2): the hook may
  tighten, never loosen. `classic.PermissionRequest` has `agent_id` but no `tool_use_id`, so the
  mod correlates the two inside `ASK_CORRELATE_WINDOW_MS`. A wrong pairing is marked `ambiguous`.
  Since CLI 2.1.289 the `tool.check` result may carry `hook?: string`, the classic hook event that decided the
  verdict (absent on a `$.tool.check` query; smoke §11.4). The mod stores it in the record and sends it as `hook`
  with `askedBy: 'hook'`, so a policy-hook ask can be told from an engine ask. It is a label and an audit field:
  it never changes the pairing rule or a decision, and an absent `hook` means `askedBy: 'engine'`.
- A remote `allow` is **not final**. On a managed machine a managed deny or ask rule on a nested part of a compound
  shell command still wins over a user-installed mod's approval (CLI 2.1.289, smoke §11.5). The host MUST NOT
  infer that the tool ran from an `allow`: only `classic.PostToolUse` (`tool-ran`) says so, and a turn that ends
  with no `PostToolUse` after an `allow` is reported as "allowed, then blocked by policy" or, when no managed rule is known,
  "allowed, no result seen" (P3W1 §10).
- The hold keeps its own `try/catch` that returns `next(e)`. Since CLI 2.1.288 the engine blocks a call when matching
  or serialising a PreToolUse or PermissionRequest hook fails (smoke §11.5), so a fail-open hold is guaranteed only by
  this code.
- The mod does not ask when `permission_mode` is `dontAsk` (the operator chose not to be asked):
  the hook returns `next(e)`.
- The mod maps `decided` to `{ decision: { behavior } }` and every other outcome to `next(e)`.
- A local "Yes" does not cancel the hook (smoke B1.7): the mod MUST send `ask.settled` from
  `classic.PostToolUse` (`tool-ran`), on `next.signal` abort (`aborted`; a request issued from the
  abort listener still goes out, smoke B1.4) and on the turn's `turn.complete` (`turn-ended`, the
  only exit after a user "No", C3). The host MUST release the ask on `ask.settled`.
- The host releases an ask that nobody re-asked within `ASK_ORPHAN_MS`.
- A `deny` message reaches the model bare (smoke B1.7), so it MUST stand alone as a sentence.
- The host answers `released` with reason `shadow` at once, without running its resolver chain,
  when the `approval` family is not `active` for the binding, and `abstain` when the session is
  not owned for another reason. The host never holds for a session it does not own.

### 10.2 `sentinel` (P3W2, feature `gate.sentinel`)

Sent from the shared `tool.check` hook for a call of a watched tool (the set of `sentinel.set`),
after `next(e)` and before the record of §10.1, raced against `SENTINEL_CHECK_BUDGET_MS`.

- The host answers at once; a `sentinel` ask is never parked and creates no ticket.
- A `decided` answer can only be a deny. The mod then returns `{ decision: 'deny', reason }` from
  `tool.check`. A timeout, a failure, `released` or a malformed body leave the engine's verdict
  untouched (SEC-1) and queue at most one `mod.error` per minute.
- While the `sentinel` key is `shadow` the host records both engines' verdicts and answers
  `released` with reason `shadow`.
- Not available headless (MOD-5), nor when `tool.check` is pinned by policy.

### 10.3 `status` (P4W2, feature `ui.command`)

Sent by `/harnu-link status`. It is a read: the host answers `decided` at once, within
`STATUS_SLA_MS`, **in every rollout mode** and for the `interactive` and (once corroborated, §21)
`external` profiles. It is never released as `shadow`. Any other outcome makes the mod print its
local line. No audit record is written (nothing changes).

## 11. Features, proof, lease

### 11.1 Feature ids

"Enabled by" names what must be on, besides "companion mode is not `off`" (the kill switch is on
and the CLI gate is not `below` or `unknown`). Hooks marked _shared_ have one registration for
several features (§11.4). "opt." marks an optional hook: a failed registration is reported as
`mod.error` and does not remove the feature from `declared`.

| Feature           | Class    | Fact family              | Enabled by                                                                                      | Mod hooks and `$` surface it needs                                                                                                                                                            | Wave |
| ----------------- | -------- | ------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `sense.identity`  | sensor   | `identity`               | always                                                                                          | `session.start`, `session.end`, `classic.SessionStart` (shared)                                                                                                                               | P1W3 |
| `sense.turn`      | sensor   | `taskState`              | family `taskState` ≠ `off`                                                                      | `turn.start` (shared), `turn.complete` (shared), `prompt.submit` event (shared)                                                                                                               | P1W5 |
| `sense.attention` | sensor   | `taskState`              | family `taskState` ≠ `off`                                                                      | `tool.check` (shared), `classic.PermissionRequest` (shared), `classic.Notification`, `classic.PostToolUse` (shared), `classic.Stop`; opt. `classic.PostToolUseFailure`, `classic.StopFailure` | P1W5 |
| `sense.subagent`  | sensor   | `taskState`              | family `taskState` ≠ `off`                                                                      | `classic.SubagentStart`, `classic.SubagentStop`                                                                                                                                               | P1W5 |
| `sense.usage`     | sensor   | `telemetry`, `planUsage` | family `telemetry` or `planUsage` ≠ `off`                                                       | `session.measure`; `$.session.usage`, `$.session.model`                                                                                                                                       | P1W6 |
| `act.channel`     | actuator | —                        | key `channel` ≠ `off`                                                                           | the poll loop                                                                                                                                                                                 | P2W1 |
| `act.turn`        | actuator | —                        | key `channel` = `active`                                                                        | `turn.start` (shared, to know the `turnId`); `$.turn.abort`                                                                                                                                   | P2W1 |
| `act.compact`     | actuator | —                        | key `channel` = `active`                                                                        | `$.session.compact`                                                                                                                                                                           | P2W1 |
| `act.ui`          | actuator | —                        | key `channel` = `active`                                                                        | `$.ui.toast`, `$.ui.status`                                                                                                                                                                   | P2W1 |
| `act.prompt`      | actuator | `startPrompt`            | family `startPrompt` = `active`, key `channel` = `active`                                       | `prompt.submit` event (shared, to tag the turn); `$.prompt.submit`, `$.command.run`, `$.command.list`                                                                                         | P2W2 |
| `act.message`     | actuator | `message`                | family `message` = `active`, key `channel` = `active`                                           | reads the `permissionMode` state key; `$.prompt.submit`                                                                                                                                       | P2W3 |
| `sense.message`   | sensor   | —                        | family `message` ≠ `off`                                                                        | `session.send`, `session.receive`                                                                                                                                                             | P2W3 |
| `act.context`     | actuator | —                        | key `context` on, key `channel` = `active`                                                      | `$.session.append`; until P4W5, `classic.SessionStart` (shared, `source: compact`)                                                                                                            | P2W4 |
| `gate.guard`      | gate     | `guard`                  | family `guard` ≠ `off`; to enforce (`guard.set {enforce: true}`), also key `channel` = `active` | `tool.call` on `Edit\|Write\|NotebookEdit`; `$.fs.stat`                                                                                                                                       | P2W4 |
| `stamp.mcp`       | gate     | —                        | key `stamp` ≠ `off`                                                                             | `tool.call` with the RegExp matcher `/^mcp__(harnu\|capy)__/` (types L5477; `capy` is the legacy server-name alias, see §24)                                                                  | P2W5 |
| `gate.approval`   | gate     | `approval`               | family `approval` ≠ `off`, `sense.attention` enabled                                            | `tool.check`, `classic.PermissionRequest`, `classic.PostToolUse`, `turn.complete` (all shared); opt. `classic.PostToolUseFailure`                                                             | P3W1 |
| `gate.sentinel`   | gate     | —                        | key `sentinel` ≠ `regex`, `sense.attention` enabled                                             | `tool.check` (shared)                                                                                                                                                                         | P3W2 |
| `sense.mods`      | sensor   | —                        | key `modsLive` on                                                                               | `plugin.register` (pass-through)                                                                                                                                                              | P4W1 |
| `ui.band`         | surface  | —                        | key `surface` on                                                                                | `ui.render` (`AbovePrompt`), drawn by the `ui.render` hook of the one hooks module, the view in `hooks/surface.tsx`; the `band` state key                                                     | P4W2 |
| `ui.command`      | surface  | —                        | key `surface` on                                                                                | `command.run` for the command `harnu-link`; `$.command.register`                                                                                                                              | P4W2 |
| `act.plan`        | actuator | —                        | key `plan.enabled`, key `channel` = `active`                                                    | `$.model.fork`; with a title, `$.model.complete`                                                                                                                                              | P4W4 |
| `sense.compact`   | sensor   | —                        | always                                                                                          | `session.compact`; opt. `classic.PostCompact`                                                                                                                                                 | P4W5 |

A feature with no fact family has no legacy rival to arbitrate against (§11.5). The profile
narrows the set further: `headless` gets `sense.*` only (§16); `external` gets the set of §21.

### 11.2 Declared → enabled → proven

1. **Declared.** The mod lists a feature in `hello.declared` only when every non-optional hook it
   needs registered without error (each `on()` is wrapped; a failure is omitted and reported as
   `mod.error {kind: 'registration'}`).
2. **Enabled.** The host answers with `enable`, a subset chosen from the "Enabled by" column, the
   folder ramp, the CLI version gate, the profile and the spawn's trust class. The mod MUST behave
   as if a feature that is not enabled does not exist. When the host's rollout turns off (the
   kill switch) it MUST revoke the binding's `conn` (`STALE_CONN`) and answer the re-hello with
   `enable: []`; turning it back on reaches new sessions only.
3. **Proven.** A declaration is not trusted, because an org policy mod (`sec-default`) pins
   `classic.*` and `prompt.section` / `prompt.context` / `prompt.compose` against the user tier, and
   passes `tool.check` (a settings deny rule holds over a user-tier loosening), `plugin.register`
   (user-tier modules are refused only under `allowManagedModsOnly`), `session.*`, `command.*`,
   `model.*`, `tool.call`, `http.fetch` and `prompt.submit`. This is read from the `sec-default`
   source (a 2.1.277 copy); confirm it on 2.1.287 under master Q8. A feature becomes authoritative only on proof:

| Feature class / id                             | Proof                                                                                                                                                                                                                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sense.identity`                               | a hello that redeemed a spawn token; for the external profile, corroboration by Harnu's own watchers (§21)                                                                                                              |
| `sense.turn`                                   | the first `turn.started` or `turn.completed`                                                                                                                                                                            |
| `sense.attention`, `sense.subagent`            | `probes.classic` is true: the mod has seen any `classic.*` dispatch in this process                                                                                                                                     |
| `sense.usage`                                  | the first `usage.measured` that carries a non-null reading; the host proves each field group (context, cost, limits) from its own first reading                                                                         |
| `sense.message`, `sense.compact`, `sense.mods` | the first event of the feature                                                                                                                                                                                          |
| `gate.approval`                                | `probes.classic` and `probes.toolCheck` are both true; a `permission` ask is itself proof of the first, and its `toolUseId` of the second. Revoked by a permission `attention.raised {source: 'request'}` with no `ask` |
| `stamp.mcp`                                    | the first stamp the MCP server resolves as `verified` (§24)                                                                                                                                                             |
| `gate.guard`                                   | a successful `command.result` for `guard.set`                                                                                                                                                                           |
| `gate.sentinel`, `ui.command`                  | the first `sentinel` (respectively `status`) ask the host answers                                                                                                                                                       |
| actuators, `ui.band`                           | **attempt-proven**: enabled is enough to attempt; a successful `command.result` is the proof. A command the mod took (the cursor covers it) with no result by `expiresAt + CMD_RESULT_GRACE_MS` is a **failed proof**   |

`probes.toolCheck` is true once the `tool.check` hook has been dispatched for a real call (one
with a `tool_use_id`), whatever the verdict.

A family is **owned** by the companion only when every feature the table in §11.1 lists for that
family is proven, the lease is live, and the family's rollout mode is `active` (ARB-3). A failed
proof makes the families that need the feature legacy for the rest of the session (ARB-4c).

### 11.3 Lease

- The lease of a binding is **live** while a `poll` or `ask` request is parked on the host, or
  less than `LEASE_TTL_MS` has passed since the host last received or answered any request of that
  binding. The host measures it on a monotonic clock and, after the machine resumes from sleep,
  grants every live binding one `LEASE_TTL_MS` before the loss counts.
- A session that does not poll (headless, external) MUST send an `events` request, empty if need
  be, at least every `HEARTBEAT_MS`.
- Lease loss is detected by the host alone. Its consequences (legacy wins, sticky) are ARB-4. A
  live lease is not a sign of progress: it never refreshes a "stuck" timer.
- An **inert** binding (its `enable` is empty: the kill switch, or a host with no enable policy
  registered) sends nothing by design. Its silence is not a lease loss: the host never reports
  it as one, never records a sticky legacy reason for it, and the Harnu mod state reads `off`.

### 11.4 Shared hook registrations

The companion has **at most one `on()` registration per (event, matcher)**. The wave named first
creates the registration (or the first consumer wave to land, when that wave is not in its base);
every later wave adds its step inside the same body, in the order below. Every body starts with
`ensureHello($)` and is wrapped so that a throw returns `next(e)` (MOD-2). A step runs only when
its feature is enabled.

| CLI event                           | Registered by | Order of responsibilities inside the one body                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every `classic.*` hook              | each owner    | first step, always: set `probes.classic`; store `e.permission_mode`, when present, in the `permissionMode` state key (P1W5)                                                                                                                                                                                                                                                                                                                               |
| `session.start`                     | P1W3          | (1) store `boot`; (2) **await** `ensureHello`, which also starts the heartbeat, the poll loop (P2W1) and the command registration (P4W2) once per load; (3) run the commands of the hello response, un-awaited                                                                                                                                                                                                                                            |
| `classic.SessionStart`              | P1W3          | (1) identity: `source` `clear` or `resume` with a new `session_id` → `session.rebound`, then reset the per-conversation state keys (§22); (2) P2W4, until P4W5 removes it: `source: compact` → schedule the deferred durable append                                                                                                                                                                                                                       |
| `prompt.submit` (event)             | P1W5          | (1) `sense.turn`: remember `origin.kind` for the next turn; (2) `sense.attention`: `attention.cleared {cause: 'prompt'}` for each open item; (3) `act.prompt` and `act.message` (P2W2): an event whose origin is this plugin pops the mod's queue of own submits, and the next `turn.started` carries that `cmd`. Returns `next(e)` unchanged                                                                                                             |
| `turn.start`                        | P1W5          | (1) `act.turn` (P2W1): store `turnId` in `channel.turnId`; (2) `sense.turn`: `turn.started`. Returns `next(e)`                                                                                                                                                                                                                                                                                                                                            |
| `turn.complete`                     | P1W5          | (1) `sense.attention`: `attention.cleared {cause: 'turn-completed'}` for each open item; (2) `gate.approval` (P3W1): `ask.settled {cause: 'turn-ended'}` for every open ticket of that loop; (3) `sense.turn`: `turn.completed`. `channel.turnId` is P2W1's and is not cleared here: a stale id is answered by the engine's own rejection                                                                                                                 |
| `tool.check`                        | P1W5          | (1) `r = await next(e)`; set `probes.toolCheck` when `e.tool_use_id` is present; keep `r.hook` (the classic hook that decided, CLI 2.1.289) in the record; (2) `gate.sentinel` (P3W2): for a watched tool, the `sentinel` ask; a deny returns `{ decision: 'deny', reason }` and ends the body; (3) when `r.decision === 'ask'`: push the one shared record (`fleet.checks`, §22) and emit `attention.raised {source: 'check'}`; (4) return `r` unchanged |
| `classic.PermissionRequest`         | P1W5          | (1) `sense.attention`: correlate with the oldest unclaimed matching record (FIFO, the same pairing `gate.approval` uses), emit `attention.raised {source: 'request'}` (edge flush, not awaited); (2) `gate.approval` (P3W1): the hold of §10.1, which returns the decision or `next(e)`; without it, return `next(e)`                                                                                                                                     |
| `classic.PostToolUse`               | P1W5          | (1) `sense.attention`: `attention.cleared {cause: 'tool-settled'}` for the matching open item; (2) `gate.approval`: `ask.settled {cause: 'tool-ran'}` and `attention.cleared {cause: 'ask-resolved'}` when a ticket was decided. Returns `next(e)`                                                                                                                                                                                                        |
| `classic.PostToolUseFailure` (opt.) | P1W5          | as `classic.PostToolUse`, with `tool-failed`; never relied on                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.compact`                   | P4W5          | (1) pass through untouched on `precompute`, for a subagent, or when neither `sense.compact` nor `act.context` is enabled; (2) `r = await next(e)`; (3) `act.context`: add the durable rows the result does not already hold; (4) `sense.compact`: `compact.done`                                                                                                                                                                                          |

`tool.call` has two registrations with disjoint matchers: `Edit|Write|NotebookEdit` (P2W4) and
`/^mcp__(harnu|capy)__/` (P2W5; `capy` is the legacy server-name alias). No registration may match `Bash` (MOD-3).

### 11.5 Rollout semantics: `shadow`, and features with no family

`shadow` means **no actuation and no authority for a family that has a legacy rival**. For such a
family in `shadow` the mod is loaded, reports, and the host records parity; legacy decides.

What runs while a family, or the command channel, is in `shadow`:

- every sensor event, recorded and never applied;
- the poll loop, so its reliability can be measured;
- the observe-only commands of §9 (`flush`, `config.update`, `guard.set {enforce: false}`,
  `sentinel.set`, `ui.band.set`);
- the `observe` level of `stamp.mcp`: the mod stamps, the server resolves and records, handlers
  use the declared argument;
- parity recording, including a `permission` ask answered `released` with reason `shadow`;
- the `status` ask.

What does not run: any hold, any other command, any start-prompt claim, any bridge stand-down.

A feature with **no fact family** has no legacy rival, so `shadow` of a family does not apply to
it. An actuator, gate or surface of that kind has its own key in `companion-prefs.json` and needs
three things: its key on, the companion mode not `off`, and a live lease. A sensor of that kind
(`sense.compact`) only reports and needs no key; `sense.message` follows its wave's family and
`sense.mods` has a key because of its reload cost.

| Key        | Values                                                                        | Default                                | Gates                                                                                                 | Wave       |
| ---------- | ----------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------- |
| `channel`  | `off \| shadow \| active`                                                     | `shadow`                               | `act.channel` (≠ `off`); `act.turn`, `act.compact`, `act.ui` and every non-observe command (`active`) | P2W1       |
| `stamp`    | `off \| observe \| prefer`                                                    | `off`                                  | `stamp.mcp`; `prefer` lets handlers use the stamped session                                           | P2W5       |
| `context`  | boolean                                                                       | `true`                                 | `act.context`: live contract rows and durable re-injection                                            | P2W4, P4W5 |
| `sentinel` | `regex \| shadow \| structured`                                               | `regex`                                | `gate.sentinel` and the structured engine on the companion transport                                  | P3W2       |
| `surface`  | boolean                                                                       | `false` until its live-verify ACs pass | `ui.band`, `ui.command`                                                                               | P4W2       |
| `external` | boolean                                                                       | `false`                                | the external profile (§21)                                                                            | P4W3       |
| `plan`     | `{ enabled: boolean; mode: 'idle' \| 'idle-only' \| 'park'; title: boolean }` | `enabled: false`, `mode: 'idle'`       | `act.plan`                                                                                            | P4W4       |
| `recap`    | boolean                                                                       | `false`                                | `opts.compactSummary` and the memory recap                                                            | P4W5       |
| `modsLive` | boolean                                                                       | `false`                                | `sense.mods`                                                                                          | P4W1       |

A CLI above the tested ceiling forces every family to `shadow` (ARB-7b) and caps every key at
its observe level: `channel: shadow`, `stamp: observe`, `sentinel: shadow`, and `off` for the
keys that have none (`context`, `surface`, `plan`, `recap`, `modsLive`, `external`).

### 11.6 Bridge stand-down

"Stand-down" is the legacy hook bridge answering a hook POST without parking it for a human. It
is one predicate, evaluated per request (P2W3 introduces it, P3W1 extends it):

1. A `PreToolUse` POST for the tool `SendMessage` stands down when the session's lease is live
   and its `message` family is `active` (ARB-9b; C7 as narrowed).
2. A `PreToolUse` or `PermissionRequest` POST stands down when the companion owns `approval` for
   the session (ARB-9a).

In both cases the synchronous resolvers still run on the legacy hook, so a Sentinel deny is
preserved; only the wait for a human is skipped. In `shadow` nothing stands down and the ledger
records "would stand down" with the measured park time.

## 12. Errors

```ts
type ErrorCode =
  // host → mod, in a Failure
  | 'PROTO_UNSUPPORTED' // no common protocol version; mod goes dormant
  | 'UNAUTHORIZED' // bad, spent or expired spawn token; a tokenless claim for a session Harnu spawned; mod goes dormant
  | 'UNKNOWN_SESSION' // resume.conn not recognised; mod goes dormant (a tokenless mod: one fresh hello, §21)
  | 'STALE_CONN' // conn superseded, revoked or dropped; mod re-hellos with resume
  | 'BAD_ENVELOPE' // schema violation; mod drops the batch and reports mod.error
  | 'TOO_LARGE' // body over BODY_MAX_BYTES (HTTP 413); mod splits the batch
  | 'SLOW_DOWN' // retry after retryAfterMs; also a tokenless hello over EXTERNAL_MAX_BINDINGS
  | 'FEATURE_DISABLED' // endpoint or ask kind not enabled for this binding; on hello: the external profile is off (dormant)
  | 'HOST_SHUTTING_DOWN' // re-read the rendezvous file, back off
  // mod → host, in command.result
  | 'CMD_EXPIRED'
  | 'CMD_UNSUPPORTED' // unknown name; or a command outside the tokenless allowlist
  | 'CMD_PRECONDITION' // e.g. compact mid-turn, abort with no turn, the bypass-parity rule, a bound exceeded
  | 'CMD_FAILED' // the $ call rejected (message carries the engine's text); or `interrupted by reload`
```

No wave added a wire error code. Codes that look similar and are **not** wire codes: the host's
own enqueue refusals (`NO_BINDING`, `MODE_SHADOW`, `ORIGIN_DENIED`, …, P2W1), and the MCP verb
errors `DELIVERY_UNCONFIRMED` (P2W3) and `SELF_MESSAGE` (P2W5).

## 13. Failure semantics (summary)

| Situation                                                   | Mod behaviour                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Transport failure, any endpoint                             | re-read rendezvous, back off, buffer sensors, gates return `next(e)` |
| `STALE_CONN`                                                | `hello` with `resume`                                                |
| `PROTO_UNSUPPORTED`, `UNAUTHORIZED`, `UNKNOWN_SESSION`      | dormant until the process ends                                       |
| `UNKNOWN_SESSION` on a tokenless mod's `resume`             | one fresh tokenless hello; a second failure is dormant               |
| `FEATURE_DISABLED` on `hello`                               | dormant until the process ends                                       |
| `hello` answered with `enable: []`                          | inert: nothing is sent; `conn` is kept                               |
| No hello answer within `HELLO_WAIT_MS`                      | the hook returns `next(e)`; the late answer is adopted               |
| `ask` fails in any way                                      | return the engine's verdict; never allow                             |
| A hook of the mod throws                                    | caught inside the mod, `next(e)` returned, `mod.error` queued        |
| 30 s fetch abort                                            | a normal reconnect; re-issue                                         |
| A command found started and not finished after a hot reload | `CMD_FAILED` (`interrupted by reload`); never re-run                 |

## 14. Version negotiation

1. `v` is an integer. This document defines protocol **1**.
2. The mod sends `protoMin`/`protoMax`; the host picks the highest version both support and
   returns it as `proto`. The host MUST serve protocol N and N-1, because a live session keeps the
   immutable mod version it was spawned with (D1).
3. Additive changes do not bump `v`: a new event type, a new command, a new optional field, a new
   feature id, a new ask kind. Receivers ignore what they do not know (§8, §9).
4. A bump is required to remove or retype a field, change an id format, change ordering or
   idempotency rules, or change the meaning of an existing value.
5. `mod.version` lets the host show "Harnu mod outdated"; it never changes protocol behaviour.

## 15. Session re-key rules

The mod keeps a **bound `sid`**: the id the host has for this binding. It is what the envelope
carries. It changes only when the mod sends a `session.rebound`.

Identity reaches Harnu's session row in two steps (P1W3). A hello or a rebound gives the host a
**claim** (this PTY is session `sid`). The row itself migrates later, at the existing
`session:added` event, when the transcript is on disk, resolved by the claim instead of by the
legacy heuristics. A row is never re-keyed at hello: the transcript does not exist yet.

| Case                                 | CLI behaviour (evidence)                                                                                                                          | Mod MUST                                                                                                                                                                          | Host MUST                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Process start                        | `session.start` awaited before the first prompt (smoke A2)                                                                                        | `hello` with `spawn`                                                                                                                                                              | create the binding and record the identity claim                                                                     |
| `claude --resume <id>` (new process) | same id, `session.start` fires (smoke A2)                                                                                                         | `hello` with `spawn`; `sid` is the resumed id                                                                                                                                     | bind as a process start; the claim is already satisfied when the row is keyed by that id                             |
| Hot reload                           | module variables wiped, `session.start` re-fires, timers and the old poll are cancelled (smoke A5, C2)                                            | find no `conn` in memory, read it from `$.state`, `hello` with `resume`; restart the poll loop once; never re-run a command it already recorded                                   | issue a new `conn`, keep the binding, its lease clock and its start-prompt claim                                     |
| `/clear`                             | `session.end {reason: clear}`, then `classic.SessionStart {source: clear, session_id: NEW}`; no `session.start`; module state survives (smoke A2) | not send `bye`; send `session.rebound {cause: 'clear'}` at once on the same `conn`; write `conn`, `bootId` and `sid` to `$.state` again                                           | rebind the binding to the new `sid` and raise a new identity claim; the row migrates when the new transcript appears |
| In-session `/resume <other>`         | `classic.SessionStart {source: resume, session_id: OTHER}`; `$.session.id()` is still the old id inside that hook (smoke A2)                      | take the id from the hook payload, never from `$.session.id()`; send `session.rebound {cause: 'resume'}`                                                                          | rebind; a `sid` already live under another binding is a conflict: no claim, counted, the PTY keeps its key (P1W3)    |
| `classic.*` not dispatched           | policy pin                                                                                                                                        | while `probes.classic` is false, and at most every `DRIFT_CHECK_MIN_MS`, detect `$.session.id()` ≠ the bound `sid` in `ensureHello` and send `session.rebound {cause: 'unknown'}` | same as above                                                                                                        |
| Rebound with `prevSid` ≠ bound `sid` | an earlier rebound was lost                                                                                                                       | —                                                                                                                                                                                 | accept it and count it; never reject (a lost rebound must not strand the binding)                                    |
| Compaction                           | `classic.SessionStart {source: compact}`, same id (smoke D5)                                                                                      | send nothing for identity                                                                                                                                                         | —                                                                                                                    |
| Listener restart (same main process) | connect failure, new `bootId`                                                                                                                     | re-read rendezvous, `hello` with `resume`, reset the command cursor                                                                                                               | accept: the table is in memory                                                                                       |
| Harnu main restart                   | Harnu-spawned sessions die with it (the PTYs are killed)                                                                                          | —                                                                                                                                                                                 | nothing to recover; an external mod's `resume` is `UNKNOWN_SESSION` unless its `conn` hash was kept (§21)            |
| Envelope `sid` ≠ bound `sid`         | —                                                                                                                                                 | —                                                                                                                                                                                 | not rebind; answer `resync: true` and wait for `session.rebound`                                                     |

The host rebinds **only** on an explicit `session.rebound`.

## 16. Headless profile (`isInteractive === false`)

A pending long-poll added about 24–46 s to `-p` wall time (smoke C2; ADR C6), so headless sessions are **sensor-only**.

1. The host answers `profile: 'headless'` and `enable` contains `sense.*` features only.
2. The mod MUST NOT call `poll` or `ask`. The endpoints answer `FEATURE_DISABLED` if it does.
3. The lease is renewed by `events` batches and by an empty heartbeat batch every `HEARTBEAT_MS`,
   driven by `$.clock.every`.
4. The host MUST NOT issue any command other than `config.update` and `flush` (piggybacked on an
   `events` response). The starting prompt stays on the argv positional: a mod-submitted prompt
   would run as an extra turn before it (smoke C1).
5. `bye` is still sent, within `BYE_BUDGET_MS`.
6. A non-interactive process with **no** spawn token sends no request at all (§21): Harnu's own
   `claude -p` probes, CI and scripts never open the channel.

## 17. Security notes: what this contract does not authenticate

There is no isolation between mods of the same tier (smoke D6): a sibling user-tier mod read the
bearer token and body of another mod's `http.fetch`, redirected the request, forged the response,
forged its `env.get` and read its `$.state`, in either load order. Any plugin may read any
`$.state` value by design (types L3156–3157). Consequently:

- A valid `conn` correlates a request with **"some code running inside a `claude` process that
  Harnu spawned"**. It does not establish that the caller is the companion, nor that the companion
  is unmodified. The hello is not authentication either (C4). A tokenless claim (§21) establishes
  even less: nothing is shown from it until Harnu's own watchers corroborate the session.
- The host cannot tell the companion from a sibling mod, or from a same-user process that obtained
  `conn`. It MUST validate every request as untrusted input (schema, size, `sid`/binding
  consistency) and MUST NOT widen any authority because a request is well-formed (SEC-3).
- The mod cannot tell the host from a sibling mod that answers its fetch. It MUST NOT trust a
  response for anything the engine would not allow anyway: responses are confined to the closed
  vocabulary of this document, and nothing in a response is executed, evaluated or used as a path.
- The endpoint token and the Unix socket permissions keep out other users and browser-borne
  requests. They do not keep out the session's own Bash tool, which runs as the same user.
  `HARNU_SPAWN_TOKEN` is inherited by tool subprocesses; it is harmless only because it is spent
  before the first prompt (§3).
- An approval decision can be forged or pre-empted at the same tier. A sibling mod that wedges
  the shared worker is unloaded alone, but the whole hook chain is skipped for that one call, so
  the companion's hook fails open once (smoke B6; ADR C9). Throws never unload anything. The
  contract therefore offers a hold, never a guarantee; the coverage state says which (SEC-7).
- `stamp.mcp` is attribution, not authentication (D8). Its proof is a truncated digest over
  `conn`: the engine exposes `crypto.subtle.digest` and nothing else (no `sign`, types
  L13829–13835), and a sibling that reads `conn` can compute the same proof.

## 18. Reserved, and what the waves settled

Later changes extend the items still reserved; they MUST NOT introduce a parallel mechanism.

| Item                                      | State                                                                                                                                                                            | Wave          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `turn.progress` event                     | **reserved**: coalesced `turn.step` liveness, at most once per 2 s; not hooked in protocol 1 (D12)                                                                               | none assigned |
| `hello.proof`                             | **reserved, not implemented in protocol 1.** A forger able to answer the mod's fetch has already read the spawn token in the request (smoke D6), and no native HMAC exists (§17) | P1W3          |
| A hold with no dialog                     | **reserved**: the dialog-suppressing `tool.check` hold, its ask field `surface: 'band'` and the band line `Held in Harnu · {tool}`. Deferred option of P3W1 (master OD-2)        | none assigned |
| `HelloResponse.pending`                   | not used: pending work is always delivered as `commands`                                                                                                                         | —             |
| Stamp field on `mcp__harnu__*` args       | settled: §24                                                                                                                                                                     | P2W5          |
| `gate.sentinel` and its wire shape        | settled: §10.2, `sentinel.set`                                                                                                                                                   | P3W2          |
| `ask` kind `status`                       | settled: §10.3                                                                                                                                                                   | P4W2          |
| `hello` with neither `spawn` nor `resume` | settled: §21                                                                                                                                                                     | P4W3          |
| `durable` context re-injection            | settled: `context.append {durable, retainOnly}`, `context.drop`, the `durableRows` state key and the `session.compact` row of §11.4                                              | P2W4, P4W5    |

## 19. Conformance checklist

Both sides are tested against the same **golden fixtures**: request/response pairs and event
sequences exported as `.ts` from `resources/companion/tests/fixtures/`, imported by the host's
vitest contract tests and by the mod's `claude plugin test` suite (with `http.fetch` stubbed by an
`on('http.fetch', …)` hook, smoke D3). Fixtures and tests are never staged into `<userData>` and
never packaged.

Rows are cited as "conformance row N". The numbers are stable: new rows are appended.

| Row | Requirement                                                                                                                                 | Side | Test layer    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------- |
| 1   | Every request and response validates against `contract.ts`                                                                                  | both | contract      |
| 2   | `hello` redeems a spawn token once; a second redemption after first use is `UNAUTHORIZED`                                                   | host | unit          |
| 3   | A lost hello response is recoverable while the issued `conn` is unused                                                                      | host | unit          |
| 4   | `ensureHello` is a no-op with a `conn` in memory and re-hellos with `resume` after a reload                                                 | mod  | mod-test      |
| 5   | Duplicate `seq` is dropped; a gap answers `resync: true` and acknowledges the highest `seq` received; the mod then sends `session.snapshot` | both | contract      |
| 6   | An event stays in the ring until acknowledged, including across an aborted fetch                                                            | mod  | mod-test      |
| 7   | Edge events flush immediately; others within `flushMs`                                                                                      | mod  | mod-test      |
| 8   | Ring overflow drops coalescable events first and reports `dropped`                                                                          | mod  | mod-test      |
| 9   | `poll` returns within `POLL_HOLD_MS`; no request is ever held to `FETCH_HARD_CAP_MS`                                                        | host | unit          |
| 10  | A command is executed once per `cmd` across re-delivery and hot reload, and always gets a result                                            | mod  | mod-test      |
| 11  | An expired or unknown command is refused with the right code                                                                                | mod  | mod-test      |
| 12  | `ask` tranches are idempotent on `askId`; every non-`decided` outcome returns the engine's verdict                                          | both | contract      |
| 13  | `ask.settled` is sent on tool-ran, abort and turn-ended; `tool-failed` is defined, not required                                             | mod  | mod-test      |
| 14  | No `poll` and no `ask` when `isInteractive === false`; a heartbeat batch every `HEARTBEAT_MS`                                               | mod  | mod-test      |
| 15  | `/clear` and in-session `/resume` produce `session.rebound` with the id from the hook payload                                               | mod  | mod-test      |
| 16  | The host rebinds only on `session.rebound`                                                                                                  | host | unit          |
| 17  | Protocol N and N-1 are both served; no overlap is `PROTO_UNSUPPORTED` and the mod goes dormant                                              | both | contract      |
| 18  | Unknown event types and fields are ignored, not rejected, and still advance `seq`                                                           | host | contract      |
| 19  | No raw CLI event name appears as a wire name; no payload carries prompt text or tool input outside the named fields                         | mod  | unit (static) |
| 20  | `conn` and the spawn token never appear in a log, `$.store`, an event payload, a spawn record or a diagnostics view                         | both | unit (static) |
| 21  | The lease is live with a parked poll and expires `LEASE_TTL_MS` after the last request otherwise                                            | host | unit          |
| 22  | A rendezvous change (new `bootId`, new socket) is picked up on the next connect failure                                                     | mod  | integration   |
| 23  | A second `poll` on a binding supersedes the first; never two parked polls                                                                   | host | unit          |
| 24  | A command started by a previous load answers `CMD_FAILED` (`interrupted by reload`) and is not re-run                                       | mod  | mod-test      |
| 25  | A hello answered `enable: []` leaves the mod inert; a revoked `conn` answers `STALE_CONN` and is accepted on `resume`                       | both | contract      |
| 26  | A tokenless non-interactive mod sends no request; a tokenless mod answers a non-allowlisted command `CMD_UNSUPPORTED`                       | mod  | mod-test      |
| 27  | `message.deliver` is refused when the last `permission_mode` is `bypassPermissions` or unseen                                               | mod  | mod-test      |
| 28  | A `status` ask is answered `decided` in every rollout mode; a `sentinel` decision is never an allow                                         | host | contract      |
| 29  | No `on()` registration is duplicated for one (event, matcher); none can match `Bash`                                                        | mod  | unit (static) |
| 30  | A hook that waited `HELLO_WAIT_MS` returns `next(e)` and adopts the late hello                                                              | mod  | mod-test      |

## 20. Open questions

Each is settled as an acceptance criterion of the named wave; until then the contract's stated
default applies. A settled question keeps its number.

| #    | Question                                                                                                                                                                                    | Default until settled                                                                             | Wave       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------- |
| CQ1  | `session.end` bound: 1.5 s (types L10329) or 5 s (smoke C2)? (C13)                                                                                                                          | design for 1.5 s: `BYE_BUDGET_MS` = 1 000                                                         | P1W3       |
| CQ2  | Does `classic.SessionStart {source: "startup"}` fire on a fresh start, giving `probes.classic` and a permission mode before the first turn?                                                 | proof waits for the first `classic.*` of any kind                                                 | P1W3       |
| CQ3  | Is `$.state` reset by `/clear`, does it survive a process restart, and is it ever written to disk where the session's Bash could read `conn`?                                               | re-write after rebound; the host re-issues what it needs; treat `conn` as tier-visible            | P1W3       |
| CQ4  | After an in-session `/resume`, does `$.session.id()` return the new id outside the `classic.SessionStart` hook? (C10)                                                                       | use the hook payload's `session_id` only                                                          | P1W3       |
| CQ5  | Is a `socketPath` fetch visible to sibling mods like a TCP one (smoke D6 did not run it)?                                                                                                   | assume visible                                                                                    | P1W1       |
| CQ6  | Socket path length on macOS `<userData>`; Windows transport                                                                                                                                 | TCP fallback at `SOCKET_PATH_MAX_BYTES`                                                           | P1W1       |
| CQ7  | Do several sessions polling at once, over the Unix socket, hold 25 s reliably? Is 25–30 s safe?                                                                                             | 25 s                                                                                              | P2W1       |
| CQ8  | Does a held `classic.PermissionRequest` hook survive a hot reload, `/clear` or a hold past 15 min?                                                                                          | host releases after `ASK_ORPHAN_MS`                                                               | P3W1       |
| CQ9  | Two parallel asks of the same tool with identical input: is the `tool.check` ↔ `PermissionRequest` correlation ambiguous?                                                                   | first-in-first-out, marked `ambiguous`; `ask_x<counter>` when uncorrelated                        | P3W1       |
| CQ10 | Does an input rewrite on `mcp__harnu__*` get refused under `auto` permission mode?                                                                                                          | no stamp in a known `auto` mode; suspend on the first refusal (§24)                               | P2W5       |
| CQ11 | Host-side request rate limit that triggers `SLOW_DOWN`                                                                                                                                      | **settled**: `RATE_MAX_REQUESTS` per `RATE_WINDOW_MS`, per binding                                | P1W1       |
| CQ12 | Does `classic.PostToolUseFailure` ever fire, and for which failures? (C3)                                                                                                                   | never depended on                                                                                 | P1W5, P3W1 |
| CQ13 | Do `classic.*` events reach a module when no settings hook is configured (`--setting-sources` isolation)? (C14)                                                                             | `probes.classic` decides per session                                                              | P1W5       |
| CQ14 | Does `session.measure` fire on a rate-limit move alone? (C5)                                                                                                                                | `/usage` poll after `PLAN_USAGE_STALE_MS`                                                         | P1W6       |
| CQ15 | When does the `$.prompt.submit` promise settle, and is a prompt over `PROMPT_MAX_CHARS` delivered intact?                                                                                   | the `CMD_ACCEPT_MS` rule; longer prompts stay on legacy                                           | P2W2       |
| CQ16 | Does the SDK pass an unknown `_meta` key through to the MCP handler?                                                                                                                        | assumed; an integration test proves it                                                            | P2W5       |
| CQ17 | Does `Link.href` accept `http://localhost` with a port (types L5309: "an `https:` URL (or `http://localhost`)", spelled as `new URL(href).href`; a port is neither confirmed nor excluded)? | on failure the band shows the hint `/harnu-link open` and no link                                 | P4W2       |
| CQ18 | Does `CLAUDE_CODE_PLUGIN_DIRS` in settings `env` load the mod, and does naming one directory by flag and by env yield one module instance or two?                                           | two instances would share `$.state`: Harnu then omits its own flag while the outside switch is on | P4W3       |
| CQ19 | Does `$.model.fork` work from the poll loop, with no hook on the stack?                                                                                                                     | attempt-proven; a failed proof disables capture                                                   | P4W4       |
| CQ20 | Does an `auto` or `precompute` compaction dispatch the `session.compact` hook with the same result shape, and do hook-added `messages` survive `--resume` (upstream #95328, #96485)?        | never touch `precompute`; assume lost on resume and re-append                                     | P4W5       |
| CQ21 | Does `plugin.register` observation make every reload re-run every module at an acceptable cost (types L4038)?                                                                               | `sense.mods` stays off                                                                            | P4W1       |

## 21. External profile (P4W3)

A session Harnu did not spawn has no spawn token. With the operator's opt-in (the `external` key,
a switch separate from the bundled-skills "Also outside Harnu" switch) its mod may claim a binding.

1. **Who claims.** The mod branches once per load on the env and on `isInteractive`:

   | `HARNU_SPAWN_TOKEN` | `isInteractive` | Behaviour                                                       |
   | ------------------- | --------------- | --------------------------------------------------------------- |
   | present             | any             | the spawned path of §3                                          |
   | absent              | false           | **dormant, no request at all** (§16 item 6)                     |
   | absent              | true            | a `hello` with neither `spawn` nor `resume`: the external claim |

2. **Host answer to a tokenless hello**, first match: the `external` key is off, or the companion
   mode is `off` → `FEATURE_DISABLED` (dormant); the `sid` is bound to a live spawned binding or
   belongs to a session Harnu spawned → `UNAUTHORIZED` (a claim never displaces a spawned
   binding); more than `EXTERNAL_MAX_BINDINGS` live external bindings → `SLOW_DOWN`; otherwise a
   binding with `profile: 'external'`, `sessionKey: null` and no `commands`.
3. **Enable set.** `sense.identity`, `sense.turn`, `sense.attention`, `sense.subagent`,
   `sense.usage`, and, when the `surface` key is on, `ui.command` and `ui.band`. `gate.approval`
   only for a corroborated binding whose `cwd` is on the existing interceptor ramp and whose
   `approval` family is `active`. Never `act.*`, `gate.guard`, `gate.sentinel`, `stamp.mcp`,
   `sense.message`, `sense.compact` or `sense.mods`.
4. **Transport.** No `poll`. The lease is renewed as in §16 item 3. `ask` is allowed for kind
   `status`, and for `permission` only when `gate.approval` is enabled. Commands arrive
   piggybacked on `events` responses only, and the mod sends its `bootId` and `cursor` there.
5. **Commands.** The host issues only `flush`, `config.update` and `ui.band.set`; every other
   command is refused at the origin gate and audited as a refusal. The mod enforces the same
   allowlist by itself (§9, the tokenless second lock).
6. **Corroboration.** A tokenless hello proves nothing (smoke D6). The host buffers the binding's
   events (at most `RING_MAX`) and feeds no consumer, draws no band and answers a `status` ask
   with the mod's local line (`released`, reason `abstain`) until Harnu's own watchers report the
   same session: the PID registry or the transcript watcher. A binding not corroborated within
   `EXTERNAL_CORROBORATE_MS` of its first `turn.started` is dropped (`STALE_CONN`); the mod may
   hello again. A `session.rebound` requires corroboration again for the new id. The companion
   never creates a sidebar row: the transcript watcher does.
7. **Harnu restart.** On `UNKNOWN_SESSION` to its `resume` a tokenless mod sends one fresh
   tokenless hello instead of going dormant: it has no token to protect and Harnu restarts on
   every update.
8. **Switch off.** Turning the `external` key off, or the kill switch, revokes every live
   external binding as in §3 item 9.

## 22. Mod state: the `$.state` key registry

`$.state` survives a hot reload (types L3152–3153); any plugin can read any value (types
L3156–3157), so no key holds anything the tier may not see. Whether it survives `/clear` or a
process restart is CQ3: the mod re-writes after a rebound and the host re-issues what it needs.
Every key is declared in the plugin's `types` contract (MOD-1) by the wave that owns it, in that
wave's change. A consumer wave reads a key; it does not redefine it.

| Key              | Owner                                    | Shape                                                                                                                                                                                                                                                                    | After a hot reload                                                     | After `/clear` or in-session `/resume` (rebound)                                    |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `conn`           | P1W3                                     | `Conn`                                                                                                                                                                                                                                                                   | read back; `hello` with `resume`                                       | kept (same binding); written again                                                  |
| `bootId`         | P1W3                                     | `BootId`                                                                                                                                                                                                                                                                 | read back                                                              | kept; written again                                                                 |
| `sid`            | P1W3                                     | `Sid`: the bound id, not a fresh `$.session.id()`                                                                                                                                                                                                                        | read back                                                              | set to the new id by the rebound                                                    |
| `boot`           | P1W3                                     | `{ cwd: string; surface: string \| null; isInteractive: boolean }`                                                                                                                                                                                                       | read back (a resume hello needs it)                                    | kept                                                                                |
| `probes`         | P1W3; written by P1W5's hooks too        | `{ classic: boolean; toolCheck: boolean }`                                                                                                                                                                                                                               | read back                                                              | kept: facts about the process                                                       |
| `permissionMode` | P1W5; read by P2W3, P2W5, P3W1           | `string \| null`: the last `permission_mode` of any `classic.*` payload; `null` = unseen                                                                                                                                                                                 | read back                                                              | kept; refreshed by the next `classic.*`                                             |
| `fleet`          | P1W5; `checks` extended by P3W1          | `{ activeTurnId: string \| null; nextOrigin; open: […]; checks: { toolUseId; tool; inputKey?; at; claimedBy? }[]; runningSubagents: number; lastStop: { all: number; subagents: number } \| null; pendingFailure: string \| null }`, `checks` capped at `ASK_RECORD_MAX` | read back, so the re-sent `session.snapshot` is correct                | reset to the neutral state: a new conversation has no turn, no open item, no record |
| `channel`        | P2W1; `started` used by P2W2, P2W3, P4W4 | `{ bootId: BootId; cursor: number; started: CmdId[]; resulted: CmdId[]; turnId: string \| null }`, the lists capped at `CMD_DONE_MAX`                                                                                                                                    | read back: this is the command dedupe                                  | kept                                                                                |
| `guard`          | P2W4                                     | `{ armed: boolean; enforce: boolean; setAt: number }`                                                                                                                                                                                                                    | read back; the hello response carries the current `guard.set`          | the host sends `guard.set` for the role record of the new `sid`                     |
| `durableRows`    | P2W4; extended by P4W5                   | `{ sid: Sid; rows: Partial<Record<ContextKey, string>> }`: the framed text per key, at most `DURABLE_MAX_ROWS`                                                                                                                                                           | read back; the host primes it with `context.append {retainOnly: true}` | cleared when `sid` changes; the host re-issues the rows that still apply            |
| `reinject`       | P2W4; removed by P4W5                    | `boolean`: a deferred durable append was scheduled and not done. P4W5 removes it: its resume-hello re-issue rule (the injector primes and re-appends from the host) replaces it                                                                                          | read back; `ensureHello` replays the cancelled timer                   | cleared                                                                             |
| `stamp`          | P2W5                                     | `{ suspended: boolean }`                                                                                                                                                                                                                                                 | read back, so a refused rewrite is not repeated                        | kept: suspension lasts for the process                                              |
| `band`           | P4W2                                     | `{ v: 1; lead: string; detail?: string; hint?: string; href?: string; label?: string; n: number; expiresAt: number } \| null`                                                                                                                                            | read back; redrawn with no host round trip                             | the host re-sends the line after the rebound                                        |

Not in `$.state`, rebuilt after a reload: `seq` and the ring (a new `conn` restarts `seq` at 1),
the dormant flag, the retry clock, the open ask tickets (the host's orphan timer retires them),
the mod's queue of own submits, the watched Sentinel tools (every hello response carries
`sentinel.set`), and the guard's "last host answer" time. The mod writes a captured plan
nowhere: not `$.state`, not `$.store`, not a log.

## 23. Generated coordinates: `hooks/coords.gen.ts`

Written by staging (P1W2), never read from env or cwd (SEC-4). It holds no token and no secret.
The renderer emits every value with `JSON.stringify`. A wave that needs a baked value adds a field
here and to the generator in its own change; the staged directory's key covers the file, so a
changed value stages a new directory.

| Export                 | Type       | Meaning                                                                                                                                                            | Wave |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `RENDEZVOUS_PATH`      | `string`   | absolute path of `endpoint.json`                                                                                                                                   | P1W2 |
| `MOD_VERSION`          | `string`   | the mod's version, sent as `hello.mod.version`                                                                                                                     | P1W2 |
| `STAGED_AT`            | `number`   | epoch ms                                                                                                                                                           | P1W2 |
| `EXEMPT_CWD_DIRS`      | `string[]` | directory names exempt from the guard under the session cwd's real path: `['.harnu', '.capy']` (`.capy` is the legacy alias, mirroring `DATA_DIRS` in `guard.mjs`) | P2W4 |
| `SCRATCH_PARENTS`      | `string[]` | real paths of the scratchpad parent directories; a child named `claude-*` under one is exempt                                                                      | P2W4 |
| `CLAUDE_PROJECTS_ROOT` | `string`   | real path of the Claude projects directory; `<root>/<slug>/memory/` is exempt                                                                                      | P2W4 |

The guard's three exempt surfaces mirror the legacy `guard.mjs`. The session cwd comes from
`session.start`, never from env. A path that cannot be placed is not exempt.

## 24. MCP caller stamp (P2W5)

The stamp travels on the MCP transport, not on the companion socket. It is attribution, not
authentication (D8, §17).

- The `tool.call` hook on `/^mcp__(harnu|capy)__/` (the current server name `harnu`, plus the **legacy alias** `capy`, which
  the control server still accepts for old installs and saved rules) adds the argument `STAMP_ARG` to the call, spread last
  so it overwrites a value the model typed (smoke B5):

  ```ts
  interface HarnuCallerStamp {
    proof: string // "v1.<handle>.<nonce>.<mac>", at most 160 chars
    agentId?: string // at most 64 chars
  }
  ```

- **Proof format** (`STAMP_PROOF_VERSION` = `v1`), digest by `crypto.subtle.digest`:

  ```
  handle = hex(SHA256("harnu-stamp-handle\n" + conn))[0..12]
  mac    = hex(SHA256("harnu-stamp-v1\n" + conn + "\n" + nonce + "\n" + tool))[0..32]   // tool as called: mcp__harnu__<verb> or the legacy alias mcp__capy__<verb>
  proof  = "v1." + handle + "." + nonce + "." + mac
  ```

  `nonce` is the call's `tool_use_id`, or a random uuid. `conn` never leaves the process in clear
  (SEC-8). The input has a fixed layout and the output is truncated, so length extension does not
  apply.

- The server lifts the argument out of the call at its HTTP border, before the handler and the
  audit see the arguments, and resolves it: `handle` finds the binding, `mac` is recomputed, the
  nonce is checked against a ring of `STAMP_NONCE_RING` (a nonce enters the ring only when the
  `mac` verifies). The outcome is one of `verified`,
  `absent`, `malformed`, `unknown-binding`, `bad-mac`, `replayed`, `mismatch`, `no-lease`, `off`.
  Only `verified` attributes the call. A stamp resolves only for a binding that completed a hello
  in the current host boot.
- The mod does not stamp when the last `permission_mode` it saw is `auto` (CQ10). With no mode
  seen yet it stamps, and suspends for the life of the process on the first refusal of a rewritten
  input (the `stamp` state key), reporting `mod.error {where: 'stamp.mcp', kind: 'abort'}`.
- Not stamped: headless bindings (scheduler ticks included) and external bindings. Their calls
  stay `declared` in protocol 1; whether headless sessions should stamp is an open question owned
  by P2W5.
- Levels (the `stamp` key): `off`; `observe`, where the server records and handlers use the
  declared argument; `prefer`, where a verified stamp overrides a declared session id.
