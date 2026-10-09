/**
 * Mission v3 §3.12 (T373 S3, AC-10) — decide when the operator must HEAR that a
 * mission owes them something. Pure: the missions store feeds it each poll's
 * views plus the memory it returned last time, and plays the cue.
 *
 * What is owed is the server's ordered `you` list. Each mission keeps one key
 * per owed kind with its count — a blocker and a re-scope key on their reason /
 * target, so a different blocker is a new key. A cue fires only when a key
 * APPEARS or its count GROWS: due checks going 1 → 2 cue, 2 → 1 never does, and
 * a tick, a resolution or any decrease stays silent. While a mission still owes
 * anything it is re-nudged every {@link RENUDGE_MS} — the list as a whole.
 *
 * Approvals and needs-input are left out on purpose — the Approval Inbox and
 * the task-state notifications already chime for them. There is no draft kind:
 * a dead legacy draft reads `active` + stale, and stale is not owed.
 *
 * Only what a poll sees exists here: a blocker raised and cleared between two
 * polls never reaches the operator, and a mission that stops owing is
 * forgotten, so it can never be re-nudged later.
 */
import type { MissionView } from '../../../main/mission-ipc'
import type { MissionYouItem } from '../../../main/mcp/tool-handlers'

/** How long a mission that still owes stays quiet before it is cued again. */
export const RENUDGE_MS = 30 * 60 * 1000

/** `${kind}` or `${kind}:${detail}` — one per owed kind (per blocker reason / re-scope target). */
export type OwedKey = string

export interface OwedEntry {
  /** Owed key → its count at the last poll. */
  keys: Map<OwedKey, number>
  firstOwedAt: number
  lastCuedAt: number
}

export interface CueMemory {
  /** Per mission id, what it owed at the last poll and when it was first owed / last cued. */
  owed: Map<string, OwedEntry>
  /** At least one poll has been decided — every later cue is a transition or a re-nudge. */
  primed: boolean
}

export interface CueDecision {
  cue: boolean
  /** The missions this cue is about — one combined cue covers all of them. */
  missionIds: string[]
  memory: CueMemory
}

/** One `you` item's key and count, or `null` for the kinds that never cue. */
function keyOf(item: MissionYouItem): [OwedKey, number] | null {
  switch (item.kind) {
    case 'rescope':
      return [`rescope:${item.end.target}`, 1]
    case 'close':
      return ['close', 1]
    case 'blocker':
      return [`blocker:${item.reason}`, 1]
    case 'checks':
      return ['checks', item.count]
    case 'human-steps':
      return ['human-steps', item.stepIds.length]
    case 'review-import':
      return ['review-import', 1]
    case 'approvals':
    case 'needs-input':
      return null
  }
}

/** Everything this mission owes that deserves a sound, as key → count (empty = nothing). */
export function owedKeys(view: MissionView): Map<OwedKey, number> {
  const out = new Map<OwedKey, number>()
  for (const item of view.you) {
    const k = keyOf(item)
    if (k) out.set(k[0], (out.get(k[0]) ?? 0) + k[1])
  }
  return out
}

/** The first `you` item that cues — what the cue's Activity entry names. */
export function firstOwed(view: MissionView): MissionYouItem | null {
  return view.you.find((item) => keyOf(item) !== null) ?? null
}

/** A key appeared, or a count grew, since the last poll. */
function grew(prev: Map<OwedKey, number>, next: Map<OwedKey, number>): boolean {
  for (const [k, n] of next) if (n > (prev.get(k) ?? 0)) return true
  return false
}

/**
 * One decision per poll. The first poll starts from an empty memory, so every
 * mission already owed lands in ONE combined decision — the restart rule.
 */
export function decideCue(
  views: readonly MissionView[],
  memory: CueMemory,
  now: number
): CueDecision {
  const next: CueMemory['owed'] = new Map()
  const cueIds: string[] = []
  const seen = new Set<string>()
  for (const v of views) {
    // Defence in depth (BUG-173): main lists each mission once; a repeat never cues twice.
    if (seen.has(v.mission.id)) continue
    seen.add(v.mission.id)
    const keys = owedKeys(v)
    if (keys.size === 0) continue
    const prev = memory.owed.get(v.mission.id)
    if (!prev) {
      next.set(v.mission.id, { keys, firstOwedAt: now, lastCuedAt: now })
      cueIds.push(v.mission.id)
    } else if (grew(prev.keys, keys) || now - prev.lastCuedAt > RENUDGE_MS) {
      next.set(v.mission.id, { keys, firstOwedAt: prev.firstOwedAt, lastCuedAt: now })
      cueIds.push(v.mission.id)
    } else {
      // Same or fewer: remember the new counts, so a later growth is measured from here.
      next.set(v.mission.id, { ...prev, keys })
    }
  }
  return { cue: cueIds.length > 0, missionIds: cueIds, memory: { owed: next, primed: true } }
}
