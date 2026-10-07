/**
 * The identity claims the host pushed (T389 P1W3 §7.7). Pure module state: no Vue, no IPC.
 *
 * A claim says "the live PTY row `key` is session `sid`"; `act` says the host owns identity for
 * that row (mode `active`, tested CLI, live lease). The sessions store consults it at the
 * existing `session:added` migration. A claim never creates a row and never moves one by itself.
 * It only chooses WHICH of Harnu's own rows becomes a given transcript.
 */

export type ClaimCause = 'spawn' | 'clear' | 'resume' | 'unknown'

/** Structural twin of the main-process `IdentityClaim` (the renderer imports no main code). */
export interface IdentityClaim {
  key: string
  sid: string
  cause: ClaimCause
  act: boolean
}

const CAUSES: ReadonlySet<string> = new Set(['spawn', 'clear', 'resume', 'unknown'])

let current: readonly IdentityClaim[] = []

function valid(c: unknown): c is IdentityClaim {
  if (typeof c !== 'object' || c === null) return false
  const x = c as Record<string, unknown>
  return (
    typeof x.key === 'string' &&
    x.key.length > 0 &&
    typeof x.sid === 'string' &&
    x.sid.length > 0 &&
    typeof x.act === 'boolean' &&
    CAUSES.has(String(x.cause))
  )
}

/** Replaces the whole list (main always pushes the full list). Malformed entries are dropped. */
export function replaceAll(list: readonly unknown[] | null | undefined): void {
  current = Array.isArray(list) ? list.filter(valid).map((c) => ({ ...c })) : []
}

export function allClaims(): readonly IdentityClaim[] {
  return current
}

/** The claim whose transcript is `sid`. */
export function claimFor(sid: string): IdentityClaim | undefined {
  return current.find((c) => c.sid === sid)
}

/** The claim held by the live row `key`. */
export function claimOfKey(key: string): IdentityClaim | undefined {
  return current.find((c) => c.key === key)
}

export function isClaimedKey(key: string): boolean {
  return claimOfKey(key) !== undefined
}

/**
 * The row `key` carries an ACTING claim for a transcript other than `sid`: the legacy heuristics
 * must not hand it `sid` (they stand aside for a row the host already placed).
 */
export function claimedAway(key: string, sid: string): boolean {
  const c = claimOfKey(key)
  return c !== undefined && c.act && c.sid !== sid
}

/** `sid` is the transcript of an ACTING claim held by a row other than `key`. */
export function sidClaimedByOther(sid: string, key: string): boolean {
  return current.some((c) => c.act && c.sid === sid && c.key !== key)
}
