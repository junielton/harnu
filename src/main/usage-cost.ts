import { ipcMain } from 'electron'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFile, writeFile, readdir, stat, rename, unlink, mkdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import {
  buildFileCostBuckets,
  extractFirstCwd,
  mergeCostBuckets,
  buildDailyCostRollup,
  buildModelCostRollup,
  buildProjectCostRollup,
  buildSessionCostRollup,
  type CostBucket,
  type DailyCostRollup,
  type ModelCostRollup,
  type ProjectCostRollup,
  type SessionCostRollup
} from './usage-cost-core'
import {
  buildFileAnatomySignals,
  buildSessionAnatomy,
  type FileAnatomySignals,
  type SessionAnatomy,
  type SessionHourlyPoint
} from './usage-bi-core'

/**
 * Real cost-engine shell (T47 P5). Scans `~/.claude/projects/**\/*.jsonl`
 * (every session's main transcript PLUS its `<sessionId>/subagents/agent-*.jsonl`
 * companions), feeds each file through the pure core (`usage-cost-core.ts`),
 * and serves the merged rollups over `usageCost:*` IPC.
 *
 * Performance: `~/.claude/projects` can be hundreds of MB, so this is
 * incremental. A per-file cache — keyed by `(path, size, mtimeMs)` — stores
 * each file's ALREADY-DEDUPED-AND-PRICED `CostBucket[]` (a handful of
 * day×model rows, not the raw request list), persisted to
 * `~/.claude/om2tab/usage-history/cost-cache.json`. A request only re-parses
 * files whose size or mtime moved since the last scan; everything else is a
 * cheap `stat()` + cache hit. Fail-safe throughout, mirroring
 * `usage-history.ts`: any I/O error degrades to "no engine data" — it never
 * breaks the Settings pane.
 */

// ---- Discovery ---------------------------------------------------------------

interface FileTask {
  path: string
  sessionId: string
  projectPath: string
  isSubagent: boolean
}

function projectsRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/**
 * Best-effort slug→path decode (dashes were slashes). LAST-RESORT fallback
 * only: the decode is lossy (a project named `my-cool_project` decodes to
 * `my/cool/project`), so `refreshCache` prefers the real `cwd` recovered from
 * the JSONL lines ({@link extractFirstCwd}) and only falls back here for a
 * file that never carried one.
 */
function decodeSlugToPath(slug: string): string {
  return slug.startsWith('-') ? '/' + slug.slice(1).replace(/-/g, '/') : slug
}

/**
 * Two-pass discovery mirroring `claude-reader.ts`'s scan: (1) every top-level
 * `<slug>/<uuid>.jsonl` is a session's main transcript; (2) every
 * `<slug>/<uuid>/subagents/agent-*.jsonl` is a subagent transcript for that
 * SAME session id (semantics #4 — never overlaps the main file, always
 * additive). Never throws — an unreadable directory just yields fewer tasks.
 */
async function discoverFiles(rootDir: string): Promise<FileTask[]> {
  let slugDirs: Dirent[]
  try {
    slugDirs = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }

  const tasks: FileTask[] = []
  await Promise.all(
    slugDirs
      .filter((d) => d.isDirectory())
      .map(async (slugDirent) => {
        const slug = slugDirent.name
        const projectDir = join(rootDir, slug)
        const projectPath = decodeSlugToPath(slug)
        let entries: Dirent[]
        try {
          entries = await readdir(projectDir, { withFileTypes: true })
        } catch {
          return
        }

        for (const e of entries) {
          if (e.isFile() && e.name.endsWith('.jsonl')) {
            tasks.push({
              path: join(projectDir, e.name),
              sessionId: e.name.replace(/\.jsonl$/, ''),
              projectPath,
              isSubagent: false
            })
          }
        }

        const parentDirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        await Promise.all(
          parentDirs.map(async (dir) => {
            const parentSessionId = dir.name
            const subagentsDir = join(projectDir, parentSessionId, 'subagents')
            let agentFiles: Dirent[]
            try {
              agentFiles = await readdir(subagentsDir, { withFileTypes: true })
            } catch {
              return
            }
            for (const f of agentFiles) {
              if (f.isFile() && f.name.startsWith('agent-') && f.name.endsWith('.jsonl')) {
                tasks.push({
                  path: join(subagentsDir, f.name),
                  sessionId: parentSessionId,
                  projectPath,
                  isSubagent: true
                })
              }
            }
          })
        )
      })
  )
  return tasks
}

// ---- Cache --------------------------------------------------------------------

interface CachedFileEntry {
  size: number
  mtimeMs: number
  buckets: CostBucket[]
  /** Session-anatomy + hourly-cost signals for this ONE file (T47 P6 S1). */
  anatomy: FileAnatomySignals
  /** Real project path: the JSONL's own `cwd` when the file carries one,
   *  else the lossy slug decode (v5). */
  projectPath: string
}

interface CostCacheFile {
  version: number
  files: Record<string, CachedFileEntry>
}

// Cached buckets are ALREADY PRICED, so the version must be bumped whenever the
// pricing table changes (a stale cache would silently keep old prices for
// unchanged files). v2: C5 published rates for Fable/Mythos 5, Opus 4.7/4.8,
// Sonnet 5. v3: C6 cache writes priced by TTL (1h = 2× input, 5m = 1.25×).
// v4: T47 P6 S1 adds `anatomy` (turns/title/peak-context/hourly buckets) to
// every cached file entry — a v3 entry lacks the field entirely, so the
// version bump forces a full rebuild rather than serving `undefined` anatomy.
// v5: `projectPath` is recovered from the JSONL's real `cwd` instead of the
// lossy slug decode (dash/underscore project names were mangled, e.g.
// `my-cool_project` → `my/cool/project`); cached buckets bake the path in,
// so a v4 cache would keep serving the mangled names for unchanged files.
const CACHE_VERSION = 5

/**
 * Hourly cost detail (used only by the BI window-enrichment join) is capped to
 * this many days back, computed at the time a file is (re)scanned — keeps the
 * cache file from growing an unbounded per-hour history for old, untouched
 * sessions. Because the cap is applied at SCAN time and a cached entry is only
 * recomputed when its file changes, a long-untouched file's hourly buckets can
 * persist slightly past this boundary until it's next rescanned — accepted for
 * cache-size sanity (pinned in tests), same spirit as the windows-enrichment
 * edge-precision note in `usage-bi-core.ts`.
 */
const HOURLY_RETENTION_DAYS = 90

function cacheDir(): string {
  return join(homedir(), '.claude', 'om2tab', 'usage-history')
}
function cacheFile(): string {
  return join(cacheDir(), 'cost-cache.json')
}

let fileCache = new Map<string, CachedFileEntry>()
let cacheLoaded = false
let loadPromise: Promise<void> | null = null

async function loadCache(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(cacheFile(), 'utf8')) as CostCacheFile
    if (raw && raw.version === CACHE_VERSION && raw.files && typeof raw.files === 'object') {
      fileCache = new Map(Object.entries(raw.files))
    }
  } catch {
    fileCache = new Map()
  }
}

// Unique tmp suffix per write, same atomic-rename pattern as usage-history.ts
// (T21): a half-written cache is never observable, last writer wins.
let saveSeq = 0
async function saveCache(): Promise<void> {
  const fp = cacheFile()
  const tmp = `${fp}.${saveSeq++}.tmp`
  const payload: CostCacheFile = { version: CACHE_VERSION, files: Object.fromEntries(fileCache) }
  try {
    await mkdir(cacheDir(), { recursive: true })
    await writeFile(tmp, JSON.stringify(payload), 'utf8')
    await rename(tmp, fp)
  } catch {
    await unlink(tmp).catch(() => {})
  }
}

async function ensureCacheLoaded(): Promise<void> {
  if (cacheLoaded) return
  if (!loadPromise) {
    loadPromise = (async () => {
      await loadCache()
      cacheLoaded = true
    })()
  }
  return loadPromise
}

// ---- Scan + merge ---------------------------------------------------------------

const SCAN_CONCURRENCY = 8

/**
 * (Re)scan every discovered file, reusing the cache for anything whose
 * `(size, mtimeMs)` didn't change. Returns whether the cache was mutated (so
 * the caller only persists when there's something new to save).
 */
async function refreshCache(tasks: readonly FileTask[]): Promise<boolean> {
  const currentPaths = new Set(tasks.map((t) => t.path))
  let mutated = false
  for (const key of fileCache.keys()) {
    if (!currentPaths.has(key)) {
      fileCache.delete(key)
      mutated = true
    }
  }

  let idx = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = idx++
      if (i >= tasks.length) return
      const task = tasks[i]
      let st: { size: number; mtimeMs: number }
      try {
        st = await stat(task.path)
      } catch {
        continue
      }
      const cached = fileCache.get(task.path)
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue

      let raw: string
      try {
        raw = await readFile(task.path, 'utf8')
      } catch {
        continue
      }
      const lines = raw.split('\n')
      // Prefer the file's own `cwd` — the slug-decoded task.projectPath is
      // lossy for project names containing `-`/`_` (see decodeSlugToPath).
      const projectPath = extractFirstCwd(lines) ?? task.projectPath
      const buckets = buildFileCostBuckets(lines, {
        sessionId: task.sessionId,
        projectPath,
        isSubagent: task.isSubagent
      })
      const anatomy = buildFileAnatomySignals(
        lines,
        { sessionId: task.sessionId, isSubagent: task.isSubagent },
        Date.now() - HOURLY_RETENTION_DAYS * 24 * 3600_000
      )
      fileCache.set(task.path, {
        size: st.size,
        mtimeMs: st.mtimeMs,
        buckets,
        anatomy,
        projectPath
      })
      mutated = true
    }
  }
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, () => worker()))
  return mutated
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

/** The result of a full incremental (re)scan — the shared substrate both the
 *  P5 summary and the P6 BI snapshot fold into their own shapes. */
interface ScannedState {
  tasks: FileTask[]
  scanMs: number
}

/**
 * (Re)discover + (re)scan every transcript file, reusing the per-file cache.
 * Single entry point for anything that needs the raw scan — P5's
 * `computeSummary` and P6's {@link buildUsageBiRawData} both call this so the
 * expensive discovery + incremental re-parse only ever happens once per call,
 * never duplicated across the two consumers.
 */
async function ensureScanned(): Promise<ScannedState> {
  const startedAt = Date.now()
  await ensureCacheLoaded()
  const tasks = await discoverFiles(projectsRoot())
  const mutated = await refreshCache(tasks)
  if (mutated) void saveCache()
  return { tasks, scanMs: Date.now() - startedAt }
}

let inFlight: Promise<UsageCostSummary> | null = null

async function computeSummary(): Promise<UsageCostSummary> {
  const { tasks, scanMs } = await ensureScanned()

  const merged = mergeCostBuckets([...fileCache.values()].map((c) => c.buckets))
  const sessionRollup = buildSessionCostRollup(merged)

  return {
    dailyRollup: buildDailyCostRollup(merged),
    modelRollup: buildModelCostRollup(merged),
    projectRollup: buildProjectCostRollup(merged),
    topSessions: sessionRollup.slice(0, TOP_SESSIONS_CAP),
    hasEstimated: merged.some((b) => b.estimated),
    fileCount: tasks.length,
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

export interface UsageBiRawData {
  /** Full anatomy for every session discovered (main + subagent files merged). */
  sessionAnatomies: SessionAnatomy[]
  /** The same merged buckets `computeSummary` folds — reused for the daily
   *  model breakdown / rollups the BI snapshot needs, no re-parse. */
  mergedBuckets: CostBucket[]
  /** Flattened (session, hour, model) cost points, across every file — the
   *  window-enrichment join input. */
  hourlyPoints: SessionHourlyPoint[]
  fileCount: number
  scanMs: number
}

let biInFlight: Promise<UsageBiRawData> | null = null

async function computeBiRawData(): Promise<UsageBiRawData> {
  const { tasks, scanMs } = await ensureScanned()

  const mergedBuckets = mergeCostBuckets([...fileCache.values()].map((c) => c.buckets))

  const bySession = new Map<string, { projectPath: string; files: FileAnatomySignals[] }>()
  const subagentCounts = new Map<string, number>()
  const hourlyPoints: SessionHourlyPoint[] = []

  for (const task of tasks) {
    const cached = fileCache.get(task.path)
    if (!cached) continue
    let entry = bySession.get(task.sessionId)
    if (!entry) {
      // cached.projectPath is the cwd-recovered path (v5) — task.projectPath
      // is the lossy slug decode, kept only as the discovery-time fallback.
      entry = { projectPath: cached.projectPath, files: [] }
      bySession.set(task.sessionId, entry)
    }
    entry.files.push(cached.anatomy)
    if (task.isSubagent) {
      subagentCounts.set(task.sessionId, (subagentCounts.get(task.sessionId) ?? 0) + 1)
    }
    for (const h of cached.anatomy.hourly) {
      hourlyPoints.push({ ...h, sessionId: task.sessionId })
    }
  }

  const sessionAnatomies: SessionAnatomy[] = [...bySession.entries()].map(
    ([sessionId, { projectPath, files }]) =>
      buildSessionAnatomy(files, {
        sessionId,
        projectPath,
        subagentCount: subagentCounts.get(sessionId) ?? 0
      })
  )

  return { sessionAnatomies, mergedBuckets, hourlyPoints, fileCount: tasks.length, scanMs }
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
  ipcMain.handle('usageCost:summary', (): Promise<UsageCostSummary> => buildUsageCostSummary())
}

/** Flush the cache on quit — mirrors `closeUsageHistory`. */
export async function closeUsageCost(): Promise<void> {
  if (cacheLoaded) await saveCache()
}
