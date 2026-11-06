/**
 * Campaign spec §3.1 (T595, chapter 3a) — the ONE campaign progress computation. Pure;
 * every surface (the verbs now, the pill and map in chapter 4, the skills) renders its
 * output and never recounts — the same rule `mission-progress.ts` holds for a mission.
 *
 * A campaign counts CHAPTERS, and a chapter's state ROLLS UP from the mission bound to it:
 * there is no second door. Nothing here is stored and nothing marks a chapter done — a
 * chapter whose mission is `delivered`, or closed as delivered, reads done because that is
 * what the mission says.
 */
import type { Campaign, Chapter } from './campaign-core'
import type { Mission } from './mission-core'
import type { MissionProgress } from './mission-progress'

/** A chapter's state, first match wins (see {@link chapterBaseState}, then locking). */
export type ChapterState = 'done' | 'inReview' | 'running' | 'locked' | 'todo'

/** What the roll-up needs of one chapter's bound mission (`null` = no mission bound yet). */
export interface ChapterFacts {
  chapterId: string
  mission: null | {
    status: Mission['status']
    closedAs?: 'delivered' | 'discarded'
    /** The mission's progress when it was derived; `null` = not read (e.g. a closed mission). */
    progress: MissionProgress | null
  }
}

export interface CampaignProgress {
  /** Required chapters. Side-quest chapters are outside every count below but `side`. */
  total: number
  /** 1-based position among the REQUIRED chapters (so it reads "Chapter N of `total`"); `from === to` unless several run in parallel; `null` = all done. */
  current: { from: number; to: number } | null
  allDone: boolean
  done: number
  /** Chapters whose mission has every step done but is not delivered yet. */
  inReview: number
  running: number
  locked: number
  /** The side-quest chapters (`required: false`). */
  side: { total: number; done: number; open: number }
  /** Present only when some chapter declares a `radiant`; `done` follows {@link radiantDone}. */
  radiant?: { done: number; total: number }
  /** Every chapter's state, side quests included. */
  states: Record<string, ChapterState>
  computedAt: string
}

/** A mission that finished: delivered, or ended by the operator as delivered. */
function missionDelivered(m: NonNullable<ChapterFacts['mission']>): boolean {
  return m.status === 'delivered' || (m.status === 'closed' && m.closedAs === 'delivered')
}

/**
 * The state a chapter reads from its mission alone. `done` is the mission's own verdict
 * (delivered, or closed as delivered); a mission closed as discarded is abandoned work and
 * never counts. `inReview` is the work finished and waiting for the operator's close.
 */
function chapterBaseState(facts: ChapterFacts | undefined): ChapterState {
  const m = facts?.mission
  if (!m) return 'todo'
  if (missionDelivered(m)) return 'done'
  if (m.status === 'closed') return 'todo'
  if (m.progress?.allDone) return 'inReview'
  if (Object.values(m.progress?.states ?? {}).includes('running')) return 'running'
  return 'todo'
}

/**
 * Which chapters read `locked`: one that consumes a token (spec §3.5) whose earlier
 * producers are not all done, or whose `unlocks: { kind: 'chapter' }` target is not done.
 * A token no earlier chapter produces locks nothing (it can never be satisfied — that is
 * the forced prerequisite gap the surprise log records). `unlocks` of kind `decision` and
 * `pr` are recorded but not resolved here: their facts live on the mission (chapter 4/5).
 * Only a chapter that has not started is locked — one already running, in review or with a
 * step done keeps what actually happened.
 */
function lockedChapterIds(
  chapters: readonly Chapter[],
  facts: ReadonlyMap<string, ChapterFacts>,
  base: ReadonlyMap<string, ChapterState>
): Set<string> {
  const locked = new Set<string>()
  chapters.forEach((c, i) => {
    const notStarted =
      base.get(c.id) === 'todo' && (facts.get(c.id)?.mission?.progress?.done ?? 0) === 0
    if (!notStarted) return
    const waitsOnToken = (c.consumes ?? []).some((token) =>
      chapters
        .slice(0, i)
        .some((p) => (p.produces ?? []).includes(token) && base.get(p.id) !== 'done')
    )
    const waitsOnChapter =
      c.unlocks?.kind === 'chapter' &&
      chapters.some((p) => p.id === c.unlocks!.ref) &&
      base.get(c.unlocks.ref) !== 'done'
    if (waitsOnToken || waitsOnChapter) locked.add(c.id)
  })
  return locked
}

/**
 * Radiant progress of one chapter: a finished chapter has done all `total` units; otherwise
 * the units done are the chapter mission's done steps (a radiant chapter's mission is
 * planned one step per unit), capped at `total`; an unbound chapter has done none.
 */
function radiantDone(c: Chapter, f: ChapterFacts | undefined, state: ChapterState): number {
  const total = c.radiant?.total ?? 0
  if (state === 'done') return total
  return Math.min(f?.mission?.progress?.done ?? 0, total)
}

export function computeCampaignProgress(
  campaign: Pick<Campaign, 'chapters'>,
  facts: readonly ChapterFacts[],
  now: number
): CampaignProgress {
  const byId = new Map(facts.map((f) => [f.chapterId, f] as const))
  const all = campaign.chapters
  const base = new Map(all.map((c) => [c.id, chapterBaseState(byId.get(c.id))] as const))
  const locked = lockedChapterIds(all, byId, base)
  const stateOf = new Map(
    all.map((c) => [c.id, locked.has(c.id) ? 'locked' : base.get(c.id)!] as const)
  )

  const required = all.filter((c) => c.required)
  const side = all.filter((c) => !c.required)
  const st = required.map((c) => stateOf.get(c.id)!)
  const isDone = (s: ChapterState): boolean => s === 'done'
  const open = (s: ChapterState): boolean => !isDone(s) && s !== 'locked'
  const lastDone = st.map(isDone).lastIndexOf(true)
  const running = st.flatMap((s, i) => (s === 'running' ? [i] : []))
  const allDone = required.length > 0 && st.every(isDone)

  let current: CampaignProgress['current'] = null
  // Nothing to count (an empty plan): there is no "current" chapter — never "Chapter 0 of 0".
  if (!allDone && required.length > 0) {
    if (running.length > 0) {
      current = { from: running[0] + 1, to: running[running.length - 1] + 1 }
    } else {
      // The first open chapter after the last done one; when every chapter after it is done
      // but an earlier one is open, the last chapter. A locked chapter never takes the marker.
      let i = st.findIndex((s, k) => k > lastDone && open(s))
      if (i === -1) i = st.some(open) ? required.length - 1 : Math.max(lastDone, 0)
      current = { from: i + 1, to: i + 1 }
    }
  }

  const radiantChapters = all.filter((c) => c.radiant)
  return {
    total: required.length,
    current,
    allDone,
    done: st.filter(isDone).length,
    inReview: st.filter((s) => s === 'inReview').length,
    running: running.length,
    locked: st.filter((s) => s === 'locked').length,
    side: {
      total: side.length,
      done: side.filter((c) => isDone(stateOf.get(c.id)!)).length,
      open: side.filter((c) => !isDone(stateOf.get(c.id)!)).length
    },
    ...(radiantChapters.length > 0
      ? {
          radiant: {
            done: radiantChapters.reduce(
              (n, c) => n + radiantDone(c, byId.get(c.id), stateOf.get(c.id)!),
              0
            ),
            total: radiantChapters.reduce((n, c) => n + (c.radiant?.total ?? 0), 0)
          }
        }
      : {}),
    states: Object.fromEntries(all.map((c) => [c.id, stateOf.get(c.id)!])),
    computedAt: new Date(now).toISOString()
  }
}

/** The headline every surface prints: "Chapter N of M", "Chapters a–b of M", "Chapter M of M ✓", or nothing (`empty`). */
export function campaignHeadline(p: CampaignProgress): {
  kind: 'single' | 'range' | 'done' | 'empty'
  n: number
  to: number
  m: number
} {
  if (p.total === 0) return { kind: 'empty', n: 0, to: 0, m: 0 }
  if (p.allDone || !p.current) return { kind: 'done', n: p.total, to: p.total, m: p.total }
  return {
    kind: p.current.from === p.current.to ? 'single' : 'range',
    n: p.current.from,
    to: p.current.to,
    m: p.total
  }
}

/** A refusal code of `campaign_request_close`. */
export type CampaignCloseRefusalCode = 'CAMPAIGN_CLOSED' | 'CHAPTERS_OPEN'

/**
 * What `campaign_request_close` would refuse right now — the same checks, in the same
 * order, so `campaign_get.closeReadiness` and the verb can never disagree. `null` = a
 * request would land `delivered` + `pendingClose`. Every REQUIRED chapter must read done
 * (an open side quest holds nothing back), and a campaign with no required chapter has
 * delivered nothing.
 */
export function campaignCloseRefusal(
  campaign: Pick<Campaign, 'id' | 'status' | 'chapters'>,
  progress: CampaignProgress
): { code: CampaignCloseRefusalCode; reason: string } | null {
  if (campaign.status === 'closed') {
    return {
      code: 'CAMPAIGN_CLOSED',
      reason: `campaign ${campaign.id} was closed by the operator — a closed campaign is immutable by verb.`
    }
  }
  if (progress.total === 0) {
    return {
      code: 'CHAPTERS_OPEN',
      reason: `campaign ${campaign.id} has no required chapter — there is nothing delivered to close.`
    }
  }
  const open = campaign.chapters
    .filter((c) => c.required && progress.states[c.id] !== 'done')
    .map((c) => `${c.id} (${progress.states[c.id] ?? 'todo'})`)
  if (open.length > 0) {
    return {
      code: 'CHAPTERS_OPEN',
      reason: `${open.length} required chapter(s) are not done: ${open.join(', ')} — a chapter reads done when its mission is delivered; close the chapters first.`
    }
  }
  return null
}
