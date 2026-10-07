/**
 * `computeEnable` and the feature-policy table (T389 P1W4 §7.2): which of the features a mod
 * declared the host enables for one binding. Each wave registers its own row with
 * `registerFeaturePolicy`; none edits another wave's. A feature with no registered rule is not
 * enabled, so a mod can never talk its way into a feature the host has no rule for.
 *
 * The first step, before any rule, is the global switch: when `getCompanionMode()` is `off` (the
 * kill switch is off, or the CLI gate is `below` or `unknown`) the answer is `[]`, so no later
 * wave's rule, feature-key rules included, can keep a mod live past the kill switch.
 */

import { normalizeFolder, type RolloutView } from './arbitration-core'
import { gateForCli } from './enable-policy'
import type { FeatureId } from './contract'
import { familyMode, getCompanionMode } from './mode'
import type { BindingView, EnablePolicy, TrustClass } from './session-table'

export type FeatureRule = (b: BindingView) => boolean

const rules = new Map<FeatureId, FeatureRule>()

/** One row of the table (contract §11.1, "Enabled by"). A second registration replaces the first. */
export function registerFeaturePolicy(feature: FeatureId, rule: FeatureRule): void {
  rules.set(feature, rule)
}

export function resetFeaturePoliciesForTests(): void {
  rules.clear()
}

const folderOf = (b: BindingView): string | null => (b.cwd ? normalizeFolder(b.cwd) : null)

/** The P1 rows, as contract §11.1 states them. */
export function registerP1FeaturePolicies(): void {
  registerFeaturePolicy('sense.identity', () => getCompanionMode() !== 'off')
  const taskState: FeatureRule = (b) => familyMode('taskState', folderOf(b)) !== 'off'
  registerFeaturePolicy('sense.turn', taskState)
  registerFeaturePolicy('sense.attention', taskState)
  registerFeaturePolicy('sense.subagent', taskState)
  registerFeaturePolicy(
    'sense.usage',
    (b) =>
      familyMode('telemetry', folderOf(b)) !== 'off' ||
      familyMode('planUsage', folderOf(b)) !== 'off'
  )
}
registerP1FeaturePolicies()

/** The external profile's ceiling (contract §21 item 3); each rule still has to pass. */
const EXTERNAL_ALLOWED: ReadonlySet<FeatureId> = new Set([
  'sense.identity',
  'sense.turn',
  'sense.attention',
  'sense.subagent',
  'sense.usage',
  'ui.command',
  'ui.band',
  'gate.approval'
])

export interface EnableContext {
  profile: 'interactive' | 'headless' | 'external'
  folder: string | null
  rollout: RolloutView
  trust: TrustClass
  /** Handed to each rule. Not in the spec's context shape: a rule takes a `BindingView`. */
  binding: BindingView
}

function rolloutOff(r: RolloutView): boolean {
  return !r.enabled || r.cliGate === 'below' || r.cliGate === 'unknown'
}

export function computeEnable(declared: readonly FeatureId[], ctx: EnableContext): FeatureId[] {
  // First, before any rule: the kill switch and the CLI gate override everything.
  if (getCompanionMode() === 'off' || rolloutOff(ctx.rollout)) return []
  const out: FeatureId[] = []
  for (const feature of declared) {
    if (out.includes(feature)) continue
    const rule = rules.get(feature)
    if (!rule) continue
    if (ctx.profile === 'headless' && !feature.startsWith('sense.')) continue
    if (ctx.profile === 'external' && !EXTERNAL_ALLOWED.has(feature)) continue
    let ok = false
    try {
      ok = rule(ctx.binding)
    } catch {
      ok = false // a throwing rule enables nothing for its feature and breaks no other
    }
    if (ok) out.push(feature)
  }
  return out
}

/**
 * What `registerCompanionHost` hands to `companionHost.setEnablePolicy`. The gate is evaluated
 * per binding on `hello.cli.version`: a live session keeps the binary it started with.
 */
export function createEnablePolicy(deps: {
  rollout(): RolloutView
  /** `api-surface.json`'s `lastVerifiedCli`. */
  ceiling: string
}): EnablePolicy {
  return (b) =>
    computeEnable(b.declared, {
      profile: b.profile,
      folder: folderOf(b),
      rollout: { ...deps.rollout(), cliGate: gateForCli(b.cliVersion, deps.ceiling) },
      trust: b.trust,
      binding: b
    })
}
