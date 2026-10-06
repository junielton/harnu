/**
 * Harnu mod protocol 1: the wire contract between the mod (running inside `claude`) and the host
 * (the companion server in Harnu main). Types and constants only, ZERO imports: the mod imports
 * this file by a relative path inside the plugin dir, the host through
 * `src/main/companion/contract.ts` (a re-export).
 *
 * The normative prose is `docs/specs/T389-companion-mod/01-contract.md`. When this file and that
 * document disagree, that is a defect in both: fix them together (DOC-7).
 */

// ---- §4 Ids ---------------------------------------------------------------------------------

/** The CLI session uuid (equals the transcript file name). */
export type Sid = string
/** `sp_<uuid>`, minted by the host, one per PTY spawn or scheduler tick. */
export type SpawnToken = `sp_${string}`
/** `c_<32 hex>`, minted by the host per connection. Correlation, not authentication. */
export type Conn = `c_${string}`
/** `b_<uuid>`, changes on every host boot. */
export type BootId = `b_${string}`
/** `cmd_<ulid>`, minted by the host. */
export type CmdId = `cmd_${string}`
/** `ask_...`, minted by the mod. */
export type AskId = string
/** Dotted lower-case `<class>.<name>` (§11). */
export type FeatureId = string
export type ContextKey = 'harnu.orchestrator' | 'harnu.mission'

// ---- §7 Constants ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1

export const FETCH_HARD_CAP_MS = 30_000
export const POLL_HOLD_MS = 25_000
export const ASK_TRANCHE_MS = 20_000
export const HELLO_SLA_MS = 2_000
export const HELLO_WAIT_MS = 2_500
export const SPAWN_REDEEM_WINDOW_MS = 600_000
export const DRIFT_CHECK_MIN_MS = 1_000
export const BYE_BUDGET_MS = 1_000
export const LEASE_TTL_MS = 20_000
export const LEASE_SWEEP_MS = 5_000
export const HEARTBEAT_MS = 10_000
export const FLUSH_MS = 250
export const BATCH_MAX_EVENTS = 32
export const BATCH_MAX_BYTES = 65_536
export const RING_MAX = 256
export const BODY_MAX_BYTES = 1_048_576
export const SOCKET_PATH_MAX_BYTES = 90
export const RATE_WINDOW_MS = 10_000
export const RATE_MAX_REQUESTS = 200
export const BACKOFF_MIN_MS = 500
export const BACKOFF_MAX_MS = 15_000
export const HOOK_BUDGET_MS = 10_000
export const WEDGE_MS = 5_000

export const CMD_TTL_MS = 30_000
export const CMD_QUEUE_MAX = 64
export const CMD_DONE_MAX = 64
/** Host wait for a result after `expiresAt`, unless the command has its own (§7.2). */
export const CMD_RESULT_GRACE_DEFAULT_MS = 5_000
/**
 * Per command name: an idle compaction answers after 14 to 37 s (smoke C2), and the engine may be
 * slower on a long session. Commands not listed use `CMD_RESULT_GRACE_DEFAULT_MS`.
 */
export const CMD_RESULT_GRACE_MS: Readonly<Partial<Record<CommandName, number>>> = {
  'session.compact': 120_000
}
export const ASK_ORPHAN_MS = 45_000
export const STAMP_NONCE_RING = 512
export const ASK_RECORD_MAX = 64
export const PLAN_USAGE_STALE_MS = 90_000

export const STAMP_ARG = '_harnuCaller'
export const STAMP_PROOF_VERSION = 'v1'

export interface Config {
  flushMs: number
  batchMaxEvents: number
  batchMaxBytes: number
  ringMax: number
  pollHoldMs: number
  askHoldMs: number
  heartbeatMs: number
}

/** What `hello.config` carries when nothing overrides it. */
export const DEFAULT_CONFIG: Readonly<Config> = {
  flushMs: FLUSH_MS,
  batchMaxEvents: BATCH_MAX_EVENTS,
  batchMaxBytes: BATCH_MAX_BYTES,
  ringMax: RING_MAX,
  pollHoldMs: POLL_HOLD_MS,
  askHoldMs: ASK_TRANCHE_MS,
  heartbeatMs: HEARTBEAT_MS
}

/** Bounds for `config.update`; a value outside them is CMD_PRECONDITION (P2W1). */
export const CONFIG_BOUNDS: Readonly<Record<keyof Config, readonly [min: number, max: number]>> = {
  flushMs: [50, 5_000],
  batchMaxEvents: [1, 256],
  batchMaxBytes: [1_024, 524_288],
  ringMax: [32, 1_024],
  pollHoldMs: [1_000, 25_000],
  askHoldMs: [1_000, 20_000],
  heartbeatMs: [2_000, 15_000]
}

// ---- §12 Errors -----------------------------------------------------------------------------

export type ErrorCode =
  // host → mod, in a Failure
  | 'PROTO_UNSUPPORTED'
  | 'UNAUTHORIZED'
  | 'UNKNOWN_SESSION'
  | 'STALE_CONN'
  | 'BAD_ENVELOPE'
  | 'TOO_LARGE'
  | 'SLOW_DOWN'
  | 'FEATURE_DISABLED'
  | 'HOST_SHUTTING_DOWN'
  // mod → host, in command.result
  | 'CMD_EXPIRED'
  | 'CMD_UNSUPPORTED'
  | 'CMD_PRECONDITION'
  | 'CMD_FAILED'

export type Failure = { ok: false; code: ErrorCode; message?: string; retryAfterMs?: number }

// ---- §2 Transport and rendezvous ------------------------------------------------------------

export type EndpointName = 'hello' | 'events' | 'poll' | 'ask' | 'bye'

/** The five routes, `POST /v1/<endpoint>`. */
export const ENDPOINT_NAMES: readonly EndpointName[] = ['hello', 'events', 'poll', 'ask', 'bye']

/** <userData>/companion/endpoint.json */
export interface EndpointFile {
  v: 1
  transport: 'unix' | 'tcp'
  socketPath?: string // transport 'unix'
  port?: number // transport 'tcp', always 127.0.0.1
  token: string // endpoint token; defence in depth only (§17)
  bootId: BootId // changes on every host boot
  protoMin: number
  protoMax: number
  writtenAt: number // epoch ms
}

// ---- §5 Endpoints ---------------------------------------------------------------------------

/** Carried by every request except hello. */
export interface Envelope {
  v: number // negotiated protocol version
  sid: Sid // the mod's bound session id (§15)
  conn: Conn
  sentAt: number // epoch ms, mod clock
}

export interface HelloRequest {
  protoMin: number
  protoMax: number
  sid: Sid
  spawn?: SpawnToken // first hello of a Harnu-spawned process
  resume?: { conn: Conn } // re-hello
  cli: { version: string }
  mod: { version: string }
  surface: string | null // session.start.surface; null for -p and the SDK
  isInteractive: boolean
  cwd: string
  declared: FeatureId[] // only features whose hooks actually registered (§11)
  sentAt: number
}

export type HelloProfile = 'interactive' | 'headless' | 'external'

export type HelloResponse =
  | {
      ok: true
      proto: number
      conn: Conn
      bootId: BootId
      sessionKey: string | null
      profile: HelloProfile
      enable: FeatureId[] // subset of `declared`
      config: Config
      opts?: ModOptions
      commands?: Command[]
    }
  | Failure

/** Per-hello options the mod cannot derive from `enable`. Additive; unknown keys are ignored. */
export interface ModOptions {
  compactSummary?: boolean // P4W5
}

export interface EventsRequest extends Envelope {
  events: WireEvent[] // may be empty (heartbeat)
  dropped?: number // events the mod discarded since the last accepted batch
  bootId?: BootId // non-polling profiles only
  cursor?: number // non-polling profiles only: highest Command.n recorded
}

export interface WireEvent<N extends EventName = EventName> {
  seq: number // monotonic per conn, starts at 1
  t: N
  ts: number // epoch ms, when the CLI event fired
  turnId?: string // MUST be set on turn.started and turn.completed
  agentId?: string // present for a subagent's event
  d: EventPayloads[N]
}

export type EventsResponse =
  { ok: true; ackSeq: number; resync?: boolean; commands?: Command[] } | Failure

export interface PollRequest extends Envelope {
  bootId: BootId // the boot the cursor belongs to
  cursor: number // highest Command.n the mod has recorded for that boot
}

export type PollResponse = { ok: true; commands: Command[]; resync?: boolean } | Failure

export interface Command<N extends CommandName = CommandName> {
  cmd: CmdId
  n: number // ordinal per binding and boot, starts at 1
  name: N
  args: CommandArgs[N]
  issuedAt: number
  expiresAt: number
}

export interface AskRequest<K extends AskKind = AskKind> extends Envelope {
  askId: AskId
  kind: K
  d?: AskPayloads[K] // MUST be present on the first tranche; MAY be omitted afterwards
}

export type ReleaseReason = 'abstain' | 'shadow' | 'settled' | 'expired' | 'host-shutdown'

export type AskResponse<K extends AskKind = AskKind> =
  | { ok: true; state: 'pending' }
  | { ok: true; state: 'decided'; decision: AskDecisions[K] }
  | { ok: true; state: 'released'; reason: ReleaseReason }
  | Failure

export interface ByeRequest extends Envelope {
  reason: string // session.end.reason
  events?: WireEvent[] // the final flush, including `session.end`
}

export type ByeResponse = { ok: true } | Failure

// ---- §8 Events (mod → host) -----------------------------------------------------------------

export type AttentionKind = 'permission' | 'idle' | 'input'

/** A model request's token counts. Fork, complete and compaction results carry no model. */
export interface AuxUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface TurnUsage extends AuxUsage {
  model: string
}

export interface EventPayloads {
  'session.snapshot': {
    reason: 'hello' | 'resync' | 'flush' | 'probe'
    activeTurnId: string | null
    openAttention: { kind: AttentionKind; toolUseId?: string }[]
    runningSubagents: number
    probes: { classic: boolean; toolCheck: boolean }
  }
  'session.rebound': { prevSid: Sid; sid: Sid; cause: 'clear' | 'resume' | 'unknown' }
  'session.end': { reason: string }
  'mod.error': {
    where: string
    kind: 'throw' | 'timeout' | 'abort' | 'registration'
    message: string
    cmd?: CmdId
  }
  'turn.started': { origin: 'human' | 'plugin' | 'peer' | 'unknown'; cmd?: CmdId }
  'turn.completed': {
    reason: 'answer' | 'aborted' | 'refusal' | 'error'
    isAborted: boolean
    durationMs: number
    usage?: TurnUsage
    backgroundTasks?: number
    backgroundSubagents?: number
    failure?: { type: string }
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
    source: 'measure' | 'read'
    context?: { window: number; tokens?: number; percent?: number }
    rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
    costUsd?: number
    changed: ('context' | 'rateLimits' | 'cost')[]
    startedAt?: number
    model?: string
  }
  'command.result': {
    cmd: CmdId
    ok: boolean
    code?: ErrorCode
    message?: string
    data?: CommandResultData[keyof CommandResultData]
  }
  'message.sent': {
    origin: 'model' | 'plugin'
    plugin?: string
    to: string
    delivered: boolean
    reason?: string
    bytes: number
    hash?: string
  }
  'message.received': {
    originKind: string
    plugin?: string
    fromName?: string
    from?: string
    bytes: number
    hash?: string
    outcome: 'queued' | 'consumed' | 'rewritten'
  }
  'guard.denied': { tool: string; path: string; toolUseId?: string }
  'guard.evaluated': {
    tool: string
    path: string
    subagent: boolean
    decision: 'allow' | 'deny'
    exempt?: 'harnu' | 'scratch' | 'memory'
    toolUseId?: string
  }
  'ask.settled': { askId: AskId; cause: 'tool-ran' | 'tool-failed' | 'aborted' | 'turn-ended' }
  'ui.action': { name: 'open' }
  'compact.done': {
    trigger: 'manual' | 'auto' | 'plugin'
    via: 'hook' | 'command' | 'classic'
    tokensBefore?: number
    tokensAfter?: number
    usage?: AuxUsage
    summary?: string
    summaryTruncated?: boolean
    summaryChars: number
    reinjected: number
  }
  'mod.admitted': {
    name: string
    tier: 'prepend' | 'user' | 'append' | 'builtin'
    root: string
    version?: string
    provenance: string
    uses: {
      events: string[]
      calls: string[]
      env: { reads: string[]; writes: string[] }
      state: { reads: { plugin: string; key: string }[]; writes: { plugin: string; key: string }[] }
    }
  }
}

export type EventName = keyof EventPayloads

// ---- §9 Commands (host → mod) ---------------------------------------------------------------

export interface BandParts {
  lead: string // at most 32 chars
  detail?: string // at most 48 chars
  hint?: string // at most 32 chars
}

export interface BandLink {
  label: string // at most 16 chars
  href: string // http://localhost:<port>/o/<Ticket> only
}

export interface CommandArgs {
  flush: Record<string, never>
  'config.update': { config: Partial<Config> }
  'turn.abort': { turnId?: string }
  'session.compact': Record<string, never>
  'ui.toast': { text: string }
  'ui.status': { text: string | null }
  'prompt.submit': {
    text: string
    asUser: boolean
    via: 'prompt' | 'command'
    command?: string
    args?: string
  }
  'message.deliver': { msgId: string; from: { name: string; sessionKey?: string }; text: string }
  'context.append': { key: ContextKey; text: string; durable: boolean; retainOnly?: boolean }
  'context.drop': { key: ContextKey }
  'guard.set': { armed: boolean; enforce?: boolean }
  'sentinel.set': { tools: string[] }
  'ui.band.set': { line: string | null; parts?: BandParts; link?: BandLink }
  'plan.capture': { title?: boolean }
}

export type CommandName = keyof CommandArgs

export interface SubmitResultData {
  submitted: true | false | 'unknown'
}

export interface PlanCaptureData {
  text: string | null
  reason?: 'nothing-to-fork' | 'api-error' | 'empty-reply' | 'aborted'
  status?: number | null
  usage?: AuxUsage
  title?: string | null
  titleUsage?: AuxUsage
  ms: number
}

/** `command.result.data`, keyed by command name. Commands not listed carry no data. */
export interface CommandResultData {
  'session.compact': { tokensBefore?: number; tokensAfter?: number } | { skipped: true }
  'prompt.submit': SubmitResultData
  'message.deliver': SubmitResultData & { reason?: 'permission-mode' }
  'guard.set': { armed: boolean }
  'plan.capture': PlanCaptureData
}

// ---- §10 Asks (mod → host) ------------------------------------------------------------------

export type AskKind = 'permission' | 'sentinel' | 'status'

export interface AskPayloads {
  permission: {
    tool: string
    input: unknown
    inputTruncated?: boolean
    toolUseId?: string
    ambiguous?: boolean
    askedBy?: 'engine' | 'hook'
    hook?: string
    agentId?: string
    agentType?: string
    permissionMode: string
    cwd: string
    suggestions?: unknown
  }
  sentinel: {
    tool: string
    input: unknown
    inputTruncated?: boolean
    toolUseId: string
    verdict: 'allow' | 'ask' | 'deny'
    cwd: string
  }
  status: { columns: number; isFullscreen: boolean }
}

/** Enums and integers only: the mod builds closed-vocabulary text from it. */
export interface StatusReport {
  companion: 'live' | 'shadow'
  profile: 'interactive' | 'external'
  coverage: 'gated' | 'contested' | 'not-gated'
  held: number
  mission: {
    from: number
    to: number
    of: number
    complete: boolean
    verified: number
    waitingOnOperator: number
  } | null
}

export interface AskDecisions {
  permission: { behavior: 'allow' } | { behavior: 'deny'; message: string }
  sentinel: { behavior: 'deny'; message: string }
  status: StatusReport
}
