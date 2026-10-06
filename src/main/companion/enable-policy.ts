/**
 * The first `EnablePolicy` (T389 P1W3 §7.6). Pure. P1W4 replaces it through
 * `companionHost.setEnablePolicy` with its `computeEnable`; later waves add their rows with
 * `registerFeaturePolicy`. Nothing edits this function.
 *
 * The gate is evaluated per binding on `hello.cli.version`, because a live session keeps the
 * binary it started with (P1W2 §7.6).
 */

import { parseClaudeVersion } from '../claude-cli-version'
import type { FeatureId } from './contract'
import type { CompanionMode } from './mode'
import type { BindingView, EnablePolicy } from './session-table'
import { cliGate, type CliGate } from './version-gate'

/** Mode `off` or a gate of `below`/`unknown` enables nothing; otherwise `declared ∩ {identity}`. */
export function enableFor(
  b: Readonly<Pick<BindingView, 'declared'>>,
  mode: CompanionMode,
  gate: CliGate
): FeatureId[] {
  if (mode === 'off' || gate === 'below' || gate === 'unknown') return []
  return b.declared.includes('sense.identity') ? ['sense.identity'] : []
}

/** The CLI gate for the binary a binding reported at hello (`hello.cli.version`). */
export function gateForCli(cliVersion: string, ceiling: string): CliGate {
  return cliGate(parseClaudeVersion(cliVersion), ceiling)
}

/** What `registerCompanionHost` hands to `companionHost.setEnablePolicy`. */
export function identityEnablePolicy(deps: {
  getMode(): CompanionMode
  /** `api-surface.json`'s `lastVerifiedCli`. */
  ceiling: string
}): EnablePolicy {
  return (b) => enableFor(b, deps.getMode(), gateForCli(b.cliVersion, deps.ceiling))
}
