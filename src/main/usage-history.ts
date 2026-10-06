import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, appendFile, mkdir, readdir, unlink, rename } from 'node:fs/promises'
import { execFile, type ChildProcess } from 'node:child_process'
import { resolveClaudePath } from './claude-cli'
import { sanitizeSpawnEnv } from './appimage-env'
import type { FleetTelemetry } from './statusline-parse'
import {
  decideHistoryWrites,
  reconcileWindowsOnBoot,
  buildRollups,
  buildHeatmap,
  projectPlanFit,
  recommendTier,
  emptyHistoryState,
  utcDayKey,
  localDayKey,
  pickBaseline,
  type HistoryState,
  type LiveReading,
  type UsageSample,
  type WindowRecord,
  type DailyRollup,
  type UsageHeatmap,
  type PlanFitResult,
  type TierRecommendation
} from './usage-history-core'
import { PLAN_TIERS, PLAN_QUOTA_AS_OF, type PlanTier } from './plan-tiers'
import { USAGE_CHAT_SYSTEM, buildUsageChatPrompt, parseUsageChatAnswer } from './usage-history-chat'
import { buildUsageCostSummary } from './usage-cost'

/**
 * Usage-history + BI shell (issue #19). Persists the per-turn statusLine
 * telemetry that today is discarded, in daily-rotated JSONL under
 * `~/.claude/om2tab/usage-history/` (NOT SQLite — see issue: native-module pain),
 * then serves rollups, a deterministic plan-fit projection, and an on-demand
 * chat over the aggregated data.
 *
 * Mirrors the pure/shell split used across the codebase: all decisions,
 * rollups, and projections are pure (`usage-history-core.ts`, unit-tested); this
 * is the electron/fs/IPC shell. Capture is a single fire-and-forget call from
 * `statusline.ts` that NEVER blocks or breaks the ingest. Opt-out, fail-safe:
 * any I/O error is swallowed and the live HUD is unaffected.
 */

export interface UsageHistoryPrefs {
  /** Capture opt-out (default ON). */
  enabled: boolean
  /** The tier the user is currently on (account-wide %s are relative to it). */
  currentTier: string
  /** Model id for the on-demand chat (default `haiku`). */
  chatModel: string
  /** Days to keep sample files; `'forever'` never deletes. */
  retentionDays: number | 'forever'
  /**
   * Weekdays the user normally works, `0` = Sunday … `6` = Saturday. The daily
   * budget splits the weekly allowance across these days only. Default Mon–Sat.
   */
  workingDays: number[]
}

const DEFAULT_PREFS: UsageHistoryPrefs = {
  enabled: true,
  currentTier: 'max20',
  chatModel: 'haiku',
  retentionDays: 90,
  workingDays: [1, 2, 3, 4, 5, 6]
}

/** Cap the recent-samples payload (24h trajectory chart) so IPC stays small. */
const RECENT_SAMPLES_MAX = 600
const CHAT_TIMEOUT_MS = 30_000

// ---- In-memory state (loaded lazily on register) ---------------------------

let prefs: UsageHistoryPrefs = { ...DEFAULT_PREFS }
let state: HistoryState = emptyHistoryState()
let loaded = false
let needsReconcile = true
const chatChildren = new Set<ChildProcess>()

// ---- Paths -----------------------------------------------------------------

function rootDir(): string {
  return join(homedir(), '.claude', 'om2tab', 'usage-history')
}
function samplesDir(): string {
  return join(rootDir(), 'samples')
}
function sampleFile(dayKey: string): string {
  return join(samplesDir(), `samples-${dayKey}.jsonl`)
}
function windowsFile(): string {
  return join(rootDir(), 'windows.jsonl')
}
function stateFile(): string {
  return join(rootDir(), 'state.json')
}
function prefsFile(): string {
  return join(rootDir(), 'prefs.json')
}

// ---- Load / persist --------------------------------------------------------

async function ensureDirs(): Promise<void> {
  await mkdir(samplesDir(), { recursive: true })
}

async function loadPrefs(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(prefsFile(), 'utf8'))
    prefs = {
      enabled: raw?.enabled !== false,
      currentTier:
        typeof raw?.currentTier === 'string' ? raw.currentTier : DEFAULT_PREFS.currentTier,
      chatModel: typeof raw?.chatModel === 'string' ? raw.chatModel : DEFAULT_PREFS.chatModel,
      retentionDays:
        raw?.retentionDays === 'forever' || typeof raw?.retentionDays === 'number'
          ? raw.retentionDays
          : DEFAULT_PREFS.retentionDays,
      workingDays:
        Array.isArray(raw?.workingDays) &&
        raw.workingDays.every((d: unknown) => typeof d === 'number' && d >= 0 && d <= 6)
          ? (raw.workingDays as number[])
          : [...DEFAULT_PREFS.workingDays]
    }
  } catch {
    prefs = { ...DEFAULT_PREFS }
  }
}

async function savePrefs(): Promise<void> {
  try {
    await ensureDirs()
    await writeFile(prefsFile(), JSON.stringify(prefs, null, 2) + '\n', 'utf8')
  } catch {
    /* fail-safe */
  }
}

async function loadState(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(stateFile(), 'utf8'))
    if (raw && typeof raw === 'object') state = raw as HistoryState
  } catch {
    state = emptyHistoryState()
  }
}

// Unique tmp suffix per write so concurrent captureFleet saves don't tear a
// shared tmp file; the rename is atomic, so the final file is always a complete
// state (last writer wins), never a half-written one (T21).
let saveSeq = 0
async function saveState(): Promise<void> {
  const fp = stateFile()
  const tmp = `${fp}.${saveSeq++}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(state), 'utf8')
    await rename(tmp, fp)
  } catch {
    await unlink(tmp).catch(() => {}) // don't leak the tmp on a failed write/rename
  }
}

// Single-flight the load so a concurrent caller during boot doesn't see
// `loaded === true` with default prefs + empty state (which bypassed the opt-out
// and ran the one-shot boot reconcile against nothing). `loaded` flips only AFTER
// the awaits complete; overlapping callers await the same in-flight promise (T21).
let loadPromise: Promise<void> | null = null
async function ensureLoaded(): Promise<void> {
  if (loaded) return
  if (!loadPromise) {
    loadPromise = (async () => {
      await ensureDirs()
      await loadPrefs()
      await loadState()
      await compact()
      loaded = true
    })()
  }
  return loadPromise
}

/**
 * The two settings other per-instance ledgers honour (T389 P1W6 turn ledger): the capture opt-out
 * and the retention window. Read-only; never touches the history's own files.
 */
export async function getUsageHistoryPolicy(): Promise<{
  enabled: boolean
  retentionDays: number | 'forever'
}> {
  await ensureLoaded()
  return { enabled: prefs.enabled, retentionDays: prefs.retentionDays }
}

// ---- Retention / compaction ------------------------------------------------

/** Delete sample files older than the retention window. `'forever'` never deletes. */
async function compact(): Promise<void> {
  if (prefs.retentionDays === 'forever') return
  try {
    const cutoff = Date.now() - prefs.retentionDays * 24 * 3600_000
    const cutoffDay = utcDayKey(cutoff)
    const files = await readdir(samplesDir())
    for (const f of files) {
      const m = f.match(/^samples-(\d{4}-\d{2}-\d{2})\.jsonl$/)
      if (m && m[1] < cutoffDay) await unlink(join(samplesDir(), f)).catch(() => {})
    }
  } catch {
    /* fail-safe */
  }
}

// ---- Append helpers --------------------------------------------------------

async function appendSample(s: UsageSample): Promise<void> {
  await appendFile(sampleFile(utcDayKey(s.t)), JSON.stringify(s) + '\n', 'utf8')
}

async function appendWindows(windows: readonly WindowRecord[]): Promise<void> {
  if (windows.length === 0) return
  await appendFile(windowsFile(), windows.map((w) => JSON.stringify(w)).join('\n') + '\n', 'utf8')
}

// ---- Capture (fire-and-forget from statusline.ts) --------------------------

function readingFromFleet(fleet: FleetTelemetry): LiveReading {
  return {
    costUsd: fleet.totalCostUsd,
    sessionCount: fleet.sessionCount,
    fiveHour: fleet.fiveHour
      ? { usedPercent: fleet.fiveHour.usedPercent, resetsAtMs: fleet.fiveHour.resetsAtMs }
      : null,
    sevenDay: fleet.sevenDay
      ? { usedPercent: fleet.sevenDay.usedPercent, resetsAtMs: fleet.sevenDay.resetsAtMs }
      : null
  }
}

/**
 * Persist one fleet reading. THE capture entry point — called fire-and-forget
 * from `statusline.ts`. Never throws (the caller `void`s it); any failure is
 * swallowed so the statusLine ingest is never affected.
 */
export async function captureFleet(fleet: FleetTelemetry, nowMs: number): Promise<void> {
  try {
    await ensureLoaded()
    if (!prefs.enabled) return
    const reading = readingFromFleet(fleet)

    if (needsReconcile) {
      needsReconcile = false
      const rec = reconcileWindowsOnBoot(state, reading, nowMs)
      state = rec.next
      await appendWindows(rec.windows)
    }

    const writes = decideHistoryWrites(state, reading, nowMs)
    state = writes.next
    if (writes.sample) await appendSample(writes.sample)
    await appendWindows(writes.windows)
    // A closed 7d window IS the weekly reset: today's baseline becomes 0, so the
    // memo from earlier in the day is now wrong.
    if (writes.windows.some((w) => w.kind === 'sevenDay')) invalidateBaselineMemo()
    if (writes.sample || writes.windows.length) await saveState()
  } catch {
    /* fail-safe: capture must never break the statusLine ingest */
  }
}

// ---- Reads (rollups / windows / recent samples) ----------------------------

async function readAllWindows(): Promise<WindowRecord[]> {
  try {
    const raw = await readFile(windowsFile(), 'utf8')
    const out: WindowRecord[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t) as WindowRecord)
      } catch {
        /* skip a torn line */
      }
    }
    return out
  } catch {
    return []
  }
}

async function readAllSamples(): Promise<UsageSample[]> {
  try {
    const files = (await readdir(samplesDir()))
      .filter((f) => /^samples-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
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

/**
 * Drop the memoized baseline. Called when a 7d window closes: a mid-day weekly
 * reset moves the baseline to 0, and the cached value would otherwise keep
 * reporting the pre-reset number for the rest of the day.
 */
function invalidateBaselineMemo(): void {
  baselineMemo = null
}

async function computeDailyBudgetBaseline(): Promise<DailyBudgetBaseline> {
  const dayKey = localDayKey(Date.now())
  if (baselineMemo?.dayKey === dayKey) return baselineMemo
  const [samples, windows] = await Promise.all([readRecentSamples(3), readAllWindows()])
  const rollups = buildRollups(samples, localDayKey, windows)
  baselineMemo = { baselinePct: pickBaseline(rollups, dayKey), dayKey }
  return baselineMemo
}

export interface UsageHistorySummary {
  prefs: UsageHistoryPrefs
  rollups: DailyRollup[]
  windows: WindowRecord[]
  /** Samples from the last 24h, for the 24h trajectory chart (capped). */
  recentSamples: UsageSample[]
  /** Weekday × hour-bucket mean 5h usage — the "when do I use it?" heatmap. */
  heatmap: UsageHeatmap
  tiers: readonly PlanTier[]
  quotaAsOf: string
}

/**
 * Exported (not just used by the IPC handler below) so `usage-bi.ts` (T47 P6
 * S1) can reuse the SAME rollups/windows/heatmap reads for the BI snapshot's
 * `now`/`days`/`windows`/`heatmap` blocks instead of re-reading the samples/
 * windows JSONL itself.
 */
export async function buildSummary(): Promise<UsageHistorySummary> {
  await ensureLoaded()
  const samples = await readAllSamples()
  const windows = await readAllWindows()
  // A real 24h cut — a bare tail would stretch over weeks of sparse usage and
  // make the "24h" chart lie about its span.
  const dayAgo = Date.now() - 24 * 3600_000
  return {
    prefs,
    rollups: buildRollups(samples, localDayKey, windows),
    windows,
    recentSamples: samples.filter((s) => s.t >= dayAgo).slice(-RECENT_SAMPLES_MAX),
    heatmap: buildHeatmap(samples, Date.now()),
    tiers: PLAN_TIERS,
    quotaAsOf: PLAN_QUOTA_AS_OF
  }
}

/** Epoch-ms lower bound for a `sinceDays` recency scope; `null`/absent = all-time. */
function sinceMsFor(sinceDays: number | null | undefined): number | undefined {
  return typeof sinceDays === 'number' && sinceDays > 0
    ? Date.now() - sinceDays * 24 * 3600_000
    : undefined
}

// ---- Chat spawn ------------------------------------------------------------

function runChat(prompt: string, model: string): Promise<{ ok: boolean; stdout?: string }> {
  return new Promise((resolve) => {
    void (async () => {
      const bin = (await resolveClaudePath()) ?? 'claude'
      const child = execFile(
        bin,
        ['-p', prompt, '--model', model, '--append-system-prompt', USAGE_CHAT_SYSTEM],
        {
          cwd: homedir(),
          env: sanitizeSpawnEnv(process.env, { execPath: process.execPath }),
          timeout: CHAT_TIMEOUT_MS,
          maxBuffer: 1 << 20,
          encoding: 'utf8'
        },
        (err, stdout) => {
          chatChildren.delete(child)
          resolve(err || !stdout?.trim() ? { ok: false } : { ok: true, stdout })
        }
      )
      chatChildren.add(child)
    })()
  })
}

// ---- IPC -------------------------------------------------------------------

export function registerUsageHistoryHandlers(): void {
  void app.whenReady().then(() => void ensureLoaded())

  ipcMain.handle('usageHistory:summary', (): Promise<UsageHistorySummary> => buildSummary())

  // Narrow, cheap counterpart to `summary` for the daily-budget row: reads at
  // most three sample files instead of the whole archive, so the footer panel
  // can ask for it at boot (daily-budget spec).
  ipcMain.handle('usageHistory:dailyBudget', async (): Promise<DailyBudgetBaseline> => {
    await ensureLoaded()
    return computeDailyBudgetBaseline()
  })

  ipcMain.handle('usageHistory:getPrefs', async (): Promise<UsageHistoryPrefs> => {
    await ensureLoaded()
    return prefs
  })

  ipcMain.handle(
    'usageHistory:setPrefs',
    async (_e, patch: Partial<UsageHistoryPrefs>): Promise<UsageHistoryPrefs> => {
      await ensureLoaded()
      const prevRetention = prefs.retentionDays
      prefs = { ...prefs, ...patch }
      await savePrefs()
      if (prefs.retentionDays !== prevRetention) await compact()
      return prefs
    }
  )

  ipcMain.handle(
    'usageHistory:planFit',
    async (
      _e,
      args: { fromTier: string; toTier: string; ratioOverride?: number; sinceDays?: number | null }
    ): Promise<PlanFitResult> => {
      const windows = await readAllWindows()
      return projectPlanFit(windows, args.fromTier, args.toTier, {
        ratioOverride: args.ratioOverride,
        sinceMs: sinceMsFor(args.sinceDays)
      })
    }
  )

  ipcMain.handle(
    'usageHistory:recommend',
    async (
      _e,
      args: { fromTier: string; sinceDays?: number | null }
    ): Promise<TierRecommendation | null> => {
      const windows = await readAllWindows()
      return recommendTier(windows, args.fromTier, PLAN_TIERS, {
        sinceMs: sinceMsFor(args.sinceDays)
      })
    }
  )

  ipcMain.handle(
    'usageHistory:chat',
    async (_e, args: { question: string }): Promise<{ ok: boolean; answer?: string }> => {
      try {
        await ensureLoaded()
        const samples = await readAllSamples()
        const windows = await readAllWindows()
        const rollups = buildRollups(samples)
        // Real cost engine (T47 P5) — best-effort: any failure just means the
        // chat falls back to the notional rollups it always had, same as before.
        const cost = await buildUsageCostSummary().catch(() => null)
        const prompt = buildUsageChatPrompt(args.question, {
          rollups,
          planFit: projectPlanFit(windows, prefs.currentTier, prefs.currentTier),
          currentTier: prefs.currentTier,
          quotaAsOf: PLAN_QUOTA_AS_OF,
          costData:
            cost && cost.dailyRollup.length > 0
              ? {
                  dailyCost: cost.dailyRollup,
                  topModels: cost.modelRollup,
                  topProjects: cost.projectRollup,
                  topSessions: cost.topSessions,
                  hasEstimated: cost.hasEstimated
                }
              : null
        })
        if (!prompt) return { ok: false }
        const outcome = await runChat(prompt, prefs.chatModel || 'haiku')
        if (!outcome.ok || !outcome.stdout) return { ok: false }
        return { ok: true, answer: parseUsageChatAnswer(outcome.stdout) }
      } catch {
        return { ok: false }
      }
    }
  )
}

/** Persist state + kill in-flight chat spawns on quit. */
export async function closeUsageHistory(): Promise<void> {
  for (const c of chatChildren) c.kill()
  chatChildren.clear()
  if (loaded) await saveState()
}
