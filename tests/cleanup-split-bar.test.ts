// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupSplitBar from '../src/renderer/src/components/CleanupSplitBar.vue'
import { i18n } from '@renderer/i18n'
import type { GcModel } from '../src/renderer/src/lib/gc-model'
import type { CycleRecord } from '../src/main/gc/gc-wire'

const totals = (): GcModel['totals'] => ({
  corpse: { count: 12, bytes: 6_000_000_000 },
  decide: { count: 46, bytes: 20_000_000_000 },
  alive: { count: 19, bytes: 7_000_000_000 },
  orphanVolumes: { count: 3, bytes: 900_000_000 }
})

const mountBar = (over: Record<string, unknown> = {}) =>
  mount(CleanupSplitBar, {
    props: { totals: totals(), hasBytes: true, lastCycle: null, ...over },
    global: { plugins: [i18n] }
  })

describe('CleanupSplitBar', () => {
  it('draws three segments sized by bytes, each with a word', () => {
    const w = mountBar()
    const auto = w.get('[data-testid="split-auto"]')
    const needs = w.get('[data-testid="split-needsYou"]')
    expect(auto.attributes('style')).toContain('flex: 6000000000 1 0px')
    expect(needs.attributes('style')).toContain('flex: 20900000000 1 0px')
    expect(auto.text()).toContain('Cleaned automatically')
    expect(needs.text()).toContain('Needs you')
    expect(w.get('[data-testid="split-untouched"]').text()).toContain('Untouched')
  })

  it('needs-you counts Decide plus orphan volumes and is hatched', () => {
    const needs = mountBar().get('[data-testid="split-needsYou"]')
    expect(needs.text()).toContain('20.90 GB')
    expect(needs.html()).toContain('repeating-linear-gradient')
  })

  it('without byte sizes (Windows) it shows counts and shares the width', () => {
    const w = mountBar({ hasBytes: false })
    expect(w.get('[data-testid="split-auto"]').attributes('style')).toContain('flex: 1 1 0px')
    expect(w.get('[data-testid="split-auto"]').text()).toContain('12 items')
    expect(w.get('[data-testid="split-needsYou"]').text()).toContain('49 items')
  })

  it('leaves out a bucket with nothing in it', () => {
    const t = totals()
    t.corpse = { count: 0, bytes: 0 }
    expect(mountBar({ totals: t }).find('[data-testid="split-auto"]').exists()).toBe(false)
  })

  it('names the last cycle: what it cleaned and freed, or that it only reported', () => {
    const base = {
      at: Date.now() - 4 * 60_000,
      trigger: 'timer',
      mode: 'clean',
      found: 2,
      foundBytes: 900_000_000,
      cleaned: [
        { id: 'a', ok: true, haltedAt: null, freedBytes: 1 },
        { id: 'b', ok: false, haltedAt: 'trash', freedBytes: 0 }
      ],
      freedBytes: 400_000_000,
      deferred: 0,
      housekeeping: null,
      notified: false,
      jobId: null
    } as CycleRecord
    expect(mountBar({ lastCycle: base }).get('[data-testid="split-last-cycle"]').text()).toBe(
      'Last cycle 4m ago: cleaned 1, freed 400 MB'
    )
    const report = { ...base, mode: 'report' } as CycleRecord
    expect(mountBar({ lastCycle: report }).get('[data-testid="split-last-cycle"]').text()).toBe(
      'Last cycle 4m ago: found 2 corpses, 900 MB (report only)'
    )
  })
})
