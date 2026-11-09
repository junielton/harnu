import { describe, expect, it } from 'vitest'
import {
  advanceCursor,
  applyVerdict,
  closeCard,
  closeForFolder,
  closeForSessions,
  emptyState,
  openCardsFor,
  pruneClosed,
  reconcileSource,
  resetCursors,
  upsertStructured,
  type StructuredDraft,
  type YourMoveCard,
  type YourMoveState
} from '../../src/main/your-move/core'

function card(over: Partial<YourMoveCard> = {}): YourMoveCard {
  return {
    id: 'a',
    sessionId: 's1',
    folder: '/org/proj/www',
    kind: 'decide',
    ask: 'old ask',
    source: 'judge',
    lane: 'observe',
    openedAt: 1,
    updatedAt: 1,
    ...over
  }
}

function stateOf(...cards: YourMoveCard[]): YourMoveState {
  return { ...emptyState(), cards }
}

const base = {
  sessionId: 's1',
  folder: '/org/proj/www',
  newIds: [] as string[],
  hasOperatorEntry: true,
  lane: 'observe' as const,
  now: 9
}

function draft(over: Partial<StructuredDraft> = {}): StructuredDraft {
  return {
    sessionId: 's1',
    folder: '/org/proj/www',
    kind: 'do',
    ask: 'Merge the PR',
    source: 'mission',
    sourceKey: 'm1:blocker:x',
    lane: 'observe',
    ...over
  }
}

describe('applyVerdict', () => {
  it('update refreshes ask and updatedAt, never openedAt', () => {
    const next = applyVerdict(stateOf(card()), {
      ...base,
      verdict: { new: [], update: [{ id: 'a', ask: 'new' }], close: [] }
    })
    expect(next.cards[0]).toMatchObject({ ask: 'new', updatedAt: 9, openedAt: 1 })
  })

  it('close is ignored without an [OPERATOR] entry', () => {
    const next = applyVerdict(stateOf(card()), {
      ...base,
      hasOperatorEntry: false,
      verdict: { new: [], update: [], close: ['a'] }
    })
    expect(next.cards[0].closedAt).toBeUndefined()
  })

  it('close applies with an [OPERATOR] entry and records closedBy judge', () => {
    const next = applyVerdict(stateOf(card()), {
      ...base,
      verdict: { new: [], update: [], close: ['a'] }
    })
    expect(next.cards[0]).toMatchObject({ closedAt: 9, closedBy: 'judge' })
  })

  it('unknown ids in update and close are ignored, cards of other sessions untouched', () => {
    const other = card({ id: 'b', sessionId: 's2' })
    const next = applyVerdict(stateOf(card(), other), {
      ...base,
      verdict: {
        new: [],
        update: [
          { id: 'zzz', ask: 'x' },
          { id: 'b', ask: 'hijack' }
        ],
        close: ['zzz', 'b']
      }
    })
    expect(next.cards.find((c) => c.id === 'b')).toEqual(other)
    expect(next.cards.find((c) => c.id === 'a')?.ask).toBe('old ask')
    expect(next.cards).toHaveLength(2)
  })

  it('recommended not among options is dropped; link not http(s) is dropped', () => {
    const mk = (link: string, recommended: string) =>
      applyVerdict(emptyState(), {
        ...base,
        newIds: ['n1'],
        verdict: {
          new: [{ kind: 'decide', ask: 'Pick', options: ['A', 'B'], recommended, link }],
          update: [],
          close: []
        }
      }).cards[0]
    expect(mk('javascript:alert(1)', 'C')).toMatchObject({ recommended: undefined, link: undefined })
    expect(mk('file:///etc/passwd', 'A').link).toBeUndefined()
    expect(mk('https://example.com/x', 'A')).toMatchObject({
      recommended: 'A',
      link: 'https://example.com/x'
    })
  })

  it('files a judge card with the pre-minted id, lane and the clock starting now', () => {
    const next = applyVerdict(emptyState(), {
      ...base,
      newIds: ['n1'],
      verdict: { new: [{ kind: 'provide', ask: 'Need the key' }], update: [], close: [] }
    })
    expect(next.cards[0]).toMatchObject({
      id: 'n1',
      source: 'judge',
      lane: 'observe',
      openedAt: 9,
      updatedAt: 9,
      sessionId: 's1'
    })
  })

  it('re-folding the same ids does not resurrect a card the operator closed', () => {
    const closed = closeCard(stateOf(card({ id: 'n1' })), 'n1', 'not-for-me', 5)
    const next = applyVerdict(closed, {
      ...base,
      newIds: ['n1'],
      verdict: { new: [{ kind: 'decide', ask: 'x' }], update: [], close: [] }
    })
    expect(next.cards).toHaveLength(1)
    expect(next.cards[0].closedBy).toBe('not-for-me')
  })

  it('does not mutate its input', () => {
    const s = stateOf(card())
    const snapshot = JSON.stringify(s)
    applyVerdict(s, { ...base, verdict: { new: [], update: [{ id: 'a', ask: 'n' }], close: ['a'] } })
    expect(JSON.stringify(s)).toBe(snapshot)
  })
})

describe('openCardsFor', () => {
  it('returns only open judge and verb cards of that session and lane', () => {
    const s = stateOf(
      card({ id: 'a' }),
      card({ id: 'b', lane: 'live' }),
      card({ id: 'c', sessionId: 's2' }),
      card({ id: 'd', closedAt: 3, closedBy: 'judge' }),
      card({ id: 'e', source: 'mission' }),
      card({ id: 'f', source: 'verb' })
    )
    expect(openCardsFor(s, 's1', 'observe').map((c) => c.id)).toEqual(['a', 'f'])
  })
})

describe('advanceCursor', () => {
  it('moves one field and stamps lastInspectedAt, leaving the other field alone', () => {
    let s = advanceCursor(emptyState(), 's1', 'offset', 100, 5)
    s = advanceCursor(s, 's1', 'shadowOffset', 150, 6)
    expect(s.cursors.s1).toEqual({ offset: 100, shadowOffset: 150, lastInspectedAt: 6 })
  })
})

describe('structured cards', () => {
  it('upsertStructured with a known sourceKey keeps openedAt and refreshes ask', () => {
    let n = 0
    const mint = () => `id${++n}`
    let s = upsertStructured(emptyState(), draft(), mint, 1)
    s = upsertStructured(s, draft({ ask: 'Merge it now' }), mint, 7)
    expect(s.cards).toHaveLength(1)
    expect(s.cards[0]).toMatchObject({ ask: 'Merge it now', openedAt: 1, updatedAt: 7 })
  })

  it('reconcileSource closes in-scope cards whose key is no longer owed as source-resolved', () => {
    let n = 0
    const mint = () => `id${++n}`
    let s = upsertStructured(emptyState(), draft({ sourceKey: 'k1' }), mint, 1)
    s = upsertStructured(s, draft({ sourceKey: 'k2' }), mint, 1)
    s = reconcileSource(s, { source: 'mission', sessionId: 's1' }, [draft({ sourceKey: 'k2' })], mint, 8)
    expect(s.cards.find((c) => c.sourceKey === 'k1')).toMatchObject({
      closedAt: 8,
      closedBy: 'source-resolved'
    })
    expect(s.cards.find((c) => c.sourceKey === 'k2')?.closedAt).toBeUndefined()
  })

  it('reconcileSource never touches cards of another mission id or session', () => {
    let n = 0
    const mint = () => `id${++n}`
    const mission = (missionId: string) => ({
      missionId,
      root: '/r',
      item: { kind: 'close' } as never
    })
    let s = upsertStructured(
      emptyState(),
      draft({ sourceKey: 'a', mission: mission('mnt-1') }),
      mint,
      1
    )
    s = upsertStructured(s, draft({ sourceKey: 'b', mission: mission('mnt-2') }), mint, 1)
    s = upsertStructured(s, draft({ sourceKey: 'c', sessionId: 's9' }), mint, 1)
    s = reconcileSource(s, { source: 'mission', missionIds: ['mnt-1'] }, [], mint, 8)
    expect(s.cards.map((c) => [c.sourceKey, c.closedBy])).toEqual([
      ['a', 'source-resolved'],
      ['b', undefined],
      ['c', undefined]
    ])
    s = reconcileSource(s, { source: 'mission', sessionId: 's1' }, [], mint, 9)
    expect(s.cards.find((c) => c.sourceKey === 'c')?.closedAt).toBeUndefined()
  })
})

describe('closing and housekeeping', () => {
  it('closeForSessions and closeForFolder close open cards with the given reason', () => {
    const s = stateOf(
      card({ id: 'a' }),
      card({ id: 'b', sessionId: 's2', folder: '/org/other' }),
      card({ id: 'c', sessionId: 's3', folder: '/org/other/sub' })
    )
    const bySession = closeForSessions(s, ['s1'], 'archived', 4)
    expect(bySession.cards.map((c) => c.closedBy)).toEqual(['archived', undefined, undefined])
    const byFolder = closeForFolder(s, '/org/other', 'folder-removed', 4)
    expect(byFolder.cards.map((c) => c.closedBy)).toEqual([undefined, 'folder-removed', 'folder-removed'])
  })

  it('closeCard never reopens or re-stamps an already closed card', () => {
    const s = closeCard(stateOf(card()), 'a', 'answered', 3)
    expect(closeCard(s, 'a', 'archived', 9).cards[0]).toMatchObject({ closedAt: 3, closedBy: 'answered' })
  })

  it('resetCursors drops every cursor and keeps every card', () => {
    const s = advanceCursor(stateOf(card()), 's1', 'offset', 10, 1)
    const next = resetCursors(s)
    expect(next.cursors).toEqual({})
    expect(next.cards).toHaveLength(1)
  })

  it('pruneClosed drops closed cards older than 30 days and caps closed at 1000, keeping open ones', () => {
    const day = 86_400_000
    const now = 100 * day
    const old = card({ id: 'old', closedAt: now - 31 * day, closedBy: 'judge' })
    const open = card({ id: 'open' })
    const many = Array.from({ length: 1005 }, (_, i) =>
      card({ id: `c${i}`, closedAt: now - 1000 + i, closedBy: 'judge' })
    )
    const next = pruneClosed(stateOf(old, open, ...many), now)
    expect(next.cards.find((c) => c.id === 'old')).toBeUndefined()
    expect(next.cards.find((c) => c.id === 'open')).toBeDefined()
    expect(next.cards.filter((c) => c.closedAt).length).toBe(1000)
    expect(next.cards.find((c) => c.id === 'c0')).toBeUndefined()
    expect(next.cards.find((c) => c.id === 'c1004')).toBeDefined()
  })
})
