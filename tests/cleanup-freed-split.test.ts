// @vitest-environment jsdom
// AC-C4 (renderer side): the hero chip, the success toast and the last-cycle line all say the SAME
// "X freed now · Y in the trash" for one clean, and say only "X freed now" when nothing was trashed.

import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@renderer/i18n'
import CleanupHeroButton from '../src/renderer/src/components/CleanupHeroButton.vue'
import CleanupSplitBar from '../src/renderer/src/components/CleanupSplitBar.vue'
import { freedText } from '../src/renderer/src/lib/gc-freed'
import { doneSummary } from '../src/renderer/src/lib/gc-jobs'
import type { GcModel } from '../src/renderer/src/lib/gc-model'
import type { CycleRecord, GcJobDone } from '../src/main/gc/gc-wire'

const MB = 1_000_000
const GB = 1_000_000_000
const t = i18n.global.t as unknown as (key: string, named: Record<string, unknown>) => string

const FREED = 400 * MB
const TRASHED = 2 * GB
const EXPECT = '400 MB freed now · 2.00 GB in the trash'

const totals = (): GcModel['totals'] => ({
  ready: { count: 1, bytes: 1 },
  review: { count: 0, bytes: 0 },
  'in-use': { count: 0, bytes: 0 },
  orphanVolumes: { count: 0, bytes: 0 },
  docker: { count: 0, bytes: 0 }
})

const cycle = (trashedBytes: number): CycleRecord =>
  ({
    at: Date.now() - 4 * 60_000,
    trigger: 'timer',
    mode: 'clean',
    found: 1,
    foundBytes: GB,
    cleaned: [{ id: 'a', ok: true, haltedAt: null, freedBytes: FREED }],
    freedBytes: FREED,
    trashedBytes,
    archivesExpired: 0,
    deferred: 0,
    housekeeping: null,
    notified: true,
    jobId: null
  }) as CycleRecord

describe('freedText', () => {
  it('says both numbers when something went to the trash', () => {
    expect(freedText(t, FREED, TRASHED)).toBe(EXPECT)
  })

  it('says only what was freed when nothing did, never "0 B in the trash"', () => {
    expect(freedText(t, FREED, 0)).toBe('400 MB freed now')
    expect(freedText(t, FREED, undefined)).toBe('400 MB freed now')
  })
})

describe('the three surfaces agree', () => {
  it('hero chip', () => {
    const w = mount(CleanupHeroButton, {
      props: {
        hero: { kind: 'running', done: 1, total: 2, freedBytes: FREED, trashedBytes: TRASHED }
      },
      global: { plugins: [i18n] }
    })
    expect(w.get('[data-testid="hero-chip"]').text()).toBe(`Cleaning 1/2 · ${EXPECT}`)
  })

  it('last-cycle line', () => {
    const w = mount(CleanupSplitBar, {
      props: { totals: totals(), hasBytes: true, lastCycle: cycle(TRASHED) },
      global: { plugins: [i18n] }
    })
    expect(w.get('[data-testid="split-last-cycle"]').text()).toBe(
      `Last cycle 4m ago: cleaned 1, ${EXPECT}`
    )
  })

  it('last-cycle line of a record from before the split (no trashed figure) still reads', () => {
    const old = { ...cycle(0) } as Partial<CycleRecord>
    delete old.trashedBytes
    const w = mount(CleanupSplitBar, {
      props: { totals: totals(), hasBytes: true, lastCycle: old as CycleRecord },
      global: { plugins: [i18n] }
    })
    expect(w.get('[data-testid="split-last-cycle"]').text()).toBe(
      'Last cycle 4m ago: cleaned 1, 400 MB freed now'
    )
  })

  it('toast title, from the same job result', () => {
    const d: GcJobDone = {
      jobId: 'j',
      kind: 'manual',
      done: 1,
      total: 1,
      freedBytes: FREED,
      trashedBytes: TRASHED,
      results: [{ id: 'a', ok: true, haltedAt: null, freedBytes: FREED, trashedBytes: TRASHED }],
      error: null
    }
    const s = doneSummary(d)
    expect(s.trashedBytes).toBe(TRASHED)
    const title = i18n.global.t('cleanup.gc.toast.success', {
      freed: freedText(t, s.freedBytes, s.trashedBytes),
      count: s.cleaned
    })
    expect(title).toBe(`${EXPECT} · 1 ready item cleaned`)
  })
})
