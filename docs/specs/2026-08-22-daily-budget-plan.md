# Daily Budget Row Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a derived "Today" row to Capy's Plan usage popover that shows how much of the day's share of the weekly allowance has been spent, and alerts when it is nearly or fully gone.

**Architecture:** A pure math module in the renderer (`daily-budget.ts`) computes the budget from three inputs: the live 7d window (already in the usage store), a per-day baseline (a new narrow IPC over the existing usage-history rollups), and a user-configured working-day set (a new field on the already-persisted `UsageHistoryPrefs`). A dedicated `UsageBudgetRow.vue` renders it below a hairline; a pure threshold detector wired the way `usage-reset-notify` already is fires the alert.

**Tech Stack:** Electron + Vue 3 + Pinia + Tailwind v4, vitest (`vitest run`), `@vue/test-utils` with jsdom.

**Spec:** `docs/superpowers/specs/2026-08-22-daily-budget-design.md`

## Global Constraints

- **English only** in code, comments, docs, commits, test names. The sole exception is `src/renderer/src/i18n/pt-BR.json`.
- **i18n parity is compile-enforced:** every key added to `en.json` MUST be added to `pt-BR.json` in the same commit or `vue-tsc` fails (`MessageSchema = typeof en`).
- **No raw colors or off-system sizes.** Tailwind utilities backed by `themes.css` only. Bars are `height: 3px`, `border-radius: 999px`, track `bg-surface-2`. Row type is 11px; the panel micro-label is 10.5px uppercase `letter-spacing: 0.06em`.
- **`design.md` is edited BEFORE the Vue it describes**, in the same commit (§6 Plan usage).
- **`CHANGELOG.md` entry is part of done**, under a `## 2026-08-22` heading, `### Added`.
- **`docs/user/` must be updated** — this ships a new setting and a new notification.
- **`docs/capy-features.md` must NOT be touched** — no MCP verb, no ACK shape, no grant semantics. Nothing here is agent-facing.
- Thresholds for this row are **80 / 100** (not the 80/95 of `barClass`).
- Run `npm run typecheck` and `npm run lint` before any commit; `.claude/skills/local-ci` runs the full gate set.

---

### Task 1: Pure budget math

**Files:**

- Create: `src/renderer/src/components/daily-budget.ts`
- Test: `tests/daily-budget.test.ts`

**Deviation from spec (intentional):** the spec placed this in `src/main/daily-budget-core.ts`. It lives in the renderer instead, next to `usage-format.ts` (the established home for this panel's pure helpers), because main never needs the math — main only supplies the baseline number. This keeps one consumer and one location.

**Interfaces:**

- Consumes: nothing.
- Produces: `DailyBudget`, `DailyBudgetInput`, `computeDailyBudget(input: DailyBudgetInput): DailyBudget`, `countWorkingDays(fromMs: number, untilMs: number, workingDays: readonly number[]): number`.

- [ ] **Step 1: Write the failing test**

Create `tests/daily-budget.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
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

  it('is unavailable when no working days remain', () => {
    expect(computeDailyBudget({ ...base, workingDays: [] }).state).toBe('unavailable')
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daily-budget.test.ts`
Expected: FAIL — cannot resolve `../src/renderer/src/components/daily-budget`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/components/daily-budget.ts`:

```ts
/**
 * Pure daily-budget math for the Plan usage panel (daily-budget spec).
 *
 * Splits what is left of the weekly (7d) allowance across the working days
 * that remain before it resets. The budget FREEZES at the start of the day:
 * the denominator is fixed for the whole day, so the bar can actually reach
 * 100% and "over" exists as a state. Were it recomputed on every spend, the
 * allowance would grow as the day went on and an overrun could never happen.
 *
 * No Vue, no i18n, no store access — the store wires real data to it.
 */

export type DailyBudgetState = 'on-track' | 'near-limit' | 'over' | 'day-off' | 'unavailable'

export interface DailyBudget {
  state: DailyBudgetState
  /** Points of the 7d allowance spent since the day began. */
  spentPct: number
  /** Today's frozen allowance in points; 0 when day-off or unavailable. */
  budgetPct: number
  /** Working days from today (inclusive) to the reset. */
  workingDaysLeft: number
  /** Per-day allowance the days AFTER today inherit — only set when `over`. */
  rebalancedPct: number | null
  /** Working days after today — the count the damage line quotes. */
  remainingDays: number
}

export interface DailyBudgetInput {
  /** Live account-wide 7d usage, or null when no window is known. */
  sevenDayPct: number | null
  /** When the 7d window resets, or null when unknown. */
  resetsAtMs: number | null
  /** 7d usage at the moment today began, or null when there's no history. */
  baselinePct: number | null
  /** Working weekdays, `0` = Sunday … `6` = Saturday. */
  workingDays: readonly number[]
  nowMs: number
}

/** Spend is at or above this share of the budget → `near-limit`. */
export const NEAR_LIMIT_RATIO = 0.8

const UNAVAILABLE: DailyBudget = {
  state: 'unavailable',
  spentPct: 0,
  budgetPct: 0,
  workingDaysLeft: 0,
  rebalancedPct: null,
  remainingDays: 0
}

/**
 * Working days whose LOCAL start falls in `[fromMs's day, untilMs)`. The day
 * containing `fromMs` counts (you can still spend the rest of it), and so does
 * the reset day itself — the old window is spendable right up to the reset, and
 * counting it makes the per-day budget smaller, which errs toward caution.
 *
 * A 7d window spans at most 8 local days; the walk is capped at 10 so a bad
 * `untilMs` can never spin.
 */
export function countWorkingDays(
  fromMs: number,
  untilMs: number,
  workingDays: readonly number[]
): number {
  if (untilMs <= fromMs) return 0
  const set = new Set(workingDays)
  const cursor = new Date(fromMs)
  cursor.setHours(0, 0, 0, 0)
  let count = 0
  for (let i = 0; i < 10 && cursor.getTime() < untilMs; i++) {
    if (set.has(cursor.getDay())) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

export function computeDailyBudget(input: DailyBudgetInput): DailyBudget {
  const { sevenDayPct, resetsAtMs, baselinePct, workingDays, nowMs } = input
  if (sevenDayPct === null || resetsAtMs === null || baselinePct === null) return UNAVAILABLE

  // A stale poll or clock skew can report less than the baseline; never negative.
  const spentPct = Math.max(0, sevenDayPct - baselinePct)
  const workingDaysLeft = countWorkingDays(nowMs, resetsAtMs, workingDays)

  if (!new Set(workingDays).has(new Date(nowMs).getDay())) {
    return {
      state: 'day-off',
      spentPct,
      budgetPct: 0,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays: 0
    }
  }
  if (workingDaysLeft === 0) return UNAVAILABLE

  const budgetPct = Math.max(0, (100 - baselinePct) / workingDaysLeft)
  const remainingDays = workingDaysLeft - 1

  // Allowance already exhausted before the day started: over, but there is no
  // meaningful per-day figure left to quote.
  if (budgetPct === 0) {
    return {
      state: 'over',
      spentPct,
      budgetPct,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays
    }
  }

  const ratio = spentPct / budgetPct
  if (ratio < NEAR_LIMIT_RATIO) {
    return {
      state: 'on-track',
      spentPct,
      budgetPct,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays
    }
  }
  if (ratio < 1) {
    return {
      state: 'near-limit',
      spentPct,
      budgetPct,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays
    }
  }
  return {
    state: 'over',
    spentPct,
    budgetPct,
    workingDaysLeft,
    rebalancedPct: remainingDays > 0 ? Math.max(0, (100 - sevenDayPct) / remainingDays) : null,
    remainingDays
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daily-budget.test.ts`
Expected: PASS — 14 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/renderer/src/components/daily-budget.ts tests/daily-budget.test.ts
git commit -m "feat(usage): pure daily-budget math"
```

---

### Task 2: Working-day preference + baseline IPC

**Files:**

- Modify: `src/main/usage-history.ts` (prefs interface + defaults ~line 46-60; sample reader ~line 266; IPC block ~line 361)
- Modify: `src/preload/index.ts` (api object ~line 1420-1438)
- Test: `tests/daily-budget-baseline.test.ts`

**Interfaces:**

- Consumes: `buildRollups`, `localDayKey`, `UsageSample`, `WindowRecord` from `./usage-history-core` (already imported by `usage-history.ts`).
- Produces: `UsageHistoryPrefs.workingDays: number[]`; `DailyBudgetBaseline { baselinePct: number | null; dayKey: string }`; IPC `usageHistory:dailyBudget`; `window.api.usageHistoryDailyBudget()`; exported pure helper `pickBaseline(rollups, dayKey)`.

- [ ] **Step 1: Write the failing test**

Create `tests/daily-budget-baseline.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { pickBaseline } from '../src/main/usage-history-core'
import type { DailyRollup } from '../src/main/usage-history-core'

function rollup(day: string, sevenDayPeak: number | null, reset = false): DailyRollup {
  return {
    day,
    sampleCount: 1,
    fiveHourPeak: null,
    sevenDayPeak,
    costPeakUsd: 0,
    sessionPeak: 0,
    weeklyReset: reset ? { atMs: 0, prePct: 90, postPct: 3 } : null
  }
}

describe('pickBaseline', () => {
  it("uses the previous day's 7d peak — a 7d window is monotonic, so it is the value at midnight", () => {
    const rollups = [rollup('2026-08-22', 20), rollup('2026-08-23', 32), rollup('2026-08-24', 36)]
    expect(pickBaseline(rollups, '2026-08-24')).toBe(32)
  })

  it('skips gaps and uses the most recent prior day', () => {
    const rollups = [rollup('2026-08-20', 41), rollup('2026-08-24', 46)]
    expect(pickBaseline(rollups, '2026-08-24')).toBe(41)
  })

  it('is 0 when the weekly window reset earlier today', () => {
    const rollups = [rollup('2026-08-23', 88), rollup('2026-08-24', 12, true)]
    expect(pickBaseline(rollups, '2026-08-24')).toBe(0)
  })

  it('is null when there is no prior day at all', () => {
    expect(pickBaseline([rollup('2026-08-24', 12)], '2026-08-24')).toBeNull()
  })

  it('is null when the prior day never reported a 7d figure', () => {
    const rollups = [rollup('2026-08-23', null), rollup('2026-08-24', 12)]
    expect(pickBaseline(rollups, '2026-08-24')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daily-budget-baseline.test.ts`
Expected: FAIL — `pickBaseline` is not exported from `usage-history-core`.

- [ ] **Step 3: Add the pure picker**

Append to `src/main/usage-history-core.ts`:

```ts
/**
 * The 7d percentage at the moment a given local day began (daily-budget spec).
 *
 * A 7d window only ever grows within its own period, so the PREVIOUS day's peak
 * is exactly the value at midnight. When the window reset earlier today the
 * baseline is 0 instead: the new window started empty, and everything spent
 * before the reset was charged to the previous week.
 *
 * @param rollups Ascending by day, as {@link buildRollups} returns.
 * @param dayKey The local day to compute the baseline for.
 */
export function pickBaseline(rollups: readonly DailyRollup[], dayKey: string): number | null {
  const today = rollups.find((r) => r.day === dayKey)
  if (today?.weeklyReset) return 0
  let prior: DailyRollup | null = null
  for (const r of rollups) {
    if (r.day < dayKey) prior = r
  }
  return prior?.sevenDayPeak ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daily-budget-baseline.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the `workingDays` preference**

In `src/main/usage-history.ts`, add to the `UsageHistoryPrefs` interface (after `retentionDays`):

```ts
  /**
   * Weekdays the user normally works, `0` = Sunday … `6` = Saturday. The daily
   * budget splits the weekly allowance across these days only. Default Mon–Sat.
   */
  workingDays: number[]
```

And to `DEFAULT_PREFS`:

```ts
workingDays: [1, 2, 3, 4, 5, 6]
```

- [ ] **Step 6: Add the recent-sample reader and the memoized baseline**

In `src/main/usage-history.ts`, immediately after `readAllSamples` (ends ~line 288), add:

```ts
/**
 * The last `utcDays` sample files only. Sample files rotate on UTC days while
 * rollups group by LOCAL days, so 3 files always cover local-yesterday and
 * local-today at any offset. Reading three files instead of the whole archive
 * is what makes the daily-budget baseline cheap enough for the footer panel.
 */
async function readRecentSamples(utcDays: number): Promise<UsageSample[]> {
  try {
    const files = (await readdir(samplesDir()))
      .filter((f) => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .slice(-utcDays)
    const out: UsageSample[] = []
    for (const f of files) {
      const raw = await readFile(join(samplesDir(), f), 'utf8').catch(() => '')
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          out.push(JSON.parse(t) as UsageSample)
        } catch {
          /* skip a torn line */
        }
      }
    }
    return out
  } catch {
    return []
  }
}

/** 7d usage at the start of the current local day, plus the day it applies to. */
export interface DailyBudgetBaseline {
  baselinePct: number | null
  dayKey: string
}

/** Memoized per local day — recomputed on the first call after a day rollover. */
let baselineMemo: DailyBudgetBaseline | null = null

async function computeDailyBudgetBaseline(): Promise<DailyBudgetBaseline> {
  const dayKey = localDayKey(Date.now())
  if (baselineMemo?.dayKey === dayKey) return baselineMemo
  const [samples, windows] = await Promise.all([readRecentSamples(3), readAllWindows()])
  const rollups = buildRollups(samples, localDayKey, windows)
  baselineMemo = { baselinePct: pickBaseline(rollups, dayKey), dayKey }
  return baselineMemo
}
```

Add `pickBaseline` to the existing import block from `./usage-history-core`.

- [ ] **Step 7: Register the IPC handler**

In `registerUsageHistoryHandlers()`, after the `usageHistory:summary` handler:

```ts
ipcMain.handle('usageHistory:dailyBudget', async (): Promise<DailyBudgetBaseline> => {
  await ensureLoaded()
  return computeDailyBudgetBaseline()
})
```

- [ ] **Step 8: Expose it in preload**

In `src/preload/index.ts`, after `usageHistorySummary` (~line 1421):

```ts
  usageHistoryDailyBudget: (): Promise<DailyBudgetBaseline> =>
    ipcRenderer.invoke('usageHistory:dailyBudget'),
```

Add `DailyBudgetBaseline` to the existing `import type { … } from '../main/usage-history'` block and re-export it alongside the other usage-history types.

- [ ] **Step 9: Typecheck and commit**

```bash
npm run typecheck
npx vitest run tests/daily-budget-baseline.test.ts tests/usage-history-core.test.ts
git add src/main/usage-history.ts src/main/usage-history-core.ts src/preload/index.ts tests/daily-budget-baseline.test.ts
git commit -m "feat(usage): working-day preference and daily-budget baseline IPC"
```

---

### Task 3: Budget store

**Files:**

- Create: `src/renderer/src/stores/daily-budget.ts`
- Test: `tests/daily-budget-store.test.ts`

**Interfaces:**

- Consumes: `computeDailyBudget`, `DailyBudget` (Task 1); `window.api.usageHistoryDailyBudget`, `window.api.usageHistoryGetPrefs` (Task 2); `useUsageStore().rateLimits` (existing).
- Produces: `useDailyBudgetStore()` with `budget: ComputedRef<DailyBudget>`, `workingDays: Ref<number[]>`, `dayKey: ComputedRef<string>`, `init(): Promise<void>`, `refreshBaseline(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/daily-budget-store.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDailyBudgetStore } from '../src/renderer/src/stores/daily-budget'
import { useUsageStore } from '../src/renderer/src/stores/usage'

const DAY = 86_400_000

/** The store's own local day key — the baseline is only trusted for today. */
function todayKey(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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
    usage.snapshot = {
      available: true,
      buckets: [
        { key: 'week_all', usedPercent: 36, resetsAtMs: Date.now() + 3 * DAY, resetsAtText: '' }
      ]
    } as never
    expect(budget.budget.spentPct).toBeCloseTo(4)
    expect(budget.budget.state).not.toBe('unavailable')
  })

  it('reads the working days from prefs', async () => {
    const budget = useDailyBudgetStore()
    await budget.init()
    expect(budget.workingDays).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('falls back to Mon–Sat when prefs cannot be read', async () => {
    ;(window.api.usageHistoryGetPrefs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('x'))
    const budget = useDailyBudgetStore()
    await budget.init()
    expect(budget.workingDays).toEqual([1, 2, 3, 4, 5, 6])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daily-budget-store.test.ts`
Expected: FAIL — cannot resolve `stores/daily-budget`.

- [ ] **Step 3: Write the store**

Create `src/renderer/src/stores/daily-budget.ts`:

```ts
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useNow } from '@vueuse/core'
import { useUsageStore } from './usage'
import { computeDailyBudget, type DailyBudget } from '../components/daily-budget'

/** Mon–Sat, matching `DEFAULT_PREFS.workingDays` in `src/main/usage-history.ts`. */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5, 6]

/**
 * Daily-budget store (daily-budget spec). Joins three sources the app already
 * has: the live 7d window from the usage store, the start-of-day baseline from
 * the narrow `usageHistory:dailyBudget` IPC, and the user's working-day set.
 *
 * The baseline is fetched once per local day — it is by definition constant
 * within a day — and re-fetched when the day key rolls over.
 */
export const useDailyBudgetStore = defineStore('dailyBudget', () => {
  const usage = useUsageStore()
  const baselinePct = ref<number | null>(null)
  const workingDays = ref<number[]>(DEFAULT_WORKING_DAYS)
  const baselineDayKey = ref<string | null>(null)

  // One tick a minute is enough: it re-evaluates the day rollover and keeps the
  // working-days walk honest without churning on every telemetry push.
  const now = useNow({ interval: 60_000 })

  const dayKey = computed(() => {
    const d = now.value
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })

  async function refreshBaseline(): Promise<void> {
    try {
      const b = await window.api.usageHistoryDailyBudget()
      baselinePct.value = b.baselinePct
      baselineDayKey.value = b.dayKey
    } catch {
      baselinePct.value = null
    }
  }

  async function init(): Promise<void> {
    try {
      const prefs = await window.api.usageHistoryGetPrefs()
      if (Array.isArray(prefs.workingDays)) workingDays.value = prefs.workingDays
    } catch {
      /* keep the Mon–Sat default */
    }
    await refreshBaseline()
  }

  const budget = computed<DailyBudget>(() => {
    // A day rollover invalidates the cached baseline; re-fetch, and stay
    // `unavailable` until it lands rather than reporting yesterday's number.
    if (baselineDayKey.value !== null && baselineDayKey.value !== dayKey.value) {
      void refreshBaseline()
    }
    const w = usage.rateLimits?.sevenDay ?? null
    return computeDailyBudget({
      sevenDayPct: w?.usedPercent ?? null,
      resetsAtMs: w?.resetsAtMs ?? null,
      baselinePct: baselineDayKey.value === dayKey.value ? baselinePct.value : null,
      workingDays: workingDays.value,
      nowMs: now.value.getTime()
    })
  })

  return { budget, workingDays, baselinePct, dayKey, init, refreshBaseline }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daily-budget-store.test.ts`
Expected: PASS — 4 tests.

The `todayKey()` helper in the test must stay in sync with the store's own `dayKey` computed: the store deliberately treats a baseline stamped with any other day as absent, so a mismatched mock would silently yield `unavailable` and make the test look like a store bug.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/renderer/src/stores/daily-budget.ts tests/daily-budget-store.test.ts
git commit -m "feat(usage): daily-budget store joining baseline, prefs and live 7d"
```

---

### Task 4: The row — design.md, i18n, component

**Files:**

- Modify: `design.md` (§6, "Plan usage (usage meter)" — after the threshold table, ~line 786)
- Modify: `src/renderer/src/i18n/en.json` (`usage` object)
- Modify: `src/renderer/src/i18n/pt-BR.json` (same keys)
- Create: `src/renderer/src/components/UsageBudgetRow.vue`
- Modify: `src/renderer/src/components/UsagePanel.vue`
- Test: `tests/usage-budget-row.test.ts`

**Deviation from spec (intentional):** the spec said "UsageMeter gains a budget variant". A separate `UsageBudgetRow.vue` is used instead. `UsageMeter` is consumed by three other call sites and `design.md` documents its anatomy precisely; adding a value-format mode, a state sub-line and a no-track mode would blur that contract. The new component reuses the same token classes, so the visual system is unchanged.

**Interfaces:**

- Consumes: `DailyBudget` (Task 1), `useDailyBudgetStore()` (Task 3).
- Produces: `UsageBudgetRow` with props `{ budget: DailyBudget }`; test hooks `[data-budget-fill]`, `[data-budget-value]`, `[data-budget-sub]`.

- [ ] **Step 1: Document it in design.md first**

In `design.md` §6, after the "Fill color by threshold" table of the Plan usage section, insert:

```markdown
**Daily budget row (`UsageBudgetRow`, daily-budget spec).** A fourth, DERIVED
row below the reported windows: what is left of the 7d allowance, split across
the user's configured working days. It is separated from the 5h/7d meters by a
`border-t --border` hairline — Anthropic's reported limits and Capy's own
arithmetic must not read as peers.

- Top line: label `Today` (`--text-3`, 11px) · value `{spent}% / {budget}%`
  (`--text-2`, 11px, `tabular-nums`), which becomes `--red` weight 600 when over.
- Bar: identical to `UsageMeter` (track `--surface-2`, 3px, radius 999px). Its
  width is `spent ÷ budget`, NOT the raw percentage.
- Bottom line (`--text-4`, 11px) carries state, not a countdown.

**Fill color by threshold** — measured against the day's budget, and
deliberately NOT the 80/95 ramp of the window meters. 100% of a daily budget is
a real event with a consequence, so it takes the red; a step at 95 would be noise.

| Spend / budget | Color      | Bottom line                               |
| -------------- | ---------- | ----------------------------------------- |
| `< 80%`        | `--green`  | `on track`                                |
| `80%–99%`      | `--accent` | `{n}% left today`                         |
| `≥ 100%`       | `--red`    | `over · next {n} days drop to {pct}%/day` |

**Day off.** On a weekday outside the working set the row renders label and
spent value with **no track at all** and the line `day off · not counted against
a budget`. Spending on a day off is a choice, not an overrun. The row is hidden
entirely when there is no 7d window, no history, or no working days left.
```

- [ ] **Step 2: Add the i18n keys to BOTH locales**

In `src/renderer/src/i18n/en.json`, inside the `usage` object:

```json
    "dailyBudget": "Today",
    "dailyBudgetValue": "{spent}% / {budget}%",
    "dailyBudgetOnTrack": "on track",
    "dailyBudgetLeft": "{pct}% left today",
    "dailyBudgetOver": "over · next {days} days drop to {pct}%/day",
    "dailyBudgetOverSpent": "over · nothing left this week",
    "dailyBudgetDayOff": "day off · not counted against a budget"
```

The `pt-BR.json` translations of these keys live in that file (same keys, Portuguese wording).

- [ ] **Step 3: Write the failing component test**

Create `tests/usage-budget-row.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageBudgetRow from '../src/renderer/src/components/UsageBudgetRow.vue'
import type { DailyBudget } from '../src/renderer/src/components/daily-budget'

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
    expect(
      mountRow({ spentPct: 8.6, budgetPct: 17.2 }).get('[data-budget-value]').text()
    ).toContain('"spent":9')
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

  it('colors the bar green / accent / red by state', () => {
    expect(mountRow({ state: 'on-track' }).get('[data-budget-fill]').classes()).toContain(
      'bg-green'
    )
    expect(mountRow({ state: 'near-limit' }).get('[data-budget-fill]').classes()).toContain(
      'bg-accent'
    )
    expect(mountRow({ state: 'over' }).get('[data-budget-fill]').classes()).toContain('bg-red')
  })

  it('reports what is left when near the limit', () => {
    const w = mountRow({ state: 'near-limit', spentPct: 14, budgetPct: 17 })
    expect(w.get('[data-budget-sub]').text()).toContain('usage.dailyBudgetLeft')
    expect(w.get('[data-budget-sub]').text()).toContain('"pct":3')
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

  it('renders no track at all on a day off', () => {
    const w = mountRow({ state: 'day-off', spentPct: 4, budgetPct: 0 })
    expect(w.find('[data-budget-fill]').exists()).toBe(false)
    expect(w.get('[data-budget-sub]').text()).toContain('usage.dailyBudgetDayOff')
  })

  it('renders nothing when unavailable', () => {
    expect(mountRow({ state: 'unavailable' }).find('[data-budget-value]').exists()).toBe(false)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/usage-budget-row.test.ts`
Expected: FAIL — cannot resolve `UsageBudgetRow.vue`.

- [ ] **Step 5: Write the component**

Create `src/renderer/src/components/UsageBudgetRow.vue`:

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { DailyBudget } from './daily-budget'

/**
 * The derived daily-budget row of the Plan usage panel (design.md §6, daily-budget
 * spec). Purely presentational: the store owns the math, this owns the bar, the
 * threshold color and the state line. The bar tracks spend ÷ BUDGET, not the raw
 * percentage, so it can reach 100% within a single day.
 */
const props = defineProps<{ budget: DailyBudget }>()

const showTrack = computed(
  () =>
    props.budget.state === 'on-track' ||
    props.budget.state === 'near-limit' ||
    props.budget.state === 'over'
)

const barPct = computed(() => {
  const { spentPct, budgetPct } = props.budget
  if (budgetPct <= 0) return 100
  return Math.min(100, Math.max(0, (spentPct / budgetPct) * 100))
})

const fillClass = computed(() => {
  if (props.budget.state === 'over') return 'bg-red'
  if (props.budget.state === 'near-limit') return 'bg-accent'
  return 'bg-green'
})

const valueParams = computed(() => ({
  spent: Math.round(props.budget.spentPct),
  budget: Math.round(props.budget.budgetPct)
}))

const subKey = computed(() => {
  switch (props.budget.state) {
    case 'day-off':
      return 'usage.dailyBudgetDayOff'
    case 'near-limit':
      return 'usage.dailyBudgetLeft'
    case 'over':
      return props.budget.rebalancedPct === null
        ? 'usage.dailyBudgetOverSpent'
        : 'usage.dailyBudgetOver'
    default:
      return 'usage.dailyBudgetOnTrack'
  }
})

const subParams = computed<Record<string, number>>(() => {
  if (props.budget.state === 'near-limit') {
    return { pct: Math.max(0, Math.round(props.budget.budgetPct - props.budget.spentPct)) }
  }
  if (props.budget.state === 'over' && props.budget.rebalancedPct !== null) {
    return { days: props.budget.remainingDays, pct: Math.round(props.budget.rebalancedPct) }
  }
  return {}
})
</script>

<template>
  <div v-if="budget.state !== 'unavailable'" class="flex flex-col" style="gap: 3px">
    <div class="flex items-center justify-between" style="font-size: 11px">
      <span class="truncate text-text-3">{{ $t('usage.dailyBudget') }}</span>
      <span
        data-budget-value
        class="tabular-nums"
        :class="budget.state === 'over' ? 'text-red' : 'text-text-2'"
        :style="budget.state === 'over' ? 'font-weight: 600' : undefined"
      >
        {{
          budget.state === 'day-off'
            ? Math.round(budget.spentPct) + '%'
            : $t('usage.dailyBudgetValue', valueParams)
        }}
      </span>
    </div>
    <div v-if="showTrack" class="overflow-hidden rounded-full bg-surface-2" style="height: 3px">
      <div
        data-budget-fill
        class="usage-fill h-full rounded-full"
        :class="fillClass"
        :style="{ width: barPct + '%' }"
      />
    </div>
    <span
      data-budget-sub
      class="tabular-nums"
      :class="budget.state === 'over' ? 'text-red' : 'text-text-4'"
      style="font-size: 11px"
      >{{ $t(subKey, subParams) }}</span
    >
  </div>
</template>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/usage-budget-row.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 7: Wire it into the panel**

In `src/renderer/src/components/UsagePanel.vue`, add to the script block:

```ts
import UsageBudgetRow from './UsageBudgetRow.vue'
import { useDailyBudgetStore } from '../stores/daily-budget'

const dailyBudget = useDailyBudgetStore()
```

In the template, between the closing `</div>` of the meters list and the `updatedLine`/`fleetLine` block, insert:

```html
<div
  v-if="!usage.loading && dailyBudget.budget.state !== 'unavailable'"
  class="border-t border-border"
  style="margin-top: 8px; padding-top: 8px"
>
  <UsageBudgetRow :budget="dailyBudget.budget" />
</div>
```

Call `dailyBudget.init()` wherever `usage.init()` is already called (`src/renderer/src/App.vue`).

- [ ] **Step 8: Verify the whole suite, then commit**

```bash
npm run typecheck
npm run lint
npx vitest run
git add design.md src/renderer/src/i18n/en.json src/renderer/src/i18n/pt-BR.json \
  src/renderer/src/components/UsageBudgetRow.vue src/renderer/src/components/UsagePanel.vue \
  src/renderer/src/App.vue tests/usage-budget-row.test.ts
git commit -m "feat(usage): daily-budget row in the Plan usage popover"
```

---

### Task 5: Working-days setting

**Files:**

- Modify: `src/renderer/src/components/UsageHistoryPane.vue` (config section, ~line 735-798)
- Modify: `src/renderer/src/i18n/en.json` + `pt-BR.json` (`usageHistory.config`)
- Test: `tests/usage-working-days.test.ts`

**Interfaces:**

- Consumes: `setPrefs(patch: Partial<UsageHistoryPrefs>)` (already in the pane), `UsageHistoryPrefs.workingDays` (Task 2), `countWorkingDays` (Task 1).
- Produces: no new exports; test hook `[data-working-day="<n>"]`.

- [ ] **Step 1: Add the i18n keys to BOTH locales**

`en.json`, inside `usageHistory.config`:

```json
      "workingDays": "Daily budget",
      "workingDaysHint": "Days you normally work. The weekly allowance is split across the ones still ahead.",
      "workingDaysCount": "{days} working days → today's budget {pct}%",
      "weekday0": "Sun",
      "weekday1": "Mon",
      "weekday2": "Tue",
      "weekday3": "Wed",
      "weekday4": "Thu",
      "weekday5": "Fri",
      "weekday6": "Sat"
```

The `pt-BR.json` translations of these keys live in that file (same keys, Portuguese wording).

- [ ] **Step 2: Write the failing test**

Create `tests/usage-working-days.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { toggleWorkingDay } from '../src/renderer/src/components/daily-budget'

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
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/usage-working-days.test.ts`
Expected: FAIL — `toggleWorkingDay` is not exported.

- [ ] **Step 4: Add the helper**

Append to `src/renderer/src/components/daily-budget.ts`:

```ts
/**
 * Toggle one weekday in the working set, kept sorted so the persisted value is
 * stable regardless of click order. Clearing every day is allowed: it turns the
 * daily budget off rather than being an error state.
 */
export function toggleWorkingDay(days: readonly number[], day: number): number[] {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day]
  return [...next].sort((a, b) => a - b)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/usage-working-days.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 6: Add the control to the settings pane**

In `UsageHistoryPane.vue` script, add:

```ts
import { toggleWorkingDay, countWorkingDays } from './daily-budget'
import { useUsageStore } from '../stores/usage'

const usage = useUsageStore()
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

/**
 * The currently-selected working days. `prefs` is `computed<… | null>` in this
 * pane, so every read must be null-safe even though the surrounding section is
 * rendered under a `v-if`.
 */
const workingDays = computed<number[]>(() => prefs.value?.workingDays ?? [])

/** Preview of today's allowance for the currently-selected days. */
const workingDaysPreview = computed(() => {
  const days = workingDays.value
  const w = usage.rateLimits?.sevenDay
  const left = w?.resetsAtMs ? countWorkingDays(Date.now(), w.resetsAtMs, days) : days.length
  const remaining = 100 - (w?.usedPercent ?? 0)
  return { days: days.length, pct: left > 0 ? Math.round(remaining / left) : 0 }
})
```

In the template, after the Retention block:

```html
<!-- Daily budget: which weekdays count -->
<div style="margin-top: 12px">
  <div class="text-text-2" style="font-size: 12px">{{ $t('usageHistory.config.workingDays') }}</div>
  <SettingHint>{{ $t('usageHistory.config.workingDaysHint') }}</SettingHint>
  <div class="flex" style="gap: 5px; margin-top: 9px">
    <button
      v-for="d in WEEKDAY_ORDER"
      :key="d"
      type="button"
      :data-working-day="d"
      :aria-pressed="workingDays.includes(d)"
      class="border"
      :class="
                workingDays.includes(d)
                  ? 'bg-accent-soft border-accent-line text-text'
                  : 'border-border-2 text-text-3'
              "
      style="width: 38px; height: 28px; border-radius: 5px; font-size: 11px"
      @click="setPrefs({ workingDays: toggleWorkingDay(workingDays, d) })"
    >
      {{ $t('usageHistory.config.weekday' + d) }}
    </button>
  </div>
  <div class="text-text-2 tabular-nums" style="font-size: 11.5px; margin-top: 11px">
    {{ $t('usageHistory.config.workingDaysCount', workingDaysPreview) }}
  </div>
</div>
```

- [ ] **Step 7: Verify and commit**

```bash
npm run typecheck
npm run lint
npx vitest run
git add src/renderer/src/components/UsageHistoryPane.vue src/renderer/src/components/daily-budget.ts \
  src/renderer/src/i18n/en.json src/renderer/src/i18n/pt-BR.json tests/usage-working-days.test.ts
git commit -m "feat(usage): working-days control in usage settings"
```

---

### Task 6: Threshold alert

**Files:**

- Create: `src/renderer/src/stores/daily-budget-notify.ts`
- Modify: `src/renderer/src/stores/session-notify.ts` (`NotifyPrefs` ~line 42, `DEFAULT_NOTIFY_PREFS` ~line 70)
- Modify: `src/renderer/src/stores/sessions.ts` (next to `checkUsageResetNotification`, ~line 3478)
- Modify: `src/renderer/src/components/SettingsDialog.vue` (notification toggles)
- Modify: `src/renderer/src/i18n/en.json` + `pt-BR.json`
- Test: `tests/daily-budget-notify.test.ts`

**Interfaces:**

- Consumes: `DailyBudget` (Task 1), `dispatchNotification` + `notifyPrefs` + `windowFocused` (existing in `sessions.ts`), `persistedRef` from `./persisted`.
- Produces: `shouldNotifyDailyBudget(...): 80 | 100 | null`; `NotifyPrefs.dailyBudget: boolean`; `checkDailyBudgetNotification(budget, dayKey)` on the sessions store.

- [ ] **Step 1: Write the failing test**

Create `tests/daily-budget-notify.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { shouldNotifyDailyBudget } from '../src/renderer/src/stores/daily-budget-notify'
import type { DailyBudget } from '../src/renderer/src/components/daily-budget'

function budget(state: DailyBudget['state'], spentPct: number, budgetPct = 17): DailyBudget {
  return { state, spentPct, budgetPct, workingDaysLeft: 4, rebalancedPct: null, remainingDays: 3 }
}

describe('shouldNotifyDailyBudget', () => {
  it('fires at 80% of the budget', () => {
    expect(shouldNotifyDailyBudget(budget('near-limit', 14), 'd1', null)).toBe(80)
  })

  it('fires at 100% of the budget', () => {
    expect(shouldNotifyDailyBudget(budget('over', 18), 'd1', null)).toBe(100)
  })

  it('does not fire twice for the same threshold on the same day', () => {
    expect(
      shouldNotifyDailyBudget(budget('near-limit', 14), 'd1', { day: 'd1', threshold: 80 })
    ).toBeNull()
  })

  it('still escalates from 80 to 100 on the same day', () => {
    expect(shouldNotifyDailyBudget(budget('over', 18), 'd1', { day: 'd1', threshold: 80 })).toBe(
      100
    )
  })

  it('never fires below 80%', () => {
    expect(shouldNotifyDailyBudget(budget('on-track', 9), 'd1', null)).toBeNull()
  })

  it('re-arms on a new day', () => {
    expect(
      shouldNotifyDailyBudget(budget('near-limit', 14), 'd2', { day: 'd1', threshold: 100 })
    ).toBe(80)
  })

  it('never fires on a day off or when unavailable', () => {
    expect(shouldNotifyDailyBudget(budget('day-off', 40), 'd1', null)).toBeNull()
    expect(shouldNotifyDailyBudget(budget('unavailable', 40), 'd1', null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daily-budget-notify.test.ts`
Expected: FAIL — cannot resolve `stores/daily-budget-notify`.

- [ ] **Step 3: Write the pure detector**

Create `src/renderer/src/stores/daily-budget-notify.ts`:

```ts
import type { DailyBudget } from '../components/daily-budget'

/**
 * Pure threshold detection for the daily-budget alert (daily-budget spec), the
 * same shape as `usage-reset-notify.ts`: the truth table lives here, the store
 * only wires real data to it.
 *
 * Fires at most twice a day — once crossing 80% of the day's budget (still
 * correctable) and once crossing 100% (the overrun). The caller persists the
 * returned threshold against the day key so an app restart mid-day cannot
 * refire, while a new day re-arms both steps.
 */
export type BudgetThreshold = 80 | 100

export interface BudgetNotifyMark {
  day: string
  threshold: BudgetThreshold
}

export function shouldNotifyDailyBudget(
  budget: DailyBudget,
  dayKey: string,
  last: BudgetNotifyMark | null
): BudgetThreshold | null {
  if (budget.state !== 'near-limit' && budget.state !== 'over') return null
  if (budget.budgetPct <= 0) return null
  const reached: BudgetThreshold = budget.state === 'over' ? 100 : 80
  const alreadyOnThisDay = last && last.day === dayKey ? last.threshold : 0
  return reached > alreadyOnThisDay ? reached : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daily-budget-notify.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Add the preference**

In `src/renderer/src/stores/session-notify.ts`, add to `NotifyPrefs` after `usageReset`:

```ts
/**
 * Notify when the daily budget crosses 80% / 100% (daily-budget spec).
 * Default ON — unlike `usageReset` this fires at most twice a day, and the
 * alert is the point of the feature rather than an ambient status ping.
 */
dailyBudget: boolean
```

And to `DEFAULT_NOTIFY_PREFS`:

```ts
dailyBudget: true
```

Update the doc comment above `DEFAULT_NOTIFY_PREFS` to read: `/** Opt-out defaults — everything on, except usageReset (opt-in, see its doc comment). */` → keep as-is; `dailyBudget` is on, so the sentence stays true.

- [ ] **Step 6: Wire it in the sessions store**

In `src/renderer/src/stores/sessions.ts`, next to the existing `lastNotifiedUsageResetMs` declaration, add:

```ts
const lastBudgetNotify = persistedRef<BudgetNotifyMark | null>('om2tab.budget-notify', null)
```

After `checkUsageResetNotification`, add:

```ts
/**
 * Notify once per threshold per day when the daily budget crosses 80% / 100%
 * (daily-budget spec). Standalone and directly callable, like
 * `checkUsageResetNotification`, so it is testable without `init()`'s full
 * subscription surface; `init()` wires a `watch()` on the budget store.
 */
function checkDailyBudgetNotification(budget: DailyBudget, dayKey: string): void {
  const threshold = shouldNotifyDailyBudget(budget, dayKey, lastBudgetNotify.value)
  if (threshold === null) return
  lastBudgetNotify.value = { day: dayKey, threshold }
  if (!notifyPrefs.value.enabled || !notifyPrefs.value.dailyBudget) return
  dispatchNotification({
    title: i18n.global.t('notifications.dailyBudget.title'),
    body:
      threshold === 100
        ? i18n.global.t('notifications.dailyBudget.bodyOver', {
            spent: Math.round(budget.spentPct),
            budget: Math.round(budget.budgetPct),
            days: budget.remainingDays,
            pct: Math.round(budget.rebalancedPct ?? 0)
          })
        : i18n.global.t('notifications.dailyBudget.bodyNear', {
            pct: Math.max(0, Math.round(budget.budgetPct - budget.spentPct))
          }),
    channel: windowFocused.value ? 'toast' : 'os',
    sound: notifyPrefs.value.sound,
    sessionId: '',
    toastKind: threshold === 100 ? 'warning' : 'info'
  })
}
```

Export `checkDailyBudgetNotification` from the store's return object, and in `init()` add:

```ts
const budgetStore = useDailyBudgetStore()
watch(
  () => budgetStore.budget,
  (b) => checkDailyBudgetNotification(b, budgetStore.dayKey)
)
```

`toastKind` accepts `'info' | 'success' | 'warning' | 'danger'` (`stores/notify-dispatch.ts:21`), so `'warning'` is valid as written.

- [ ] **Step 7: Add the notification strings to BOTH locales**

`en.json`, inside `notifications`:

```json
    "dailyBudget": {
      "title": "Daily budget",
      "bodyNear": "{pct}% left of today's budget.",
      "bodyOver": "{spent}% of today's {budget}% used. The next {days} working days drop to {pct}%/day."
    }
```

The `pt-BR.json` translations of these keys live in that file (same keys, Portuguese wording).

- [ ] **Step 8: Add the settings toggle**

In `SettingsDialog.vue`, next to the existing `usageReset` toggle, add the same row bound to `dailyBudget`, with label key `settings.notifications.dailyBudget` and description key `settings.notifications.dailyBudgetDescription` — the namespace the existing `usageReset` toggle already uses (`SettingsDialog.vue:1536-1546`). There is no `settings.notify.*` namespace in this repo. Add both keys to `en.json` and The `pt-BR.json` translations of these keys live in that file (same keys, Portuguese wording).

The `pt-BR.json` translations of these keys live in that file (same keys, Portuguese wording).

- [ ] **Step 9: Verify and commit**

```bash
npm run typecheck
npm run lint
npx vitest run
git add src/renderer/src/stores/daily-budget-notify.ts src/renderer/src/stores/session-notify.ts \
  src/renderer/src/stores/sessions.ts src/renderer/src/components/SettingsDialog.vue \
  src/renderer/src/i18n/en.json src/renderer/src/i18n/pt-BR.json tests/daily-budget-notify.test.ts
git commit -m "feat(usage): daily-budget threshold notification"
```

---

### Task 7: Repo contracts and full gate

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `docs/user/usage.md` (the row and what it means)
- Modify: `docs/user/settings.md` (the working-days control and the alert toggle)

- [ ] **Step 1: Read the two user-doc pages**

Read `docs/user/usage.md` and `docs/user/settings.md` in full before editing, so the addition matches their existing voice, heading depth and level of detail. Extend those two pages — do not create a new one.

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md`, under a `## 2026-08-22` heading:

```markdown
### Added

- **Daily budget in Plan usage.** The popover now shows a `Today` row: what is
  left of the weekly limit divided across the days you actually work, so you can
  see at a glance how much you can still spend today. Set your working days in
  Settings → Usage. Capy notifies at 80% and 100% of the day's budget, and when
  you go over it tells you what the remaining days drop to.
```

- [ ] **Step 3: Update the user docs**

In `docs/user/usage.md`, document: what the `Today` row means; that the budget is
fixed for the day and why; that going over is never blocked but does shrink the
following days; and that a day off shows spend without a budget.

In `docs/user/settings.md`, document: the working-days control under Settings →
Usage (default Mon–Sat), the fact that unticking every day turns the row off, and
the daily-budget alert toggle (on by default, fires at most twice a day).

Confirm every claim against the code before writing it — never document behavior
this plan specified but the implementation ended up changing.

- [ ] **Step 4: Run the full gate**

Run: `/local-ci`
Expected: format:check, i18n parity, CHANGELOG / self-awareness / user-docs gates, typecheck, lint and `test:coverage` all pass.

The self-awareness gate must pass **without** touching `docs/capy-features.md` — this change touches neither `tool-catalog.ts` nor `capy-features.ts`, so the gate does not apply.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/user
git commit -m "docs: daily budget in changelog and user docs"
```

---

## Manual verification

Automated tests cannot prove the row looks right in the real app. After Task 7:

1. `npm run dev`, open the Plan usage popover, confirm the `Today` row renders below a hairline with the same 3px bar as the meters above it.
2. Compare against `docs/superpowers/specs/2026-08-22-daily-budget-mockup.png`.
3. In Settings → Usage, untick every weekday — the row must disappear, not error.
4. Set today as a non-working day — the row must show the spent value with no bar.
5. Switch themes (at least one light theme) and confirm no raw colors leak.
