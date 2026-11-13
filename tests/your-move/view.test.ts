import { describe, expect, it } from 'vitest'
import type { CardView } from '../../src/main/your-move/core'
import {
  buttonsFor,
  formatClock,
  pageOfQueue,
  QUEUE_PAGE,
  queueCards,
  sortOldestFirst
} from '../../src/renderer/src/lib/your-move-view'

const view = (over: Partial<CardView> = {}): CardView => ({
  id: 'c1',
  sessionId: 'sess-0001',
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Pick one',
  source: 'judge',
  lane: 'live',
  openedAt: 1_000,
  updatedAt: 1_000,
  answerable: true,
  optionDeliverable: [],
  ...over
})

const ids = (cards: CardView[]): string[] => cards.map((c) => c.id)
const labelsOf = (card: CardView): (string | undefined)[] =>
  buttonsFor(card).map((b) => b.label ?? b.labelKey)

describe('formatClock', () => {
  it('formatClock: seconds under a minute; minute granularity from a minute on (BUG-271)', () => {
    expect(formatClock(5_000)).toBe('00m 05s')
    expect(formatClock(59_999)).toBe('00m 59s')
    expect(formatClock(60_000)).toBe('01m')
    expect(formatClock(123_000)).toBe('02m')
    expect(formatClock(3_723_000)).toBe('1h 02m')
    expect(formatClock(183_840_000)).toBe('2d 03h 04m')
    expect(formatClock(0)).toBe('00m 00s')
    expect(formatClock(-5_000)).toBe('00m 00s')
  })

  it('an old clock keeps one text for a whole minute, so a tick writes nothing (BUG-271)', () => {
    const base = 3_600_000 + 120_000
    expect(formatClock(base + 1_000)).toBe(formatClock(base + 59_000))
  })
})

describe('the queue page (BUG-271)', () => {
  const many = (n: number): CardView[] =>
    Array.from({ length: n }, (_, i) => view({ id: `c${i}`, openedAt: i }))

  it('the page size is bounded to 50 at most', () => {
    expect(QUEUE_PAGE).toBeGreaterThan(0)
    expect(QUEUE_PAGE).toBeLessThanOrEqual(50)
  })

  it('shows the first page in queue order and counts what is left', () => {
    const page = pageOfQueue(many(2_000), QUEUE_PAGE)
    expect(page.cards).toHaveLength(QUEUE_PAGE)
    expect(page.cards[0].id).toBe('c0')
    expect(page.cards[QUEUE_PAGE - 1].id).toBe(`c${QUEUE_PAGE - 1}`)
    expect(page.hidden).toBe(2_000 - QUEUE_PAGE)
    expect(page.next).toBe(QUEUE_PAGE)
  })

  it('a queue that fits shows everything and no more affordance', () => {
    const page = pageOfQueue(many(3), QUEUE_PAGE)
    expect(page.cards).toHaveLength(3)
    expect(page.hidden).toBe(0)
    expect(page.next).toBe(0)
  })

  it('the last page offers only what is left', () => {
    const page = pageOfQueue(many(30), QUEUE_PAGE)
    expect(page.hidden).toBe(30 - QUEUE_PAGE)
    expect(page.next).toBe(30 - QUEUE_PAGE)
  })
})

describe('the queue', () => {
  it('queue is open cards of lane live only, oldest first', () => {
    const cards = [
      view({ id: 'late', openedAt: 3_000 }),
      view({ id: 'closed', openedAt: 1_000, closedAt: 5_000, closedBy: 'not-for-me' }),
      view({ id: 'observed', openedAt: 500, lane: 'observe' }),
      view({ id: 'mid', openedAt: 600, lane: 'mid-turn' }),
      view({ id: 'early', openedAt: 2_000 })
    ]
    expect(ids(queueCards(cards))).toEqual(['early', 'late'])
    expect(ids(sortOldestFirst(cards))).toEqual(['observed', 'mid', 'closed', 'early', 'late'])
    // the input is never reordered in place
    expect(ids(cards)).toEqual(['late', 'closed', 'observed', 'mid', 'early'])
  })
})

describe('buttonsFor', () => {
  it('decide: one button per option, recommended first and marked, then Open session', () => {
    const card = view({
      options: ['Merge now', 'Wait for CI', 'Close it'],
      recommended: 'Wait for CI',
      optionDeliverable: [true, true, true]
    })
    const buttons = buttonsFor(card)
    expect(buttons.map((b) => b.label ?? b.labelKey)).toEqual([
      'Wait for CI',
      'Merge now',
      'Close it',
      'yourMove.buttons.openSession'
    ])
    expect(buttons.map((b) => b.recommended === true)).toEqual([true, false, false, false])
    // the answer carries the index into the card's own options, whatever the display order
    expect(buttons[0].action).toEqual({ type: 'answer', request: { kind: 'option', index: 1 } })
    expect(buttons[1].action).toEqual({ type: 'answer', request: { kind: 'option', index: 0 } })
    expect(buttons[3].action).toEqual({ type: 'open-session' })
    // ids are unique: they are the v-for key
    expect(new Set(buttons.map((b) => b.id)).size).toBe(buttons.length)
  })

  it('decide: with no recommendation the options keep their order', () => {
    const card = view({ options: ['A', 'B'], optionDeliverable: [true, true] })
    expect(labelsOf(card)).toEqual(['A', 'B', 'yourMove.buttons.openSession'])
    expect(buttonsFor(card).some((b) => b.recommended)).toBe(false)
  })

  it('go_no_go: Go, No-go, Open session', () => {
    const buttons = buttonsFor(view({ kind: 'go_no_go' }))
    expect(buttons.map((b) => b.labelKey)).toEqual([
      'yourMove.buttons.go',
      'yourMove.buttons.noGo',
      'yourMove.buttons.openSession'
    ])
    expect(buttons[0].action).toMatchObject({ type: 'answer', request: { kind: 'go' } })
    expect(buttons[1].action).toMatchObject({ type: 'answer', request: { kind: 'no-go' } })
  })

  it('do: Open link when http(s), Done, Open session; no link button otherwise', () => {
    const withLink = buttonsFor(view({ kind: 'do', link: 'https://example.com/pull/231' }))
    expect(withLink.map((b) => b.labelKey)).toEqual([
      'yourMove.buttons.openLink',
      'yourMove.buttons.done',
      'yourMove.buttons.openSession'
    ])
    expect(withLink[0].action).toEqual({ type: 'open-link', url: 'https://example.com/pull/231' })
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'not a url', undefined]) {
      expect(buttonsFor(view({ kind: 'do', link: bad })).map((b) => b.labelKey)).toEqual([
        'yourMove.buttons.done',
        'yourMove.buttons.openSession'
      ])
    }
  })

  it('check: Looks right, Something is wrong, Open session', () => {
    const buttons = buttonsFor(view({ kind: 'check' }))
    expect(buttons.map((b) => b.labelKey)).toEqual([
      'yourMove.buttons.looksRight',
      'yourMove.buttons.somethingWrong',
      'yourMove.buttons.openSession'
    ])
    expect(buttons[0].action).toMatchObject({ type: 'answer', request: { kind: 'looks-right' } })
    expect(buttons[1].action).toEqual({ type: 'looks-wrong' })
  })

  it('provide: Open session only', () => {
    const buttons = buttonsFor(view({ kind: 'provide', options: ['x'], link: 'https://a.test' }))
    expect(buttons.map((b) => b.labelKey)).toEqual(['yourMove.buttons.openSession'])
    expect(buttons[0].action).toEqual({ type: 'open-session' })
  })

  it('mission card: Open session and Open mission only', () => {
    const buttons = buttonsFor(
      view({
        kind: 'go_no_go',
        source: 'mission',
        mission: {
          missionId: 'mnt-1',
          root: '/org/proj/www',
          item: { kind: 'close' } as never
        }
      })
    )
    expect(buttons.map((b) => b.labelKey)).toEqual([
      'yourMove.buttons.openSession',
      'yourMove.buttons.openMission'
    ])
    expect(buttons[1].action).toEqual({ type: 'open-mission', missionId: 'mnt-1' })
  })

  it('human-gate, death, judge-failure: Open session only', () => {
    for (const source of ['human-gate', 'death', 'judge-failure'] as const) {
      expect(
        buttonsFor(view({ kind: 'decide', source, options: ['A'] })).map((b) => b.labelKey)
      ).toEqual(['yourMove.buttons.openSession'])
    }
  })

  it('not answerable: answer buttons gone, Open session stays', () => {
    for (const kind of ['decide', 'go_no_go', 'do', 'check'] as const) {
      const card = view({
        kind,
        answerable: false,
        options: ['A', 'B'],
        link: 'https://example.com/x',
        optionDeliverable: [true, true]
      })
      const buttons = buttonsFor(card)
      expect(buttons.some((b) => b.action.type === 'answer')).toBe(false)
      expect(buttons.at(-1)?.action).toEqual({ type: 'open-session' })
    }
    // a link is not an answer: it stays on a do card that cannot be answered
    expect(
      buttonsFor(view({ kind: 'do', answerable: false, link: 'https://example.com/x' })).map(
        (b) => b.labelKey
      )
    ).toEqual(['yourMove.buttons.openLink', 'yourMove.buttons.openSession'])
  })

  it('an option with optionDeliverable false is an Open session action', () => {
    // Review Focus 2: a model-written option like "/exit" is never typed into the PTY
    const card = view({
      options: ['/exit', 'Merge'],
      recommended: '/exit',
      optionDeliverable: [false, true]
    })
    const buttons = buttonsFor(card)
    expect(buttons.map((b) => b.label ?? b.labelKey)).toEqual([
      '/exit',
      'Merge',
      'yourMove.buttons.openSession'
    ])
    expect(buttons[0].action).toEqual({ type: 'open-session' })
    expect(buttons[1].action).toEqual({ type: 'answer', request: { kind: 'option', index: 1 } })
  })
})
