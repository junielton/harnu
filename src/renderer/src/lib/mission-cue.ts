/**
 * Mission v3 §3.12 + BUG-173 S3 (spec §3.2) — decide when the operator must HEAR
 * that a mission owes them something. Pure: the missions store feeds it each
 * poll's views plus the memory it returned last time, and plays the cue.
 *
 * What is owed is the server's ordered `you` list. Each mission keeps one key
 * per owed kind with its count — a blocker and a re-scope key on their reason /
 * target, so a different blocker is a new key. A key cues when it APPEARS or its
 * count GROWS: due checks going 1 → 2 cue, 2 → 1 never does, and a tick, a
 * resolution or any decrease stays silent. Growth (or a new key) restarts that
 * key's schedule.
 *
 * Two classes of kind:
 * - **standing** (`close`, `checks`, `review-import`): a to-do nobody is waiting
 *   on. Cue once, never re-nudge — the pill and the bell still show it.
 * - **blocking** (`rescope`, `blocker`, `human-steps`): something an agent or a
 *   later step waits on. Re-nudge on {@link BLOCKING_NUDGE_MS} after the last
 *   cue, then go silent.
 *
 * The memory is persisted by the store (`om2tab.missionCues`), so a restart
 * continues where the last run stopped: only what is new or grown cues. With no
 * memory at all {@link seedCueMemory} records the backlog as already heard.
 * A mission absent from a poll keeps its entry for {@link ABSENT_TTL_MS} and is
 * never cued while absent.
 *
 * Approvals and needs-input are left out on purpose — the Approval Inbox and
 * the task-state notifications already chime for them. There is no draft kind:
 * a dead legacy draft reads `active` + stale, and stale is not owed.
 *
 * Only what a poll sees exists here: a blocker raised and cleared between two
 * polls never reaches the operator.
 */
import type { MissionView } from '../../../main/mission-ipc'
import type { MissionYouItem } from '../../../main/mcp/tool-handlers'

/**
 * How long a blocking key waits after its last cue before the next reminder: the
 * nth reminder fires when `now - lastCuedAt >= BLOCKING_NUDGE_MS[nudges]`; once
 * every entry was used the key is silent until it changes.
 */
export const BLOCKING_NUDGE_MS: readonly number[] = [
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000
]

/** How long a mission absent from the polls keeps its memory entry (measured from `lastSeenAt`). */
export const ABSENT_TTL_MS = 24 * 60 * 60 * 1000

/** `${kind}` or `${kind}:${detail}` — one per owed kind (per blocker reason / re-scope target). */
export type OwedKey = string

/** What the cue remembers about one owed key. */
export interface KeyState {
  /** The count at the last poll. */
  count: number
  firstOwedAt: number
  lastCuedAt: number
  /** Reminders already sent; at {@link BLOCKING_NUDGE_MS}`.length` the key is silent. */
  nudges: number
}

export interface OwedEntry {
  keys: Map<OwedKey, KeyState>
  /** The last poll that listed the mission. */
  lastSeenAt: number
}

export interface CueMemory {
  /** Per mission id, what it owed at the last poll. */
  owed: Map<string, OwedEntry>
}

export interface CueDecision {
  cue: boolean
  /** The missions this cue is about — one combined cue covers all of them. */
  missionIds: string[]
  memory: CueMemory
}

/** `localStorage['om2tab.missionCues']`, v1: plain objects on disk, Maps in memory. */
export interface PersistedCueMemory {
  v: 1
  owed: Record<string, { keys: Record<OwedKey, KeyState>; lastSeenAt: number }>
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

/** Blocking keys re-nudge on the back-off; every other key is standing. */
function isBlocking(key: OwedKey): boolean {
  return key.startsWith('rescope:') || key.startsWith('blocker:') || key === 'human-steps'
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

/** The views with a repeated `mission.id` dropped (first wins) — defence in depth, main de-duplicates. */
function uniqueById(views: readonly MissionView[]): MissionView[] {
  const seen = new Set<string>()
  return views.filter((v) => !seen.has(v.mission.id) && !!seen.add(v.mission.id))
}

/**
 * First run with no memory: record the current backlog as already heard —
 * `lastCuedAt = now`, every schedule spent — so the first poll is silent and a
 * later change is news.
 */
export function seedCueMemory(views: readonly MissionView[], now: number): CueMemory {
  const owed: CueMemory['owed'] = new Map()
  for (const v of uniqueById(views)) {
    const keys = new Map<OwedKey, KeyState>()
    for (const [k, count] of owedKeys(v)) {
      keys.set(k, { count, firstOwedAt: now, lastCuedAt: now, nudges: BLOCKING_NUDGE_MS.length })
    }
    if (keys.size > 0) owed.set(v.mission.id, { keys, lastSeenAt: now })
  }
  return { owed }
}

/**
 * One decision per poll. A key cues when it is new, its count grew, or (blocking
 * kinds only) its next back-off step is due; everything that cues in the same
 * poll lands in ONE combined decision.
 */
export function decideCue(
  views: readonly MissionView[],
  memory: CueMemory,
  now: number
): CueDecision {
  const next: CueMemory['owed'] = new Map()
  const cueIds: string[] = []
  for (const v of uniqueById(views)) {
    const id = v.mission.id
    const prev = memory.owed.get(id)
    const keys = new Map<OwedKey, KeyState>()
    let cued = false
    for (const [k, count] of owedKeys(v)) {
      const was = prev?.keys.get(k)
      if (!was || count > was.count) {
        // A new key or a grown count is a fresh cue: the schedule restarts.
        keys.set(k, { count, firstOwedAt: was?.firstOwedAt ?? now, lastCuedAt: now, nudges: 0 })
        cued = true
      } else if (
        isBlocking(k) &&
        was.nudges < BLOCKING_NUDGE_MS.length &&
        now - was.lastCuedAt >= BLOCKING_NUDGE_MS[was.nudges]
      ) {
        keys.set(k, { ...was, count, lastCuedAt: now, nudges: was.nudges + 1 })
        cued = true
      } else {
        // Same or fewer: remember the new count, so a later growth is measured from here.
        keys.set(k, { ...was, count })
      }
    }
    // A mission that owes nothing now but was remembered keeps its (empty) entry.
    if (keys.size > 0 || prev) next.set(id, { keys, lastSeenAt: now })
    if (cued) cueIds.push(id)
  }
  // Absent from this poll: keep the entry untouched until it ages out. Never cued here.
  for (const [id, entry] of memory.owed) {
    if (!next.has(id) && now - entry.lastSeenAt <= ABSENT_TTL_MS) next.set(id, entry)
  }
  return { cue: cueIds.length > 0, missionIds: cueIds, memory: { owed: next } }
}

/** Maps → plain objects for `localStorage`. */
export function serializeCueMemory(memory: CueMemory): PersistedCueMemory {
  const owed: PersistedCueMemory['owed'] = {}
  for (const [id, entry] of memory.owed) {
    owed[id] = {
      keys: Object.fromEntries([...entry.keys].map(([k, s]) => [k, { ...s }])),
      lastSeenAt: entry.lastSeenAt
    }
  }
  return { v: 1, owed }
}

/** Plain objects → Maps. Only call it on a value {@link isPersistedCueMemory} accepted. */
export function deserializeCueMemory(p: PersistedCueMemory): CueMemory {
  const owed: CueMemory['owed'] = new Map()
  for (const [id, entry] of Object.entries(p.owed)) {
    owed.set(id, {
      keys: new Map(Object.entries(entry.keys).map(([k, s]) => [k, { ...s }])),
      lastSeenAt: entry.lastSeenAt
    })
  }
  return { owed }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

/** Accepts only `{ v: 1, owed }` whose entries are all well-formed — anything else is "no memory". */
export function isPersistedCueMemory(x: unknown): x is PersistedCueMemory {
  if (!isRecord(x) || x.v !== 1 || !isRecord(x.owed)) return false
  return Object.values(x.owed).every(
    (entry) =>
      isRecord(entry) &&
      isNum(entry.lastSeenAt) &&
      isRecord(entry.keys) &&
      Object.values(entry.keys).every(
        (s) =>
          isRecord(s) &&
          isNum(s.count) &&
          isNum(s.firstOwedAt) &&
          isNum(s.lastCuedAt) &&
          isNum(s.nudges)
      )
  )
}
