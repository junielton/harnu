import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { computeDailyBudget, countWorkingDays } from '../src/renderer/src/components/daily-budget'

/** Mon–Sat, Sunday off — the default working set. */
const MON_SAT = [1, 2, 3, 4, 5, 6]
/** 2026-08-24 is a Monday. Noon local, so day-boundary walks are unambiguous. */
const MON_NOON = new Date(2026, 7, 24, 12, 0, 0).getTime()
const DAY = 86_400_000

describe('countWorkingDays', () => {
  it('counts today plus every working day whose start precedes the reset', () => {
    // Mon noon → Thu noon: Mon, Tue, Wed, Thu all start before the reset.
    expect(countWorkingDays(MON_NOON, MON_NOON + 3 * DAY, MON_SAT)).toBe(4)
  })

  it('skips days that are not in the working set', () => {
    // Sat noon → Tue noon spans Sat, Sun, Mon, Tue; Sunday is excluded.
    const satNoon = new Date(2026, 7, 29, 12, 0, 0).getTime()
    expect(countWorkingDays(satNoon, satNoon + 3 * DAY, MON_SAT)).toBe(3)
  })

  it('returns 0 when the reset is already in the past', () => {
    expect(countWorkingDays(MON_NOON, MON_NOON - DAY, MON_SAT)).toBe(0)
  })

  it('returns 0 when no weekday is selected', () => {
    expect(countWorkingDays(MON_NOON, MON_NOON + 3 * DAY, [])).toBe(0)
  })
})

describe('computeDailyBudget', () => {
  const base = {
    sevenDayPct: 36,
    resetsAtMs: MON_NOON + 3 * DAY,
    baselinePct: 32,
    workingDays: MON_SAT,
    nowMs: MON_NOON
  }

  it('splits the remaining allowance across the remaining working days', () => {
    const b = computeDailyBudget(base)
    // 100 − 32 = 68 left over 4 working days → 17% per day; 36 − 32 = 4 spent.
    expect(b.budgetPct).toBeCloseTo(17)
    expect(b.spentPct).toBeCloseTo(4)
    expect(b.workingDaysLeft).toBe(4)
    expect(b.state).toBe('on-track')
  })

  it('reports near-limit from 80% of the budget', () => {
    const b = computeDailyBudget({ ...base, sevenDayPct: 32 + 0.8 * 17 })
    expect(b.state).toBe('near-limit')
  })

  it('reports over at 100% of the budget and rebalances the remaining days', () => {
    const b = computeDailyBudget({ ...base, sevenDayPct: 53 })
    expect(b.state).toBe('over')
    expect(b.remainingDays).toBe(3)
    // 100 − 53 = 47 left over the 3 days after today.
    expect(b.rebalancedPct).toBeCloseTo(47 / 3)
  })

  it('keeps the budget frozen as spend rises through the day', () => {
    const early = computeDailyBudget({ ...base, sevenDayPct: 34 })
    const late = computeDailyBudget({ ...base, sevenDayPct: 48 })
    expect(late.budgetPct).toBeCloseTo(early.budgetPct)
  })

  it('is day-off when today is not a working day', () => {
    const sunNoon = new Date(2026, 7, 23, 12, 0, 0).getTime()
    const b = computeDailyBudget({ ...base, nowMs: sunNoon, resetsAtMs: sunNoon + 3 * DAY })
    expect(b.state).toBe('day-off')
    expect(b.spentPct).toBeCloseTo(4)
    expect(b.budgetPct).toBe(0)
  })

  it('is unavailable without a 7d window', () => {
    expect(computeDailyBudget({ ...base, sevenDayPct: null }).state).toBe('unavailable')
  })

  it('is unavailable without a baseline', () => {
    expect(computeDailyBudget({ ...base, baselinePct: null }).state).toBe('unavailable')
  })

  it('is unavailable without a known reset moment', () => {
    expect(computeDailyBudget({ ...base, resetsAtMs: null }).state).toBe('unavailable')
  })

  it('is unavailable when no working days remain', () => {
    expect(computeDailyBudget({ ...base, workingDays: [] }).state).toBe('unavailable')
  })

  it('is unavailable when the reset has already passed', () => {
    expect(computeDailyBudget({ ...base, resetsAtMs: MON_NOON - DAY }).state).toBe('unavailable')
  })

  it('clamps a negative spend to zero', () => {
    expect(computeDailyBudget({ ...base, sevenDayPct: 30 }).spentPct).toBe(0)
  })

  it('is over with no damage line when the weekly allowance is already gone', () => {
    const b = computeDailyBudget({ ...base, baselinePct: 100, sevenDayPct: 100 })
    expect(b.state).toBe('over')
    expect(b.budgetPct).toBe(0)
    expect(b.rebalancedPct).toBeNull()
  })
})

/**
 * The daily-budget i18n contract. This unit single-owns `en.json` / `pt-BR.json`
 * for the feature: the row, the settings control and the alert are built by
 * later units that only READ these keys, so they must all exist here, in BOTH
 * locales, before any of that UI is written. `ci-i18n-parity.test.ts` guards
 * that the two files agree; this guards that the feature's own keys are there
 * at all.
 */
describe('daily-budget i18n keys', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const i18nDir = join(here, '..', 'src/renderer/src/i18n')
  const locales = {
    'en.json': JSON.parse(readFileSync(join(i18nDir, 'en.json'), 'utf8')),
    'pt-BR.json': JSON.parse(readFileSync(join(i18nDir, 'pt-BR.json'), 'utf8'))
  } as Record<string, unknown>

  /** The daily-budget row in the Plan usage popover. */
  const ROW_KEYS = [
    'usage.dailyBudget',
    'usage.dailyBudgetValue',
    'usage.dailyBudgetOnTrack',
    'usage.dailyBudgetLeft',
    'usage.dailyBudgetOver',
    'usage.dailyBudgetOverSpent',
    'usage.dailyBudgetDayOff'
  ]
  /** The working-days control in Settings → Usage. */
  const SETTING_KEYS = [
    'usageHistory.config.workingDays',
    'usageHistory.config.workingDaysHint',
    'usageHistory.config.workingDaysCount',
    'usageHistory.config.weekday0',
    'usageHistory.config.weekday1',
    'usageHistory.config.weekday2',
    'usageHistory.config.weekday3',
    'usageHistory.config.weekday4',
    'usageHistory.config.weekday5',
    'usageHistory.config.weekday6'
  ]
  /** The 80% / 100% threshold alert and its opt-out toggle. */
  const ALERT_KEYS = [
    'notifications.dailyBudget.title',
    'notifications.dailyBudget.bodyNear',
    'notifications.dailyBudget.bodyOver',
    'settings.notifications.dailyBudget',
    'settings.notifications.dailyBudgetDescription'
  ]

  function lookup(root: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, part) => {
      if (node && typeof node === 'object' && part in node) {
        return (node as Record<string, unknown>)[part]
      }
      return undefined
    }, root)
  }

  for (const [file, messages] of Object.entries(locales)) {
    for (const key of [...ROW_KEYS, ...SETTING_KEYS, ...ALERT_KEYS]) {
      it(`${file} defines ${key}`, () => {
        const value = lookup(messages, key)
        expect(typeof value).toBe('string')
        expect(value).not.toBe('')
      })
    }
  }

  it('keeps the interpolation placeholders identical across locales', () => {
    const placeholders = (s: string): string[] => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort()
    for (const key of [...ROW_KEYS, ...SETTING_KEYS, ...ALERT_KEYS]) {
      expect({ key, params: placeholders(lookup(locales['en.json'], key) as string) }).toEqual({
        key,
        params: placeholders(lookup(locales['pt-BR.json'], key) as string)
      })
    }
  })
})
