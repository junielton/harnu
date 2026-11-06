/**
 * T590 — pure view-model for the Scheduler takeover's folder-grouped worker list
 * (approved mockup `pastas--combinada`, `docs/specs/2026-10-29-scheduler-folders/`).
 *
 * No Vue import, so it unit-tests in the plain `node` vitest environment like
 * `scheduler-format.ts`. The view feeds it `ListEntry`s (a worker + what the
 * renderer knows about it right now) and renders what comes back: grouping,
 * sorting, filtering, the Up next strip, the run ticks and the cycle bar all
 * live here so the components stay thin.
 */

import type { WorkerDisplayState } from './scheduler-format'
import { folderHue, folderInitial, type FolderHue } from '../lib/folder-hue'
import type { Run, Worker } from '../../../preload'

// ── folder hue (design.md §2 "Folder hue") ─────────────────────────────────

// Moved to the shared lib in T591 so the System Monitor uses the very same rule.
export { FOLDER_HUES, folderHue, folderInitial } from '../lib/folder-hue'
export type { FolderHue } from '../lib/folder-hue'

// ── run ticks ──────────────────────────────────────────────────────────────

export const TICK_COUNT = 10

/** `none` is an empty slot, and also how a skipped / stopped run reads (neither ok nor failed). */
export type TickKind = 'ok' | 'error' | 'timeout' | 'running' | 'none'

/**
 * The last ten runs, oldest left, newest right. Runs arrive oldest-first. A live
 * tick takes the rightmost slot as `running` (and pushes the oldest out); fewer
 * than ten pad on the left so the newest is always the rightmost tick.
 */
export function runTicks(runs: readonly Run[], running: boolean): TickKind[] {
  const kinds: TickKind[] = runs.map((r) =>
    r.status === 'ok' || r.status === 'error' || r.status === 'timeout' ? r.status : 'none'
  )
  if (running) kinds.push('running')
  const tail = kinds.slice(-TICK_COUNT)
  return [...Array<TickKind>(TICK_COUNT - tail.length).fill('none'), ...tail]
}

// ── cadence ────────────────────────────────────────────────────────────────

/**
 * Epoch-ms a worker is next due: its last run's start plus the cadence, `0` when it
 * never ran (treated as due now). Duplicated from main's `nextRunAt` on purpose —
 * `scheduler-core.ts` is main-only per the process-boundary rule.
 */
export function nextDueAt(worker: Worker, runs: readonly Run[]): number {
  const last = runs[runs.length - 1]
  return last ? last.startedAt + worker.everyMinutes * 60_000 : 0
}

// ── entries, filters, search ───────────────────────────────────────────────

/** One worker plus everything the list needs to place and draw it. */
export interface ListEntry {
  worker: Worker
  state: WorkerDisplayState
  running: boolean
  /** Epoch-ms next due (`0` = never ran). */
  nextAt: number
  /** Finished runs, oldest first. */
  runs: readonly Run[]
}

export type StateFilter = 'all' | 'running' | 'failing' | 'waiting' | 'off'

/** Failing is `failed` + `disabled`: both mean "this cadence stopped producing anything trustworthy". */
export function stateFilterFor(state: WorkerDisplayState): Exclude<StateFilter, 'all'> {
  switch (state) {
    case 'running':
      return 'running'
    case 'failed':
    case 'disabled':
      return 'failing'
    case 'off':
      return 'off'
    default:
      return 'waiting'
  }
}

/** Case-insensitive match on worker name, folder name, folder path and prompt. A blank query matches all. */
export function matchesSearch(worker: Worker, folderName: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [worker.name, folderName, worker.folder, worker.prompt].some((field) =>
    field.toLowerCase().includes(q)
  )
}

export function filterEntries(
  entries: readonly ListEntry[],
  opts: { query: string; filter: StateFilter; folderName: (path: string) => string }
): ListEntry[] {
  return entries.filter(
    (e) =>
      matchesSearch(e.worker, opts.folderName(e.worker.folder), opts.query) &&
      (opts.filter === 'all' || stateFilterFor(e.state) === opts.filter)
  )
}

export function chipCounts(entries: readonly ListEntry[]): Record<StateFilter, number> {
  const counts: Record<StateFilter, number> = {
    all: entries.length,
    running: 0,
    failing: 0,
    waiting: 0,
    off: 0
  }
  for (const e of entries) counts[stateFilterFor(e.state)]++
  return counts
}

// ── folder groups ──────────────────────────────────────────────────────────

export interface FolderInfo {
  name: string
  branch: string | null
}

export type FolderSummary =
  { kind: 'running' } | { kind: 'next'; nextAt: number } | { kind: 'none' }

export interface FolderGroup {
  path: string
  name: string
  initial: string
  hue: FolderHue
  branch: string | null
  entries: ListEntry[]
  total: number
  /** Enabled workers (a failing-but-armed worker is still on). */
  on: number
  /** Workers that are not enabled (switched off, or auto-disabled). */
  off: number
  running: number
  failing: number
  summary: FolderSummary
  /** Fractions of `total`, for the header health bar. */
  health: { running: number; failing: number; waiting: number; off: number }
}

/**
 * Inside a folder: enabled workers above off ones; within each band, pinned first
 * (by `pinnedAt`), then storage order. Runtime state never decides a position.
 */
function rowOrder(a: ListEntry, b: ListEntry): number {
  if (a.worker.enabled !== b.worker.enabled) return a.worker.enabled ? -1 : 1
  const pa = typeof a.worker.pinnedAt === 'number' ? a.worker.pinnedAt : Infinity
  const pb = typeof b.worker.pinnedAt === 'number' ? b.worker.pinnedAt : Infinity
  if (pa === pb) return 0
  return pa < pb ? -1 : 1
}

/**
 * Group by folder, in a fixed order: alphabetical by folder name, then path —
 * activity never moves a folder. Inside a folder enabled workers sit above off
 * ones, and within each band a pinned worker sorts first (by `pinnedAt`), then
 * storage order — see `rowOrder`.
 */
export function buildFolderGroups(
  entries: readonly ListEntry[],
  info: (path: string) => FolderInfo
): FolderGroup[] {
  const byPath = new Map<string, ListEntry[]>()
  for (const e of entries) {
    const list = byPath.get(e.worker.folder)
    if (list) list.push(e)
    else byPath.set(e.worker.folder, [e])
  }

  const groups: FolderGroup[] = []
  for (const [path, list] of byPath) {
    const { name, branch } = info(path)
    // `Array.prototype.sort` is stable, so equal pin times keep storage order.
    const sorted = [...list].sort(rowOrder)
    const total = sorted.length
    let on = 0
    let running = 0
    let failing = 0
    let waiting = 0
    let offState = 0
    let nextAt: number | null = null
    for (const e of sorted) {
      if (e.worker.enabled) on++
      switch (stateFilterFor(e.state)) {
        case 'running':
          running++
          break
        case 'failing':
          failing++
          break
        case 'waiting':
          waiting++
          break
        default:
          offState++
      }
      if (e.worker.enabled && !e.running && (nextAt === null || e.nextAt < nextAt))
        nextAt = e.nextAt
    }
    const summary: FolderSummary =
      running > 0
        ? { kind: 'running' }
        : nextAt !== null
          ? { kind: 'next', nextAt }
          : { kind: 'none' }
    groups.push({
      path,
      name,
      initial: folderInitial(name),
      hue: folderHue(path),
      branch,
      entries: sorted,
      total,
      on,
      off: total - on,
      running,
      failing,
      summary,
      health: {
        running: running / total,
        failing: failing / total,
        waiting: waiting / total,
        off: offState / total
      }
    })
  }

  return groups.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.path.localeCompare(b.path)
  )
}

/** The default selection is the first row in display order: the first row of the first folder. */
export function defaultSelectionId(groups: readonly FolderGroup[]): string | null {
  return groups[0]?.entries[0]?.worker.id ?? null
}

// ── Up next ────────────────────────────────────────────────────────────────

export interface UpNextItem {
  worker: Worker
  /** The worker is running right now. */
  now: boolean
  /** Ms until due; `0` when running or overdue. */
  inMs: number
  nextAt: number
}

/**
 * The next due runs across every folder: running first, then soonest. Off and
 * auto-disabled workers are never due. An armed worker whose last tick failed is
 * still on its cadence, so it is listed.
 */
export function upNext(entries: readonly ListEntry[], nowMs: number, limit = 4): UpNextItem[] {
  return entries
    .filter((e) => e.running || e.worker.enabled)
    .map((e) => ({
      running: e.running,
      item: {
        worker: e.worker,
        now: e.running || e.nextAt - nowMs < 1000,
        inMs: e.running || e.nextAt - nowMs < 1000 ? 0 : e.nextAt - nowMs,
        nextAt: e.nextAt
      }
    }))
    .sort((a, b) => Number(b.running) - Number(a.running) || a.item.inMs - b.item.inMs)
    .slice(0, limit)
    .map((x) => x.item)
}

/** The collapsed strip shows one line: the single next run. */
export function upNextSummaryOf(items: readonly UpNextItem[]): UpNextItem | null {
  return items[0] ?? null
}
