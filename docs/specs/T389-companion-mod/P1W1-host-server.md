# T389 P1W1 — Host server

## 1. Status

**Specified (not implemented)** · 2026-10-02 · Epic T389 · Wave P1W1
**Reads:** [`00-master.md`](00-master.md) · [`01-contract.md`](01-contract.md) ·
[ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) ·
`docs/studies/T389-smoke-evidence.md`
**Verified against:** repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository); Claude Code CLI 2.1.287.

## 2. Depends on / Unblocks

- **Depends on:** P0 (contract, ADR). Nothing in code.
- **Unblocks:** P1W2 (after its rebase it consumes `contract.ts`, `mode.ts` and `mintSpawnToken`),
  P1W3 (handshake wiring), P1W4 (arbitration reads the binding table and the lease).
- **Parallel with:** P1W2. P1W2 is rebased onto this wave before P1W3 starts (master §5), so this
  wave owns three things P1W2 consumes:
  1. `resources/companion/hooks/contract.ts` (types and constants of protocol 1, zero imports) and
     the first golden fixtures under `resources/companion/tests/fixtures/`.
  2. `src/main/companion/mode.ts` (the rollout-mode seam, default `off`).
  3. `companionHost.mintSpawnToken()` (the spawn-token ledger's only writer).

## 3. Summary

A dedicated HTTP/1.1 server in Harnu main, listening on a Unix socket under the app's data
directory (TCP loopback where a socket cannot be used), announced through a rendezvous file. It
validates every request as untrusted input, keeps the binding table (spawn token → `conn` → `sid`
→ Harnu session key), sequences and dedupes events, tracks each binding's lease, and exposes a
typed in-process bus and a diagnostics snapshot. No consumer is attached in this wave and no
packaged build starts the listener (mode is `off`); the server is proven by contract tests against
a real socket.

## 4. Evidence

| Smoke id | Verdict   | What this wave takes from it                                                                                                                                                                 |
| -------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2       | CONFIRMED | `$.http.fetch(url, { socketPath })` reaches a Node HTTP server from a PTY and from `-p`; a Unix POST costs 0–9 ms; `session.start` is awaited before the first prompt, so hello is blocking. |
| A5       | CONFIRMED | Module state is wiped on hot reload and the handshake is re-sent: the host must accept a re-hello for a live binding.                                                                        |
| C2       | CONFIRMED | A single fetch aborts at 30 000 ms: the host never holds a request that long. Hot reload closes the old request (`clientclosed`) and a new one follows within 0.8–10 s.                      |
| B6       | CONFIRMED | A throwing or wedged hook is skipped: the host can see a binding go silent without any `bye`. Lease expiry is the signal.                                                                    |
| D6       | REFUTED   | No isolation between same-tier mods: bearer, body and response of a fetch are readable and forgeable by a sibling. Tokens are correlation only (C4).                                         |

Types file (CLI 2.1.287): `socketPath` is "the absolute path of a Unix domain socket … (near 100 B
at most)" (types L4897-4898); `HttpInit` has no timeout field (types L4878).

Harnu code read for this wave:

- `src/main/hook-bridge.ts:86-203` (`startHookServer`, the testable-core template), `:197`
  (ephemeral port), `:209` and `:451` (per-boot token), `:119` (constant-time compare).
- `src/main/mcp/server.ts:1367-1391` (`readBody`, body cap), `:1439-1448` (`listenOnce`),
  `:1461-1480` (stored-port fallback that orphans sessions, `:1467-1477`).
- `src/main/mcp/http-guard.ts:63` (`constantTimeEqual`), `:92` (`isLoopbackHostname`), `:99`
  (`isAllowedOrigin`); `src/main/mcp/token-store.ts:89` (`readOrCreateToken`); ADR-0004.
- `src/main/index.ts:599` (`registerHookBridge` call shape), `:1010-1079` (`before-quit` teardown).
- `src/main/pty.ts:622` (ptyId minted), `:902-926` (`onExit`), `:1003-1033` (`pty:rekey`).

## 5. Deviations from the study

| Deviation                                                                                                              | Decision | Evidence                            |
| ---------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------- |
| The study put the channel on the existing loopback servers. This wave builds a dedicated server on a Unix socket.      | D2       | smoke A2; `mcp/server.ts:1467-1477` |
| The study treated the handshake as authentication. Here the spawn token and `conn` are correlation only.               | D2, C4   | smoke D6                            |
| The study assumed one long request per wait. The host caps every hold below the engine's 30 s abort (none in P1W1).    | D3       | smoke C2, B1.1                      |
| "Three crashes unload all mods" is not a signal the host can rely on; silence is detected by lease expiry and PTY exit | C9       | smoke B6, A5                        |

## 6. Scope / Non-goals

**In scope.** `src/main/companion/`: `mode.ts`, `wire-core.ts`, `rendezvous.ts`,
`session-table.ts`, `server.ts`, `host.ts`, `companion-ipc.ts`, `contract.ts` (re-export),
`audit-core.ts` / `audit-log.ts` (the companion audit log and its `binding` record, §7.8a);
`resources/companion/hooks/contract.ts`; the preload method `companionDiagnostics`; tests.

**Non-goals.**

- No feature is enabled: `hello.enable` is always `[]`. `sense.identity` arrives with P1W3.
- `poll` and `ask` exist as routes and answer `FEATURE_DISABLED` until a handler (poll) or a kind
  (ask) is registered through the extension points of §7.7 (P2W1, P3W1, P3W2, P4W2).
- No adapter, no arbitration, no parity ledger, no UI (P1W3–P1W4).
- No staging, no `--plugin-dir`, no call to `mintSpawnToken` from `pty.ts` (P1W2).
- No `conn` persistence (§7.5; contract §3 item 8).
- No peer-credential check on the socket (needs a native module; conceded, SEC-3).

## 7. Design

### 7.1 Modules

| File (under `src/main/companion/`) | Kind       | Owns                                                                                                       |
| ---------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------- |
| `contract.ts`                      | re-export  | `export * from '../../../resources/companion/hooks/contract'`; the only import path main uses.             |
| `mode.ts`                          | shell+core | `getCompanionMode()`, `familyMode(family, folder)`; reads `companion-prefs.json`.                          |
| `wire-core.ts`                     | pure       | route parsing, schema validation, protocol negotiation, sequence acceptance, rate bucket.                  |
| `rendezvous.ts`                    | pure+fs    | `chooseTransport`, `EndpointFile` write/remove, stale-socket probe.                                        |
| `session-table.ts`                 | pure       | spawn-token ledger, bindings, `conn` rotation, lease clock. Clock and id generators are injected.          |
| `server.ts`                        | core       | `startCompanionServer(opts)`: listener, guard, body read, dispatch. Tested with real sockets, no Electron. |
| `host.ts`                          | shell      | `registerCompanionHost(getWindow)`, `closeCompanionHost()`, the `companionHost` facade, the lease sweep.   |
| `companion-ipc.ts`                 | shell      | `companion:diagnostics`.                                                                                   |
| `audit-core.ts` / `audit-log.ts`   | pure/shell | the companion audit log, `appendAudit`, the `binding` record (§7.8a).                                      |

`host.ts` and `companion-ipc.ts` join the coverage `exclude` list in `vitest.config.mts` (Electron
glue; every decision is in the three tested cores, QA-4). `tsconfig.node.json` gains
`resources/companion/hooks/contract.ts` and `resources/companion/tests/fixtures/**/*.ts` in
`include`. No file lands directly under `src/main/`, so the user-docs gate does not fire.

### 7.2 Rollout-mode seam (`mode.ts`)

```ts
export type CompanionMode = 'off' | 'shadow' | 'active'
export type FactFamily =
  | 'identity'
  | 'taskState'
  | 'telemetry'
  | 'planUsage'
  | 'approval'
  | 'guard'
  | 'startPrompt'
  | 'message'

/** <app data>/companion-prefs.json — this wave reads only the developer key `mode`. */
export function getCompanionMode(): CompanionMode // sync, cached; missing file → 'off'
export function familyMode(family: FactFamily, folder: string | null): CompanionMode // P1W1: the global mode
export async function hydrateCompanionMode(): Promise<void> // called once at boot
/** Should the socket exist? P1W1: `getCompanionMode() !== 'off'`. P1W4 replaces the body (kill switch on, and some family or the developer `mode` key not `off`); it never reads the CLI gate, which is per binary and still `unknown` when the host boots. */
export function listenerWanted(): boolean
/** Fires when a prefs write, the kill switch or the settled CLI-version probe changes `getCompanionMode()` or `listenerWanted()`. */
export function onModeChange(fn: () => void): () => void
```

A missing file reads `off` (ARB-6e). An unreadable or invalid file reads `shadow` only once P1W4
ships (ARB-6a); until then it reads `off`, because no disclosure exists yet. There is no UI and no
IPC setter in this wave: developers edit the file. `companion-prefs.json` is **owned by P1W4**:
this wave reads only the developer key `mode`, which P1W4 keeps honouring as the default for every
family that has no entry of its own. P1W4 keeps these signatures and replaces the bodies
(master §12.1, "Mode seam"). Until P1W4 lands, `onModeChange` fires only when `hydrateCompanionMode()` settles.

### 7.3 Transport and rendezvous (`rendezvous.ts`, `server.ts`)

Directory `<app data>/companion/`, created `0700`. Files: `c.sock` (`0600`), `endpoint.json`
(`0600`, atomic through `mcp/atomic-write.ts`).

```ts
export function chooseTransport(
  socketPath: string,
  platform: NodeJS.Platform
): { transport: 'unix'; socketPath: string } | { transport: 'tcp' }
// 'tcp' when platform === 'win32' or Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES (90)
```

Boot sequence (`startCompanionServer`), in this order:

1. `mkdir -p` the directory with mode `0700`; `chmod` it if it already exists.
2. Read the previous `endpoint.json` if any. Reuse its `token` when it is a non-empty string
   (ADR-0004 reasoning: a stable token keeps a re-reading mod from one avoidable 403); otherwise
   mint a `randomUUID()`. Remember its `port` as the preferred TCP port.
3. Mint `bootId = b_<uuid>`.
4. **Unix:** if `c.sock` exists, connect to it with a 250 ms timeout. Connection refused or
   `ENOENT` → unlink it (a stale file from a crash). A successful connect → another live process
   owns it: do not unlink, fall through to TCP and log once. Then `server.listen(socketPath)` and
   `chmod 0600`. The `0700` directory closes the window between `listen` and `chmod`.
5. **TCP:** `listen(preferredPort, '127.0.0.1')`, falling back to port `0` on any bind error
   (`listenOnce` shape, `mcp/server.ts:1439`). A changed port orphans nobody, because the mod
   re-reads the rendezvous file on every connect failure (contract §2.5).
6. Write `endpoint.json` (contract §2 `EndpointFile`, `protoMin: 1`, `protoMax: 1`). The listener
   is bound but `accepting` is false until the write resolves; a request that arrives in between is
   answered `HOST_SHUTTING_DOWN` so the mod backs off and re-reads.
7. Flip `accepting`.

Stop: flip `accepting` off, answer every in-flight request `HOST_SHUTTING_DOWN`, remove
`endpoint.json`, close the server with `closeAllConnections()`, unlink the socket. The binding
table is **not** cleared: it lives in `host.ts` module state and survives a listener restart
inside one main process. The kill switch of P1W4 does **not** stop the listener: it revokes
bindings (§7.5, `revoke`), and the listener stays up, so a revoked mod can re-hello and be told
`enable: []` (contract §3 item 9). Only `closeCompanionHost()` stops it.

Request guard, in the order of `mcp/http-guard.ts` (contract §2): route (`404` unless
`/v1/{hello,events,poll,ask,bye}`) → method (`405` if not `POST`) → on TCP, `Host` must be
loopback and `Origin`, when present, must be `null` or loopback (`403`; reuse
`isLoopbackHostname`, `isAllowedOrigin`); on Unix, `Host` must be `harnu` (`403`) → bearer equals
the endpoint token by `constantTimeEqual` (`403`) → declared `Content-Length` over
`BODY_MAX_BYTES` (`413`) → body read with the same cap (`413`) → JSON parse (a parse error is
`200` with `BAD_ENVELOPE`: a parsed route always answers 200). There is no `401`.

### 7.4 Wire core (`wire-core.ts`, pure)

```ts
export const HOST_PROTO_MIN = 1
export const HOST_PROTO_MAX = 1

export function parseRoute(method?: string, url?: string): EndpointName | { status: 404 | 405 }
export function negotiate(modMin: number, modMax: number): number | null // highest common, else null
export function validateHello(body: unknown): Result<HelloRequest>
export function validateEnvelope(body: unknown): Result<Envelope>
export function validateEvents(body: unknown): Result<EventsRequest>
export function validateBye(body: unknown): Result<ByeRequest>

export interface SeqState {
  last: number
} // highest seq accepted on this conn
export function acceptEvents(
  state: SeqState,
  events: readonly WireEvent[],
  dropped: number | undefined,
  known: ReadonlySet<string>
): {
  accepted: WireEvent[] // known types, seq > state.last, in order
  duplicates: number
  unknown: number // seq advanced, event not delivered (contract §8, last rule)
  ackSeq: number
  resync: boolean
  next: SeqState
}

export function takeToken(bucket: RateBucket, now: number): { ok: true } | { retryAfterMs: number }
type Result<T> = { ok: true; value: T } | { ok: false; code: 'BAD_ENVELOPE'; message: string }
```

Validation is structural and closed on what it reads: required fields, primitive types, string
length caps (`sid` ≤ 64, `cwd` ≤ 4 096, `cli.version` and `mod.version` ≤ 64, `declared` ≤ 64
entries), `seq` a positive safe integer, `events` ≤ 256 entries. Unknown fields are ignored;
payload `d` of a known event is validated by the wave that owns the event, and in this wave the
`known` set is empty apart from what P1W3 registers.

**Sequence rule.** For each event in array order: `seq ≤ last` → duplicate, dropped; `seq === last + 1`
→ accepted; `seq > last + 1` → a gap: the event is accepted, `resync` is set. After the batch
`last` is the highest seq seen and `ackSeq = last`. A gap is closed by the resync, not left open:
answering the pre-gap value would make the mod re-send the post-gap events for ever (contract §6). `dropped > 0` also sets `resync`. An empty batch is a heartbeat: `ackSeq = last`.

**Rate bucket.** Per binding, 200 requests per 10 s, refilled continuously; `hello` is exempt.
Over the limit the answer is `SLOW_DOWN` with `retryAfterMs: 1000` (settles CQ11).

### 7.5 Session table (`session-table.ts`, pure)

```ts
export type SpawnOwner =
  { kind: 'pty'; ptyId: string } | { kind: 'tick'; workerId: string; runId: string } // scheduler tick, no PTY (P1W2)
export type TrustClass = 'operator' | 'agent' | 'read-only' | 'tick'

export interface SpawnMeta {
  owner: SpawnOwner
  trust: TrustClass
  cwd: string
}

export interface Binding {
  readonly key: number // table-local ordinal; never on the wire
  readonly owner: SpawnOwner | null // null only for an external binding (P4W3)
  readonly trust: TrustClass
  conn: Conn
  prevConn: Conn | null // accepted for recovery only while `connUsed` is false
  connUsed: boolean
  sid: Sid
  proto: number
  profile: 'interactive' | 'headless' | 'external' // 'external' is set by P4W3 only
  cliVersion: string
  modVersion: string
  surface: string | null
  cwd: string
  declared: FeatureId[]
  enabled: FeatureId[]
  proven: FeatureId[]
  seq: SeqState
  parked: number // poll/ask requests currently held; always 0 in P1W1
  lastRequestAt: number
  leaseLostAt: number | null // set once, by the sweep; never cleared (ARB-4c is P1W4's rule)
  state: 'bound' | 'ended' | 'closed'
  revoked: boolean // set by revoke(); cleared by the resume hello that follows
  counters: {
    requests: number
    events: number
    duplicates: number
    gaps: number
    dropped: number
    unknown: number
    refused: number
  }
}

export class SessionTable {
  constructor(deps: { now(): number; mintConn(): Conn; mintToken(): SpawnToken }) // now() is monotonic
  mint(meta: SpawnMeta): SpawnToken
  release(owner: SpawnOwner, reason: 'pty-exit' | 'spawn-aborted' | 'tick-done'): Binding | null
  hello(req: HelloRequest, enable: EnablePolicy): HelloOutcome // spawn or resume
  resolve(conn: Conn): Binding | 'STALE_CONN'
  touch(b: Binding): void // lastRequestAt = now, connUsed = true
  end(b: Binding, reason: string): void // from bye
  rebind(b: Binding, sid: Sid): void // only caller: the session.rebound handler (P1W3)
  leaseOf(b: Binding): 'live' | 'lost' // pure read: parked > 0 or now - lastRequestAt < LEASE_TTL_MS
  sweep(): Binding[] // bindings whose lease just turned lost; sets leaseLostAt once; skips a binding whose enabled is [] (inert, contract §11.3)
  grace(ms: number): void // push every live binding's lastRequestAt forward to now; see §7.7
  spawnRecord(owner: SpawnOwner): SpawnRecordView | null
  revoke(b: BindingView): void // contract §3 item 9; callers: P1W4 (kill switch), P4W3
  markProven(b: BindingView, feature: FeatureId): void // adapters
  revokeProof(b: BindingView, feature: FeatureId): void
  view(): BindingView[]
}

/** Token-free: no `conn`, no spawn token. What every other wave and the bus receive (master §12.1). */
export interface BindingView {
  key: number
  owner: SpawnOwner | null
  trust: TrustClass
  sid: Sid
  sessionKey: string | null
  cwd: string
  profile: 'interactive' | 'headless' | 'external'
  cliVersion: string
  modVersion: string
  declared: FeatureId[]
  enabled: FeatureId[]
  proven: FeatureId[]
  lease: 'live' | 'lost'
  state: 'bound' | 'ended' | 'closed'
  corroborated?: boolean // P4W3
}

/** No token (SEC-8, conformance row 20). */
export interface SpawnRecordView {
  cwd: string
  trust: TrustClass
  state: 'minted' | 'redeemed' | 'spent' | 'released'
  releasedReason?: string
}

/** A policy supplied by another wave never sees `conn`. */
export type EnablePolicy = (b: Readonly<BindingView>) => FeatureId[]
```

**Revocation.** `revoke(b)` sets `revoked`, empties `enabled` and invalidates the `conn` for every
route but `hello`: a request carrying it answers `STALE_CONN`. A `hello` whose `resume.conn` is
that revoked `conn` is **accepted**: it rotates the `conn` as any resume does, clears `revoked`,
and is answered with whatever the enable policy returns now (`[]` while the switch is off, which
makes the mod inert, contract §5.1). `onBindingChange` fires on `revoke`.

Spawn-token ledger, one entry per `mint`:

| State      | Entered by                                           | A hello with this token                                                          |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `minted`   | `mint`                                               | creates the binding, issues `conn`, → `redeemed`                                 |
| `redeemed` | first hello                                          | **accepted again**: issues a fresh `conn`, invalidates the first (contract §3.3) |
| `spent`    | the first request that carries the binding's `conn`  | `UNAUTHORIZED`                                                                   |
| `released` | `release(owner)` (PTY exit, tick end, aborted spawn) | `UNAUTHORIZED`                                                                   |

The same recovery applies to a re-hello: `resume.conn` is accepted when it equals the binding's
`conn`, or its `prevConn` while `connUsed` is false (a lost resume response). Each accepted hello
rotates `prevConn ← conn`, mints a new `conn`, resets `seq` to `{ last: 0 }` and `connUsed` to
false. A `conn` that matches nothing is `UNKNOWN_SESSION` on `hello` and `STALE_CONN` elsewhere.
A resume on a binding in state `closed` is `UNKNOWN_SESSION`.

`sid` is taken from `hello.sid`. Later requests whose envelope `sid` differs are answered with
`resync: true` and do **not** change `binding.sid` (contract §15, last row); only the
`session.rebound` handler of P1W3 calls `table.rebind(b, sid)`, which this wave provides.

**No `conn` persistence** (contract §3 item 8). `before-quit` kills every PTY
(`killAllPtys`, `pty.ts:1112`; `index.ts:1015`), and a main-process crash closes the PTY masters, so
a Harnu-spawned `claude` never outlives the table that knows its PTY. The only "host restart" a
live binding sees is a listener restart inside one process, which the in-memory table covers. A
hash file would add a secret-derived artefact at rest for no reachable case. The external profile
(P4W3), where sessions do outlive Harnu, owns persistence if it needs it.

**Harnu session key.** The table stores the owner, not the key. `host.ts` resolves the key lazily
through an injected `sessionKeyOf(owner)`, backed for PTYs by a new export
`sessionKeyForPty(ptyId)` in `pty.ts` (a one-line read of `sessionIndex.getSessionKey`, used at
`pty.ts:923`). `pty:rekey` therefore needs no second bookkeeping. A tick's key is
`tick:<workerId>:<runId>`.

### 7.6 Endpoint behaviour in this wave

| Endpoint | Behaviour                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`  | validate → `negotiate` (`PROTO_UNSUPPORTED`) → at most one of `spawn`/`resume` (both present: `BAD_ENVELOPE`; neither: the external claim, `FEATURE_DISABLED` until P4W3 registers its handler, contract §5.1 and §21) → `table.hello` → `beforeHello` listeners → respond `{ ok, proto, conn, bootId, sessionKey, profile, enable: [], config }`. Answered from memory, no awaited I/O (R9). |
| `events` | envelope → `resolve` (`STALE_CONN`) → rate bucket → `touch` → `acceptEvents` → respond `{ ok, ackSeq, resync? }` → then, on `setImmediate`, publish accepted events on the bus.                                                                                                                                                                                                               |
| `poll`   | envelope → `resolve` → `touch` → the poll handler; `FEATURE_DISABLED` until one is registered (`setPollHandler`, P2W1).                                                                                                                                                                                                                                                                       |
| `ask`    | envelope → `resolve` → `touch` → the handler of `req.kind`; `FEATURE_DISABLED` until that kind is registered (`registerAskKind`).                                                                                                                                                                                                                                                             |
| `bye`    | envelope → `resolve` → accept `events` as above → `table.end` → `{ ok: true }`. The lease reads `lost` at once; no 20 s wait.                                                                                                                                                                                                                                                                 |

`profile` is `'headless'` when `hello.isInteractive === false`, else `'interactive'`. `config` is
the contract §7 defaults. `sessionKey` is `sessionKeyOf(owner)`.

### 7.7 Facade, bus and wiring (`host.ts`)

```ts
export interface CompanionBus {
  on(type: 'hello', fn: (b: BindingView, kind: 'spawn' | 'resume' | 'external') => void): () => void
  on(type: 'event', fn: (b: BindingView, ev: WireEvent) => void): () => void
  on(type: 'lease', fn: (b: BindingView, state: 'lost') => void): () => void
  on(type: 'end', fn: (b: BindingView, reason: string) => void): () => void
}

export const companionHost: {
  mintSpawnToken(meta: SpawnMeta): SpawnToken | null // null when the listener is not accepting
  releaseSpawn(owner: SpawnOwner, reason: 'pty-exit' | 'spawn-aborted' | 'tick-done'): void
  bindingForSession(sessionKey: string): BindingView | null
  bindingForSid(sid: Sid): BindingView | null
  getBinding(sidOrSessionKey: string): BindingView | null // the lookup P1W4 names; tries the key, then the sid
  onBindingChange(fn: (b: BindingView) => void): () => void // any of hello, lease, end, rebind
  spawnRecord(owner: SpawnOwner): SpawnRecordView | null
  setEnablePolicy(fn: EnablePolicy): void // P1W3 registers the first policy; P1W4 replaces it
  // Endpoint extension points (master §12.1). None has a caller in this wave.
  setPollHandler(
    fn: (b: BindingView, req: PollRequest, reply: (r: PollResponse) => void) => void
  ): void
  registerAskKind<K extends AskKind>(
    kind: K,
    fn: (b: BindingView, req: AskRequest<K>, reply: (r: AskResponse<K>) => void) => void
  ): void
  setCommandSource(fn: (b: BindingView, cursor?: number) => Command[]): void // fills `commands` of hello and events responses
  beforeHello(fn: (b: BindingView, kind: 'spawn' | 'resume' | 'external') => void): () => void
  hold(b: BindingView): () => void // the lease counts a parked request until the returned function is called
  revoke(b: BindingView): void
  markProven(b: BindingView, feature: FeatureId): void
  revokeProof(b: BindingView, feature: FeatureId): void
  verifyStamp(
    handle: string,
    nonce: string,
    tool: string,
    mac: string
  ): { binding: BindingView; verdict: 'verified' | 'bad-mac' | 'replayed' } | 'unknown-binding' // P2W5; conn and the nonce ring stay here; a nonce is recorded only on 'verified'
  registerEventTypes(names: readonly string[]): void // owning waves extend the `known` set
  bus: CompanionBus
  diagnostics(): CompanionDiagnostics
}
```

- `registerCompanionHost(getWindow)` is called from `src/main/index.ts` beside
  `registerHookBridge` (`index.ts:599`), fire-and-forget with a `.catch` that logs once. It
  hydrates the mode, then runs `reconcileListener()`: start the listener when `listenerWanted()`
  is true and none is running; never stop a running one. `reconcileListener()` runs again on every
  `onModeChange`, so a mode that read `off` at boot only because the CLI-version probe had not
  settled starts the listener a moment later, and a kill switch turned back on at runtime starts it
  if it never ran (a switch turned off leaves it running, §7.3). A start failure
  (`EACCES`, no socket and no port) leaves `mintSpawnToken` returning `null`: every spawn is then a
  legacy spawn.
- `closeCompanionHost()` joins the `before-quit` list (`index.ts:1044`, beside `closeHookBridge()`).
- `companionHost.releaseSpawn({ kind: 'pty', ptyId }, 'pty-exit')`: this wave provides the method;
  P1W2 adds the call in `pty.onExit` (`pty.ts:902`, P1W2 §7.4 item 3). The binding goes to `closed`, the bus emits `end`, later requests on its `conn` are `STALE_CONN`.
  For Harnu-spawned sessions this, not lease expiry, is the primary death signal.
- Lease sweep: `setInterval` every `LEASE_SWEEP_MS = 5 000`, calling `table.sweep()` and emitting
  `lease` once per binding. `leaseOf` is a pure read, so a consumer that asks never sees a stale
  "live" between sweeps. An inert binding (`enabled` empty, which is every binding while only
  this wave's host runs) is never swept as lost: its silence is by design and its Harnu mod
  state is `off` (contract §11.3).
- **Clock.** The lease clock is monotonic (`performance.now()`), never wall time, so a clock change
  cannot expire or revive a lease. A suspended machine would still expire every lease at once on
  wake; `host.ts` therefore calls `table.grace(LEASE_TTL_MS)` on Electron's `powerMonitor`
  `resume` event, giving each binding one TTL to speak again before ARB-4c makes the loss sticky
  (a constraint stated by P1W4). Wire timestamps (`sentAt`, `ts`, `writtenAt`) stay epoch ms.
- **Listener timing.** `beforeHello` listeners run **synchronously**, after the binding exists and
  before `commands` is read from the command source, with no awaited I/O (R9): they are how a
  later wave puts a command into the hello response. Bus listeners run **after** the HTTP response
  is written. Each listener of either kind runs inside its own `try/catch`.

### 7.8 Diagnostics IPC

`ipcMain.handle('companion:diagnostics')` → `companionHost.diagnostics()`; preload
`companionDiagnostics()`.

```ts
interface CompanionDiagnostics {
  mode: CompanionMode
  listener:
    | { state: 'off' }
    | { state: 'failed'; reason: string }
    | { state: 'listening'; transport: 'unix' | 'tcp'; bootId: BootId; startedAt: number }
  totals: { helloOk: number; helloRefused: Record<string, number>; http4xx: Record<string, number> }
  pendingSpawns: number
  bindings: {
    sessionKey: string | null
    sid: Sid
    trust: TrustClass
    state: Binding['state']
    lease: 'live' | 'lost'
    lastRequestAgoMs: number
    proto: number
    profile: string
    cliVersion: string
    modVersion: string
    declared: FeatureId[]
    enabled: FeatureId[]
    counters: Binding['counters']
  }[]
}
```

It carries no endpoint token, spawn token, `conn`, socket path or port (SEC-8).

A second handler, `companion:devMintSpawn`, is registered **only when `!app.isPackaged`**. It
mints a spawn token for a throwaway owner (`{ kind: 'tick', workerId: 'dev', runId }`, trust
`tick`) so the live-verify recipes and the L4 harness of P1W2 can exercise the real server
before `pty.ts` mints tokens. Its preload method `companionDevMintSpawn()` exists in every
build, but in a packaged build no handler is registered, so the call rejects. A static test
asserts the registration sits behind the `isPackaged` check.

### 7.8a Audit log (SEC-6)

The MCP audit ring is verb-centric and holds 200 records (`mcp/audit-log.ts:37`), so the
companion gets its own log, created by this wave so that SEC-6 holds from P1:
`<userData>/companion/audit.ndjson`, mode `0600`, append-only, rotated to `audit.1.ndjson` at
1 MiB. It has one writer, exported for the later record kinds (`command` P2W1, `native-message`
P2W3, `ask` P3W1, `focus` P4W2):

```ts
export function appendAudit(rec: AuditRecord): void // throws when the append fails

interface BindingAuditRecord {
  kind: 'binding'
  ts: number
  change: 'bound' | 'rebound' | 'lease-lost' | 'ended' | 'revoked'
  sessionKey: string | null
  sid: Sid
  prevSid?: Sid
  profile: 'interactive' | 'headless' | 'external'
  trust: TrustClass
}
```

`host.ts` writes one `binding` row per change, from `onBindingChange` and the lease edge. No
record carries `conn`, a spawn token, the endpoint token or message text (SEC-8). `audit-log.ts`
joins the coverage `exclude` list with the other shells.

### 7.9 Mod side

None. `resources/companion/hooks/contract.ts` is created here as types and constants only.

### 7.10 Contract additions

None — merged into `01-contract.md`:

| Item of this wave                                                                     | Now in                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------- |
| `SOCKET_PATH_MAX_BYTES`, `LEASE_SWEEP_MS`, `RATE_WINDOW_MS`, `RATE_MAX_REQUESTS`      | contract §7.1 (the last two settle CQ11) |
| HTTP statuses: `403` (bad token, `Host`, `Origin`), `405`; there is no `401`          | contract §2                              |
| `ackSeq` after a gap is the highest `seq` received                                    | contract §6                              |
| Lost resume response: the previous `conn` is accepted while the current one is unused | contract §3 item 5                       |
| No `conn` persistence for Harnu-spawned sessions                                      | contract §3 item 8                       |
| A tick's `sessionKey` is `tick:<workerId>:<runId>`                                    | contract §4                              |
| Unknown event types still advance `seq`                                               | contract §8; conformance row 18          |
| Revocation and the inert mod                                                          | contract §3 item 9, §5.1                 |

## 8. Arbitration & fallback

This wave has no fact family and arbitrates nothing. Its duty is that the legacy seams cannot
notice it (ARB-1) and that every failure is visible to P1W4 as "no binding" or "lease lost".

| Condition                                             | Host behaviour                                                                                                                        | Session outcome                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Mode `off` (default)                                  | no directory, no socket, no rendezvous file; `mintSpawnToken` → `null`                                                                | legacy, byte-identical to today             |
| Mod absent (old CLI, policy, `--safe-mode`, `--bare`) | a minted token is never redeemed; released at PTY exit                                                                                | legacy; diagnostics shows no binding        |
| Listener fails to start                               | logged once; `listener.state: 'failed'`; `mintSpawnToken` → `null`                                                                    | legacy                                      |
| Host restarting (listener stop/start)                 | in-flight → `HOST_SHUTTING_DOWN`; rendezvous removed then rewritten with a new `bootId`; table kept                                   | mod re-reads, re-hellos with `resume`       |
| Kill switch turned off mid-session (P1W4)             | `revoke(b)` for every binding: the `conn` answers `STALE_CONN`; the re-hello is accepted and answered `enable: []`; listener stays up | mod inert; legacy wins at once, no TTL wait |
| Harnu main restarts                                   | PTYs are killed with it; nothing to recover                                                                                           | new spawns get new tokens                   |
| Lease lost mid-session (unload, wedge, lost `conn`)   | `sweep` sets `leaseLostAt`, bus `lease: 'lost'`; the binding stays resolvable so a late re-hello is still served                      | legacy (P1W4 makes it sticky, ARB-4c)       |
| Process dies without `bye` (SIGKILL)                  | PTY `onExit` → `releaseSpawn` → binding `closed`                                                                                      | settles Q7 on the host side                 |
| Hot reload                                            | old request closes; resume hello rotates `conn`; `seq` restarts at 1                                                                  | binding and lease clock kept                |
| `/clear`                                              | envelope `sid` changes → `resync: true`; no re-key here                                                                               | P1W3 handles `session.rebound`              |
| Headless                                              | `profile: 'headless'`; `poll`/`ask` → `FEATURE_DISABLED`                                                                              | lease by `events` heartbeat                 |
| Stale socket file from a crashed boot                 | probed, unlinked, re-bound                                                                                                            | none                                        |
| Socket owned by another live process                  | not unlinked; TCP fallback                                                                                                            | none                                        |
| Flood from one binding                                | `SLOW_DOWN`                                                                                                                           | mod honours `retryAfterMs`                  |

## 9. Security requirements

Inherits SEC-1 to SEC-9. Wave-specific:

- **SEC-3a/b/c.** The bearer alone reaches nothing: every route but `hello` needs a known `conn`,
  and `hello` needs a redeemable spawn token or a known `conn`. A well-formed request widens no
  authority; the table stores a `TrustClass` taken from the **spawn** (`pty.ts` knows
  `agentControlled`, `readOnly`, `spawnedBy`), never from the request.
- **SEC-8.** Spawn tokens, `conn` and the endpoint token are never logged, never placed in a bus
  payload (`BindingView` omits them), never in diagnostics. `endpoint.json` holds the endpoint
  token only, at `0600`, as ADR-0004 already concedes for the MCP bearer.
- **SEC-6.** One `binding` audit row per binding change (§7.8a), from this wave on.
- **No command surface.** This wave has no route, IPC or facade method that makes the mod do
  anything; `HelloResponse.commands` is never set.
- **Untrusted input.** Bodies are capped before parsing; strings are length-capped; no field of a
  request is used as a path, a key into the filesystem or an argument to a child process.
- **DNS rebinding.** The TCP variant keeps the `Host`/`Origin` guard of `mcp/http-guard.ts`.
- **Residual, stated:** any same-user process can read `endpoint.json` and connect; a sibling mod
  can read `conn` (smoke D6). Neither obtains more than the ability to post events for a binding,
  which no consumer trusts as authority (SEC-3b).

## 10. UX & copy

No user-visible surface and no strings. Diagnostics is consumed by P1W4.

## 11. Acceptance criteria

Test files: `tests/companion/wire-core.test.ts` (W), `tests/companion/session-table.test.ts` (T),
`tests/companion/server.test.ts` (S, real socket in a temp directory, no Electron),
`tests/companion/rendezvous.test.ts` (R), `tests/companion/host-static.test.ts` (H),
`tests/companion/host-lifecycle.test.ts` (L: `reconcileListener` with an injected `start`),
`tests/companion/contract.test.ts` (C: created here, as the host-side replay of the golden fixtures
and the `contract.ts` re-export; later waves append their own cases to it, for example
AC-P3W2-29 and AC-P4W2-18, and never create it).

```
AC-P1W1-1 [contract] Given a started server on a temp directory, When a client POSTs a valid
  hello over the Unix socket, Then it receives HTTP 200 with a body that validates as HelloResponse.
  Evidence: S › "serves hello over the unix socket"; C › "the hello fixtures validate as HelloResponse through the re-export"

AC-P1W1-2 [contract] Given a started server, Then the socket has mode 0600 and its directory 0700.
  Evidence: S › "socket and directory modes"

AC-P1W1-3 [unit] Given a socket path of 91 bytes, or platform win32, Then chooseTransport returns tcp.
  Evidence: R › "falls back to tcp for long paths and win32"

AC-P1W1-4 [contract] Given two consecutive boots on one directory, Then endpoint.json carries the
  same token and a different bootId, and is complete before the first request is accepted.
  Evidence: S › "rendezvous: stable token, fresh bootId, written before accept"
  Guards: BUG-35

AC-P1W1-5 [contract] Given a TCP boot whose stored port is occupied, Then the server binds another
  port and endpoint.json names it.
  Evidence: S › "tcp port fallback is announced"
  Guards: BUG-35

AC-P1W1-6 [contract] Given a wrong bearer, an unknown route, a GET, a 2 MiB body and (TCP) a
  non-loopback Origin, Then the statuses are 403, 404, 405, 413 and 403 respectively.
  Evidence: S › "transport-level refusals"

AC-P1W1-7 [unit] Given a spawn token redeemed once and its conn used by one request, When a second
  hello presents the token, Then the answer is UNAUTHORIZED.
  Evidence: T › "spawn token is one-time (conformance row 2)"

AC-P1W1-8 [unit] Given a spawn token redeemed once and its conn never used, When a second hello
  presents the token, Then a new conn is issued and the first conn answers STALE_CONN.
  Evidence: T › "lost hello response is recoverable (conformance row 3)"

AC-P1W1-9 [unit] Given a bound session, When hello arrives with resume.conn, Then a new conn is
  issued for the same binding, seq restarts at 1 and lastRequestAt is preserved or advanced.
  Evidence: T › "resume rotates conn and keeps the binding"
  Guards: smoke A5

AC-P1W1-10 [unit] Given a resume whose response was lost, When the mod resumes again with the
  previous conn, Then it is accepted; after any request on the current conn it is UNKNOWN_SESSION.
  Evidence: T › "lost resume response is recoverable once"

AC-P1W1-11 [contract] Given batches with seq 1-3, then 2-4, then 7, Then the acks are 3, 4 and 7,
  one duplicate pair is dropped, and only the last answer carries resync: true.
  Evidence: W › "dedupe, gap and resync (conformance row 5)" with fixtures/events-seq.ts

AC-P1W1-12 [contract] Given an event of an unregistered type with unknown fields, Then the batch
  is answered ok, the event is not published and counters.unknown is 1.
  Evidence: W › "unknown types are ignored and counted (conformance row 18)"

AC-P1W1-13 [contract] Given hello with protoMin 2, Then PROTO_UNSUPPORTED.
  Evidence: W › "negotiation: no overlap (conformance row 17)"

AC-P1W1-14 [unit] Given an injected clock, When LEASE_TTL_MS passes with no request and no parked
  request, Then leaseOf is lost and sweep returns the binding exactly once.
  Evidence: T › "lease expiry and single edge (conformance row 21)"

AC-P1W1-30 [unit] Given bindings idle for longer than LEASE_TTL_MS across a simulated suspend,
  When grace(LEASE_TTL_MS) runs before the sweep, Then no lease is reported lost by that sweep.
  Evidence: T › "resume from suspend grants one TTL of grace"

AC-P1W1-15 [contract] Given a known conn, When poll or ask is called, Then FEATURE_DISABLED is
  answered in under 100 ms.
  Evidence: S › "poll and ask are disabled and never hold"

AC-P1W1-16 [contract] Given a bus listener that blocks for 3 s, When hello arrives, Then the
  response is written in under HELLO_SLA_MS.
  Evidence: S › "hello is answered before consumers run"
  Guards: R9

AC-P1W1-17 [contract] Given a bound session with sid A, When an events request carries sid B,
  Then the answer has resync: true and the binding still reads sid A.
  Evidence: S › "envelope sid mismatch does not re-key (conformance row 16)"

AC-P1W1-18 [unit] Given 201 requests in 10 s on one binding, Then the 201st is SLOW_DOWN with
  retryAfterMs 1000, and a hello in the same window is served.
  Evidence: W › "rate bucket"

AC-P1W1-19 [contract] Given a leftover socket file with no listener, Then boot replaces it.
  Evidence: S › "stale socket is replaced"

AC-P1W1-20 [contract] Given a request in flight, When the server stops, Then the request is
  answered HOST_SHUTTING_DOWN and endpoint.json no longer exists.
  Evidence: S › "stop drains and withdraws the rendezvous"

AC-P1W1-21 [unit] Given a bound session, When releaseSpawn(owner, 'pty-exit') runs, Then the
  binding is closed, the bus emits end, and its conn answers STALE_CONN.
  Evidence: T › "pty exit closes the binding"
  Guards: Q7

AC-P1W1-22 [contract] Given the correct bearer and no conn and no spawn token, Then events, poll,
  ask and bye are refused, a hello with neither spawn nor resume is FEATURE_DISABLED, and a hello
  with both is BAD_ENVELOPE.
  Evidence: S › "the bearer alone reaches nothing"

AC-P1W1-31 [contract] Given a bound session, When revoke runs, Then a request on its conn answers
  STALE_CONN, a hello with resume of that conn is accepted, and with a policy returning nothing
  the answer carries enable: [] (conformance row 25).
  Evidence: S › "revoked conn: stale elsewhere, accepted on resume, enable empty"

AC-P1W1-32 [contract] Given a beforeHello listener and a command source, When hello arrives,
  Then the listener ran before the command source was read and the response is written before
  any bus listener runs.
  Evidence: S › "beforeHello is synchronous and precedes commands"
  Guards: R9

AC-P1W1-33 [unit] Given a binding change (bound, rebound, lease lost, ended, revoked), Then one
  binding audit row is appended, and it contains no conn, token or endpoint token.
  Evidence: tests/companion/audit-core.test.ts › "one row per binding change"

AC-P1W1-23 [unit] Given a populated table, Then JSON.stringify(diagnostics()) and every bus
  payload contain no substring of any minted token, conn or the endpoint token.
  Evidence: H › "no secret leaves the table (conformance row 20)"

AC-P1W1-24 [unit] Then no source file under src/main/companion/ passes a token-bearing identifier
  to console.*, and none imports hook-bridge, responder-registry or pty internals other than
  sessionKeyForPty.
  Evidence: H › "static: no secret logging, no legacy coupling"

AC-P1W1-25 [unit] Given no companion-prefs.json, Then getCompanionMode() is off and
  registerCompanionHost creates no directory and no socket.
  Evidence: tests/companion/mode.test.ts › "default off starts nothing"

AC-P1W1-26 [unit] Given a listener that failed to start, Then mintSpawnToken returns null and
  diagnostics().listener.state is failed.
  Evidence: T › "host down mints nothing"

AC-P1W1-27 [contract] Given bye with a final events batch, Then the events are accepted, the
  binding is ended and leaseOf is lost immediately.
  Evidence: S › "bye ends the binding"

AC-P1W1-28 [live-verify] Given the isolated instance with mode shadow, When a throwaway mod posts
  hello over the real socket from an interactive PTY and from -p, Then both get 200 in under 50 ms.
  Evidence: LV-P1W1-a (host log excerpt, claude --version)

AC-P1W1-29 [live-verify] Given a spy mod and a caller mod loaded together, When the caller
  fetches with socketPath, Then the recipe records whether the spy observed the request (CQ5).
  Evidence: LV-P1W1-b (both mods' logs)

AC-P1W1-34 [unit] Given a host whose mode inputs read off at boot, When they change and
  onModeChange fires, Then the listener is started once and a later mintSpawnToken returns a token.
  Evidence: tests/companion/host-lifecycle.test.ts › "the listener follows the mode inputs"

AC-P1W1-35 [contract] Given hello with protoMin 1 and protoMax 3, Then proto is 1.
  Evidence: W › "negotiation: highest common version (conformance row 17)"

AC-P1W1-36 [contract] Given a socket with a live listener, Then boot leaves it and announces tcp.
  Evidence: S › "a live socket is left alone"
```

**Live-verify recipes** (second isolated instance per `docs/dev/live-verify-second-instance.md`;
its data directory is separate, so its socket and rendezvous file are too).

**LV-P1W1-a — real CLI over the real socket.**

1. Write `{ "v": 1, "mode": "shadow" }` to the isolated instance's `companion-prefs.json`; launch
   it from `out/` (an unpackaged run; a `build:unpack` build is packaged and refuses step 3).
2. Read its `endpoint.json`; confirm `transport: "unix"`.
3. Through CDP, call `window.api.companionDevMintSpawn()` (§7.8; served only when
   `!app.isPackaged`) to obtain a spawn token bound to a throwaway owner.
4. In a temp folder create a one-file mod whose `session.start` hook reads `HARNU_SPAWN_TOKEN` and
   the rendezvous path baked as a literal, POSTs `hello`, then one `events` heartbeat, and logs
   status and elapsed ms with `$.fs`.
5. Run it interactively and with `-p "/exit" < /dev/null`, each with a fresh token.
6. Pass: both log 200 for hello and for events; `window.api.companionDiagnostics()` shows two
   bindings, `lease: 'live'` then `lost` 20 s after the process ends. Record `claude --version`.

**LV-P1W1-b — sibling visibility of a socket fetch (CQ5).**

1. Reuse the mod of LV-P1W1-a as the caller; add a spy mod with `on('http.fetch', …)` that logs
   `e.url` and whether `e.init.socketPath` and the `authorization` header are present, then
   returns `next(e)`.
2. Run `claude -p "/exit" --plugin-dir <spy> --plugin-dir <caller>`, then with the flags swapped.
3. Record the observation in the smoke evidence addendum. Either outcome passes: the design
   already assumes "visible". If the spy sees nothing, P1W4 may note it; nothing here changes.

**Human ACs.** None.

## 12. Docs deliverables

| Contract                 | Deliverable                                                                                                                                                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`           | None: no behaviour changes for a user (mode `off`, nothing listens), so DOC-1 does not apply. The gate fires on any `src/` change (`scripts/ci/changelog-gate-core.mjs`), so the PR carries the `no-changelog` label and local-ci runs with `--labels no-changelog`. |
| `docs/harnu-features.md` | None (not agent-facing).                                                                                                                                                                                                                                             |
| `docs/user/`             | None. No top-level `src/main/*.ts` file is added; the gate does not fire.                                                                                                                                                                                            |
| `design.md`, i18n        | None.                                                                                                                                                                                                                                                                |
| `01-contract.md`         | Already merged (§7.10). `contract.ts` and the fixtures land with this wave's code (DOC-7).                                                                                                                                                                           |
| `docs/dev/`              | One paragraph in `docs/dev/live-verify-second-instance.md`: the isolated instance has its own `companion/` directory.                                                                                                                                                |

## 13. Rollout & parity gate

No fact family, no shadow comparison, no parity gate. The wave ships dark: the mode file does not
exist in any install, so nothing listens. It **demotes nothing**. Merge bar: QA-4 with the base
`docs/t389-harnu-mod-specs` tip (or `main`); `--with-cli` is not required (no CLI-dependent
vitest suite; the two live-verify ACs are attached as evidence).

## 14. Open questions

| #    | Question                                                                                                                            | Owner | Fallback already designed                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| OQ-1 | CQ5: is a `socketPath` fetch visible to sibling mods?                                                                               | P1W1  | Assume visible (AC-P1W1-29 records the answer).                                                   |
| OQ-2 | CQ6: the real byte length of the socket path on macOS, and whether `socketPath` works there; no Windows transport test.             | P1W1  | TCP above 90 bytes and on win32. Needs one macOS run of LV-P1W1-a before the family flip in P1W4. |
| OQ-3 | Does the engine's fetch reuse the Unix connection (keep-alive)? It decides whether Node's default `keepAliveTimeout` (5 s) matters. | P1W1  | Server sets `keepAliveTimeout` to 35 s and `headersTimeout` to 40 s; harmless if unused.          |
| OQ-4 | Master Q30: should the rate bucket be per binding or per connection for the external profile?                                       | P4W3  | Per binding.                                                                                      |

## 15. Risks

| Risk                                                                                | Sev    | Mitigation                                                                                        |
| ----------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| R9: a slow host blocks the first prompt                                             | Medium | hello answered from memory before any consumer runs (AC-P1W1-16); the mod bounds its wait (P1W3). |
| A second Harnu on the same data directory unlinks a live socket                     | Medium | connect-probe before unlink (AC-P1W1-19); the single-instance lock already prevents the case.     |
| Importing `resources/…/contract.ts` from main breaks the build or the packaged path | Medium | it is compiled into the main bundle (types and constants only); the typecheck includes it.        |
| The table grows without bound when tokens are never redeemed                        | Low    | every grant is released at PTY exit or tick end; diagnostics shows `pendingSpawns`.               |
| `endpoint.json` left behind by a crash points at a dead socket                      | Low    | the mod backs off to 15 s; the next boot rewrites it.                                             |
| Treating `conn` as proof of anything in a later wave                                | High   | `BindingView` carries `trust` from the spawn; SEC-3b; AC-P1W1-22.                                 |
