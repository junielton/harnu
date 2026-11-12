// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SystemMonitorStalls from '../src/renderer/src/components/SystemMonitorStalls.vue'
import {
  formatBusyPct,
  formatStallMs,
  offenderTitle,
  stallCountClass,
  totalStalls
} from '../src/renderer/src/components/system-monitor-format'
import { i18n } from '@renderer/i18n'
import type { StallsSample } from '../src/preload'

const sample: StallsSample = {
  main: {
    busyPct: 37.4,
    busyApprox: false,
    over50: 5,
    over100: 3,
    over250: 1,
    offenders: [
      {
        owner: 'timer:sweep (index.js:120)',
        ownerKind: 'timer',
        count: 4,
        totalMs: 1500,
        worstMs: 842
      },
      {
        owner: 'sampled:x',
        ownerKind: 'unattributed',
        count: 1,
        totalMs: 90,
        worstMs: 90,
        frames: ['locate index.js:3']
      }
    ]
  },
  renderer: { busyPct: 12, busyApprox: true, over50: 0, over100: 0, over250: 0, offenders: [] }
}

const mountIt = (stalls: StallsSample | null, sampled = true) =>
  mount(SystemMonitorStalls, { props: { stalls, sampled }, global: { plugins: [i18n] } })

describe('format helpers', () => {
  it('renders an unmeasured thread as a dash and a lower bound with a tilde', () => {
    expect(formatBusyPct(null, false)).toBe('—')
    expect(formatBusyPct(37.4, false)).toBe('37%')
    expect(formatBusyPct(11.6, true)).toBe('~12%')
    expect(formatBusyPct(0, false)).toBe('0%')
  })
  it('formats durations, counter colours, totals and tooltips', () => {
    expect(formatStallMs(842)).toBe('842 ms')
    expect(formatStallMs(1234)).toBe('1.2 s')
    expect(stallCountClass(50, 0)).toBe('text-text-3')
    expect(stallCountClass(100, 2)).toBe('text-warning')
    expect(stallCountClass(250, 1)).toBe('text-red')
    expect(totalStalls(sample)).toBe(5)
    expect(totalStalls(null)).toBe(0)
    expect(offenderTitle(sample.main.offenders[1])).toBe('sampled:x\nlocate index.js:3')
    expect(offenderTitle(sample.main.offenders[0])).toBe('timer:sweep (index.js:120)')
  })
})

describe('SystemMonitorStalls', () => {
  it('shows both threads with busy, the three counters and the offenders by name', () => {
    const w = mountIt(sample)
    expect(w.get('[data-testid="stalls-summary"]').text()).toBe(
      '5 stalls over 50 ms in the last hour'
    )
    const main = w.get('[data-testid="stalls-main"]')
    expect(main.get('[data-testid="stalls-busy"]').text()).toBe('37%')
    expect(main.get('[data-testid="stalls-over50"]').text()).toBe('5')
    expect(main.get('[data-testid="stalls-over250"]').classes()).toContain('text-red')
    const rows = main.findAll('[data-testid="stalls-offender"]')
    expect(rows[0].text()).toContain('timer:sweep (index.js:120)')
    expect(rows[0].text()).toContain('×4')
    expect(rows[0].text()).toContain('842 ms')
    expect(rows[1].text()).toContain('unattributed')
    expect(rows[1].get('span').attributes('title')).toContain('locate index.js:3')
  })

  it('a quiet thread says so, and a lower-bound busy reading explains itself', () => {
    const w = mountIt(sample)
    const renderer = w.get('[data-testid="stalls-renderer"]')
    expect(renderer.find('[data-testid="stalls-none"]').exists()).toBe(true)
    expect(renderer.get('[data-testid="stalls-busy"]').text()).toBe('~12%')
    expect(renderer.get('[data-testid="stalls-busy"]').attributes('title')).toMatch(/lower bound/)
  })

  it('says the monitor is off when samples arrive without a stalls block', () => {
    const w = mountIt(null, true)
    expect(w.find('[data-testid="stalls-off"]').exists()).toBe(true)
    expect(w.find('[data-testid="stalls-main"]').exists()).toBe(false)
  })

  it('shows nothing but the title before the first sample', () => {
    const w = mountIt(null, false)
    expect(w.find('[data-testid="stalls-off"]').exists()).toBe(false)
    expect(w.find('[data-testid="stalls-summary"]').exists()).toBe(false)
  })

  it('an empty hour reads as no stalls', () => {
    const quiet: StallsSample = {
      main: { busyPct: 1, busyApprox: false, over50: 0, over100: 0, over250: 0, offenders: [] },
      renderer: {
        busyPct: null,
        busyApprox: false,
        over50: 0,
        over100: 0,
        over250: 0,
        offenders: []
      }
    }
    const w = mountIt(quiet)
    expect(w.get('[data-testid="stalls-summary"]').text()).toBe(
      'no stalls over 50 ms in the last hour'
    )
    expect(w.get('[data-testid="stalls-renderer"] [data-testid="stalls-busy"]').text()).toBe('—')
  })
})
