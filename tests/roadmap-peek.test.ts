import { describe, it, expect } from 'vitest'
import { summarizeCards } from '../src/main/roadmap-ipc'
import type { RoadmapCard } from '../src/main/roadmap-core'

/**
 * T212 — the pure half of `roadmap:peek`. The fs read is env-bound (e2e-only per
 * ADR-0001); the bucketing math is unit-tested here.
 *
 * T284 — plus the branch-ownership read (`owned`): which card is this branch
 * executing, and the tie-break when more than one names it.
 */

function card(over: Partial<RoadmapCard>): RoadmapCard {
  return {
    id: 'T1',
    slug: 't1',
    title: 'Card',
    status: 'backlog',
    rawStatus: 'backlog',
    column: 'backlog',
    blocked: false,
    ...over
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('summarizeCards', () => {
  it('counts every column, including empty ones', () => {
    const out = summarizeCards([card({ status: 'backlog' }), card({ status: 'backlog' })])
    expect(out.counts).toEqual({
      backlog: 2,
      ready: 0,
      'in-progress': 0,
      review: 0,
      done: 0
    })
  })

  it('returns only in-progress and review cards as active', () => {
    const out = summarizeCards([
      card({ slug: 'a', status: 'backlog' }),
      card({ slug: 'b', status: 'in-progress', session: 'sess-1' }),
      card({ slug: 'c', status: 'review' }),
      card({ slug: 'd', status: 'done' })
    ])
    expect(out.active.map((c) => c.slug)).toEqual(['b', 'c'])
    expect(out.active[0].session).toBe('sess-1')
  })

  it('orders active cards in-progress before review', () => {
    const out = summarizeCards([
      card({ slug: 'r', status: 'review' }),
      card({ slug: 'p', status: 'in-progress' })
    ])
    expect(out.active.map((c) => c.slug)).toEqual(['p', 'r'])
  })

  it('is empty for a board with no cards', () => {
    const out = summarizeCards([])
    expect(out.active).toEqual([])
    expect(out.counts.backlog).toBe(0)
  })
})

describe('summarizeCards — branch ownership (T284)', () => {
  it('omits `owned` entirely when no branch is asked about', () => {
    const out = summarizeCards([card({ slug: 'a', status: 'in-progress', executedIn: 'feat/x' })])
    expect('owned' in out).toBe(false)
    expect(Object.keys(out).sort()).toEqual(['active', 'counts'])
  })

  it('returns the card whose executedIn is the branch', () => {
    const out = summarizeCards(
      [
        card({ slug: 'a', id: 'T1', status: 'in-progress', executedIn: 'card/T1-thing' }),
        card({ slug: 'b', id: 'T2', status: 'in-progress', executedIn: 'card/T2-other' })
      ],
      'card/T2-other'
    )
    expect(out.owned?.id).toBe('T2')
    expect(out.owned?.executedIn).toBe('card/T2-other')
  })

  it('searches all five columns, not just the active ones', () => {
    for (const status of ['backlog', 'ready', 'in-progress', 'review', 'done'] as const) {
      const out = summarizeCards(
        [card({ slug: 'a', id: 'T9', status, executedIn: 'feat/x' })],
        'feat/x'
      )
      expect(out.owned?.id, `column ${status}`).toBe('T9')
      expect(out.owned?.status).toBe(status)
    }
  })

  it('returns null when the branch is owned by no card', () => {
    const out = summarizeCards([card({ slug: 'a', status: 'in-progress' })], 'feat/nobody')
    expect(out.owned).toBeNull()
  })

  it('returns null for a blank branch rather than matching a blank executedIn', () => {
    const out = summarizeCards([card({ slug: 'a', status: 'in-progress' })], '   ')
    expect(out.owned).toBeNull()
  })

  it('tie-breaks on liveness first: in-progress beats review beats ready beats backlog beats done', () => {
    const all = [
      card({ slug: 'd', id: 'T4', status: 'done', executedIn: 'feat/x' }),
      card({ slug: 'b', id: 'T1', status: 'backlog', executedIn: 'feat/x' }),
      card({ slug: 'r', id: 'T3', status: 'review', executedIn: 'feat/x' }),
      card({ slug: 'y', id: 'T2', status: 'ready', executedIn: 'feat/x' }),
      card({ slug: 'p', id: 'T5', status: 'in-progress', executedIn: 'feat/x' })
    ]
    expect(summarizeCards(all, 'feat/x').owned?.id).toBe('T5')
    expect(
      summarizeCards(
        all.filter((c) => c.status !== 'in-progress'),
        'feat/x'
      ).owned?.id
    ).toBe('T3')
    expect(
      summarizeCards(
        all.filter((c) => c.status !== 'in-progress' && c.status !== 'review'),
        'feat/x'
      ).owned?.id
    ).toBe('T2')
    expect(
      summarizeCards(
        all.filter((c) => c.status === 'backlog' || c.status === 'done'),
        'feat/x'
      ).owned?.id
    ).toBe('T1')
    expect(
      summarizeCards(
        all.filter((c) => c.status === 'done'),
        'feat/x'
      ).owned?.id
    ).toBe('T4')
  })

  it('tie-breaks within a column by the board order (priority, then id) — never input order', () => {
    const cards = [
      card({ slug: 'z', id: 'T9', status: 'review', executedIn: 'feat/x', priority: 'low' }),
      card({ slug: 'a', id: 'T2', status: 'review', executedIn: 'feat/x', priority: 'high' }),
      card({ slug: 'm', id: 'T1', status: 'review', executedIn: 'feat/x', priority: 'high' })
    ]
    expect(summarizeCards(cards, 'feat/x').owned?.id).toBe('T1')
    // Same set, reversed on input — the answer must not move.
    expect(summarizeCards([...cards].reverse(), 'feat/x').owned?.id).toBe('T1')
  })

  it('falls back to slug so the order is total even when two cards share an id', () => {
    const cards = [
      card({ slug: 'zzz', id: 'T1', status: 'review', executedIn: 'feat/x', priority: 'high' }),
      card({ slug: 'aaa', id: 'T1', status: 'review', executedIn: 'feat/x', priority: 'high' })
    ]
    expect(summarizeCards(cards, 'feat/x').owned?.slug).toBe('aaa')
    expect(summarizeCards([...cards].reverse(), 'feat/x').owned?.slug).toBe('aaa')
  })

  it('carries executedIn on active cards, and only when the card has one', () => {
    const out = summarizeCards([
      card({ slug: 'a', status: 'in-progress', executedIn: 'feat/x' }),
      card({ slug: 'b', status: 'review' })
    ])
    expect(out.active[0].executedIn).toBe('feat/x')
    expect('executedIn' in out.active[1]).toBe(false)
  })
})
