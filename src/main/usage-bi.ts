import { ipcMain } from 'electron'
import { buildUsageBiRawData, type UsageBiRawData } from './usage-cost'
import {
  buildDailyCostRollup,
  buildModelCostRollup,
  buildProjectCostRollup,
  localDayKey,
  type CostBucket,
  type ModelCostRollup,
  type ProjectCostRollup
} from './usage-cost-core'
import {
  buildDailyModelBreakdown,
  enrichWindows,
  projectWindowPeak,
  type SessionAnatomy,
  type EnrichedWindow
} from './usage-bi-core'
import { buildSummary as buildUsageHistorySummary, type UsageHistorySummary } from './usage-history'
import { WINDOW_DURATION_MS, type UsageHeatmap } from './usage-history-core'
import { getTelemetryPayload } from './statusline'

/**
 * `usageBi:snapshot` — the single IPC call the (upcoming) Usage BI dashboard
 * makes to get everything it renders in one JSON (T47 P6 S1, part C). Joins
 * three already-built sources with NO extra JSONL re-reads:
 *
 *  - the P5/P6 cost+anatomy engine (`usage-cost.ts` → {@link buildUsageBiRawData})
 *  - the usage-history engine (`usage-history.ts` → rollups/windows/heatmap)
 *  - live fleet telemetry (`statusline.ts` → {@link getTelemetryPayload})
 *
 * Fail-safe throughout: each block is built behind its own try/catch and
 * degrades to `null`/`[]` on failure — a broken source never breaks the
 * others, and the handler itself never throws to the renderer.
 */

export type UsageBiRange = '24h' | '7d' | '30d' | '60d' | '90d' | 'all'

export interface UsageBiRateWindowNow {
  usedPct: number | null
  resetsAt: number | null
  /** Linear projection of where this window lands at reset (see `projectWindowPeak`). */
  projectedAtResetPct: number | null
}

export interface UsageBiNow {
  fiveHour: UsageBiRateWindowNow
  sevenDay: UsageBiRateWindowNow
  liveSessions: number
  peakLiveToday: number | null
  /** Today's peak Σ-live-session-cost (the pre-P5 "notional" number, kept as a secondary metric). */
  notionalCostToday: number | null
  /** Today's REAL cost (P5 engine, deduped + priced), local day. */
  realCostToday: number | null
}

export interface UsageBiDay {
  day: string
  peak5hPct: number | null
  peak7dPct: number | null
  costUsd: number
  costByModel: Record<string, number>
  sessionsWorked: number
  dominantModel: string | null
  estimated: boolean
  /** A weekly (7d) cap reset that happened mid-day, if any. */
  weeklyReset: { atMs: number; prePct: number; postPct: number } | null
}

export interface UsageBiSnapshot {
  meta: { schemaVersion: 1; generatedAt: string; timezone: string; range: UsageBiRange }
  now: UsageBiNow | null
  days: UsageBiDay[]
  windows: EnrichedWindow[]
  models: ModelCostRollup[]
  projects: ProjectCostRollup[]
  /** Top 50 by cost, within `range`. */
  sessions: SessionAnatomy[]
  /**
   * Reused VERBATIM from `usage-history-core.ts` (not remapped/renamed) — the
   * exact shape `UsageHeatmap.vue` (already built for the Settings pane, T47
   * P4) already consumes, so the dashboard's "when you use it" card is a
   * direct reuse of that component with zero adapter glue.
   */
  heatmap: UsageHeatmap | null
}

const TOP_SESSIONS_CAP = 50

/** Epoch-ms lower bound for a range, or `null` for `'all'` (no cutoff). */
function sinceMsForRange(range: UsageBiRange, nowMs: number): number | null {
  switch (range) {
    case '24h':
      return nowMs - 24 * 3600_000
    case '7d':
      return nowMs - 7 * 24 * 3600_000
    case '30d':
      return nowMs - 30 * 24 * 3600_000
    case '60d':
      return nowMs - 60 * 24 * 3600_000
    case '90d':
      return nowMs - 90 * 24 * 3600_000
    case 'all':
      return null
    default:
      return null
  }
}

function safeTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

async function buildNow(nowMs: number, realCostToday: number | null): Promise<UsageBiNow | null> {
  try {
    const { fleet } = getTelemetryPayload()
    const history = await buildUsageHistorySummary()
    const today = localDayKey(nowMs)
    const todayRollup = history.rollups.find((r) => r.day === today) ?? null

    const fiveUsed = fleet.fiveHour?.usedPercent ?? null
    const fiveResets = fleet.fiveHour?.resetsAtMs ?? null
    const sevenUsed = fleet.sevenDay?.usedPercent ?? null
    const sevenResets = fleet.sevenDay?.resetsAtMs ?? null

    return {
      fiveHour: {
        usedPct: fiveUsed,
        resetsAt: fiveResets,
        projectedAtResetPct:
          fiveUsed !== null
            ? projectWindowPeak(fiveUsed, fiveResets, nowMs, WINDOW_DURATION_MS.fiveHour)
            : null
      },
      sevenDay: {
        usedPct: sevenUsed,
        resetsAt: sevenResets,
        projectedAtResetPct:
          sevenUsed !== null
            ? projectWindowPeak(sevenUsed, sevenResets, nowMs, WINDOW_DURATION_MS.sevenDay)
            : null
      },
      liveSessions: fleet.sessionCount,
      peakLiveToday: todayRollup?.sessionPeak ?? null,
      notionalCostToday: todayRollup?.costPeakUsd ?? null,
      realCostToday
    }
  } catch {
    return null
  }
}

function buildDaysBlock(
  filteredBuckets: readonly CostBucket[],
  history: UsageHistorySummary | null,
  cutoffDay: string | null
): UsageBiDay[] {
  try {
    const costByDay = new Map(buildDailyCostRollup(filteredBuckets).map((d) => [d.day, d]))
    const modelByDay = new Map(buildDailyModelBreakdown(filteredBuckets).map((d) => [d.day, d]))
    const historyByDay = new Map((history?.rollups ?? []).map((r) => [r.day, r]))

    const allDays = new Set<string>([...costByDay.keys(), ...historyByDay.keys()])
    return [...allDays]
      .filter((d) => !cutoffDay || d >= cutoffDay)
      .sort()
      .map((day) => {
        const cost = costByDay.get(day)
        const model = modelByDay.get(day)
        const hist = historyByDay.get(day)
        return {
          day,
          peak5hPct: hist?.fiveHourPeak ?? null,
          peak7dPct: hist?.sevenDayPeak ?? null,
          costUsd: cost?.costUsd ?? 0,
          costByModel: model?.costByModel ?? {},
          sessionsWorked: cost?.sessionsWorked ?? 0,
          dominantModel: model?.dominantModel ?? null,
          estimated: cost?.estimated ?? false,
          weeklyReset: hist?.weeklyReset ?? null
        }
      })
  } catch {
    return []
  }
}

function buildWindowsBlock(
  history: UsageHistorySummary | null,
  bi: UsageBiRawData,
  cutoffMs: number | null
): EnrichedWindow[] {
  try {
    const windows = (history?.windows ?? []).filter(
      (w) => cutoffMs === null || w.closedAtMs >= cutoffMs
    )
    const titleBySession = new Map(bi.sessionAnatomies.map((s) => [s.sessionId, s.title]))
    return enrichWindows(windows, bi.hourlyPoints, titleBySession)
  } catch {
    return []
  }
}

function buildSessionsBlock(
  sessionAnatomies: readonly SessionAnatomy[],
  cutoffMs: number | null
): SessionAnatomy[] {
  try {
    const filtered = sessionAnatomies.filter(
      (s) => cutoffMs === null || (s.endedAtMs !== null && s.endedAtMs >= cutoffMs)
    )
    return [...filtered].sort((a, b) => b.costUsd - a.costUsd).slice(0, TOP_SESSIONS_CAP)
  } catch {
    return []
  }
}

function buildHeatmapBlock(history: UsageHistorySummary | null): UsageHeatmap | null {
  try {
    return history ? history.heatmap : null
  } catch {
    return null
  }
}

/** Cost-model/project rollups within `range` — small try/catch wrappers so a
 *  malformed bucket never sinks the whole snapshot. */
function buildModelsBlock(filteredBuckets: readonly CostBucket[]): ModelCostRollup[] {
  try {
    return buildModelCostRollup(filteredBuckets)
  } catch {
    return []
  }
}
function buildProjectsBlock(filteredBuckets: readonly CostBucket[]): ProjectCostRollup[] {
  try {
    return buildProjectCostRollup(filteredBuckets)
  } catch {
    return []
  }
}

export async function buildUsageBiSnapshot(range: UsageBiRange): Promise<UsageBiSnapshot> {
  const nowMs = Date.now()
  const timezone = safeTimezone()

  let bi: UsageBiRawData
  try {
    bi = await buildUsageBiRawData()
  } catch {
    bi = { sessionAnatomies: [], mergedBuckets: [], hourlyPoints: [], fileCount: 0, scanMs: 0 }
  }

  let history: UsageHistorySummary | null
  try {
    history = await buildUsageHistorySummary()
  } catch {
    history = null
  }

  const cutoffMs = sinceMsForRange(range, nowMs)
  const cutoffDay = cutoffMs !== null ? localDayKey(cutoffMs) : null
  const filteredBuckets = cutoffDay
    ? bi.mergedBuckets.filter((b) => b.day >= cutoffDay)
    : bi.mergedBuckets

  const todayDay = localDayKey(nowMs)
  let realCostToday: number | null = null
  try {
    realCostToday =
      buildDailyCostRollup(bi.mergedBuckets).find((d) => d.day === todayDay)?.costUsd ?? null
  } catch {
    realCostToday = null
  }

  const now = await buildNow(nowMs, realCostToday)

  return {
    meta: { schemaVersion: 1, generatedAt: new Date(nowMs).toISOString(), timezone, range },
    now,
    days: buildDaysBlock(filteredBuckets, history, cutoffDay),
    windows: buildWindowsBlock(history, bi, cutoffMs),
    models: buildModelsBlock(filteredBuckets),
    projects: buildProjectsBlock(filteredBuckets),
    sessions: buildSessionsBlock(bi.sessionAnatomies, cutoffMs),
    heatmap: buildHeatmapBlock(history)
  }
}

export function registerUsageBiHandlers(): void {
  ipcMain.handle(
    'usageBi:snapshot',
    (_e, args: { range: UsageBiRange }): Promise<UsageBiSnapshot> =>
      buildUsageBiSnapshot(args?.range ?? '30d')
  )
}
