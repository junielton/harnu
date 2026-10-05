// User-tunable prefs for the Reaper background scan (plan Task 13,
// `docs/plans/2026-07-15-reaper-cleanup.md`). Pure defaults/normalization
// (`defaultPrefs`/`normalizePrefs`) are exercised directly by
// `tests/reaper-prefs.test.ts`; `readPrefs`/`writePrefs` are the thin disk
// shell, same split as `journal.ts`.

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface ReaperPrefs {
  version: 1
  autoScan: boolean
  intervalMs: number
  neverDeleteRemote: boolean
  protectedBranches: string[]
  minAgeDays: number
  notifyOnHarvestable: boolean
  /**
   * Dehydrate defaults (T250): how many days since a worktree's last commit
   * before a repo's "Dehydrate N idle" action counts it as idle. The per-row
   * Dehydrate button ignores it — an operator clicking one row has decided.
   * Dehydration stays manual in v1; there is deliberately no auto-dehydrate
   * switch yet (spec, "Open questions").
   */
  dehydrateIdleDays: number
}

const MIN_INTERVAL_MS = 1_800_000 // 30 minutes
const MAX_INTERVAL_MS = 86_400_000 // 24 hours
const MAX_IDLE_DAYS = 365

export function defaultPrefs(): ReaperPrefs {
  return {
    version: 1,
    autoScan: true,
    intervalMs: 3_600_000,
    neverDeleteRemote: false,
    protectedBranches: ['main', 'master', 'develop'],
    minAgeDays: 0,
    notifyOnHarvestable: true,
    dehydrateIdleDays: 7
  }
}

/** Tolerates junk input (wrong types, missing keys, out-of-range numbers) and
 *  always returns a fully-populated, clamped `ReaperPrefs`. */
export function normalizePrefs(raw: unknown): ReaperPrefs {
  const fallback = defaultPrefs()
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>

  const autoScan = typeof r.autoScan === 'boolean' ? r.autoScan : fallback.autoScan
  const intervalMs =
    typeof r.intervalMs === 'number' && Number.isFinite(r.intervalMs)
      ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(r.intervalMs)))
      : fallback.intervalMs
  const neverDeleteRemote =
    typeof r.neverDeleteRemote === 'boolean' ? r.neverDeleteRemote : fallback.neverDeleteRemote
  const protectedBranches = Array.isArray(r.protectedBranches)
    ? r.protectedBranches.filter((b): b is string => typeof b === 'string' && b.trim().length > 0)
    : fallback.protectedBranches
  const minAgeDays =
    typeof r.minAgeDays === 'number' && Number.isFinite(r.minAgeDays)
      ? Math.max(0, Math.round(r.minAgeDays))
      : fallback.minAgeDays
  const notifyOnHarvestable =
    typeof r.notifyOnHarvestable === 'boolean'
      ? r.notifyOnHarvestable
      : fallback.notifyOnHarvestable
  const dehydrateIdleDays =
    typeof r.dehydrateIdleDays === 'number' && Number.isFinite(r.dehydrateIdleDays)
      ? Math.min(MAX_IDLE_DAYS, Math.max(0, Math.round(r.dehydrateIdleDays)))
      : fallback.dehydrateIdleDays

  return {
    version: 1,
    autoScan,
    intervalMs,
    neverDeleteRemote,
    protectedBranches,
    minAgeDays,
    notifyOnHarvestable,
    dehydrateIdleDays
  }
}

export function prefsPath(): string {
  return path.join(app.getPath('userData'), 'reaper-prefs.json')
}

export async function readPrefs(): Promise<ReaperPrefs> {
  try {
    const content = await fs.readFile(prefsPath(), 'utf8')
    return normalizePrefs(JSON.parse(content))
  } catch {
    return defaultPrefs()
  }
}

/** Atomic tmp+rename write (copies `writeUserProjects`, `user-projects.ts:259`). */
export async function writePrefs(prefs: ReaperPrefs): Promise<void> {
  const filePath = prefsPath()
  const dir = path.dirname(filePath)
  const tmpPath = filePath + '.tmp'

  await fs.mkdir(dir, { recursive: true })
  const body = JSON.stringify(prefs, null, 2) + '\n'
  await fs.writeFile(tmpPath, body, 'utf8')
  await fs.rename(tmpPath, filePath)
}
