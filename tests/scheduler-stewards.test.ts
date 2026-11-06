// @vitest-environment jsdom
/**
 * Campaign ch.5b (T609, AC-5b.1) — the Scheduler's Stewards section: stewards listed under their own
 * heading, read-only (no switch, no delete, no prompt edit, nothing selectable), each row naming its
 * mission, last wake and last action; a paused one says so.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '../src/renderer/src/i18n'
import SchedulerStewards from '../src/renderer/src/components/SchedulerStewards.vue'
import type { StewardSummary } from '../src/renderer/src/lib/steward-view'

const NOW = 10_000_000
const steward = (over: Partial<StewardSummary> = {}): StewardSummary => ({
  workerId: 'w1',
  missionId: 'mnt-0000000a',
  folder: '/repo',
  lastWakeAt: NOW - 4 * 60_000,
  lastAction: 'Rebased #317 onto main.',
  running: false,
  awaitingClose: false,
  ...over
})

function render(
  stewards: StewardSummary[],
  paused: Record<string, string> = {},
  showHint = false,
  collapsed = false
) {
  return mount(SchedulerStewards, {
    props: {
      stewards,
      nowMs: NOW,
      collapsed,
      titleFor: (id: string) => (id === 'mnt-0000000a' ? 'Ship the importer' : null),
      pausedFor: (id: string) => paused[id] ?? null,
      showHint
    },
    global: { plugins: [i18n] }
  })
}

describe('SchedulerStewards', () => {
  it('renders nothing when no mission has a steward', () => {
    expect(render([]).find('[data-test="scheduler-stewards"]').exists()).toBe(false)
  })

  it('lists each steward under a "Stewards" heading: mission, last wake, last action', () => {
    const w = render([steward()])
    expect(w.text()).toContain('Stewards')
    const row = w.get('[data-test="scheduler-steward-row"]')
    expect(row.get('[data-test="scheduler-steward-mission"]').text()).toBe('Ship the importer')
    expect(row.get('[data-test="scheduler-steward-last"]').text()).toBe(
      'Last wake 4m ago · Rebased #317 onto main.'
    )
  })

  it('is read-only: no switch, no input, nothing selectable — the header toggle is the only button', () => {
    const w = render([steward(), steward({ workerId: 'w2', missionId: 'mnt-0000000b' })])
    expect(w.findAll('button')).toHaveLength(1)
    expect(w.findAll('input, textarea, select, [role="switch"], [role="option"]')).toHaveLength(0)
    expect(w.findAll('[data-test="scheduler-steward-row"]')).toHaveLength(2)
  })

  it('before the first tick it says so instead of inventing a time', () => {
    const w = render([steward({ lastWakeAt: null, lastAction: null })])
    expect(w.get('[data-test="scheduler-steward-last"]').text()).toBe('No tick yet')
  })

  it('names the mission by its id when the mission is not open here', () => {
    const w = render([steward({ missionId: 'mnt-0000000c' })])
    expect(w.get('[data-test="scheduler-steward-mission"]').text()).toBe('Mission mnt-0000000c')
  })

  it('a running steward reads "Running"; a paused one reads "Paused" with the reason instead of its last action', () => {
    const running = render([steward({ running: true })])
    expect(running.get('[data-test="scheduler-steward-state"]').text()).toBe('Running')
    const paused = render([steward()], { 'mnt-0000000a': 'CI is flaky today' })
    expect(paused.get('[data-test="scheduler-steward-state"]').text()).toBe('Paused')
    expect(paused.get('[data-test="scheduler-steward-last"]').text()).toBe(
      'Paused — CI is flaky today'
    )
    expect(paused.get('[data-test="scheduler-steward-row"]').attributes('data-paused')).toBe('true')
  })

  it('the hint under the rows appears only when asked (no user worker in the list)', () => {
    expect(render([steward()]).find('[data-test="scheduler-stewards-hint"]').exists()).toBe(false)
    expect(
      render([steward()], {}, true).get('[data-test="scheduler-stewards-hint"]').text()
    ).toContain('belongs to its mission')
  })
})

describe('SchedulerStewards — collapsible block (T651)', () => {
  it('the header is a button with aria-expanded that reflects the collapsed prop', () => {
    const open = render([steward()]).get('[data-test="scheduler-stewards-toggle"]')
    expect(open.element.tagName).toBe('BUTTON')
    expect(open.attributes('aria-expanded')).toBe('true')
    const closed = render([steward()], {}, false, true).get(
      '[data-test="scheduler-stewards-toggle"]'
    )
    expect(closed.attributes('aria-expanded')).toBe('false')
  })

  it('collapsed: the header and its summary stay, the rows and hints are gone', () => {
    const w = render([steward({ running: true })], {}, true, true)
    expect(w.get('[data-test="scheduler-stewards-summary"]').text()).toBe('1 · 1 running')
    expect(w.find('[data-test="scheduler-stewards-rows"]').exists()).toBe(false)
    expect(w.find('[data-test="scheduler-steward-row"]').exists()).toBe(false)
    expect(w.find('[data-test="scheduler-stewards-hint"]').exists()).toBe(false)
  })

  it('the chevron rotates when collapsed', () => {
    const chev = (c: boolean) =>
      render([steward()], {}, false, c).get('[data-test="scheduler-stewards-toggle"] svg')
    expect(chev(true).classes()).toContain('-rotate-90')
    expect(chev(false).classes()).not.toContain('-rotate-90')
  })

  it('clicking the header asks the parent to toggle', async () => {
    const w = render([steward()])
    await w.get('[data-test="scheduler-stewards-toggle"]').trigger('click')
    expect(w.emitted('toggle')).toHaveLength(1)
  })

  it('open: the rows sit in a container capped by --sched-stewards-max-h that scrolls', () => {
    const rows = render([steward()]).get('[data-test="scheduler-stewards-rows"]')
    expect(rows.attributes('style')).toContain('max-height: var(--sched-stewards-max-h)')
    expect(rows.classes()).toContain('overflow-y-auto')
  })

  it('summary: "{n} · {r} running · {a} awaiting close", a zero part omitted, colours by part', () => {
    const many = [
      steward({ workerId: 'r', running: true }),
      steward({ workerId: 'a1', awaitingClose: true }),
      steward({ workerId: 'a2', awaitingClose: true }),
      steward({ workerId: 'i' })
    ]
    const w = render(many)
    expect(w.get('[data-test="scheduler-stewards-summary"]').text()).toBe(
      '4 · 1 running · 2 awaiting close'
    )
    expect(w.get('[data-part="running"]').classes()).toContain('text-accent')
    expect(w.get('[data-part="awaiting"]').classes()).toContain('text-text-2')
    const idle = render(Array.from({ length: 13 }, (_, i) => steward({ workerId: `w${i}` })))
    expect(idle.get('[data-test="scheduler-stewards-summary"]').text()).toBe('13')
  })

  it('a steward whose mission is delivered reads "Awaiting close" in text-text-3', () => {
    const w = render([steward({ awaitingClose: true })])
    const state = w.get('[data-test="scheduler-steward-state"]')
    expect(state.text()).toBe('Awaiting close')
    expect(state.classes()).toContain('text-text-3')
  })

  it('state word precedence: Paused > Running > Awaiting close', () => {
    const both = { running: true, awaitingClose: true }
    expect(
      render([steward(both)])
        .get('[data-test="scheduler-steward-state"]')
        .text()
    ).toBe('Running')
    expect(
      render([steward(both)], { 'mnt-0000000a': 'CI is flaky' })
        .get('[data-test="scheduler-steward-state"]')
        .text()
    ).toBe('Paused')
  })

  it('open with a steward awaiting close, the rows end with the close hint', () => {
    const w = render([steward({ awaitingClose: true })])
    expect(w.get('[data-test="scheduler-stewards-close-hint"]').text()).toBe(
      'Close a delivered mission to retire its steward.'
    )
    expect(render([steward()]).find('[data-test="scheduler-stewards-close-hint"]').exists()).toBe(
      false
    )
  })
})
