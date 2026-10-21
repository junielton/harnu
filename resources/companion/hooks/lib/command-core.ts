import {
  BAND_DETAIL_MAX,
  BAND_HINT_MAX,
  BAND_LEAD_MAX,
  BAND_TTL_MS,
  CMD_DONE_MAX,
  CONFIG_BOUNDS,
  CONTEXT_MAX_CHARS,
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
  'ui.status',
  'context.append',
  'ui.band.set'
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
  // A tokenless mod runs its three commands without looking at `enable` (contract §21 item 5): the
  // external enable set carries no `act.*`, and the host decides what it sends.
  if (ctx.tokenBacked && !ctx.featureEnabled(COMMAND_FEATURE[c.name]))
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

// ---- context.append (T257 U2a-ii) ------------------------------------------------------------------

/** The one context key this build of the mod appends: the others belong to a later wave (P2W4). */
export const REVIEW_SELECTION_KEY = 'harnu.review-selection'

/**
 * `context.append` (second lock, spec T257 §6.3): exactly `{ key, text, durable }`, the review key,
 * `durable: false` and 1 to `CONTEXT_MAX_CHARS` characters. The mod stores nothing of it: a row is
 * appended once and is lost with the conversation on a compaction, by design.
 */
export function parseContextAppend(
  args: unknown
): { ok: true; text: string } | { ok: false; message: string } {
  if (!isRec(args)) return { ok: false, message: 'the arguments are not an object' }
  if (Object.keys(args).some((k) => k !== 'key' && k !== 'text' && k !== 'durable'))
    return { ok: false, message: 'an unknown argument' }
  if (args.key !== REVIEW_SELECTION_KEY)
    return { ok: false, message: 'this mod appends only the review selection key' }
  if (args.durable !== false) return { ok: false, message: 'only a non-durable row is supported' }
  const text = args.text
  if (typeof text !== 'string' || text.length === 0)
    return { ok: false, message: 'the text is empty' }
  if (text.length > CONTEXT_MAX_CHARS)
    return { ok: false, message: `the text is over ${CONTEXT_MAX_CHARS} characters` }
  return { ok: true, text }
}

// ---- ui.band.set (T257 U2a-ii, P4W2 §7.4) --------------------------------------------------------------

/** The `$.state` key `band`: the one line the view draws. `n` is the `Command.n` that set it. */
export interface BandState {
  v: 1
  lead: string
  detail?: string
  hint?: string
  n: number
  expiresAt: number
}

/** C0 and C1 controls, line and paragraph separators, and the bidi overrides a path could carry. */
// eslint-disable-next-line no-control-regex
const BAND_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
const clean = (s: string): string => s.replace(BAND_UNSAFE, '')

/** What `ui.band.set` asks for: clear the band, or set these (already cleaned) parts. */
export type BandRequest =
  { kind: 'clear' } | { kind: 'set'; lead: string; detail?: string; hint?: string }

/**
 * `ui.band.set` (second lock, contract §9): `parts` are cleaned of control characters and checked
 * against the lengths the host checked; a `link` is dropped and the line is kept (the band carries
 * no href). `null` is a precondition failure (no parts, an empty or over-long part).
 */
export function parseBandSet(args: unknown): BandRequest | null {
  if (!isRec(args)) return null
  if (args.line === null) return { kind: 'clear' }
  if (typeof args.line !== 'string' || !isRec(args.parts)) return null
  const part = (v: unknown, max: number): string | null | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'string') return null
    const s = clean(v)
    return s.length > max ? null : s
  }
  const lead = part(args.parts.lead, BAND_LEAD_MAX)
  const detail = part(args.parts.detail, BAND_DETAIL_MAX)
  const hint = part(args.parts.hint, BAND_HINT_MAX)
  if (lead === undefined || lead === null || lead.trim() === '') return null
  if (detail === null || hint === null) return null
  return {
    kind: 'set',
    lead,
    ...(detail !== undefined && detail !== '' ? { detail } : {}),
    ...(hint !== undefined && hint !== '' ? { hint } : {})
  }
}

/** What `$.state` held under `band`, read defensively: any other plugin can write it. */
export function parseBandState(raw: unknown): BandState | null {
  if (!isRec(raw) || raw.v !== 1) return null
  if (typeof raw.lead !== 'string' || raw.lead === '') return null
  if (!Number.isSafeInteger(raw.n) || typeof raw.expiresAt !== 'number') return null
  if (!Number.isFinite(raw.expiresAt)) return null
  return {
    v: 1,
    lead: raw.lead,
    ...(typeof raw.detail === 'string' && raw.detail !== '' ? { detail: raw.detail } : {}),
    ...(typeof raw.hint === 'string' && raw.hint !== '' ? { hint: raw.hint } : {}),
    n: raw.n as number,
    expiresAt: raw.expiresAt
  }
}

/** A band stands until its `expiresAt`; the clock is the mod's. */
export const bandLive = (b: BandState | null, now: number): b is BandState =>
  b !== null && now < b.expiresAt

/**
 * The next band state, or `null` for "leave it": a lower `n` never overwrites a higher one, and a
 * clear is a state too. `known` is the highest `n` this load has applied.
 */
export function applyBand(
  req: BandRequest,
  n: number,
  now: number,
  stored: BandState | null,
  known: number
): { apply: true; next: BandState | null } | { apply: false } {
  if (n < Math.max(known, stored?.n ?? 0)) return { apply: false }
  if (req.kind === 'clear') return { apply: true, next: null }
  return {
    apply: true,
    next: {
      v: 1,
      lead: req.lead,
      ...(req.detail !== undefined ? { detail: req.detail } : {}),
      ...(req.hint !== undefined ? { hint: req.hint } : {}),
      n,
      expiresAt: now + BAND_TTL_MS
    }
  }
}

/**
 * The features the band hook buys (contract §11): `act.context` and `ui.band`, only when the
 * `ui.render` registration took AND the base set (identity, channel) is declared. A CLI without the
 * hook declares neither, and the host never enables them.
 */
export const bandFeatures = (
  registered: Readonly<Record<string, boolean>>,
  base: boolean
): FeatureId[] => (base && registered['ui.render'] === true ? ['act.context', 'ui.band'] : [])

/** The band sweep: how often a standing line is checked against its `expiresAt`. */
export const BAND_SWEEP_MS = 30_000

/** Below this the band is the compact line (the range alone); at it and above, the full one. */
export const BAND_MIN_COLUMNS = 40
const BAND_MARK = '\u25c6 Harnu '

/**
 * The range at the end of a band lead the host built (`⧉ speech.ts L85–92`, `⧉ speech.ts old L85
 * – new L92`, `⧉ L85`, `⧉ speech.ts (file)`), or `null` when the lead does not end in one. The host
 * already puts the range in the lead, so the compact line needs no new field and no contract change.
 * The longest form is tried first, so a range across both sides is not read as its last half.
 */
// Built from strings: the API-surface scan reads a `$` in code as the engine's `$` (MOD-1).
const RANGE_TAIL = new RegExp(
  '(?:^| )((?:old|new) L\\d+ \\u2013 (?:old|new) L\\d+|(?:old )?L\\d+(?:\\u2013\\d+)?|\\(file\\))$'
)

const MIXED_RANGE = new RegExp('^(?:old|new) L(\\d+) \\u2013 (?:old|new) L(\\d+)$')

/**
 * The compact line, for a pane under {@link BAND_MIN_COLUMNS}: `⧉ L21`, `⧉ L21–24`, `⧉ (file)`, and
 * for a range across both sides its explicit form `⧉ old L85 – new L92`, shortened to `⧉ L85–L92`
 * when that does not fit. No mark, no file name. The first form that fits is returned; when none
 * does (the shortest is 4 columns, `⧉ L9`) nothing is drawn: a cut-off range would name the wrong
 * lines.
 */
function fitCompact(lead: string, columns: number): string | null {
  const range = RANGE_TAIL.exec(lead)?.[1]
  if (range === undefined) return null
  const mixed = MIXED_RANGE.exec(range)
  const forms = [`\u29c9 ${range}`, ...(mixed ? [`\u29c9 L${mixed[1]}\u2013L${mixed[2]}`] : [])]
  return forms.find((f) => f.length <= columns) ?? null
}

/**
 * The text of the one row, fitted to `bodyColumns` (P4W2 §7.4): under 40 the compact line (range
 * only, {@link fitCompact}), 40-79 the lead, 80-109 the lead (no link), 110-143 lead and detail, 144
 * and up lead, detail and hint. A part that is not there leaves no separator. Cut at the width with
 * an ellipsis, never wider.
 */
export function fitBand(b: BandState, columns: number): string | null {
  if (!Number.isFinite(columns) || columns < 0) return null
  if (columns < BAND_MIN_COLUMNS) return fitCompact(b.lead, columns)
  const parts = [b.lead]
  if (columns >= 110 && b.detail !== undefined) parts.push(b.detail)
  if (columns >= 144 && b.hint !== undefined) parts.push(b.hint)
  const row = `${BAND_MARK}${parts.join(' \u00b7 ')}`
  return row.length <= columns ? row : `${row.slice(0, Math.max(1, columns - 1))}\u2026`
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
