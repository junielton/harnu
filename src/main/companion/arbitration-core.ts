/**
 * The arbitration core (T389 P1W4 §7.1): who writes a fact for a session. Pure: no I/O, no
 * clock, no Electron. `session-arbiter.ts` is the stateful shell that builds an `ArbiterBinding`
 * from the host's binding table and a `RolloutView` from the prefs.
 *
 * The one rule of thumb: when in doubt the answer is `legacy` (SEC-1). Nothing in a request can
 * raise ownership; it comes from host-side state only (mode, lease, proof).
 */

import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { FeatureId } from './contract'
import type { CompanionMode, FactFamily } from './mode'
import type { CliGate } from './version-gate'

export type FactSource = 'legacy' | 'companion'

/** This wave's own view of a binding; P1W1 owns `BindingView`. */
export interface ArbiterBinding {
  sessionKey: string | null
  folder: string | null // normalized like the ramp set
  leaseLive: boolean
  enabled: ReadonlySet<FeatureId>
  proven: ReadonlySet<FeatureId>
  revoked: ReadonlySet<FactFamily> // sticky reversions, ARB-4c
}

export interface RolloutView {
  enabled: boolean // kill switch
  cliGate: CliGate
  families: Partial<Record<FactFamily, CompanionMode>> // persisted overrides
  defaultMode?: CompanionMode // P1W1's developer key `mode`
  allFolders: boolean
  rampFolders: ReadonlySet<string>
}

export type OwnReason =
  | 'owned'
  | 'mode-off'
  | 'mode-shadow'
  | 'off-ramp'
  | 'cli-above-ceiling'
  | 'no-binding'
  | 'lease-lost'
  | 'unproven'
  | 'revoked'

/** Why a spawn did or did not carry the mod (`companionInjectDecision`, §7.3). */
export interface CompanionInjectDecision {
  inject: boolean
  skip?: 'off' | 'pre-disclosure' | 'cli-too-old' | 'cli-unknown' | 'not-claude'
}

export type Admit = 'apply' | 'record-only' | 'drop'

/**
 * The features each family needs before the companion may own it (contract §11.1, "Fact family"
 * column). A feature with no fact family is not listed: it has no legacy rival (§11.5).
 */
export const FAMILY_FEATURES: Readonly<Record<FactFamily, readonly FeatureId[]>> = {
  identity: ['sense.identity'],
  taskState: ['sense.turn', 'sense.attention', 'sense.subagent'],
  telemetry: ['sense.usage'],
  planUsage: ['sense.usage'],
  approval: ['gate.approval'],
  guard: ['gate.guard'],
  startPrompt: ['act.prompt'],
  message: ['act.message']
}

/** Shipped default (OD-1): every family loads in `shadow`. Only overrides are persisted. */
export const DEFAULT_FAMILY_MODE: Readonly<Record<FactFamily, CompanionMode>> = {
  identity: 'shadow',
  taskState: 'shadow',
  telemetry: 'shadow',
  planUsage: 'shadow',
  approval: 'shadow',
  guard: 'shadow',
  startPrompt: 'shadow',
  message: 'shadow'
}

const MODES: ReadonlySet<string> = new Set(['off', 'shadow', 'active'])

/** The mode the prefs ask for, before the gate and the ramp narrow it (ARB-6a). */
function configuredMode(f: FactFamily, r: RolloutView): CompanionMode {
  const m: unknown = r.families[f] ?? r.defaultMode ?? DEFAULT_FAMILY_MODE[f]
  return typeof m === 'string' && MODES.has(m) ? (m as CompanionMode) : 'shadow'
}

/**
 * A folder path as the ramp set keys it: `~` expanded, absolutized, no trailing separator. The
 * same rule as `responder-registry.ts`'s private `normalizeFolder`, so both ramps agree. No
 * `realpath`: a symlink divergence falls to the fail-safe off-ramp `shadow`.
 */
export function normalizeFolder(input: string): string {
  const expanded = input.startsWith('~') ? join(homedir(), input.slice(1)) : input
  const abs = resolve(expanded)
  return abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs
}

const onRamp = (folder: string | null, r: RolloutView): boolean =>
  r.allFolders || (folder !== null && r.rampFolders.has(folder))

export function effectiveMode(f: FactFamily, folder: string | null, r: RolloutView): CompanionMode {
  if (!r.enabled || r.cliGate === 'below' || r.cliGate === 'unknown') return 'off'
  const m = configuredMode(f, r)
  if (m !== 'active') return m
  if (r.cliGate === 'above') return 'shadow' // ARB-7b
  return onRamp(folder, r) ? 'active' : 'shadow'
}

export function ownerOf(
  f: FactFamily,
  b: ArbiterBinding | null,
  r: RolloutView
): { owner: FactSource; reason: OwnReason } {
  const legacy = (reason: OwnReason): { owner: FactSource; reason: OwnReason } => ({
    owner: 'legacy',
    reason
  })
  const mode = effectiveMode(f, b?.folder ?? null, r)
  if (mode === 'off') return legacy('mode-off')
  if (mode === 'shadow') {
    if (r.enabled && configuredMode(f, r) === 'active') {
      return legacy(r.cliGate === 'above' ? 'cli-above-ceiling' : 'off-ramp')
    }
    return legacy('mode-shadow')
  }
  if (!b) return legacy('no-binding')
  if (b.revoked.has(f)) return legacy('revoked')
  if (!b.leaseLive) return legacy('lease-lost')
  if (!FAMILY_FEATURES[f].every((x) => b.proven.has(x))) return legacy('unproven')
  return { owner: 'companion', reason: 'owned' }
}

/**
 * What the hub does with one fact. Proof is evaluated BEFORE admission: the event that proves a
 * feature may itself be applied, so callers mark proof first and ask afterwards.
 */
export function admit(
  f: FactFamily,
  src: FactSource,
  b: ArbiterBinding | null,
  r: RolloutView
): Admit {
  const { owner } = ownerOf(f, b, r)
  if (owner === 'companion') return src === 'companion' ? 'apply' : 'drop'
  if (src === 'legacy') return 'apply'
  return effectiveMode(f, b?.folder ?? null, r) === 'off' ? 'drop' : 'record-only'
}
