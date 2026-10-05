/**
 * Containers prefs (PRD §6, provisional defaults), persisted to
 * `<userData>/containers-prefs.json`. Pure defaults and normalization, plus a
 * thin read/atomic-write shell that takes the file path — the same split as
 * the Reaper's `prefs.ts`, minus the Electron import.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ContainersPrefs } from './containers-wire'

export const PREFS_FILE = 'containers-prefs.json'

/** Reaper's bounds (PRD §6): 30 minutes to 24 hours. */
export const MIN_INTERVAL_MS = 1_800_000
export const MAX_INTERVAL_MS = 86_400_000
export const MIN_ZOMBIE_AFTER_DAYS = 1

export function prefsFile(userDataDir: string): string {
  return path.join(userDataDir, PREFS_FILE)
}

export function defaultPrefs(): ContainersPrefs {
  return {
    version: 1,
    autoScan: true,
    intervalMs: 3_600_000,
    zombieAfterDays: 2,
    notifyOnNewZombies: true
  }
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Tolerates junk (wrong types, missing keys, out-of-range numbers); always clamps. */
export function normalizePrefs(raw: unknown): ContainersPrefs {
  const fallback = defaultPrefs()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const r = raw as Record<string, unknown>

  const interval = finiteNumber(r.intervalMs)
  const zombieDays = finiteNumber(r.zombieAfterDays)
  return {
    version: 1,
    autoScan: typeof r.autoScan === 'boolean' ? r.autoScan : fallback.autoScan,
    intervalMs:
      interval === null
        ? fallback.intervalMs
        : Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(interval))),
    zombieAfterDays:
      zombieDays === null
        ? fallback.zombieAfterDays
        : Math.max(MIN_ZOMBIE_AFTER_DAYS, Math.round(zombieDays)),
    notifyOnNewZombies:
      typeof r.notifyOnNewZombies === 'boolean' ? r.notifyOnNewZombies : fallback.notifyOnNewZombies
  }
}

export async function readPrefs(file: string): Promise<ContainersPrefs> {
  try {
    return normalizePrefs(JSON.parse(await fs.readFile(file, 'utf8')))
  } catch {
    return defaultPrefs()
  }
}

/** Atomic: write `<file>.tmp`, then rename over the target. */
export async function writePrefs(file: string, prefs: ContainersPrefs): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(normalizePrefs(prefs), null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}
