import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBoard, type BoardSession } from '../src/renderer/src/components/fleet-board'

/**
 * BUG-265: `buildBoard` used to parse `created` inside the sort comparator, so a bucket of N cards cost
 * about N log N `Date.parse` calls on every recompute of the board (470 ms of self time in the 2026-11-13
 * profile). Each card's `created` is now parsed once, however the cards are ordered.
 */

function card(i: number): BoardSession {
  return {
    sessionId: `s-${String(i).padStart(4, '0')}`,
    taskState: 'working',
    status: 'active',
    isSidechain: false,
    modified: '2026-01-01T00:00:00.000Z',
    created: new Date(1_760_000_000_000 - ((i * 7919) % 5000) * 1000).toISOString(),
    activity: 'working',
    folderAlias: 'alpha'
  }
}

describe('buildBoard parses `created` once per card (BUG-265)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('calls Date.parse at most once per card for a 500-card bucket', () => {
    const cards = Array.from({ length: 500 }, (_, i) => card(i))
    const parse = vi.spyOn(Date, 'parse')

    buildBoard(cards)

    expect(parse.mock.calls.length).toBeLessThanOrEqual(cards.length)
  })

  it('still orders newest first, oldest first on request, with ties on sessionId', () => {
    const same = '2026-03-03T00:00:00.000Z'
    const cards: BoardSession[] = [
      { ...card(1), sessionId: 'b', created: same },
      { ...card(2), sessionId: 'a', created: same },
      { ...card(3), sessionId: 'new', created: '2026-04-01T00:00:00.000Z' },
      { ...card(4), sessionId: 'bad', created: 'not a date' }
    ]
    expect(buildBoard(cards)[0].sessions.map((s) => s.sessionId)).toEqual(['new', 'a', 'b', 'bad'])
    expect(buildBoard(cards, 'oldest-first')[0].sessions.map((s) => s.sessionId)).toEqual([
      'a',
      'b',
      'new',
      'bad'
    ])
  })
})
