import { describe, it, expect } from 'vitest'
import {
  TOPBAR_ACTION_GAP_PX,
  TOPBAR_ACTION_PX,
  TOPBAR_BAR_ORDER,
  TOPBAR_CRUMB_MIN_PX,
  TOPBAR_HYSTERESIS_PX,
  TOPBAR_MIN_TITLE_PX,
  TOPBAR_OVERFLOW_ORDER,
  clusterBudget,
  planTopbarOverflow,
  type TopbarActionId
} from '../src/renderer/src/lib/topbar-overflow'

/**
 * BUG-252 — the pure fit/priority math behind the Topbar overflow menu (design.md §6 "Topbar overflow").
 * One action takes 26px plus a 2px gap, the `…` button takes a slot of its own, and the priority order
 * is the single list `TOPBAR_OVERFLOW_ORDER`.
 */

const SLOT = TOPBAR_ACTION_PX + TOPBAR_ACTION_GAP_PX
const ALL = TOPBAR_BAR_ORDER
const hide = (available: number, present: readonly TopbarActionId[] = ALL, prev?: number) =>
  planTopbarOverflow({ present, available, previousHiddenCount: prev })

describe('the declared orders', () => {
  it('the priority list is a permutation of the bar order: every action has exactly one priority', () => {
    expect([...TOPBAR_OVERFLOW_ORDER].sort()).toEqual([...TOPBAR_BAR_ORDER].sort())
    expect(new Set(TOPBAR_OVERFLOW_ORDER).size).toBe(TOPBAR_OVERFLOW_ORDER.length)
  })

  it('github-pulls leaves first, new-session last', () => {
    expect(TOPBAR_OVERFLOW_ORDER[0]).toBe('github-pulls')
    expect(TOPBAR_OVERFLOW_ORDER.at(-1)).toBe('new-session')
  })
})

describe('planTopbarOverflow', () => {
  it('keeps everything in the bar when it all fits, with no `…`', () => {
    const plan = hide(ALL.length * SLOT)
    expect(plan.hidden).toEqual([])
    expect(plan.visible).toEqual([...ALL])
  })

  it('hides two when one is short, because the `…` button takes a slot', () => {
    const plan = hide(ALL.length * SLOT - 1)
    expect(plan.hidden).toEqual(['open-folder', 'github-pulls'])
    // The menu and the bar keep bar order, not priority order.
    expect(plan.visible).toEqual(ALL.filter((id) => id !== 'open-folder' && id !== 'github-pulls'))
  })

  it('hides in priority order and the hidden sets are nested as the width shrinks', () => {
    let previous: TopbarActionId[] = []
    for (let w = ALL.length * SLOT; w >= 0; w -= 3) {
      const hidden = hide(w).hidden
      const expected = TOPBAR_OVERFLOW_ORDER.slice(0, hidden.length)
      expect([...hidden].sort()).toEqual([...expected].sort())
      expect(hidden.length).toBeGreaterThanOrEqual(previous.length)
      for (const id of previous) expect(hidden).toContain(id)
      previous = hidden
    }
  })

  it('never lets the bar plus the `…` button exceed the budget (down to one slot)', () => {
    for (let w = SLOT; w <= ALL.length * SLOT + 40; w++) {
      const { visible, hidden } = hide(w)
      const slots = visible.length + (hidden.length > 0 ? 1 : 0)
      expect(slots * SLOT).toBeLessThanOrEqual(w)
    }
  })

  it('hides everything when not even the `…` button fits', () => {
    expect(hide(0).visible).toEqual([])
    expect(hide(0).hidden).toHaveLength(ALL.length)
  })

  it('skips an action that is not present, and the priority moves to the next one', () => {
    const present = ALL.filter((id) => id !== 'github-pulls')
    const plan = hide(present.length * SLOT - 1, present)
    expect(plan.hidden).toEqual(['editor', 'open-folder'])
  })

  it('has nothing to do with nothing present', () => {
    expect(hide(500, [])).toEqual({ visible: [], hidden: [] })
  })

  it('hysteresis: a hidden action comes back only with 8px to spare', () => {
    const edge = ALL.length * SLOT
    expect(hide(edge).hidden).toEqual([]) // no history: it fits, so it is all shown
    expect(hide(edge, ALL, 2).hidden).toHaveLength(2) // it was hidden: it stays hidden
    expect(hide(edge + TOPBAR_HYSTERESIS_PX - 1, ALL, 2).hidden).toHaveLength(2)
    expect(hide(edge + TOPBAR_HYSTERESIS_PX, ALL, 2).hidden).toEqual([])
  })

  it('hysteresis never hides more than the plain rule asks for', () => {
    for (let w = 0; w <= ALL.length * SLOT + 40; w++) {
      for (const prev of [0, 1, 2, 5, 12]) {
        const withHistory = hide(w, ALL, prev).hidden.length
        expect(withHistory).toBeGreaterThanOrEqual(hide(w).hidden.length)
        expect(withHistory).toBeLessThanOrEqual(Math.max(prev, hide(w).hidden.length))
      }
    }
  })

  it('does not oscillate: a width jittering around the boundary settles on one plan', () => {
    const edge = ALL.length * SLOT
    let prev = 0
    const seen: number[] = []
    for (const w of [edge - 2, edge + 3, edge - 1, edge + 5, edge - 4, edge + 2, edge - 1]) {
      prev = hide(w, ALL, prev).hidden.length
      seen.push(prev)
    }
    expect(new Set(seen).size).toBe(1)
  })
})

describe('clusterBudget', () => {
  it('leaves, for the cluster, what the toggle, bell, gaps, crumb, badges and the 96px title do not take', () => {
    // 1000 − 32 padding − 22 toggle − 26 bell − 36 (three 12px gaps) − 32 crumb − 0 badges − 96 title
    expect(clusterBudget({ headerWidth: 1000, paddingX: 32, hasCrumb: true, extrasWidth: 0 })).toBe(
      1000 - 32 - 22 - 26 - 36 - TOPBAR_CRUMB_MIN_PX - TOPBAR_MIN_TITLE_PX
    )
  })

  it('has no crumb and one gap fewer in the folder view', () => {
    expect(
      clusterBudget({ headerWidth: 1000, paddingX: 32, hasCrumb: false, extrasWidth: 0 })
    ).toBe(1000 - 32 - 22 - 26 - 24 - TOPBAR_MIN_TITLE_PX)
  })

  it('takes the badges after the title out of the budget', () => {
    const a = clusterBudget({ headerWidth: 800, paddingX: 32, hasCrumb: true, extrasWidth: 0 })
    const b = clusterBudget({ headerWidth: 800, paddingX: 32, hasCrumb: true, extrasWidth: 90 })
    expect(a - b).toBe(90)
  })

  it('AC-1: at any width, title floor + crumb + badges + the planned bar never exceed the header', () => {
    for (const extrasWidth of [0, 60, 150]) {
      // 272 = padding + toggle + bell + gaps + crumb + title floor + one slot (the `…` button): the floor.
      for (let headerWidth = 272 + extrasWidth; headerWidth <= 1400; headerWidth += 7) {
        const available = clusterBudget({ headerWidth, paddingX: 32, hasCrumb: true, extrasWidth })
        const { visible, hidden } = planTopbarOverflow({ present: ALL, available })
        const slots = visible.length + (hidden.length > 0 ? 1 : 0)
        const used =
          32 + 22 + 26 + 36 + TOPBAR_CRUMB_MIN_PX + TOPBAR_MIN_TITLE_PX + extrasWidth + slots * SLOT
        expect(used).toBeLessThanOrEqual(headerWidth)
      }
    }
  })
})
