import { ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import {
  buildDailyCostRollup,
  buildModelCostRollup,
  buildProjectCostRollup,
  buildSessionCostRollup,
  calibrateBuckets,
  type CalibrationSkip,
  type CostBucket,
  type DailyCostRollup,
  type ModelCostRollup,
  type ProjectCostRollup,
  type SessionCostRollup
} from './usage-cost-core'
import {
  createUsageScanner,
  type UsageScanBi,
  type UsageScanMerged,
  type UsageScanner,
  type UsageScanReply,
  type UsageScanRequest,
  type UsageScanRoots,
  type UsageScanWorkerData
} from './usage-scan-worker'

/**
 * Real cost-engine shell (T47 P5). The scan of `~/.claude/projects/**\/*.jsonl` (every session's main
 * transcript plus its `<sessionId>/subagents/agent-*.jsonl` companions) runs in a worker thread
 * (`usage-scan-worker.ts`), so the main process never parses a transcript. This side asks for the merged
 * buckets, calibrates them, folds the rollups and serves them over `usageCost:*` IPC. Fail-safe
 * throughout, mirroring `usage-history.ts`: any error degrades to "no engine data", it never breaks the
 * Settings pane.
 */

// ---- Scan worker ----------------------------------------------------------------

function scanRoots(): UsageScanRoots {
  return {
    projectsRoot: join(homedir(), '.claude', 'projects'),
    cacheDir: join(homedir(), '.claude', 'om2tab', 'usage-history')
  }
}

type ScanWorkerFactory = (data: UsageScanWorkerData) => Worker

let factory: ScanWorkerFactory | null = null
let worker: Worker | null = null
let localScanner: UsageScanner | null = null
let nextId = 1
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>()

/**
 * Run every scan in a worker from now on. Without it (unit tests, tooling) the same scanner runs in this
 * thread. The worker starts on the first request and is kept, so its in-memory cache is too.
 */
export function startUsageScanWorker(f: ScanWorkerFactory): void {
  factory = f
}

/** Terminate the worker and go back to scanning in this thread. */
export async function stopUsageScanWorker(): Promise<void> {
  factory = null
  const w = worker
  if (!w) return
  workerGone(w, new Error('the usage scan worker was stopped'))
  await w.terminate()
}

/** The worker is gone: everything waiting on it rejects now, and the next request starts a new one. */
function workerGone(w: Worker, err: Error): void {
  if (worker !== w) return
  worker = null
  for (const p of pending.values()) p.reject(err)
  pending.clear()
}

function ensureWorker(f: ScanWorkerFactory): Worker {
  if (worker) return worker
  const w = f({ usageScan: scanRoots() })
  w.on('message', (m: UsageScanReply) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok) p.resolve(m.value)
    else p.reject(new Error(m.error))
  })
  w.on('error', (err) => {
    console.error('[usage-scan] worker failed', err)
    workerGone(w, err instanceof Error ? err : new Error(String(err)))
  })
  w.on('exit', (code) => workerGone(w, new Error(`the usage scan worker exited (${code})`)))
  worker = w
  return w
}

function scan(want: 'merged'): Promise<UsageScanMerged>
function scan(want: 'bi'): Promise<UsageScanBi>
function scan(want: 'flush'): Promise<void>
function scan(want: keyof UsageScanner): Promise<unknown> {
  const f = factory
  if (!f) {
    localScanner ??= createUsageScanner(scanRoots())
    return localScanner[want]()
  }
  return new Promise((resolve, reject) => {
    const w = ensureWorker(f)
    const id = nextId++
    pending.set(id, { resolve, reject })
    w.postMessage({ id, want } satisfies UsageScanRequest)
  })
}

// ---- Summary shape --------------------------------------------------------------

export interface UsageCostSummary {
  dailyRollup: DailyCostRollup[]
  modelRollup: ModelCostRollup[]
  projectRollup: ProjectCostRollup[]
  /** Highest-spend sessions, all-time, capped for IPC payload size. */
  topSessions: SessionCostRollup[]
  /** `true` when ANY contributing request was priced on the unknown/default tier. */
  hasEstimated: boolean
  fileCount: number
  scanMs: number
  generatedAtMs: number
}

const TOP_SESSIONS_CAP = 20

function emptySummary(): UsageCostSummary {
  return {
    dailyRollup: [],
    modelRollup: [],
    projectRollup: [],
    topSessions: [],
    hasEstimated: false,
    fileCount: 0,
    scanMs: 0,
    generatedAtMs: Date.now()
  }
}

// ---- Calibration by the CLI's own total (T389 P1W6 §7.5) -------------------------------------

/** What the host hands us: measured USD per `(session, day)` for the sessions it fully covers. */
interface CostCalibration {
  totals(): Promise<ReadonlyMap<string, number>>
  onSkip?(s: CalibrationSkip): void
}
let calibration: CostCalibration | null = null

/** Called once by the companion host; `null` removes it. The scan stays the structure and history. */
export function setUsageCostCalibration(c: CostCalibration | null): void {
  calibration = c
}

/** Applied after the per-file cache merge; any failure leaves the scan's price standing. */
async function calibrated(buckets: CostBucket[]): Promise<CostBucket[]> {
  if (!calibration) return buckets
  try {
    return calibrateBuckets(buckets, await calibration.totals(), calibration.onSkip)
  } catch {
    return buckets
  }
}

let inFlight: Promise<UsageCostSummary> | null = null

async function computeSummary(): Promise<UsageCostSummary> {
  const { mergedBuckets, fileCount, scanMs } = await scan('merged')

  const merged = await calibrated(mergedBuckets)
  const sessionRollup = buildSessionCostRollup(merged)

  return {
    dailyRollup: buildDailyCostRollup(merged),
    modelRollup: buildModelCostRollup(merged),
    projectRollup: buildProjectCostRollup(merged),
    topSessions: sessionRollup.slice(0, TOP_SESSIONS_CAP),
    hasEstimated: merged.some((b) => b.estimated),
    fileCount,
    scanMs,
    generatedAtMs: Date.now()
  }
}

/**
 * Build (or reuse an in-flight) cost summary. Never throws: any failure
 * degrades to an empty summary so the UI can fall back to the notional
 * cost/day it already shows — the real-cost surface is additive, not a hard
 * dependency.
 */
export async function buildUsageCostSummary(): Promise<UsageCostSummary> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      return await computeSummary()
    } catch {
      return emptySummary()
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

// ---- BI raw data (T47 P6 S1) ------------------------------------------------

/** What the BI snapshot reads: the scan's folds, with `mergedBuckets` calibrated here. */
export type UsageBiRawData = UsageScanBi

let biInFlight: Promise<UsageBiRawData> | null = null

async function computeBiRawData(): Promise<UsageBiRawData> {
  const raw = await scan('bi')
  return { ...raw, mergedBuckets: await calibrated(raw.mergedBuckets) }
}

function emptyBiRawData(): UsageBiRawData {
  return { sessionAnatomies: [], mergedBuckets: [], hourlyPoints: [], fileCount: 0, scanMs: 0 }
}

/**
 * Build (or reuse an in-flight) BI raw-data pass. Never throws — degrades to
 * empty (the snapshot builder then reports null/[] for everything it feeds,
 * per the "fail-safe, never throws to the renderer" contract).
 */
export async function buildUsageBiRawData(): Promise<UsageBiRawData> {
  if (biInFlight) return biInFlight
  biInFlight = (async () => {
    try {
      return await computeBiRawData()
    } catch {
      return emptyBiRawData()
    } finally {
      biInFlight = null
    }
  })()
  return biInFlight
}

// ---- IPC ------------------------------------------------------------------------

export function registerUsageCostHandlers(): void {
  // Built by electron-vite as its own main entry, next to this bundle.
  startUsageScanWorker(
    (data) => new Worker(join(__dirname, 'usage-scan-worker.js'), { workerData: data })
  )
  ipcMain.handle('usageCost:summary', (): Promise<UsageCostSummary> => buildUsageCostSummary())
}

/** Flush the cache on quit — mirrors `closeUsageHistory`. */
export async function closeUsageCost(): Promise<void> {
  // Never start a worker just to quit.
  if (worker || localScanner) await scan('flush').catch(() => {})
}
