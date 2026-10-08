// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CleanupSplitBar from '../src/renderer/src/components/CleanupSplitBar.vue'
import { i18n } from '@renderer/i18n'
import type { GcModel } from '../src/renderer/src/lib/gc-model'
import type { CycleRecord } from '../src/main/gc/gc-wire'

const totals = (): GcModel['totals'] => ({
  ready: { count: 12, bytes: 6_000_000_000 },
  review: { count: 46, bytes: 20_000_000_000 },
  'in-use': { count: 19, bytes: 7_000_000_000 },
  orphanVolumes: { count: 3, bytes: 900_000_000 },
  docker: { count: 0, bytes: 0 }
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
    const needs = w.get('[data-testid="split-review"]')
    expect(auto.attributes('style')).toContain('flex: 6000000000 1 0px')
    expect(needs.attributes('style')).toContain('flex: 20900000000 1 0px')
    expect(auto.text()).toContain('Ready to clean')
    expect(needs.text()).toContain('Needs review')
    expect(w.get('[data-testid="split-untouched"]').text()).toContain('In use')
  })

  it('review counts Needs review plus orphan volumes and is hatched', () => {
    const needs = mountBar().get('[data-testid="split-review"]')
    expect(needs.text()).toContain('20.90 GB')
    expect(needs.html()).toContain('repeating-linear-gradient')
  })

  it('without byte sizes (Windows) it shows counts and shares the width', () => {
    const w = mountBar({ hasBytes: false })
    expect(w.get('[data-testid="split-auto"]').attributes('style')).toContain('flex: 1 1 0px')
    expect(w.get('[data-testid="split-auto"]').text()).toContain('12 items')
    expect(w.get('[data-testid="split-review"]').text()).toContain('49 items')
  })

  it('keeps Docker bytes out of the Ready segment and draws them as their own "Docker" segment', () => {
    const t = totals()
    t.docker = { count: 14, bytes: 5_000_000_000 }
    const w = mountBar({ totals: t })
    expect(w.get('[data-testid="split-auto"]').attributes('style')).toContain(
      'flex: 6000000000 1 0px'
    )
    const docker = w.get('[data-testid="split-docker"]')
    expect(docker.attributes('style')).toContain('flex: 5000000000 1 0px')
    expect(docker.text()).toContain('Docker (cleaned each cycle)')
    expect(docker.text()).toContain('5.00 GB')
    expect(docker.find('svg').exists()).toBe(true)
  })

  it('with zero ready worktrees and some Docker bytes, the Ready segment is gone and Docker stays', () => {
    const t = totals()
    t.ready = { count: 0, bytes: 0 }
    t.docker = { count: 14, bytes: 5_000_000_000 }
    const w = mountBar({ totals: t })
    expect(w.find('[data-testid="split-auto"]').exists()).toBe(false)
    expect(w.get('[data-testid="split-docker"]').exists()).toBe(true)
  })

  it('while a job runs the line under the bar reads "Cleaning now · N left", not the last cycle', () => {
    const cycle = {
      at: Date.now() - 4 * 60_000,
      trigger: 'timer',
      mode: 'clean',
      found: 2,
      foundBytes: 1,
      cleaned: [{ id: 'a', ok: true, haltedAt: null, freedBytes: 1 }],
      freedBytes: 1,
      deferred: 0,
      housekeeping: { buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] },
      notified: false,
      jobId: null
    } as CycleRecord
    const w = mountBar({ lastCycle: cycle, running: { left: 9 } })
    expect(w.get('[data-testid="split-running"]').text()).toBe('Cleaning now · 9 left')
    expect(w.find('[data-testid="split-last-cycle"]').exists()).toBe(false)
    const idle = mountBar({ lastCycle: cycle, running: null })
    expect(idle.find('[data-testid="split-running"]').exists()).toBe(false)
    expect(idle.find('[data-testid="split-last-cycle"]').exists()).toBe(true)
  })

  it('says "Cleaning now" alone when nothing is left to count', () => {
    const w = mountBar({ running: { left: 0 } })
    expect(w.get('[data-testid="split-running"]').text()).toBe('Cleaning now')
  })

  it('leaves out a bucket with nothing in it', () => {
    const t = totals()
    t.ready = { count: 0, bytes: 0 }
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
      'Last cycle 4m ago: found 2 ready items, 900 MB (report only)'
    )
  })
})
