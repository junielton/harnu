/**
 * Campaign ch.3a (T595, spec §3.1) — `derived.progress` for a campaign counts CHAPTERS:
 * `{ total, current, done, inReview, running, locked, side: { total, done, open }, radiant? }`.
 * A chapter's state rolls up from its bound mission with no second door: a chapter whose
 * mission is `delivered`, or closed as delivered, reads done (AC-3a.3).
 *
 * The expectations are written from the spec's words, one hand-computed case each — never
 * copied from what `computeCampaignProgress` returned (testing/003).
 */
import { describe, it, expect } from 'vitest'
import type { Campaign, Chapter } from '../src/main/campaign-core'
import {
  campaignCloseRefusal,
  campaignHeadline,
  computeCampaignProgress,
  type ChapterFacts
} from '../src/main/campaign-progress'
import type { Mission } from '../src/main/mission-core'
import type { MissionProgress, StepState } from '../src/main/mission-progress'

const NOW = Date.parse('2026-10-31T12:00:00.000Z')

function chapter(n: number, over: Partial<Chapter> = {}): Chapter {
  return { id: `chp-${n}`, ordinal: n, title: `Chapter ${n}`, required: true, ...over }
}

function campaignOf(chapters: Chapter[]): Pick<Campaign, 'chapters'> {
  return { chapters }
}

/** A mission's progress with the given step states (all required steps). */
function mp(states: StepState[]): MissionProgress {
  const m = states.length
  const done = states.filter((s) => s === 'done' || s === 'verified').length
  return {
    total: m,
    current: done === m ? null : { from: done + 1, to: done + 1 },
    allDone: m > 0 && done === m,
    done,
    verified: states.filter((s) => s === 'verified').length,
    states: Object.fromEntries(states.map((s, i) => [`stp-${i + 1}`, s])),
    leftBehind: [],
    unprovable: [],
    computedAt: new Date(NOW).toISOString()
  }
}

function facts(
  chapterId: string,
  status: Mission['status'],
  progress: MissionProgress | null,
  closedAs?: 'delivered' | 'discarded'
): ChapterFacts {
  return { chapterId, mission: { status, ...(closedAs ? { closedAs } : {}), progress } }
}

const unbound = (chapterId: string): ChapterFacts => ({ chapterId, mission: null })

describe('AC-3a.3 — a chapter rolls up from its bound mission, with no second door', () => {
  const c = campaignOf([chapter(1), chapter(2), chapter(3), chapter(4)])

  it('delivered → done, closed as delivered → done, even with no progress read', () => {
    const p = computeCampaignProgress(
      c,
      [
        facts('chp-1', 'delivered', null),
        facts('chp-2', 'closed', null, 'delivered'),
        unbound('chp-3'),
        unbound('chp-4')
      ],
      NOW
    )
    expect(p.states['chp-1']).toBe('done')
    expect(p.states['chp-2']).toBe('done')
    expect(p.done).toBe(2)
  })

  it('a mission closed as DISCARDED is not done (the operator abandoned it)', () => {
    const p = computeCampaignProgress(
      campaignOf([chapter(1)]),
      [facts('chp-1', 'closed', mp(['done']), 'discarded')],
      NOW
    )
    expect(p.states['chp-1']).not.toBe('done')
    expect(p.done).toBe(0)
  })

  it('a mission whose steps are all done but is not delivered yet reads inReview', () => {
    const p = computeCampaignProgress(
      campaignOf([chapter(1)]),
      [facts('chp-1', 'active', mp(['verified', 'done']))],
      NOW
    )
    expect(p.states['chp-1']).toBe('inReview')
    expect(p).toMatchObject({ done: 0, inReview: 1, running: 0 })
  })

  it('a mission with a step running reads running', () => {
    const p = computeCampaignProgress(
      campaignOf([chapter(1)]),
      [facts('chp-1', 'active', mp(['done', 'running', 'todo']))],
      NOW
    )
    expect(p.states['chp-1']).toBe('running')
    expect(p.running).toBe(1)
  })

  it('an unbound chapter, or a bound one with nothing moving, is neither running nor done', () => {
    const p = computeCampaignProgress(
      campaignOf([chapter(1), chapter(2)]),
      [unbound('chp-1'), facts('chp-2', 'active', mp(['todo', 'todo']))],
      NOW
    )
    expect(p).toMatchObject({ done: 0, inReview: 0, running: 0, locked: 0 })
    expect(p.total).toBe(2)
  })

  it('counts: total, done, inReview, running, locked over the required chapters (spec §3.1 shape)', () => {
    const chapters = [
      chapter(1, { produces: ['a'] }),
      chapter(2),
      chapter(3),
      chapter(4, { consumes: ['a'] })
    ]
    const p = computeCampaignProgress(
      campaignOf(chapters),
      [
        facts('chp-1', 'delivered', null),
        facts('chp-2', 'active', mp(['done', 'done'])),
        facts('chp-3', 'active', mp(['running'])),
        unbound('chp-4')
      ],
      NOW
    )
    expect(p).toMatchObject({ total: 4, done: 1, inReview: 1, running: 1, locked: 0 })
    expect(p.side).toEqual({ total: 0, done: 0, open: 0 })
  })
})

describe('AC-3a.3 — locked chapters', () => {
  it('a chapter that consumes a token is locked until every earlier producer of it is done', () => {
    const chapters = [
      chapter(1, { produces: ['images-on-cdn'] }),
      chapter(2, { consumes: ['images-on-cdn'] })
    ]
    const open = computeCampaignProgress(
      campaignOf(chapters),
      [facts('chp-1', 'active', mp(['running'])), unbound('chp-2')],
      NOW
    )
    expect(open.states).toEqual({ 'chp-1': 'running', 'chp-2': 'locked' })
    expect(open.locked).toBe(1)

    const released = computeCampaignProgress(
      campaignOf(chapters),
      [facts('chp-1', 'delivered', null), unbound('chp-2')],
      NOW
    )
    expect(released.states['chp-2']).toBe('todo')
    expect(released.locked).toBe(0)
  })

  it('`unlocks: { kind: chapter }` keeps a chapter locked until that chapter is done', () => {
    const chapters = [chapter(1), chapter(2, { unlocks: { kind: 'chapter', ref: 'chp-1' } })]
    const locked = computeCampaignProgress(
      campaignOf(chapters),
      [unbound('chp-1'), unbound('chp-2')],
      NOW
    )
    expect(locked.states['chp-2']).toBe('locked')
    const free = computeCampaignProgress(
      campaignOf(chapters),
      [facts('chp-1', 'closed', null, 'delivered'), unbound('chp-2')],
      NOW
    )
    expect(free.states['chp-2']).toBe('todo')
  })

  it('a chapter already started keeps what actually happened — it is never re-locked', () => {
    const chapters = [chapter(1, { produces: ['a'] }), chapter(2, { consumes: ['a'] })]
    const p = computeCampaignProgress(
      campaignOf(chapters),
      [facts('chp-1', 'active', mp(['todo'])), facts('chp-2', 'active', mp(['running']))],
      NOW
    )
    expect(p.states['chp-2']).toBe('running')
  })
})

describe('AC-3a.3 — current, in the mission-progress sense ("Chapter N of M")', () => {
  const four = campaignOf([chapter(1), chapter(2), chapter(3), chapter(4)])

  it('is the first open chapter after the last done one', () => {
    const p = computeCampaignProgress(
      four,
      [
        facts('chp-1', 'delivered', null),
        facts('chp-2', 'delivered', null),
        unbound('chp-3'),
        unbound('chp-4')
      ],
      NOW
    )
    expect(p.current).toEqual({ from: 3, to: 3 })
    expect(campaignHeadline(p)).toEqual({ kind: 'single', n: 3, to: 3, m: 4 })
  })

  it('spans the running chapters when several run in parallel', () => {
    const p = computeCampaignProgress(
      four,
      [
        facts('chp-1', 'delivered', null),
        facts('chp-2', 'active', mp(['running'])),
        unbound('chp-3'),
        facts('chp-4', 'active', mp(['running']))
      ],
      NOW
    )
    expect(p.current).toEqual({ from: 2, to: 4 })
    expect(campaignHeadline(p)).toEqual({ kind: 'range', n: 2, to: 4, m: 4 })
  })

  it('is null when every required chapter is done (the pill reads "Chapter M of M ✓")', () => {
    const p = computeCampaignProgress(
      campaignOf([chapter(1), chapter(2)]),
      [facts('chp-1', 'delivered', null), facts('chp-2', 'delivered', null)],
      NOW
    )
    expect(p.current).toBeNull()
    expect(p.allDone).toBe(true)
    expect(campaignHeadline(p)).toEqual({ kind: 'done', n: 2, to: 2, m: 2 })
  })

  it('a locked chapter never takes the marker', () => {
    // Chapter 2 waits for chapter 3, so after the delivered chapter 1 the marker is on 3, not 2.
    const chapters = [
      chapter(1),
      chapter(2, { unlocks: { kind: 'chapter', ref: 'chp-3' } }),
      chapter(3)
    ]
    const p = computeCampaignProgress(
      campaignOf(chapters),
      [facts('chp-1', 'delivered', null), unbound('chp-2'), unbound('chp-3')],
      NOW
    )
    expect(p.states['chp-2']).toBe('locked')
    expect(p.current).toEqual({ from: 3, to: 3 })
  })

  it('an empty campaign has no current and an empty headline (never "Chapter 0 of 0")', () => {
    const p = computeCampaignProgress(campaignOf([]), [], NOW)
    expect(p).toMatchObject({ total: 0, current: null, allDone: false })
    expect(campaignHeadline(p).kind).toBe('empty')
  })
})

describe('AC-3a.3 — side-quest chapters (required: false)', () => {
  it('stay out of total / current / done and are counted in side { total, done, open }', () => {
    const chapters = [
      chapter(1),
      chapter(2, { required: false, discoveredFrom: { chapterId: 'chp-1' } }),
      chapter(3, { required: false }),
      chapter(4)
    ]
    const p = computeCampaignProgress(
      campaignOf(chapters),
      [
        facts('chp-1', 'delivered', null),
        facts('chp-2', 'delivered', null),
        facts('chp-3', 'active', mp(['running'])),
        unbound('chp-4')
      ],
      NOW
    )
    expect(p.total).toBe(2)
    expect(p.done).toBe(1)
    expect(p.current).toEqual({ from: 2, to: 2 })
    expect(p.side).toEqual({ total: 2, done: 1, open: 1 })
    // The running side quest never reads as a running main chapter.
    expect(p.running).toBe(0)
    expect(p.states['chp-3']).toBe('running')
  })
})

describe('AC-3a.3 — radiant (one template × N units)', () => {
  it('is omitted when no chapter declares one', () => {
    expect(
      computeCampaignProgress(campaignOf([chapter(1)]), [unbound('chp-1')], NOW).radiant
    ).toBeUndefined()
  })

  it('reports { done, total }: the declared total, and done = the chapter mission’s done steps, capped; a done chapter is all done', () => {
    const radiant = { template: 'migrate page {slug}', total: 4 }
    const mid = computeCampaignProgress(
      campaignOf([chapter(1, { radiant })]),
      [facts('chp-1', 'active', mp(['done', 'verified', 'running', 'todo']))],
      NOW
    )
    expect(mid.radiant).toEqual({ done: 2, total: 4 })
    const finished = computeCampaignProgress(
      campaignOf([chapter(1, { radiant })]),
      [facts('chp-1', 'delivered', null)],
      NOW
    )
    expect(finished.radiant).toEqual({ done: 4, total: 4 })
    const unstarted = computeCampaignProgress(
      campaignOf([chapter(1, { radiant })]),
      [unbound('chp-1')],
      NOW
    )
    expect(unstarted.radiant).toEqual({ done: 0, total: 4 })
  })

  it('sums several radiant chapters', () => {
    const p = computeCampaignProgress(
      campaignOf([
        chapter(1, { radiant: { template: 'a', total: 3 } }),
        chapter(2, { radiant: { template: 'b', total: 5 } })
      ]),
      [facts('chp-1', 'delivered', null), unbound('chp-2')],
      NOW
    )
    expect(p.radiant).toEqual({ done: 3, total: 8 })
  })
})

describe('campaignCloseRefusal — what campaign_request_close would refuse right now', () => {
  const chapters = [chapter(1), chapter(2), chapter(3, { required: false })]
  const base = { id: 'cmp-0a1b2c3d', status: 'active' as const, chapters }

  it('refuses CHAPTERS_OPEN while a required chapter is not done, naming it', () => {
    const p = computeCampaignProgress(
      campaignOf(chapters),
      [facts('chp-1', 'delivered', null), unbound('chp-2'), unbound('chp-3')],
      NOW
    )
    const refusal = campaignCloseRefusal(base, p)
    expect(refusal?.code).toBe('CHAPTERS_OPEN')
    expect(refusal?.reason).toContain('chp-2')
    expect(refusal?.reason).not.toContain('chp-3')
  })

  it('an open SIDE quest does not hold a close back', () => {
    const p = computeCampaignProgress(
      campaignOf(chapters),
      [facts('chp-1', 'delivered', null), facts('chp-2', 'delivered', null), unbound('chp-3')],
      NOW
    )
    expect(campaignCloseRefusal(base, p)).toBeNull()
  })

  it('a campaign with no required chapter cannot be closed as delivered (nothing was delivered)', () => {
    const p = computeCampaignProgress(campaignOf([]), [], NOW)
    expect(campaignCloseRefusal({ ...base, chapters: [] }, p)?.code).toBe('CHAPTERS_OPEN')
  })

  it('refuses CAMPAIGN_CLOSED on a closed campaign, before anything else', () => {
    const p = computeCampaignProgress(campaignOf(chapters), [], NOW)
    expect(campaignCloseRefusal({ ...base, status: 'closed' }, p)?.code).toBe('CAMPAIGN_CLOSED')
  })
})
