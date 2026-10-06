/**
 * Identity classification (T389 P1W3 §7.6). Pure: no I/O, no clock.
 *
 * A hello or a `session.rebound` gives the host a FACT about a binding: "this PTY is session
 * `sid`". The fact becomes a CLAIM that the renderer honours when the transcript is on disk, and
 * a claim only acts when the host owns identity for that row (`mayAct`, ARB-3). A claim never
 * re-keys a row by itself: the row migrates at the existing `session:added` (spec §7.1).
 */

import type { Sid } from './contract'
import type { CompanionMode } from './mode'
import type { CliGate } from './version-gate'

export type IdentityCause = 'spawn' | 'clear' | 'resume' | 'unknown'

export type IdentityFact =
  | { kind: 'confirmed'; key: string; sid: Sid } // key === sid (resume, wake)
  | { kind: 'claim'; key: string; sid: Sid; cause: IdentityCause }
  | { kind: 'conflict'; key: string; sid: Sid; heldBy: string } // sid is live under another key
  | { kind: 'none' } // tick owner, or no key

export function classifyIdentity(x: {
  /** `sessionKeyOf(owner)` now. */
  key: string | null
  sid: Sid
  cause: IdentityCause
  ownerKind: 'pty' | 'tick'
  /** Another live PTY already keyed by (or bound to) this sid. */
  liveKeyForSid: string | null
}): IdentityFact {
  if (x.ownerKind === 'tick' || x.key === null) return { kind: 'none' }
  if (x.key === x.sid) return { kind: 'confirmed', key: x.key, sid: x.sid }
  if (x.liveKeyForSid !== null && x.liveKeyForSid !== x.key) {
    return { kind: 'conflict', key: x.key, sid: x.sid, heldBy: x.liveKeyForSid }
  }
  return { kind: 'claim', key: x.key, sid: x.sid, cause: x.cause }
}

/** ARB-3, ARB-7b: acts only in `active`, on a tested CLI, with a live lease, for a real claim. */
export function mayAct(x: {
  mode: CompanionMode
  gate: CliGate
  lease: 'live' | 'lost'
  fact: IdentityFact
}): boolean {
  return x.mode === 'active' && x.gate === 'ok' && x.lease === 'live' && x.fact.kind === 'claim'
}

/** What the renderer gets: "PTY row `key` is session `sid`", and whether it may act on it. */
export interface IdentityClaim {
  key: string
  sid: Sid
  cause: IdentityCause
  act: boolean
}

/** The identity part of the companion diagnostics. Counts and claims only: no id of a transcript. */
export interface IdentityDiagnostics {
  claims: IdentityClaim[]
  conflicts: number
  reboundGap: number
  rebounds: number
}
