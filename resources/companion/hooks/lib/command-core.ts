import {
  CMD_DONE_MAX,
  CONFIG_BOUNDS,
  type Command,
  type CommandName,
  type Config,
  type ErrorCode,
  type FeatureId
} from '../contract'

/**
 * The `$`-free half of the command channel (P2W1 §7.7): cursor and dedupe arithmetic, the closed
 * table of commands, argument bounds, the structural check of an untrusted response and the
 * mapping of an engine rejection to an error code. `register.ts` owns the loop and the `$` calls.
 */

/** The `$.state` key `channel` (contract §22). */
export interface ChannelState {
  bootId: string | null
  cursor: number
  started: string[]
  resulted: string[]
  turnId: string | null
}

export const EMPTY_CHANNEL: Readonly<ChannelState> = {
  bootId: null,
  cursor: 0,
  started: [],
  resulted: [],
  turnId: null
}

/** Keeps the newest `max` ids. */
export const capIds = (ids: readonly string[], max = CMD_DONE_MAX): string[] =>
  ids.length > max ? ids.slice(ids.length - max) : [...ids]

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= CMD_DONE_MAX * 4 && v.every((x) => typeof x === 'string')

/** What `$.state` held, read defensively: any other plugin can write it (types L3156). */
export function parseChannel(raw: unknown): ChannelState {
  if (typeof raw !== 'object' || raw === null)
    return { ...EMPTY_CHANNEL, started: [], resulted: [] }
  const r = raw as Record<string, unknown>
  return {
    bootId: typeof r.bootId === 'string' ? r.bootId : null,
    cursor: Number.isSafeInteger(r.cursor) && (r.cursor as number) >= 0 ? (r.cursor as number) : 0,
    started: isIdList(r.started) ? capIds(r.started) : [],
    resulted: isIdList(r.resulted) ? capIds(r.resulted) : [],
    turnId: typeof r.turnId === 'string' ? r.turnId : null
  }
}

/** A cursor belongs to one host boot: a new boot restarts it at 0 (contract §6, commands 6). */
export function forBoot(state: ChannelState, bootId: string): ChannelState {
  return state.bootId === bootId ? state : { ...state, bootId, cursor: 0 }
}

export const withCursor = (state: ChannelState, n: number): ChannelState =>
  n > state.cursor ? { ...state, cursor: n } : state

export const markStarted = (state: ChannelState, cmd: string): ChannelState => ({
  ...state,
  started: capIds([...state.started, cmd])
})

export const markResulted = (state: ChannelState, cmd: string): ChannelState => ({
  ...state,
  resulted: capIds([...state.resulted, cmd])
})

// ---- the closed table of commands ----------------------------------------------------------------

/** Contract §11.1 and §9: the feature each command needs. */
export const COMMAND_FEATURE: Readonly<Record<CommandName, FeatureId>> = {
  flush: 'act.channel',
  'config.update': 'act.channel',
  'turn.abort': 'act.turn',
  'session.compact': 'act.compact',
  'ui.toast': 'act.ui',
  'ui.status': 'act.ui',
  'prompt.submit': 'act.prompt',
  'message.deliver': 'act.message',
  'context.append': 'act.context',
  'context.drop': 'act.context',
  'guard.set': 'gate.guard',
  'sentinel.set': 'gate.sentinel',
  'ui.band.set': 'ui.band',
  'plan.capture': 'act.plan'
}

/**
 * The commands this build of the mod has a `case` for in `runHandler`. A name that is in the
 * contract but not here is `CMD_UNSUPPORTED`: a later wave adds its name with its `case`.
 */
export const IMPLEMENTED_COMMANDS: ReadonlySet<string> = new Set([
  'flush',
  'config.update',
  'turn.abort',
  'session.compact',
  'ui.toast',
  'ui.status'
])

/** The tokenless second lock (contract §9): every other command is `CMD_UNSUPPORTED` without a token. */
export const TOKENLESS_OK: ReadonlySet<string> = new Set(['flush', 'config.update', 'ui.band.set'])

/** A reload after the `$` call is no proof of non-delivery (contract §6, commands 5). */
const SUBMIT_COMMANDS: ReadonlySet<string> = new Set(['prompt.submit', 'message.deliver'])

export const UI_TEXT_MAX = 200
const MESSAGE_MAX = 512

export type Disposition =
  | { kind: 'skip' }
  | { kind: 'run' }
  | { kind: 'answer'; code: ErrorCode; message?: string; data?: unknown }

export interface ClassifyContext {
  state: ChannelState
  /** Ids a running call in THIS load will answer. */
  inFlight: ReadonlySet<string>
  now: number
  tokenBacked: boolean
  featureEnabled(feature: FeatureId): boolean
  /** A handler is registered for this name. Default: the name is in the closed table. */
  known?(name: string): boolean
}

/** The executor's table (spec §7.7): exactly one `command.result` per `cmd`. */
export function classifyCommand(c: Command, ctx: ClassifyContext): Disposition {
  if (ctx.state.resulted.includes(c.cmd)) return { kind: 'skip' }
  if (ctx.inFlight.has(c.cmd)) return { kind: 'skip' }
  if (ctx.state.started.includes(c.cmd)) {
    return {
      kind: 'answer',
      code: 'CMD_FAILED',
      message: 'interrupted by reload',
      ...(SUBMIT_COMMANDS.has(c.name) ? { data: { submitted: 'unknown' } } : {})
    }
  }
  if (ctx.now >= c.expiresAt) return { kind: 'answer', code: 'CMD_EXPIRED' }
  const known = Object.hasOwn(COMMAND_FEATURE, c.name) && (ctx.known?.(c.name) ?? true)
  if (!known) return { kind: 'answer', code: 'CMD_UNSUPPORTED' }
  if (!ctx.tokenBacked && !TOKENLESS_OK.has(c.name))
    return { kind: 'answer', code: 'CMD_UNSUPPORTED' }
  if (!ctx.featureEnabled(COMMAND_FEATURE[c.name]))
    return { kind: 'answer', code: 'FEATURE_DISABLED' }
  return { kind: 'run' }
}

// ---- untrusted input -------------------------------------------------------------------------------

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The commands of a response, structurally checked and in `n` order. The host's response is
 * untrusted (SEC-3d): what is not shaped like a command is dropped, nothing is evaluated.
 */
export function parseCommands(raw: unknown): Command[] {
  if (!Array.isArray(raw)) return []
  const out: Command[] = []
  for (const c of raw.slice(0, 64)) {
    if (!isRec(c)) continue
    if (typeof c.cmd !== 'string' || !c.cmd.startsWith('cmd_') || c.cmd.length > 128) continue
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 64) continue
    if (!Number.isSafeInteger(c.n) || (c.n as number) < 1) continue
    if (typeof c.issuedAt !== 'number' || !Number.isFinite(c.issuedAt)) continue
    if (typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt)) continue
    out.push({
      cmd: c.cmd as Command['cmd'],
      n: c.n as number,
      name: c.name as CommandName,
      args: (isRec(c.args) ? c.args : {}) as Command['args'],
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt
    })
  }
  return out.sort((a, b) => a.n - b.n)
}

/**
 * `config.update`: every field against `CONFIG_BOUNDS`, all or none. `null` is a precondition
 * failure (a value outside the bounds, an unknown field, an empty update).
 */
export function parseConfigUpdate(args: unknown): Partial<Config> | null {
  if (!isRec(args) || !isRec(args.config)) return null
  const keys = Object.keys(args.config)
  if (keys.length === 0) return null
  const out: Partial<Config> = {}
  for (const k of keys) {
    if (!Object.hasOwn(CONFIG_BOUNDS, k)) return null
    const v = args.config[k]
    const [min, max] = CONFIG_BOUNDS[k as keyof Config]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return null
    out[k as keyof Config] = v
  }
  return out
}

// ---- the engine's rejections ---------------------------------------------------------------------------

const NO_TURN = /no turn is running/i
const TURN_RUNNING = /a turn is running/i
const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, MESSAGE_MAX)

/**
 * The two rejection texts the smoke runs recorded are preconditions: the engine refused the call,
 * the channel worked. Anything else is a failure carrying the engine's text (OQ-2).
 */
export function mapEngineRejection(err: unknown): { code: ErrorCode; message: string } {
  const message = messageOf(err)
  if (NO_TURN.test(message) || TURN_RUNNING.test(message))
    return { code: 'CMD_PRECONDITION', message }
  return { code: 'CMD_FAILED', message }
}

/** The 30 s fetch cap is a normal reconnect, never an error (contract §7 end, D3). */
export const isHardCapAbort = (err: unknown): boolean =>
  /no complete answer within \d+\s*ms/i.test(messageOf(err))

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** A skipped compaction is ok with `{ skipped: true }`; the counts are optional (types L10050). */
export function compactData(
  r: unknown
): { skipped: true } | { tokensBefore?: number; tokensAfter?: number } {
  if (isRec(r) && typeof r.skip === 'string') return { skipped: true }
  const before = isRec(r) ? num(r.tokensBefore) : undefined
  const after = isRec(r) ? num(r.tokensAfter) : undefined
  return {
    ...(before !== undefined ? { tokensBefore: before } : {}),
    ...(after !== undefined ? { tokensAfter: after } : {})
  }
}
