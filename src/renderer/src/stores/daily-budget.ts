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
  const workingDays = ref<number[]>([...DEFAULT_WORKING_DAYS])
  const baselineDayKey = ref<string | null>(null)

  // One tick a minute is enough: it re-evaluates the day rollover and keeps the
  // working-days walk honest without churning on every telemetry push.
  const now = useNow({ interval: 60_000 })

  const dayKey = computed(() => {
    const d = now.value
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  })

  /**
   * The day key a baseline fetch has already been issued for. Deliberately a
   * plain `let`, not a ref: the `budget` computed reads it to decide whether to
   * kick off a fetch, and a reactive read there would re-dirty the computed and
   * defeat the guard it exists to provide.
   */
  let requestedDayKey: string | null = null

  /** Fetch the baseline unconditionally. Exposed for an explicit re-read. */
  async function refreshBaseline(): Promise<void> {
    requestedDayKey = dayKey.value
    try {
      const b = await window.api.usageHistoryDailyBudget()
      baselinePct.value = b.baselinePct
      baselineDayKey.value = b.dayKey
    } catch {
      // Nothing trustworthy to show: drop the stamp too, so the row reads
      // `unavailable` rather than pairing a null baseline with a stale day.
      baselinePct.value = null
      baselineDayKey.value = null
    }
  }

  /**
   * Fetch the baseline for the current local day, AT MOST ONCE per day key.
   *
   * Without this guard the call below would re-fire on every dependency change
   * of the `budget` computed (a telemetry push, the 60s clock tick) for as long
   * as the store's day key and the fetched one disagree — which is permanent
   * both when the IPC keeps failing and when main and renderer genuinely
   * disagree about the local day (clock or timezone skew). One attempt per day
   * is enough: the day key advancing is what re-arms it.
   */
  function requestBaselineForToday(): void {
    if (requestedDayKey === dayKey.value) return
    void refreshBaseline()
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
    if (baselineDayKey.value !== dayKey.value) requestBaselineForToday()
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
