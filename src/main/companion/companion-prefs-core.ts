/**
 * `companion-prefs.json`, pure (T389 P1W4 §7.3): parsing, serializing and the decisions that read
 * the prefs (the rollout view, the global mode, `listenerWanted`, the injection decision). No I/O,
 * no clock, no Electron; `companion-prefs.ts` is the stateful store around it.
 *
 * The file mirrors `responder-prefs.json`: no file, invalid JSON or a wrong type degrades field
 * by field to the defaults and never throws, and an invalid mode reads `shadow` (ARB-6a). Only
 * overrides are persisted, so a later release that changes a default reaches users who never
 * touched the file.
 */

import {
  FAMILY_FEATURES,
  effectiveMode,
  type CompanionInjectDecision,
  type RolloutView
} from './arbitration-core'
import type { CompanionMode, FactFamily } from './mode'
import type { CliGate } from './version-gate'

export interface CompanionPrefs {
  /** The kill switch. Default true. */
  enabled: boolean
  /** P1W1's developer key: the default for every family with no entry in `families`. */
  mode?: CompanionMode
  families: Partial<Record<FactFamily, CompanionMode>>
  /** Ramp escape hatch, like `trustAll`. Default false. */
  allFolders: boolean
  /** Epoch ms; absent until the notice was rendered. */
  disclosureShownAt?: number
  /** Feature keys, each parsed by its registered spec. */
  keys: Record<string, unknown>
}

const MODES: ReadonlySet<string> = new Set(['off', 'shadow', 'active'])
const FAMILIES = Object.keys(FAMILY_FEATURES) as FactFamily[]

export function defaultPrefs(): CompanionPrefs {
  return { enabled: true, families: {}, allFolders: false, keys: {} }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** An invalid mode reads `shadow` (ARB-6a). */
const modeOf = (v: unknown): CompanionMode =>
  typeof v === 'string' && MODES.has(v) ? (v as CompanionMode) : 'shadow'

/** `null` is "no file": the shipped defaults. */
export function parsePrefs(raw: string | null): CompanionPrefs {
  const prefs = defaultPrefs()
  if (raw === null) return prefs
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return prefs
  }
  if (!isObject(parsed)) return prefs
  if (typeof parsed.enabled === 'boolean') prefs.enabled = parsed.enabled
  if (parsed.mode !== undefined) prefs.mode = modeOf(parsed.mode)
  if (isObject(parsed.families)) {
    for (const f of FAMILIES) {
      if (parsed.families[f] !== undefined) prefs.families[f] = modeOf(parsed.families[f])
    }
  }
  if (typeof parsed.allFolders === 'boolean') prefs.allFolders = parsed.allFolders
  const at = parsed.disclosureShownAt
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) prefs.disclosureShownAt = at
  if (isObject(parsed.keys)) prefs.keys = { ...parsed.keys }
  return prefs
}

/** Only overrides: a default left alone is not written. */
export function serializePrefs(p: CompanionPrefs): string {
  const out: Record<string, unknown> = { v: 1 }
  if (!p.enabled) out.enabled = false
  if (p.mode !== undefined) out.mode = p.mode
  if (Object.keys(p.families).length > 0) out.families = { ...p.families }
  if (p.allFolders) out.allFolders = true
  if (p.disclosureShownAt !== undefined) out.disclosureShownAt = p.disclosureShownAt
  if (Object.keys(p.keys).length > 0) out.keys = { ...p.keys }
  return JSON.stringify(out, null, 2) + '\n'
}

export function buildRollout(
  p: CompanionPrefs,
  cliGate: CliGate,
  rampFolders: ReadonlySet<string>
): RolloutView {
  return {
    enabled: p.enabled,
    cliGate,
    families: { ...p.families },
    ...(p.mode !== undefined ? { defaultMode: p.mode } : {}),
    allFolders: p.allFolders,
    rampFolders
  }
}

/**
 * The global mode: `off` when the kill switch is off or the gate is `below`/`unknown`; `active`
 * when some family is effectively `active` for some folder; else `shadow`.
 */
export function companionModeOf(
  p: CompanionPrefs,
  cliGate: CliGate,
  rampFolders: ReadonlySet<string>
): CompanionMode {
  const r = buildRollout(p, cliGate, rampFolders)
  if (!r.enabled || cliGate === 'below' || cliGate === 'unknown') return 'off'
  // "Some folder": the ramp has one, or every folder is on it. `null` is no folder.
  const someFolder = r.allFolders || rampFolders.size > 0
  const folder = r.allFolders ? null : ([...rampFolders][0] ?? null)
  if (!someFolder) return 'shadow'
  return FAMILIES.some((f) => effectiveMode(f, folder, r) === 'active') ? 'active' : 'shadow'
}

/**
 * Should the socket exist? The kill switch is on, and the developer key or some family is not
 * `off`. It never reads the CLI gate: that is per binary and still `unknown` for the first
 * moments of a run (P1W2 fires the probe at boot and the spawn path never awaits it), so a
 * gate-dependent test would keep the socket down for good.
 */
export function listenerWantedFor(p: CompanionPrefs): boolean {
  if (!p.enabled) return false
  if (p.mode !== undefined && p.mode !== 'off') return true
  const fallback: CompanionMode = p.mode ?? 'shadow'
  return FAMILIES.some((f) => (p.families[f] ?? fallback) !== 'off')
}

/**
 * Whether a `claude` spawn carries the mod (called through `spawn-inject.ts`). The order is the
 * order of the state table: a gate problem is more fundamental than a missing notice. A session
 * spawned before the notice rendered runs without the mod (ARB-6e); nobody is asked to click.
 */
export function decideInject(
  p: CompanionPrefs,
  ctx: { kind: string; cliGate: CliGate }
): CompanionInjectDecision {
  if (!ctx.kind.startsWith('claude-')) return { inject: false, skip: 'not-claude' }
  if (!p.enabled) return { inject: false, skip: 'off' }
  if (ctx.cliGate === 'below') return { inject: false, skip: 'cli-too-old' }
  if (ctx.cliGate === 'unknown') return { inject: false, skip: 'cli-unknown' }
  if (p.disclosureShownAt === undefined) return { inject: false, skip: 'pre-disclosure' }
  return { inject: true }
}

/** What a registered feature key looks like (contract §11.5). */
export interface PrefsKeySpec<T> {
  default: T
  parse(raw: unknown): T
  /** The value the key is capped at when the CLI is above the tested ceiling. */
  observeCap?: T
}
