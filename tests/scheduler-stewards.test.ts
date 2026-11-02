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
  ...over
})

function render(stewards: StewardSummary[], paused: Record<string, string> = {}) {
  return mount(SchedulerStewards, {
    props: {
      stewards,
      nowMs: NOW,
      titleFor: (id: string) => (id === 'mnt-0000000a' ? 'Ship the importer' : null),
      pausedFor: (id: string) => paused[id] ?? null
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

  it('is read-only: no switch, no button, no input, nothing selectable', () => {
    const w = render([steward(), steward({ workerId: 'w2', missionId: 'mnt-0000000b' })])
    expect(
      w.findAll('button, input, textarea, select, [role="switch"], [role="option"]')
    ).toHaveLength(0)
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
})
