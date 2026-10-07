import {
  compareClaudeVersions,
  parseClaudeVersion,
  type ClaudeVersion
} from '../claude-cli-version'

/** Lowest CLI the mod was verified to load on (spec P1W2 §7.6). */
export const COMPANION_MIN_CLI = '2.1.287'

export type CliGate = 'unknown' | 'below' | 'ok' | 'above'

/**
 * `ceiling` is `api-surface.json`'s `lastVerifiedCli`. Unknown (probe cold or
 * failed) and below are separate states but both refuse injection.
 */
export function cliGate(v: ClaudeVersion | null, ceiling: string): CliGate {
  if (!v) return 'unknown'
  const min = parseClaudeVersion(COMPANION_MIN_CLI)
  const top = parseClaudeVersion(ceiling)
  if (!min || !top) return 'unknown'
  if (compareClaudeVersions(v, min) < 0) return 'below'
  if (compareClaudeVersions(v, top) > 0) return 'above'
  return 'ok'
}

export function gateAllowsInjection(g: CliGate): boolean {
  return g === 'ok' || g === 'above'
}
