/**
 * The origin gate of the command channel (T389 P2W1 §7.4, SEC-5). Pure.
 *
 * Every command is gated by WHO CAUSED IT, server-side, from a constant table: a `(command, cause
 * kind)` pair that is not in the table is `ORIGIN_DENIED`, and so is a gesture, verb or subsystem
 * string the row does not list. This wave registers the rows of its six commands; each later wave
 * adds its own with `registerGateRow` in its own change. A command with no row is denied for every
 * cause, so a wave that forgets to register is closed, never open.
 *
 * `operator` is accepted as a kind for `turn.abort` and `session.compact` but no gesture is
 * registered for it: no IPC route can produce one until a later wave designs the button.
 */

import {
  CONFIG_BOUNDS,
  type CommandName,
  type Config,
  type FeatureId,
  type HelloProfile
} from './contract'
import type { CommandCause, EnqueueRefusal } from './command-types'
import {
  REVIEW_BAND_SUBSYSTEM,
  REVIEW_SELECTION_GESTURE,
  REVIEW_SELECTION_KEY,
  validBand,
  validReviewSelectionAppend
} from './review-selection-core'

export const COMMAND_NAMES: readonly CommandName[] = [
  'flush',
  'config.update',
  'turn.abort',
  'session.compact',
  'ui.toast',
  'ui.status',
  'prompt.submit',
  'message.deliver',
  'context.append',
  'context.drop',
  'guard.set',
  'sentinel.set',
  'ui.band.set',
  'plan.capture'
]

export interface GateRow {
  feature: FeatureId
  operator?: string[] // gesture ids
  verb?: string[] // verb names
  internal?: string[] // subsystem ids
  /** Also admitted under the gesture `debug` while the debug route is registered (§7.6). */
  debug?: boolean
  /**
   * The owning wave's argument check; this wave's six commands are validated below. It receives the
   * cause too, because a command several waves share (`context.append`) is valid for one cause's
   * keys and not another's. A validator that does not care ignores the second parameter.
   */
  validate?: (args: unknown, cause: CommandCause) => boolean
}

const rows = new Map<CommandName, GateRow>()

/**
 * A grant that survives a later registration of the same command (T257 §6.6). A second
 * `registerGateRow` for the name replaces the row, which would silently remove a gesture another
 * wave depends on; a reserved grant is merged back in, so P2W4 and P4W2 *extend* the row and cannot
 * replace it by accident.
 */
interface ReservedGrant {
  operator?: string[]
  internal?: string[]
  validate: (args: unknown, cause: CommandCause) => boolean
}

const reserved = new Map<CommandName, ReservedGrant>()

const isReservedCause = (g: ReservedGrant, cause: CommandCause): boolean =>
  (cause.kind === 'operator' && g.operator?.includes(cause.gesture) === true) ||
  (cause.kind === 'internal' && g.internal?.includes(cause.subsystem) === true)

function withReserved(name: CommandName, row: GateRow): GateRow {
  const g = reserved.get(name)
  if (!g) return row
  const union = (a?: string[], b?: string[]): string[] | undefined =>
    a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined
  const operator = union(row.operator, g.operator)
  const internal = union(row.internal, g.internal)
  const own = row.validate
  return {
    ...row,
    ...(operator ? { operator } : {}),
    ...(internal ? { internal } : {}),
    validate: (args, cause) =>
      isReservedCause(g, cause) ? g.validate(args, cause) : (own?.(args, cause) ?? false)
  }
}

/**
 * A later wave's row. A second registration replaces the first (tests, hot reload in dev), except
 * for what a reserved grant (the review selection's) puts back.
 */
export function registerGateRow(name: CommandName, row: GateRow): void {
  rows.set(name, withReserved(name, row))
}

export function gateRowFor(name: CommandName): GateRow | undefined {
  return rows.get(name)
}

function registerP2W1Rows(): void {
  registerGateRow('flush', {
    feature: 'act.channel',
    operator: ['diagnostics.ping'],
    internal: ['arbitration', 'parity']
  })
  registerGateRow('config.update', { feature: 'act.channel', internal: ['prefs'], debug: true })
  registerGateRow('turn.abort', { feature: 'act.turn', debug: true })
  registerGateRow('session.compact', { feature: 'act.compact', debug: true })
  registerGateRow('ui.toast', { feature: 'act.ui', operator: ['diagnostics.ping'] })
  registerGateRow('ui.status', { feature: 'act.ui', internal: ['arbitration'], debug: true })
}
registerP2W1Rows()

/**
 * T257: the two rows the review selection needs. `context.append` is limited to one key and one
 * operator gesture; `ui.band.set` to the band driver's subsystem. `feature` is what the review
 * companion's `read-only` binding is enabled for (feature-policy.ts).
 */
function registerReviewSelectionRows(): void {
  reserved.set('context.append', {
    operator: [REVIEW_SELECTION_GESTURE],
    validate: validReviewSelectionAppend
  })
  reserved.set('ui.band.set', { internal: [REVIEW_BAND_SUBSYSTEM], validate: validBand })
  registerGateRow('context.append', { feature: 'act.context' })
  registerGateRow('ui.band.set', { feature: 'ui.band' })
}
registerReviewSelectionRows()

export function resetGateRowsForTests(): void {
  rows.clear()
  registerP2W1Rows()
  registerReviewSelectionRows()
}

export type OriginResult = { ok: true; row: GateRow } | { ok: false; reason: 'ORIGIN_DENIED' }

/** `ctx.debug` is true only while `companion:debug:enqueue` is registered (§7.6). */
export function checkOrigin(
  name: CommandName,
  cause: CommandCause,
  ctx: { debug: boolean }
): OriginResult {
  const row = rows.get(name)
  const denied = { ok: false, reason: 'ORIGIN_DENIED' } as const
  if (!row) return denied
  switch (cause.kind) {
    case 'operator':
      if (cause.gesture === 'debug')
        return ctx.debug && row.debug === true ? { ok: true, row } : denied
      return row.operator?.includes(cause.gesture) ? { ok: true, row } : denied
    case 'verb':
      return row.verb?.includes(cause.verb) ? { ok: true, row } : denied
    case 'internal':
      return row.internal?.includes(cause.subsystem) ? { ok: true, row } : denied
    default:
      return denied
  }
}

// ---- profile and shadow admission ---------------------------------------------------------------

const ALL_PROFILES: ReadonlySet<CommandName> = new Set(['flush', 'config.update'])
const EXTERNAL_OK: ReadonlySet<CommandName> = new Set(['flush', 'config.update', 'ui.band.set'])

/** Contract §9, column "Profiles". `interactive` admits every command. */
export function profileRefusal(
  profile: HelloProfile,
  name: CommandName
): 'HEADLESS' | 'EXTERNAL' | null {
  if (profile === 'headless') return ALL_PROFILES.has(name) ? null : 'HEADLESS'
  if (profile === 'external') return EXTERNAL_OK.has(name) ? null : 'EXTERNAL'
  return null
}

export type ChannelMode = 'off' | 'shadow' | 'active'

/**
 * Contract §9 "observe-only commands": the only ones the host may issue while the channel is in
 * `shadow`. `guard.set` counts only with `enforce: false`.
 */
export function shadowRefusal(
  mode: ChannelMode,
  name: CommandName,
  args: unknown
): 'FEATURE_OFF' | 'MODE_SHADOW' | null {
  if (mode === 'off') return 'FEATURE_OFF'
  if (mode === 'active') return null
  if (
    name === 'flush' ||
    name === 'config.update' ||
    name === 'sentinel.set' ||
    name === 'ui.band.set'
  ) {
    return null
  }
  if (name === 'guard.set' && (args as { enforce?: unknown } | null)?.enforce === false) return null
  // T257 O-3 (option B): the review selection's own key, nothing else. `shadow` exists to measure
  // poll reliability before an actuator competes with a legacy path, and a selection has none.
  if (
    name === 'context.append' &&
    (args as { key?: unknown } | null)?.key === REVIEW_SELECTION_KEY
  ) {
    return null
  }
  return 'MODE_SHADOW'
}

// ---- text of the terminal chrome ------------------------------------------------------------------

/**
 * The only words an agent-visible terminal toast or status line may say (contract §9, SEC-5). Keyed
 * by id; a caller names an id and never passes text. The engine draws the `harnu-companion:` prefix.
 */
export const UI_TEXTS = {
  'channel-ok': 'Harnu mod channel check',
  'status-test': 'Harnu mod status test'
} as const

export type UiTextId = keyof typeof UI_TEXTS

export const uiText = (id: UiTextId): string => UI_TEXTS[id]

const UI_TEXT_VALUES: ReadonlySet<string> = new Set(Object.values(UI_TEXTS))
export const UI_TEXT_MAX = 200

// ---- arguments ------------------------------------------------------------------------------------

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const onlyKeys = (r: Rec, keys: readonly string[]): boolean =>
  Object.keys(r).every((k) => keys.includes(k))

const CONFIG_KEYS = Object.keys(CONFIG_BOUNDS) as (keyof Config)[]

function validConfigUpdate(a: unknown): boolean {
  if (!isRec(a) || !onlyKeys(a, ['config']) || !isRec(a.config)) return false
  const keys = Object.keys(a.config)
  if (keys.length === 0) return false
  for (const k of keys) {
    if (!(CONFIG_KEYS as string[]).includes(k)) return false
    const v = (a.config as Rec)[k]
    const [min, max] = CONFIG_BOUNDS[k as keyof Config]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return false
  }
  return true
}

const SIX: Partial<Record<CommandName, (a: unknown) => boolean>> = {
  flush: (a) => isRec(a) && Object.keys(a).length === 0,
  // protocol 1: no `instructions` (smoke D5)
  'session.compact': (a) => isRec(a) && Object.keys(a).length === 0,
  'config.update': validConfigUpdate,
  'turn.abort': (a) =>
    isRec(a) &&
    onlyKeys(a, ['turnId']) &&
    (a.turnId === undefined ||
      (typeof a.turnId === 'string' && a.turnId.length >= 1 && a.turnId.length <= 128)),
  'ui.toast': (a) =>
    isRec(a) &&
    onlyKeys(a, ['text']) &&
    typeof a.text === 'string' &&
    UI_TEXT_VALUES.has(a.text) &&
    a.text.length <= UI_TEXT_MAX,
  'ui.status': (a) =>
    isRec(a) &&
    onlyKeys(a, ['text']) &&
    (a.text === null || (typeof a.text === 'string' && UI_TEXT_VALUES.has(a.text)))
}

/**
 * The channel always passes the real cause. A caller that checks the shape of arguments alone gets
 * one no gesture, verb or subsystem can match, so a cause-dependent validator refuses it.
 */
const NO_CAUSE: CommandCause = { kind: 'internal', subsystem: '' }

export type ArgsResult = { ok: true } | { ok: false; reason: Extract<EnqueueRefusal, 'BAD_ARGS'> }

/** Schema and bounds. The mod checks the same bounds again: this is the first of two locks. */
export function validateArgs(
  name: CommandName,
  args: unknown,
  cause: CommandCause = NO_CAUSE
): ArgsResult {
  const check = SIX[name] ?? rows.get(name)?.validate
  return check?.(args, cause) ? { ok: true } : { ok: false, reason: 'BAD_ARGS' }
}
