/**
 * Missions v4 S-34 (AC-82) — the proactive hint, a backstop to the rule.
 *
 * The rule lives in the skills and the awareness doc: a session that does work worth following starts a
 * mission. This module is what catches the session that did not. When a session that leads no mission
 * has started two sessions, or cut a worktree, the ACK of the verb it just called carries one sentence
 * (`missionHint`) naming `mission_create`. That is all it does: Harnu never creates the mission, never
 * refuses or delays the call, and says it once per session.
 *
 * - **The count** is a map held in this module, so it resets when Harnu starts. A `create_session`
 *   counts one; a manifest counts the cards it stamps (one session each, once drained); a
 *   `create_worktree` is enough on its own.
 * - **Who is counted** is the call's own `sessionId` (optional, self-declared like every v4 caller). A
 *   caller that does not say who it is is counted as one anonymous caller of its repo, and is left
 *   alone when the repo has a mission that someone leads (it may be that leader: a hint is a nudge, and
 *   silence is the safe side). A session Harnu spawned for a step and a steward are never counted: the
 *   transport proved who they are and what they are for.
 * - **"Leads no mission"** reads the records: the session has no open entry, as `leads` or `worked`, in
 *   a mission that is not closed (the attachment on the record, as the guard reads it).
 *
 * Pure: no file, no clock, no electron. The handlers read the records and call in.
 */

import type { MissionV4 } from './model'
import { openEntry } from './guard'

/** The ACK field the hint travels in, the same name on `create_session`, `create_worktree`, `submit_manifest`. */
export const MISSION_HINT_FIELD = 'missionHint'

/** The one sentence: what to call, and why now. No explanation of what a mission is. */
export const MISSION_HINT =
  'You lead no mission and have started work: call mission_create now, with its steps, so the operator can follow it.'

/** How many sessions a caller starts before the hint (a worktree is enough alone). */
export const SESSIONS_BEFORE_HINT = 2

/** What a call did. `sessions` is how many sessions it started (or, for a manifest, will drain). */
export type Work = { kind: 'sessions'; count: number } | { kind: 'worktree' }

/** What Harnu remembers about each counted caller since it started. */
export interface ProactiveTally {
  sessions: Map<string, number>
  hinted: Set<string>
}

export function createProactiveTally(): ProactiveTally {
  return { sessions: new Map(), hinted: new Set() }
}

/** The key an anonymous caller is counted under: one per repo. */
export const anonymousKey = (repo: string): string => `repo:${repo}`

/** Whether `sessionId` has an open entry in a mission that is not closed. */
export function isAttached(records: readonly MissionV4[], sessionId: string): boolean {
  return records.some((r) => r.status !== 'closed' && openEntry(r, sessionId) !== undefined)
}

/** Whether any mission that is not closed has a leader now. */
export function someoneLeads(records: readonly MissionV4[]): boolean {
  return records.some(
    (r) => r.status !== 'closed' && r.sessions.some((s) => s.role === 'leads' && s.to === null)
  )
}

/**
 * Note one call's work for a counted caller and say what to add to the ACK: `{ missionHint }` the one
 * time the caller crosses the line while it leads no mission, else `{}`. `exempt` is the caller's
 * standing on the records (see {@link isAttached} and {@link someoneLeads}); an exempt caller is not
 * counted at all, so a session that later stops leading starts from zero.
 */
export function noteWork(
  tally: ProactiveTally,
  key: string,
  work: Work,
  exempt: boolean
): { missionHint?: string } {
  if (exempt || tally.hinted.has(key)) return {}
  const sessions = (tally.sessions.get(key) ?? 0) + (work.kind === 'sessions' ? work.count : 0)
  tally.sessions.set(key, sessions)
  if (work.kind === 'worktree' || sessions >= SESSIONS_BEFORE_HINT) {
    tally.hinted.add(key)
    return { [MISSION_HINT_FIELD]: MISSION_HINT }
  }
  return {}
}
