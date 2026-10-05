import { homedir } from 'node:os'
import { join } from 'node:path'
import { scanFoldersUncached, type ReadOptions } from './claude-reader'
import type { FolderEntry } from './folder-model'
import {
  EMPTY_FLEET_STATE,
  deriveFolders,
  flattenFolders,
  membershipSignature,
  mergeSlugSessions,
  replaceAllSessions,
  type FleetState
} from './fleet-model-core'

/**
 * Central in-memory fleet model (T123 spec §5.1 W1 / Task A brief).
 *
 * This is the ONE place the main process holds the fleet in memory. Every
 * consumer that used to call `scanFolders()` (MCP `handleToolCall`,
 * `memory-digest`, memory/markdown root resolution,
 * `foldersLoad`) now transparently reads this model via `scanFolders()`
 * itself (see `claude-reader.ts`), which delegates the full-scan (no-opts)
 * case to {@link getFleetFolders} here.
 *
 * Design (mirrors the pure/impure split in `fleet-model-core.ts`):
 *  - **Boot**: the first call to `getFleetFolders()` runs ONE full scan
 *    (`scanFoldersUncached({})`, main thread — S2 moves this off-thread) and
 *    populates the model. Concurrent callers during that window share the
 *    SAME in-flight promise (single-flight — AC2).
 *  - **Post-boot reads**: `getFleetFolders()` never touches disk. It returns
 *    the model's current, memoized `FolderEntry[]` — the SAME array reference
 *    to every caller until the next state change (AC1 — zero disk scans on
 *    the consumer call paths).
 *  - **Incremental refresh**: {@link notifySlugChanged} (wired from the
 *    chokidar watcher's typed per-slug events) schedules a fixed-window
 *    coalesced, slug-scoped rescan (`scanFoldersUncached({ slugsFilter })`)
 *    and merges just that slug's fresh sessions into the model (AC3) — never
 *    a full rescan for an ordinary create/append/remove. Append-only events
 *    are rate-limited per slug (sidebar-liveness spec §4.C C4): at most one
 *    pass every {@link APPEND_MIN_INTERVAL_MS}, so `get_fleet`'s append fields
 *    (`fileMtime`, `transcriptState`, `ctxPct`, `awaySummary`) may lag the
 *    transcript by up to ~2.3 s; membership events keep the 250 ms window.
 *  - **Ready gap-close**: {@link notifyWatcherReady} (chokidar `ready`) runs
 *    one full rescan to catch anything that hit disk between the boot scan
 *    and the watch registration going live.
 *  - **Degraded fallback**: {@link notifyWatcherDegraded} runs a full rescan
 *    AND keeps poll-rescanning on an interval while the watcher is unhealthy
 *    — a watcher that errored can no longer be trusted to report deltas.
 *  - **Change push**: {@link onFleetChanged} listeners hear about every
 *    refresh that changed the model's MEMBERSHIP (sessions per folder, git
 *    identity — sidebar-liveness spec §3 D1), whatever triggered it; pure
 *    appends never fire it.
 *
 * All scan I/O funnels through `scanFoldersUncached` (exported by
 * `claude-reader.ts` for exactly this purpose) — this module owns caching,
 * refresh policy, and the "one shared model" invariant; `claude-reader.ts`
 * keeps owning the actual disk-scanning mechanics.
 */

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects')

/** Debounce window for coalescing a burst of watcher events into one rescan. */
const DEBOUNCE_MS = 250

/** Minimum gap between two passes of one slug when only appends are pending (spec §4.C C4). */
const APPEND_MIN_INTERVAL_MS = 2000

/**
 * What a watcher event can change: `membership` (session/subagent add or
 * unlink, a project dir, an index rewrite) or `append` (new lines in a
 * transcript the model already lists).
 */
export type SlugChangeClass = 'membership' | 'append'

let rootDirOverride: string | null = null
function rootDir(): string {
  return rootDirOverride ?? DEFAULT_ROOT
}

let state: FleetState = EMPTY_FLEET_STATE
let cachedFolders: FolderEntry[] | null = null
let cachedVersion = -1

/** Derive (or reuse the memoized) `FolderEntry[]` view for the current state. */
function currentFolders(): FolderEntry[] {
  if (cachedFolders && cachedVersion === state.version) return cachedFolders
  cachedFolders = deriveFolders(state)
  cachedVersion = state.version
  return cachedFolders
}

let booted = false
let bootScan: Promise<FolderEntry[]> | null = null

/**
 * The public read: past boot, a synchronous (already-resolved) read of the
 * shared model — zero disk I/O, zero per-call scan (AC1). Before boot, single-
 * flights the initial full scan so a burst of concurrent callers shares ONE
 * scan and ONE resulting array reference (AC2).
 */
export async function getFleetFolders(): Promise<FolderEntry[]> {
  if (booted) return currentFolders()
  if (bootScan) return bootScan
  bootScan = runBootScan()
  try {
    return await bootScan
  } finally {
    bootScan = null
  }
}

async function runBootScan(): Promise<FolderEntry[]> {
  scanStats.fullScans += 1
  const folders = await scanFoldersUncached({ rootDir: rootDirOverride ?? undefined })
  const { sessions, gitByPath } = flattenFolders(folders)
  state = replaceAllSessions(state, sessions, gitByPath)
  noteRefresh([], true)
  booted = true
  // Watcher events that arrived DURING the boot scan were queued but not
  // drained (the debounce callback defers while !booted). Re-schedule now so
  // nothing that raced the boot scan is lost.
  if (pendingSlugs.size > 0 || fullRescanRequested) scheduleDebouncedRefresh()
  return currentFolders()
}

// ---------------------------------------------------------------------------
// Incremental refresh (watcher-driven)
// ---------------------------------------------------------------------------

const pendingSlugs = new Set<string>()
let fullRescanRequested = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let refreshInFlight: Promise<void> | null = null

/**
 * FIXED-WINDOW coalescing, not a sliding debounce: the first event arms the
 * timer, later events within the window do NOT re-arm it. A sliding debounce
 * (clear + re-arm per event) would starve the refresh indefinitely under a
 * busy fleet — sub-250ms inter-event gaps are exactly the T123 workload, and
 * with the old 2s TTL cache gone there is no backstop; staleness must be
 * bounded by THIS timer. Fixed-window guarantees a refresh at most
 * `DEBOUNCE_MS` after the first unprocessed event, no matter how hot the
 * event stream is.
 *
 * Pre-boot events are queued (pendingSlugs / fullRescanRequested persist) but
 * the drain is deferred until boot completes — `runBootScan` re-schedules if
 * anything queued up while it was scanning, so no event is dropped.
 */
function scheduleDebouncedRefresh(): void {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    // Not booted yet — keep the queue; runBootScan re-schedules on completion.
    if (!booted) return
    void runPendingRefresh()
  }, debounceMsOverride ?? DEBOUNCE_MS)
}

/** Slugs waiting on an append-only pass → the earliest time that pass may run. */
const pendingAppendSlugs = new Map<string, number>()
/** When each slug's last pass started — the append cadence is measured from it. */
const lastPassAt = new Map<string, number>()
let appendTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Chokidar reported a change for `slug` — schedule a slug-scoped rescan.
 *
 * `membership` (the default) joins the fixed 250 ms window and upgrades any
 * append already waiting for that slug. `append` runs the slug no sooner than
 * {@link APPEND_MIN_INTERVAL_MS} after its previous pass: a busy transcript
 * writes several lines a second, and each pass re-reads the whole slug.
 */
export function notifySlugChanged(slug: string, cls: SlugChangeClass = 'membership'): void {
  if (!slug) return
  if (cls === 'membership') {
    pendingAppendSlugs.delete(slug)
    pendingSlugs.add(slug)
    scheduleDebouncedRefresh()
    return
  }
  // Already queued for a pass (membership, or an append slot that came due).
  if (pendingSlugs.has(slug) || pendingAppendSlugs.has(slug)) return
  const last = lastPassAt.get(slug)
  const dueAt = last === undefined ? 0 : last + (appendIntervalMsOverride ?? APPEND_MIN_INTERVAL_MS)
  if (dueAt <= Date.now()) {
    pendingSlugs.add(slug)
    scheduleDebouncedRefresh()
    return
  }
  pendingAppendSlugs.set(slug, dueAt)
  scheduleAppendTimer()
}

/** Arm the one shared append timer for the earliest pending slot. */
function scheduleAppendTimer(): void {
  if (appendTimer) clearTimeout(appendTimer)
  appendTimer = null
  if (pendingAppendSlugs.size === 0) return
  const earliest = Math.min(...pendingAppendSlugs.values())
  appendTimer = setTimeout(
    () => {
      appendTimer = null
      const now = Date.now()
      for (const [slug, dueAt] of pendingAppendSlugs) {
        if (dueAt > now) continue
        pendingAppendSlugs.delete(slug)
        pendingSlugs.add(slug)
      }
      scheduleAppendTimer()
      // The slot already waited out the cadence — no extra 250 ms window.
      if (pendingSlugs.size > 0) void runPendingRefresh()
    },
    Math.max(0, earliest - Date.now())
  )
}

/**
 * The chokidar watcher finished its initial registration (`ready`). Events
 * that hit disk between the boot scan's readdir and the watch registration
 * were never reported to anyone — for a session that then goes quiet (created-
 * then-silent, or removed in the gap) they would be lost FOREVER. One full
 * rescan at ready closes that gap: it observes everything the boot scan and
 * the (now live) watcher could each have missed.
 */
export function notifyWatcherReady(): void {
  fullRescanRequested = true
  scheduleDebouncedRefresh()
}

/**
 * How often to poll-rescan while the watcher is degraded. Generous — this is
 * a safety net for a watcher that can no longer be trusted to report deltas
 * (ENOSPC/EMFILE/…), not a hot loop. chokidar never reports recovery, so the
 * poll runs until app exit; it is `unref`ed so it never keeps the process
 * alive on its own.
 */
const DEGRADED_POLL_MS = 45_000
let degradedPollTimer: ReturnType<typeof setInterval> | null = null

/**
 * The watcher degraded — fall back to a full rescan now (spec §5.1) AND keep
 * poll-rescanning on an interval: a one-shot rescan would trust the broken
 * watcher again immediately, reintroducing unbounded staleness for everything
 * that changes after the degrade.
 */
export function notifyWatcherDegraded(): void {
  fullRescanRequested = true
  scheduleDebouncedRefresh()
  if (!degradedPollTimer) {
    degradedPollTimer = setInterval(() => {
      fullRescanRequested = true
      scheduleDebouncedRefresh()
    }, degradedPollMsOverride ?? DEGRADED_POLL_MS)
    degradedPollTimer.unref?.()
  }
}

async function runPendingRefresh(): Promise<void> {
  if (refreshInFlight) {
    await refreshInFlight
    return
  }
  refreshInFlight = drainRefresh()
  try {
    await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

/** Drains every queued refresh (slugs and/or a full-rescan request) — single-flighted. */
async function drainRefresh(): Promise<void> {
  while (fullRescanRequested || pendingSlugs.size > 0) {
    if (fullRescanRequested) {
      fullRescanRequested = false
      pendingSlugs.clear()
      const waiters = fullRescanWaiters
      fullRescanWaiters = []
      try {
        scanStats.fullScans += 1
        const folders = await scanFoldersUncached({ rootDir: rootDirOverride ?? undefined })
        const { sessions, gitByPath } = flattenFolders(folders)
        state = replaceAllSessions(state, sessions, gitByPath)
        noteRefresh([], true)
      } catch (err) {
        console.error('[fleet-model] full rescan failed', err)
      } finally {
        for (const w of waiters) w()
      }
      continue
    }
    const slugs = [...pendingSlugs]
    pendingSlugs.clear()
    // Stamped at the START of the pass: an append landing mid-scan is not seen
    // by it, so its slot is measured from here.
    const startedAt = Date.now()
    for (const s of slugs) lastPassAt.set(s, startedAt)
    try {
      const opts: ReadOptions = { slugsFilter: slugs }
      if (rootDirOverride) opts.rootDir = rootDirOverride
      scanStats.slugScans += 1
      const folders = await scanFoldersUncached(opts)
      const { sessions, gitByPath } = flattenFolders(folders)
      state = mergeSlugSessions(state, rootDir(), slugs, sessions, gitByPath)
      noteRefresh(slugs, false)
    } catch (err) {
      console.error('[fleet-model] slug refresh failed', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Change push (sidebar-liveness spec §4.A A3)
// ---------------------------------------------------------------------------

/** One membership change of the model, as pushed to the renderer (`fleet:changed`). */
export interface FleetChange {
  version: number
  /** Slugs whose refresh produced this change; empty when `full` is true. */
  slugs: string[]
  /** True when a full rescan (boot, ready, degraded poll, Rescan) produced it. */
  full: boolean
}

const changeListeners = new Set<(c: FleetChange) => void>()
let lastSignature: string | null = null
let lastSignatureVersion = -1
const coveredSlugs = new Set<string>()
let coveredFull = false

/** Subscribe to membership changes of the model. Returns the unsubscribe. */
export function onFleetChanged(listener: (c: FleetChange) => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/**
 * Called after every successful refresh (boot, full rescan, slug pass). Every
 * refresh counts as coverage — "the model looked at this slug" — even when it
 * changed nothing, because the renderer's migrated-row rule (D8) gates on what
 * the model has SEEN. Coverage accumulates until the next emit; an emit fires
 * only when the membership signature moved (D1). The boot scan only sets the
 * baseline: the renderer's own `foldersLoad` reads that state.
 */
function noteRefresh(slugs: string[], full: boolean): void {
  if (full) coveredFull = true
  else for (const s of slugs) coveredSlugs.add(s)
  // Same version → same state object → same membership; skip the sort.
  if (state.version === lastSignatureVersion) return
  lastSignatureVersion = state.version
  const sig = membershipSignature(state)
  if (sig === lastSignature) return
  const isBaseline = lastSignature === null
  lastSignature = sig
  if (isBaseline) {
    coveredSlugs.clear()
    coveredFull = false
    return
  }
  // A slug dirty again at emit time (an event landed while its scan ran) may
  // have been read before that event's session existed: reporting it as
  // covered would let the renderer drop a just-migrated row on a stale read
  // (D8). Leave it out — its next refresh covers it. A full rescan raced by
  // such an event is downgraded to the slugs it can still vouch for.
  const vouchFull = coveredFull && pendingSlugs.size === 0
  const change: FleetChange = {
    version: state.version,
    slugs: vouchFull ? [] : [...coveredSlugs].filter((s) => !pendingSlugs.has(s)),
    full: vouchFull
  }
  coveredSlugs.clear()
  coveredFull = false
  for (const listener of changeListeners) {
    try {
      listener(change)
    } catch (err) {
      console.error('[fleet-model] onFleetChanged listener threw', err)
    }
  }
}

let fullRescanWaiters: Array<() => void> = []

/**
 * Rescan (spec §4.D SW-1): ONE full rescan of the model, resolving with the
 * refreshed folders once the drain that consumed the request finishes. Before
 * boot the boot scan IS that one scan. Changes it finds reach `fleet:changed`
 * listeners like any other refresh.
 */
export async function requestFullRescan(): Promise<FolderEntry[]> {
  if (!booted) return getFleetFolders()
  await new Promise<void>((resolve) => {
    fullRescanWaiters.push(resolve)
    fullRescanRequested = true
    scheduleDebouncedRefresh()
  })
  return currentFolders()
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

interface ScanStats {
  /** Full scans (`scanFoldersUncached({})` — boot + degraded-fallback rescans). */
  fullScans: number
  /** Slug-scoped incremental scans (`scanFoldersUncached({ slugsFilter })`). */
  slugScans: number
}
let scanStats: ScanStats = { fullScans: 0, slugScans: 0 }

/** Test-only: current scan counters (AC1/AC2/AC3 assertions — no real disk scans on a model read). */
export function __fleetScanStatsForTests(): ScanStats {
  return { ...scanStats }
}

/** Test-only: point the model at an isolated fixture root instead of `~/.claude/projects`. */
export function __setRootDirForTests(dir: string | null): void {
  rootDirOverride = dir
}

let debounceMsOverride: number | null = null
/** Test-only: shrink the refresh debounce so incremental-update tests don't wait 250ms for real. */
export function __setDebounceMsForTests(ms: number | null): void {
  debounceMsOverride = ms
}

let appendIntervalMsOverride: number | null = null
/** Test-only: override the append-only cadence ({@link APPEND_MIN_INTERVAL_MS}); `null` restores it. */
export function __setAppendIntervalMsForTests(ms: number | null): void {
  appendIntervalMsOverride = ms
}

let degradedPollMsOverride: number | null = null
/** Test-only: shrink the degraded poll interval so the poll loop is observable in a test. */
export function __setDegradedPollMsForTests(ms: number | null): void {
  degradedPollMsOverride = ms
}

/**
 * Test-only: reset every module-level singleton to its pre-boot state.
 *
 * Awaits any in-flight `drainRefresh()` FIRST, before clearing anything else.
 * `drainRefresh` closes over the module-level `state`/`pendingSlugs`/etc — if
 * a prior test's refresh were still running when we swap `state` back to
 * `EMPTY_FLEET_STATE`, its eventual `state = mergeSlugSessions(...)` /
 * `state = replaceAllSessions(...)` assignment would land AFTER the reset,
 * silently reintroducing stale data into what the next test expects to be a
 * fresh, empty model.
 */
export async function __resetFleetModelForTests(): Promise<void> {
  if (refreshInFlight) await refreshInFlight
  state = EMPTY_FLEET_STATE
  cachedFolders = null
  cachedVersion = -1
  booted = false
  bootScan = null
  pendingSlugs.clear()
  fullRescanRequested = false
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  pendingAppendSlugs.clear()
  lastPassAt.clear()
  if (appendTimer) clearTimeout(appendTimer)
  appendTimer = null
  if (degradedPollTimer) clearInterval(degradedPollTimer)
  degradedPollTimer = null
  refreshInFlight = null
  changeListeners.clear()
  lastSignature = null
  lastSignatureVersion = -1
  coveredSlugs.clear()
  coveredFull = false
  const waiters = fullRescanWaiters
  fullRescanWaiters = []
  for (const w of waiters) w()
  scanStats = { fullScans: 0, slugScans: 0 }
  rootDirOverride = null
  debounceMsOverride = null
  appendIntervalMsOverride = null
  degradedPollMsOverride = null
}

/**
 * Test-only: await the refresh pass currently running, if any — and only that. Unlike
 * {@link __flushPendingRefreshForTests} it never forces a pass or fires a waiting slot, so a
 * fake-timer test can let a pass's real disk read finish between time steps without
 * masking a timer that never fires.
 */
export async function __awaitRefreshIdleForTests(): Promise<void> {
  while (refreshInFlight) await refreshInFlight
}

/** Test-only: await any in-flight/scheduled refresh (append slots included) so assertions see the settled model. */
export async function __flushPendingRefreshForTests(): Promise<void> {
  if (pendingAppendSlugs.size > 0) {
    for (const slug of pendingAppendSlugs.keys()) pendingSlugs.add(slug)
    pendingAppendSlugs.clear()
    if (appendTimer) clearTimeout(appendTimer)
    appendTimer = null
    if (!debounceTimer && !refreshInFlight) {
      await runPendingRefresh()
      return
    }
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
    await runPendingRefresh()
  } else if (refreshInFlight) {
    await refreshInFlight
  }
}
