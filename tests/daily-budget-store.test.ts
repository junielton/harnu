// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDailyBudgetStore } from '../src/renderer/src/stores/daily-budget'
import { useUsageStore } from '../src/renderer/src/stores/usage'
import type { UsageSnapshot } from '../src/main/usage-parse'

const DAY = 86_400_000

/** The store's own local day key — the baseline is only trusted for today. */
function todayKey(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * A `/usage` poll reporting a 7d window. The store reads the window through
 * `useUsageStore().rateLimits`, which merges the statusLine cockpit with this
 * snapshot via `mergeRateWindows` — so the fixture must be a real
 * {@link UsageSnapshot} (`weekAll` + `fetchedAtMs`), not a loose bucket list.
 */
function snapshotWith(usedPercent: number, resetsAtMs: number): UsageSnapshot {
  return {
    available: true,
    subscription: true,
    session: null,
    weekAll: { key: 'week_all', usedPercent, resetsAtText: '', resetsAtMs },
    perModel: [],
    fetchedAtMs: Date.now(),
    stale: false,
    status: 'ready'
  }
}

describe('daily-budget store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ;(globalThis as unknown as { window: { api: unknown } }).window = {
      api: {
        usageHistoryDailyBudget: vi.fn().mockResolvedValue({ baselinePct: 32, dayKey: todayKey() }),
        usageHistoryGetPrefs: vi.fn().mockResolvedValue({ workingDays: [1, 2, 3, 4, 5, 6] })
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('is unavailable before init supplies a baseline', () => {
    expect(useDailyBudgetStore().budget.state).toBe('unavailable')
  })

  it('combines the baseline with the live 7d window', async () => {
    const budget = useDailyBudgetStore()
    await budget.init()
    const usage = useUsageStore()
    usage.snapshot = snapshotWith(36, Date.now() + 3 * DAY)
    expect(budget.budget.spentPct).toBeCloseTo(4)
    expect(budget.budget.state).not.toBe('unavailable')
  })

  it('stays unavailable when the baseline is stamped with another day', async () => {
    ;(window.api.usageHistoryDailyBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
      baselinePct: 32,
      dayKey: '1999-01-01'
    })
    const budget = useDailyBudgetStore()
    await budget.init()
    useUsageStore().snapshot = snapshotWith(36, Date.now() + 3 * DAY)
    expect(budget.budget.state).toBe('unavailable')
  })

  it('is unavailable while there is no 7d window at all', async () => {
    const budget = useDailyBudgetStore()
    await budget.init()
    expect(budget.budget.state).toBe('unavailable')
  })

  it('reads the working days from prefs', async () => {
    ;(window.api.usageHistoryGetPrefs as ReturnType<typeof vi.fn>).mockResolvedValue({
      workingDays: [1, 3, 5]
    })
    const budget = useDailyBudgetStore()
    await budget.init()
    expect(budget.workingDays).toEqual([1, 3, 5])
  })

  it('falls back to Mon–Sat when prefs cannot be read', async () => {
    ;(window.api.usageHistoryGetPrefs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x'))
    const budget = useDailyBudgetStore()
    await budget.init()
    expect(budget.workingDays).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('keeps the baseline null when the IPC fails', async () => {
    ;(window.api.usageHistoryDailyBudget as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('x')
    )
    const budget = useDailyBudgetStore()
    await budget.init()
    useUsageStore().snapshot = snapshotWith(36, Date.now() + 3 * DAY)
    expect(budget.baselinePct).toBeNull()
    expect(budget.budget.state).toBe('unavailable')
  })

  it('re-fetches the baseline on demand', async () => {
    const budget = useDailyBudgetStore()
    await budget.init()
    await budget.refreshBaseline()
    expect(window.api.usageHistoryDailyBudget).toHaveBeenCalledTimes(2)
  })

  /**
   * The `budget` computed kicks off a baseline fetch when its own day key and
   * the fetched one disagree. That disagreement is PERMANENT when the IPC keeps
   * failing, and also when main and renderer genuinely disagree about the local
   * day (clock or timezone skew) — so without a once-per-day-key guard the
   * computed would re-fire the fetch on every telemetry push and every clock
   * tick, forever.
   */
  describe('does not loop on a baseline it can never reconcile', () => {
    it('re-reads the budget after a failed fetch without re-firing the IPC', async () => {
      ;(window.api.usageHistoryDailyBudget as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('x')
      )
      const budget = useDailyBudgetStore()
      await budget.init()
      const usage = useUsageStore()
      for (const pct of [36, 37, 38, 39]) {
        usage.snapshot = snapshotWith(pct, Date.now() + 3 * DAY)
        expect(budget.budget.state).toBe('unavailable')
      }
      expect(window.api.usageHistoryDailyBudget).toHaveBeenCalledTimes(1)
    })

    it('re-reads the budget after a day-key mismatch without re-firing the IPC', async () => {
      ;(window.api.usageHistoryDailyBudget as ReturnType<typeof vi.fn>).mockResolvedValue({
        baselinePct: 32,
        dayKey: '1999-01-01'
      })
      const budget = useDailyBudgetStore()
      await budget.init()
      const usage = useUsageStore()
      for (const pct of [36, 37, 38, 39]) {
        usage.snapshot = snapshotWith(pct, Date.now() + 3 * DAY)
        expect(budget.budget.state).toBe('unavailable')
      }
      expect(window.api.usageHistoryDailyBudget).toHaveBeenCalledTimes(1)
    })
  })
})
