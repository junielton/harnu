// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageBudgetRow from '../src/renderer/src/components/UsageBudgetRow.vue'
import type { DailyBudget } from '../src/renderer/src/components/daily-budget'

/** Echoes the key and its params so a test can assert on both without a real locale. */
const t = (key: string, params: Record<string, unknown> = {}): string =>
  `${key}:${JSON.stringify(params)}`

function mountRow(budget: Partial<DailyBudget>) {
  const full: DailyBudget = {
    state: 'on-track',
    spentPct: 9,
    budgetPct: 17,
    workingDaysLeft: 4,
    rebalancedPct: null,
    remainingDays: 3,
    ...budget
  }
  return mount(UsageBudgetRow, {
    props: { budget: full },
    global: { mocks: { $t: t }, stubs: { i18n: true } }
  })
}

describe('UsageBudgetRow', () => {
  it('renders spent over budget, both rounded', () => {
    const value = mountRow({ spentPct: 8.6, budgetPct: 17.2 }).get('[data-budget-value]').text()
    expect(value).toContain('usage.dailyBudgetValue')
    expect(value).toContain('"spent":9')
    expect(value).toContain('"budget":17')
  })

  it('sizes the bar by spend ÷ budget, not by the raw percentage', () => {
    const style = mountRow({ spentPct: 9, budgetPct: 18 })
      .get('[data-budget-fill]')
      .attributes('style')
    expect(style).toContain('width: 50%')
  })

  it('clamps the bar at 100% when over', () => {
    const style = mountRow({ state: 'over', spentPct: 34, budgetPct: 17 })
      .get('[data-budget-fill]')
      .attributes('style')
    expect(style).toContain('width: 100%')
  })

  it('fills the bar when the week was already spent before the day began', () => {
    const style = mountRow({ state: 'over', spentPct: 0, budgetPct: 0, rebalancedPct: null })
      .get('[data-budget-fill]')
      .attributes('style')
    expect(style).toContain('width: 100%')
  })

  it('colors the bar green / accent / red by state', () => {
    expect(mountRow({ state: 'on-track' }).get('[data-budget-fill]').classes()).toContain(
      'bg-green'
    )
    expect(mountRow({ state: 'near-limit' }).get('[data-budget-fill]').classes()).toContain(
      'bg-accent'
    )
    expect(mountRow({ state: 'over' }).get('[data-budget-fill]').classes()).toContain('bg-red')
  })

  it('keeps the bar geometry of the window meters — 3px track, fully rounded', () => {
    const w = mountRow({ state: 'on-track' })
    const track = w.get('[data-budget-track]')
    expect(track.attributes('style')).toContain('height: 3px')
    expect(track.classes()).toContain('rounded-full')
    expect(track.classes()).toContain('bg-surface-2')
    expect(w.get('[data-budget-fill]').classes()).toContain('rounded-full')
  })

  it('says on track below the near-limit threshold', () => {
    expect(mountRow({ state: 'on-track' }).get('[data-budget-sub]').text()).toContain(
      'usage.dailyBudgetOnTrack'
    )
  })

  it('reports what is left when near the limit', () => {
    const w = mountRow({ state: 'near-limit', spentPct: 14, budgetPct: 17 })
    expect(w.get('[data-budget-sub]').text()).toContain('usage.dailyBudgetLeft')
    expect(w.get('[data-budget-sub]').text()).toContain('"pct":3')
  })

  it('differences what is left from the figures it displays, so the row cannot contradict itself', () => {
    // 13.4 / 16.6 renders as "13% / 17%"; a remainder rounded on its own would
    // read "3% left today" against a displayed gap of 4.
    const w = mountRow({ state: 'near-limit', spentPct: 13.4, budgetPct: 16.6 })
    expect(w.get('[data-budget-value]').text()).toContain('"spent":13')
    expect(w.get('[data-budget-value]').text()).toContain('"budget":17')
    expect(w.get('[data-budget-sub]').text()).toContain('"pct":4')
  })

  it('quotes the rebalanced per-day figure when over', () => {
    const w = mountRow({
      state: 'over',
      spentPct: 21,
      budgetPct: 17,
      rebalancedPct: 12,
      remainingDays: 3
    })
    expect(w.get('[data-budget-sub]').text()).toContain('usage.dailyBudgetOver')
    expect(w.get('[data-budget-sub]').text()).toContain('"days":3')
    expect(w.get('[data-budget-sub]').text()).toContain('"pct":12')
  })

  it('omits the damage line when nothing is left to rebalance', () => {
    const w = mountRow({ state: 'over', rebalancedPct: null, remainingDays: 0 })
    expect(w.get('[data-budget-sub]').text()).toContain('usage.dailyBudgetOverSpent')
  })

  it('renders no track at all on a day off, and shows only what was spent', () => {
    const w = mountRow({ state: 'day-off', spentPct: 4, budgetPct: 0 })
    expect(w.find('[data-budget-track]').exists()).toBe(false)
    expect(w.find('[data-budget-fill]').exists()).toBe(false)
    expect(w.get('[data-budget-value]').text()).toBe('4%')
    expect(w.get('[data-budget-sub]').text()).toContain('usage.dailyBudgetDayOff')
  })

  it('renders nothing when unavailable', () => {
    const w = mountRow({ state: 'unavailable' })
    expect(w.find('[data-budget-value]').exists()).toBe(false)
    expect(w.find('[data-budget-sub]').exists()).toBe(false)
  })
})
