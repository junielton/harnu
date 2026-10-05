// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import { toggleWorkingDay } from '../src/renderer/src/components/daily-budget'
import UsageHistoryPane from '../src/renderer/src/components/UsageHistoryPane.vue'
import { useUsageStore } from '../src/renderer/src/stores/usage'
import type { UsageHistoryPrefs, UsageHistorySummary } from '../src/preload'

/**
 * The working-days control writes its selection straight to
 * `UsageHistoryPrefs.workingDays`, so the toggle must produce a stable,
 * canonical array regardless of the order the user clicks the weekday chips.
 */
describe('toggleWorkingDay', () => {
  it('adds a day and keeps the set sorted', () => {
    expect(toggleWorkingDay([1, 2, 6], 4)).toEqual([1, 2, 4, 6])
  })

  it('removes a day that is already selected', () => {
    expect(toggleWorkingDay([1, 2, 3], 2)).toEqual([1, 3])
  })

  it('allows clearing every day — the feature simply switches off', () => {
    expect(toggleWorkingDay([3], 3)).toEqual([])
  })

  it('sorts Sunday (0) to the front, however it was clicked in', () => {
    expect(toggleWorkingDay([1, 2, 3, 4, 5, 6], 0)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('does not mutate the array it was given', () => {
    const days = [1, 2, 3]
    toggleWorkingDay(days, 5)
    expect(days).toEqual([1, 2, 3])
  })
})

/**
 * The control itself, in Settings → Usage. Mounted for real (rather than
 * asserted through an extracted helper) because the interesting parts are the
 * template's: the Mon→Sun order, `aria-pressed`, the selected styling, and the
 * live readout that reacts to the 7d window in the usage store.
 */
describe('working-days control (Settings → Usage)', () => {
  // Wed 2026-08-19 12:00 local. Local-constructed on purpose: `countWorkingDays`
  // walks LOCAL calendar days, so a UTC literal would shift the expected count
  // in half the world's timezones.
  const NOW = new Date(2026, 7, 19, 12, 0, 0)
  /** Sun 2026-08-23 10:00 local — the 7d window's reset. */
  const RESET = new Date(2026, 7, 23, 10, 0, 0)

  const setPrefs = vi.fn()

  function prefs(workingDays: number[]): UsageHistoryPrefs {
    return {
      enabled: true,
      currentTier: 'max20',
      chatModel: 'haiku',
      retentionDays: 90,
      workingDays
    }
  }

  function installWindow(workingDays: number[]): void {
    const summary = {
      prefs: prefs(workingDays),
      rollups: [{ day: '2026-08-19' }],
      windows: [],
      recentSamples: [],
      heatmap: { cells: [], hourBuckets: [] },
      tiers: [{ id: 'max20', label: 'Max 20x' }],
      quotaAsOf: '2026-08-19'
    } as unknown as UsageHistorySummary

    ;(window as unknown as { api: unknown }).api = {
      usageHistorySummary: vi.fn(async () => summary),
      usageCostSummary: vi.fn(async () => null),
      usageHistoryPlanFit: vi.fn(async () => null),
      usageHistoryRecommend: vi.fn(async () => null),
      usageHistorySetPrefs: setPrefs,
      telemetryGet: vi.fn(async () => ({ perSession: [], fleet: null })),
      onTelemetryUpdated: vi.fn(() => () => {})
    }
  }

  /** Seed the store's 7d window the way the statusLine cockpit would. */
  function seedSevenDay(usedPercent: number): void {
    useUsageStore().fleet = {
      totalCostUsd: 0,
      sessionCount: 0,
      fiveHour: null,
      sevenDay: { usedPercent, resetsAtMs: RESET.getTime() },
      fiveHourAtMs: null,
      sevenDayAtMs: NOW.getTime()
    }
  }

  async function mountPane(workingDays: number[], sevenDayPct?: number): Promise<VueWrapper> {
    installWindow(workingDays)
    const w = mount(UsageHistoryPane, {
      global: {
        plugins: [i18n],
        stubs: {
          UsageChart: true,
          UsageStatTiles: true,
          UsageNowStrip: true,
          UsageHeatmap: true,
          PlanFitCard: true,
          ToggleSwitch: true,
          SegmentedControl: true
        }
      }
    })
    if (sevenDayPct != null) seedSevenDay(sevenDayPct)
    await flushPromises()
    return w
  }

  const labels = (w: VueWrapper): string[] => w.findAll('[data-working-day]').map((b) => b.text())

  beforeEach(() => {
    setActivePinia(createPinia())
    setPrefs.mockReset()
    setPrefs.mockImplementation(async (patch: Partial<UsageHistoryPrefs>) => ({
      ...prefs([1, 2, 3, 4, 5, 6]),
      ...patch
    }))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
  })

  it('renders seven weekday buttons ordered Mon→Sun', async () => {
    const w = await mountPane([1, 2, 3, 4, 5, 6])
    expect(labels(w)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  })

  it('adds an unselected day through setPrefs', async () => {
    const w = await mountPane([1, 2, 3, 4, 5, 6])
    await w.get('[data-working-day="0"]').trigger('click')
    expect(setPrefs).toHaveBeenCalledWith({ workingDays: [0, 1, 2, 3, 4, 5, 6] })
  })

  it('removes a selected day through setPrefs', async () => {
    const w = await mountPane([1, 2, 3, 4, 5, 6])
    await w.get('[data-working-day="6"]').trigger('click')
    expect(setPrefs).toHaveBeenCalledWith({ workingDays: [1, 2, 3, 4, 5] })
  })

  it('reflects the selection in aria-pressed', async () => {
    const w = await mountPane([1, 2, 3, 4, 5])
    expect(w.get('[data-working-day="1"]').attributes('aria-pressed')).toBe('true')
    expect(w.get('[data-working-day="6"]').attributes('aria-pressed')).toBe('false')
    expect(w.get('[data-working-day="0"]').attributes('aria-pressed')).toBe('false')
  })

  it('marks selected days with the accent tokens and unselected ones without', async () => {
    const w = await mountPane([1, 2, 3, 4, 5])
    const on = w.get('[data-working-day="3"]').classes()
    expect(on).toContain('bg-accent-soft')
    expect(on).toContain('border-accent-line')
    const off = w.get('[data-working-day="0"]').classes()
    expect(off).not.toContain('bg-accent-soft')
    expect(off).toContain('border-border-2')
  })

  it('repaints aria-pressed after the preference round-trips', async () => {
    const w = await mountPane([1, 2, 3, 4, 5])
    setPrefs.mockResolvedValueOnce(prefs([1, 2, 3, 4, 5, 6]))
    await w.get('[data-working-day="6"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-working-day="6"]').attributes('aria-pressed')).toBe('true')
  })

  it('reads out the selected count and today’s budget from the live 7d window', async () => {
    // Mon–Sat selected, Wed noon → Wed/Thu/Fri/Sat are the 4 working days left
    // before Sunday's reset; 80 points remain, so 80 / 4 = 20% for today.
    const w = await mountPane([1, 2, 3, 4, 5, 6], 20)
    expect(w.get('[data-working-days-readout]').text()).toBe("6 working days → today's budget 20%")
  })

  it('shrinks today’s budget as working days are added to the window', async () => {
    // Sunday ticked too: the reset day itself counts, so 5 days share the 80
    // points and today's slice drops from 20% to 16%.
    const w = await mountPane([0, 1, 2, 3, 4, 5, 6], 20)
    expect(w.get('[data-working-days-readout]').text()).toBe("7 working days → today's budget 16%")
  })

  it('falls back to the size of the selected set when no 7d window is known', async () => {
    const w = await mountPane([1, 2, 3, 4, 5, 6])
    expect(w.get('[data-working-days-readout]').text()).toBe("6 working days → today's budget 17%")
  })

  it('renders every day unticked without erroring — the feature is simply off', async () => {
    const w = await mountPane([], 20)
    expect(w.findAll('[data-working-day]')).toHaveLength(7)
    expect(
      w.findAll('[data-working-day]').every((b) => b.attributes('aria-pressed') === 'false')
    ).toBe(true)
    expect(w.get('[data-working-days-readout]').text()).toBe("0 working days → today's budget 0%")
  })

  it('lets the last remaining day be unticked', async () => {
    const w = await mountPane([3])
    await w.get('[data-working-day="3"]').trigger('click')
    expect(setPrefs).toHaveBeenCalledWith({ workingDays: [] })
  })
})
