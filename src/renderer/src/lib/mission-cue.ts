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
 * - **blocking** (`rescope`, `blocker`, `decide`, `human-steps`): something an agent or a
 *   later step waits on. Re-nudge on {@link BLOCKING_NUDGE_MS} after the last
 *   cue, then go silent.
 *
 * The memory is persisted by the store (`om2tab.missionCues`), so a restart
 * continues where the last run stopped: only what is new or grown cues. With no
 * memory at all {@link seedCueMemory} records the backlog as already heard.
 * A mission absent from a poll keeps its entry for {@link ABSENT_TTL_MS} and is
 * never cued while absent.
 *
 * The v4 kinds (S-23, the operator's rule: a false alarm beats a miss): an operator-owned blocker
 * (`unblock`), a request to join (`attach`), a mission ready to close, a red `main` and a criterion
 * only the operator can mark (`settle`) are all **blocking** — they chime when they appear and re-nudge
 * on the same back-off. Pull requests waiting for review (`review`) chime when one more waits and never
 * re-nudge. A decrease never chimes, for any kind.
 *
 * Approvals and needs-input are left out on purpose — the Approval Inbox and
 * the task-state notifications already chime for them. There is no draft kind:
 * a dead legacy draft reads `active` + stale, and stale is not owed.
 *
 * Only what a poll sees exists here: a blocker raised and cleared between two
 * polls never reaches the operator.
 */
import type { MissionYouItem, WaitingItemV4 } from '../../../main/missions/waiting'

/**
 * What the cue reads of a mission: its id and the ONE waiting list. The v3 view the list poll returns
 * fits (`you` holds v3 items); so does the v4 reader view (`you` holds {@link WaitingItemV4}, worded once
 * by the server in `ask`). Missions v4 S-23: the store feeds it the v4 view, for v3 and v4 records alike.
 */
export interface CueView {
  mission: { id: string }
  you: readonly (MissionYouItem | WaitingItemV4)[]
}

/** One item of either list. */
export type CueItem = MissionYouItem | WaitingItemV4

/** A v4 item carries its own `ask`; a v3 one never does. */
const isV4Item = (item: CueItem): item is WaitingItemV4 => 'ask' in item

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

/**
 * How long an owed key that left a poll is still remembered (measured from the first poll that missed
 * it). 5 minutes is 15 polls at the 20 s cadence: far longer than the one-or-two-poll flaps a source
 * produces, far shorter than a real resolve-then-recur (a review done, a new pull request opened later).
 */
export const FLAP_GRACE_MS = 5 * 60_000

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
function keyOf(item: CueItem): [OwedKey, number] | null {
  if (isV4Item(item)) return keyOfV4(item)
  switch (item.kind) {
    case 'rescope':
      return [`rescope:${item.end.target}`, 1]
    case 'close':
      return ['close', 1]
    case 'blocker':
      return [`blocker:${item.reason}`, 1]
    // A pending decision blocks the steps it names until the operator chooses: it is a blocking key.
    case 'decide':
      return [`decide:${item.stepId}`, 1]
    case 'checks':
      return ['checks', item.count]
    case 'human-steps':
      return ['human-steps', item.stepIds.length]
    case 'review-import':
      return ['review-import', 1]
    case 'main-red':
    case 'approvals':
    case 'needs-input':
      return null
  }
}

/**
 * One v4 waiting item's key and count. The key rides on the item's own id, which is stable while the
 * thing it names is unchanged, so a different blocker or request is a new key and a cleared one just
 * leaves. `review` is one item for all the pull requests, so its count is how many wait.
 */
function keyOfV4(item: WaitingItemV4): [OwedKey, number] {
  switch (item.kind) {
    case 'review':
      return ['review', Math.max(1, item.prs.length || item.stepIds.length)]
    case 'close':
      return ['ready-to-close', 1]
    // A blocker's `blk-N` is a position, and a v3 record renumbers its blockers when one is cleared: the key
    // is its scope plus its words, so clearing a neighbour never makes it new (a decrease never chimes).
    case 'unblock':
      return [`unblock:${item.stepId ?? 'mission'}:${item.ask}`, 1]
    case 'main-failing':
    case 'settle':
    case 'attach':
    case 'rescope':
      return [item.id, 1]
  }
}

/** Blocking keys re-nudge on the back-off; every other key is standing. */
function isBlocking(key: OwedKey): boolean {
  return (
    key === 'ready-to-close' ||
    key.startsWith('unblock:') ||
    key.startsWith('attach:') ||
    key.startsWith('main-failing:') ||
    key.startsWith('settle:') ||
    key.startsWith('rescope:') ||
    key.startsWith('blocker:') ||
    key.startsWith('decide:') ||
    key === 'human-steps'
  )
}

/** Everything this mission owes that deserves a sound, as key → count (empty = nothing). */
export function owedKeys(view: CueView): Map<OwedKey, number> {
  const out = new Map<OwedKey, number>()
  for (const item of view.you) {
    const k = keyOf(item)
    if (k) out.set(k[0], (out.get(k[0]) ?? 0) + k[1])
  }
  return out
}

/** The first `you` item that cues — what the cue's Activity entry names. */
export function firstOwed<V extends CueView>(view: V): V['you'][number] | null {
  return view.you.find((item) => keyOf(item) !== null) ?? null
}

/** The views with a repeated `mission.id` dropped (first wins) — defence in depth, main de-duplicates. */
function uniqueById<V extends CueView>(views: readonly V[]): V[] {
  const seen = new Set<string>()
  return views.filter((v) => !seen.has(v.mission.id) && !!seen.add(v.mission.id))
}

/**
 * First run with no memory: record the current backlog as already heard —
 * `lastCuedAt = now`, every schedule spent — so the first poll is silent and a
 * later change is news.
 */
export function seedCueMemory(views: readonly CueView[], now: number): CueMemory {
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
export function decideCue(views: readonly CueView[], memory: CueMemory, now: number): CueDecision {
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
