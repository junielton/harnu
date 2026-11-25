import { join } from 'node:path'
import { readFile, writeFile, readdir, stat, rename, unlink, mkdir, open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  extractFirstCwd,
  foldCostBuckets,
  mergeCostBuckets,
  priceFileLines,
  type CostBucket
} from './usage-cost-core'
import {
  buildSessionAnatomy,
  foldFileAnatomySignals,
  type FileAnatomySignals,
  type SessionAnatomy,
  type SessionHourlyPoint
} from './usage-bi-core'
import { readMeasuredLedger, type MeasuredProject } from './companion/turn-ledger'

/**
 * The usage scan, in its own thread. Reading and parsing every transcript that changed is hundreds of
 * megabytes of synchronous work, which on the main process froze input, IPC and terminal output for
 * seconds. The companion turn ledger that calibrates the cost is read here for the same reason.
 * `usage-cost.ts` starts this file as a `worker_threads` Worker and gets back only the folded results;
 * the per-file cache never crosses the boundary. No Electron imports: a worker has none.
 *
 * `~/.claude/projects` can be gigabytes, so the scan is incremental. A per-file cache, keyed by
 * `(path, size, mtimeMs)`, stores each file's ALREADY-DEDUPED-AND-PRICED `CostBucket[]` (a handful of
 * day x model rows, not the raw request list), persisted to
 * `~/.claude/om2tab/usage-history/cost-cache.json`. A request only looks inside files whose size or mtime
 * moved since the last scan; everything else is a cheap `stat()` + cache hit. Transcripts are append-only,
 * so a file that grew is read from where the last scan stopped and its folds are continued; any other
 * change re-reads it whole. Fail-safe throughout: any I/O error degrades to "no engine data".
 */

export interface UsageScanRoots {
  projectsRoot: string
  cacheDir: string
}

/** The merged cost buckets of every transcript, before calibration. */
export interface UsageScanMerged {
  mergedBuckets: CostBucket[]
  fileCount: number
  scanMs: number
}

export interface UsageScanBi extends UsageScanMerged {
  /** Full anatomy for every session discovered (main + subagent files merged). */
  sessionAnatomies: SessionAnatomy[]
  /** Flattened (session, hour, model) cost points, across every file: the
   *  window-enrichment join input. */
  hourlyPoints: SessionHourlyPoint[]
}

export interface UsageScanner {
  merged(): Promise<UsageScanMerged>
  bi(): Promise<UsageScanBi>
  /** The companion turn ledger under `dir`, read for calibration. */
  ledger(dir: string): Promise<MeasuredProject[]>
  /** Persist the cache, if one was ever loaded. */
  flush(): Promise<void>
}

export interface UsageScanRequest {
  id: number
  want: keyof UsageScanner
  /** `ledger` only. */
  dir?: string
}

export type UsageScanReply =
  { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

export interface UsageScanWorkerData {
  usageScan: UsageScanRoots
}

// ---- Discovery ---------------------------------------------------------------

interface FileTask {
  path: string
  sessionId: string
  projectPath: string
  isSubagent: boolean
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
  resume: ResumeState
}

/** What it takes to continue a file's folds once it has grown (v6). No transcript text. */
interface ResumeState {
  /** Bytes consumed: just past the last newline. */
  offset: number
  /** Hash of the first and the last few KB before `offset`: are they still the same bytes? */
  fingerprint: string
  /** Request ids already counted, so a later block of the same response isn't counted again. */
  requestIds: string[]
  /** The first `cwd` found before `offset`. */
  cwd: string | null
  /** The folds up to `offset`. Present only when the entry's own folds also count a last
   *  line that has no newline yet, which will be read again. */
  beforeTail?: Pick<CachedFileEntry, 'buckets' | 'anatomy'>
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
// v6: every entry carries `resume`, without which a grown file can't be continued.
const CACHE_VERSION = 6

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

const CACHE_NAME = 'cost-cache.json'

/**
 * A save interrupted by a quit or a crash leaves its `cost-cache.json.<n>.tmp` behind, megabytes each,
 * and nothing ever reads it again. Called before this process writes its own.
 */
async function removeLeftoverTmps(cacheDir: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(cacheDir)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((n) => n.startsWith(`${CACHE_NAME}.`) && n.endsWith('.tmp'))
      .map((n) => unlink(join(cacheDir, n)).catch(() => {}))
  )
}

// ---- Parsing one file ---------------------------------------------------------

const HOUR_MS = 3_600_000

/** How much of the start, and of the end, of the consumed bytes the fingerprint covers. */
const FINGERPRINT_BYTES = 4096

async function readRange(file: FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(end - start)
  let got = 0
  while (got < buffer.length) {
    const { bytesRead } = await file.read(buffer, got, buffer.length - got, start + got)
    if (bytesRead === 0) break
    got += bytesRead
  }
  return buffer.subarray(0, got)
}

async function fingerprint(file: FileHandle, offset: number): Promise<string> {
  const length = Math.min(offset, FINGERPRINT_BYTES)
  return createHash('sha1')
    .update(await readRange(file, 0, length))
    .update(await readRange(file, offset - length, offset))
    .digest('base64')
}

interface Folds {
  buckets: CostBucket[]
  anatomy: FileAnatomySignals | null
  requestIds: ReadonlySet<string>
  cwd: string | null
}

/** Continue `prev` with the lines that follow it. `prev` is not mutated. */
function foldLines(
  prev: Folds,
  lines: readonly string[],
  task: FileTask,
  hourlyCutoffMs: number
): Folds & { anatomy: FileAnatomySignals } {
  // Prefer the file's own `cwd` — the slug-decoded task.projectPath is
  // lossy for project names containing `-`/`_` (see decodeSlugToPath).
  const cwd = prev.cwd ?? extractFirstCwd(lines)
  const { sessionId, isSubagent } = task
  const requestIds = new Set(prev.requestIds)
  const priced = priceFileLines(lines, requestIds)
  return {
    cwd,
    requestIds,
    buckets: foldCostBuckets(prev.buckets, priced, {
      sessionId,
      projectPath: cwd ?? task.projectPath,
      isSubagent
    }),
    anatomy: foldFileAnatomySignals(
      prev.anatomy,
      lines,
      priced,
      { sessionId, isSubagent },
      hourlyCutoffMs
    )
  }
}

/** Everything folded so far, or nothing when `prev` can't be continued for the file as it is now. */
async function resumeFrom(
  file: FileHandle,
  size: number,
  prev: CachedFileEntry | undefined,
  hourlyCutoffMs: number
): Promise<{ offset: number; folds: Folds }> {
  const nothing = {
    offset: 0,
    folds: { buckets: [], anatomy: null, requestIds: new Set<string>(), cwd: null }
  }
  // Only growth is an append: a smaller file, or a new mtime on the same size, was rewritten.
  if (!prev || size <= prev.size) return nothing
  // An hour the retention cutoff now falls inside can only be recomputed from its requests.
  const split = prev.anatomy.hourly.some(
    (h) => h.hourStartMs < hourlyCutoffMs && h.hourStartMs + HOUR_MS > hourlyCutoffMs
  )
  const { offset, requestIds, cwd, beforeTail } = prev.resume
  if (split || (await fingerprint(file, offset)) !== prev.resume.fingerprint) return nothing
  const { buckets, anatomy } = beforeTail ?? prev
  return { offset, folds: { buckets, anatomy, requestIds: new Set(requestIds), cwd } }
}

/** The cache entry for a new or changed file, reading no more of it than necessary. */
async function parseFile(
  task: FileTask,
  st: { size: number; mtimeMs: number },
  prev: CachedFileEntry | undefined
): Promise<CachedFileEntry> {
  const hourlyCutoffMs = Date.now() - HOURLY_RETENTION_DAYS * 24 * HOUR_MS
  const file = await open(task.path, 'r')
  try {
    const from = await resumeFrom(file, st.size, prev, hourlyCutoffMs)
    // Never past the stat'ed size, so the entry describes the file at that size.
    const bytes = await readRange(file, from.offset, st.size)
    // A newline byte is never part of a multi-byte character, so both halves decode cleanly.
    const complete = bytes.lastIndexOf(0x0a) + 1
    const lines = bytes.toString('utf8', 0, complete).split('\n')
    const base = foldLines(from.folds, lines, task, hourlyCutoffMs)
    // A last line with no newline counts now, but stays unconsumed: it may still be growing.
    const tail = bytes.toString('utf8', complete)
    const whole = tail.trim() ? foldLines(base, [tail], task, hourlyCutoffMs) : base
    const offset = from.offset + complete
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      buckets: whole.buckets,
      anatomy: whole.anatomy,
      projectPath: whole.cwd ?? task.projectPath,
      resume: {
        offset,
        fingerprint: await fingerprint(file, offset),
        requestIds: [...base.requestIds],
        cwd: base.cwd,
        ...(whole !== base && { beforeTail: { buckets: base.buckets, anatomy: base.anatomy } })
      }
    }
  } finally {
    await file.close()
  }
}

/** One scanner owns the per-file cache, in memory and on disk, for the roots it was given. */
export function createUsageScanner({ projectsRoot, cacheDir }: UsageScanRoots): UsageScanner {
  const cacheFile = join(cacheDir, CACHE_NAME)

  let fileCache = new Map<string, CachedFileEntry>()
  let cacheLoaded = false
  let loadPromise: Promise<void> | null = null

  async function loadCache(): Promise<void> {
    await removeLeftoverTmps(cacheDir)
    try {
      const raw = JSON.parse(await readFile(cacheFile, 'utf8')) as CostCacheFile
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
    const fp = cacheFile
    const tmp = `${fp}.${saveSeq++}.tmp`
    const payload: CostCacheFile = { version: CACHE_VERSION, files: Object.fromEntries(fileCache) }
    try {
      await mkdir(cacheDir, { recursive: true })
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
   * `(size, mtimeMs)` didn't change, and the folds of whatever only grew.
   * Returns whether the cache was mutated (so the caller only persists when
   * there's something new to save).
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

        try {
          fileCache.set(task.path, await parseFile(task, st, cached))
        } catch {
          continue
        }
        mutated = true
      }
    }
    await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, () => worker()))
    return mutated
  }

  /** The result of a full incremental (re)scan — the shared substrate both folds below read. */
  interface ScannedState {
    tasks: FileTask[]
    scanMs: number
  }

  /**
   * (Re)discover + (re)scan every transcript file, reusing the per-file cache.
   * Single entry point for anything that needs the raw scan, so the expensive
   * discovery + incremental re-parse only ever happens once per request.
   */
  async function ensureScanned(): Promise<ScannedState> {
    const startedAt = Date.now()
    await ensureCacheLoaded()
    const tasks = await discoverFiles(projectsRoot)
    const mutated = await refreshCache(tasks)
    if (mutated) void saveCache()
    return { tasks, scanMs: Date.now() - startedAt }
  }

  // ---- Folds ----------------------------------------------------------------------

  function merge(): CostBucket[] {
    return mergeCostBuckets([...fileCache.values()].map((c) => c.buckets))
  }

  async function scanMerged(): Promise<UsageScanMerged> {
    const { tasks, scanMs } = await ensureScanned()
    return { mergedBuckets: merge(), fileCount: tasks.length, scanMs }
  }

  async function scanBi(): Promise<UsageScanBi> {
    const { tasks, scanMs } = await ensureScanned()

    const mergedBuckets = merge()

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

  return {
    merged: scanMerged,
    bi: scanBi,
    ledger: readMeasuredLedger,
    flush: async () => {
      if (cacheLoaded) await saveCache()
    }
  }
}

// ---- Worker entry ---------------------------------------------------------------

const roots = (workerData as Partial<UsageScanWorkerData> | null)?.usageScan
if (!isMainThread && parentPort && roots) {
  const port = parentPort
  const scanner = createUsageScanner(roots)
  port.on('message', ({ id, want, dir }: UsageScanRequest) => {
    scanner[want](dir ?? '').then(
      (value) => port.postMessage({ id, ok: true, value } satisfies UsageScanReply),
      (err) => port.postMessage({ id, ok: false, error: String(err) } satisfies UsageScanReply)
    )
  })
}
