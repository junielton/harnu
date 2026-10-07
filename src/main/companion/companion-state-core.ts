/**
 * The Harnu mod state of one session row (T389 P1W4 §7.6). Pure: the shell
 * (`companion-ipc.ts`) gathers the facts, this file decides. First match wins; `null` means
 * "show no line" (parked and shell rows, external rows until P4W3 gives them a state, and a
 * spawn still inside `HELLO_GRACE_MS`).
 *
 * A cause is named only when it was observed (DOC-8): `policy` needs the recorded sideload exit
 * text to match, and `modsOff` is the neutral wording of a probe that only shows mods are off.
 * `legacy` is not an error, and nothing here implies protection (SEC-7).
 */

import type { CompanionInjectDecision } from './arbitration-core'
import type { PolicyProbeClass } from '../claude-policy-probe-core'

export type LegacyReason =
  | 'cliTooOld'
  | 'cliUnknown'
  | 'policy'
  | 'modsOff'
  | 'remoteOff'
  | 'noHello'
  | 'refused'
  | 'unloaded'
  | 'hostRestart'
  | 'notInjected'

export type CompanionState =
  /** `outside`: a session Harnu did not spawn, corroborated by Harnu's own watchers (P4W3). */
  { state: 'live'; outside?: true } | { state: 'off' } | { state: 'legacy'; reason: LegacyReason }

/** Host-only (not a contract constant): how long a spawn may take to say hello. */
export const HELLO_GRACE_MS = 15_000

export interface StateFacts {
  /** The Harnu PTY behind the row, or null (parked, never spawned, or an external session). */
  pty: { kind: string } | null
  /** The kill switch, read now. */
  killSwitchOff: boolean
  /** The injection decision kept for this spawn, or null when none was recorded. */
  inject: CompanionInjectDecision | null
  /** The first process exited early and the spawn was respawned bare (P1W2), with its kept output. */
  sideload: { respawnedBare: boolean; output: string | null } | null
  /** The last hello the host refused for this spawn. */
  refusal: { code: string } | null
  /** The spawn was injected but the host has no record of it: the host restarted since. */
  hostRestart: boolean
  /** The binding of this spawn, once a hello landed. */
  binding: { enabledEmpty: boolean; leaseLive: boolean; ended: boolean } | null
  /** Milliseconds since the spawn, or null when unknown. */
  spawnAgeMs: number | null
  /** The shared probe's answer, null until it ran. */
  probe: PolicyProbeClass | null
  /** The sideload-refusal texts recorded from a managed machine (LV-P1W4-e, Q6). Empty until then. */
  refusalTexts: readonly string[]
}

/** A kept exit output matches only a text that was recorded; with none recorded it never does. */
export function sideloadRefusalMatches(output: string | null, texts: readonly string[]): boolean {
  if (output === null || texts.length === 0) return false
  const haystack = output.toLowerCase()
  return texts.some((t) => t.length > 0 && haystack.includes(t.toLowerCase()))
}

const legacy = (reason: LegacyReason): CompanionState => ({ state: 'legacy', reason })

/**
 * The state of an outside session (P4W3): `live` only for a binding that Harnu's watchers
 * corroborated and whose lease is live; otherwise no line. An outside session is never `legacy`
 * or `off`: Harnu did not start it, so it has no expectation to fail (§10).
 */
export function deriveOutsideState(b: {
  corroborated: boolean
  leaseLive: boolean
  ended: boolean
  enabledEmpty: boolean
}): CompanionState | null {
  if (!b.corroborated || b.ended || b.enabledEmpty || !b.leaseLive) return null
  return { state: 'live', outside: true }
}

export function deriveCompanionState(f: StateFacts): CompanionState | null {
  // 1
  if (f.pty === null || !f.pty.kind.startsWith('claude-')) return null
  // 2
  if (f.killSwitchOff || f.inject?.skip === 'off') return { state: 'off' }
  // The spawn decision was never recorded (spawned outside the provider): nothing is known.
  if (f.inject === null) return null
  // 3, 4
  if (f.inject.skip === 'cli-too-old') return legacy('cliTooOld')
  if (f.inject.skip === 'cli-unknown') return legacy('cliUnknown')
  // 5
  if (f.sideload?.respawnedBare) {
    return legacy(sideloadRefusalMatches(f.sideload.output, f.refusalTexts) ? 'policy' : 'noHello')
  }
  // 6
  if (f.inject.skip === 'pre-disclosure') return legacy('notInjected')
  if (!f.inject.inject) return null // not-claude, already handled by row 1
  // 7
  if (f.binding === null) {
    if (f.refusal?.code === 'UNKNOWN_SESSION' || f.hostRestart) return legacy('hostRestart')
    if (f.refusal !== null) return legacy('refused')
  }
  if (f.binding !== null) {
    if (f.binding.ended) return null
    // 8: inert (the kill switch, or no enable policy): never a lease loss
    if (f.binding.enabledEmpty) return { state: 'off' }
    // 9
    if (!f.binding.leaseLive) return legacy('unloaded')
    // 13
    return { state: 'live' }
  }
  // 10
  if (f.spawnAgeMs === null || f.spawnAgeMs < HELLO_GRACE_MS) return null
  // 11, 12
  if (f.probe === 'off-here') return legacy('modsOff')
  if (f.probe === 'off-remote') return legacy('remoteOff')
  return legacy('noHello')
}
