/**
 * T198 — user-tunable prefs for the PR Stack Canvas' FOREGROUND refresh.
 *
 * This is deliberately a separate clock from the Reaper's background scan
 * (`reaper/prefs.ts`, hourly by default). The two measure different kinds of
 * rot: an hour is fine for "is this worktree still needed", and far too slow
 * for "is this PR green right now". The canvas rides the Reaper scan for
 * topology and harvest verdicts, and adds this faster poll only while the
 * takeover is actually open — closing it stops the timer.
 *
 * Pure `defaultPrefs`/`normalizePrefs` are unit-tested; `readPrefs`/
 * `writePrefs` are the thin disk shell, the same split `reaper/prefs.ts` uses.
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface PrStackPrefs {
  version: 1
  /** Poll while the canvas is open. Off leaves the manual button as the only way. */
  autoRefresh: boolean
  intervalMs: number
  /**
   * T278 — draw GitHub labels as chips on the card. Off by default: labels are
   * the one signal whose worth is entirely repo-dependent (a repo that labels
   * liberally would drown the chip row), so the operator opts in per install.
   */
  showLabels: boolean
  /**
   * Option+click on a link to an OPEN PR of the session's own repo shows that
   * card on the PR Stack canvas instead of opening the browser. Off by default:
   * each click costs a `gh pr view` round-trip before anything happens.
   */
  openPrLinksInCanvas: boolean
}

/** 15s is as fast as a `gh` round-trip is worth; 10min is where it stops being "live". */
const MIN_INTERVAL_MS = 15_000
const MAX_INTERVAL_MS = 600_000

export function defaultPrefs(): PrStackPrefs {
  return {
    version: 1,
    autoRefresh: true,
    intervalMs: 90_000,
    showLabels: false,
    openPrLinksInCanvas: false
  }
}

/**
 * Tolerates junk (wrong types, missing keys, out-of-range numbers) and always
 * returns a fully-populated, clamped object — a corrupt prefs file must not be
 * able to stop the canvas from opening.
 */
export function normalizePrefs(raw: unknown): PrStackPrefs {
  const fallback = defaultPrefs()
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  return {
    version: 1,
    autoRefresh: typeof r.autoRefresh === 'boolean' ? r.autoRefresh : fallback.autoRefresh,
    intervalMs:
      typeof r.intervalMs === 'number' && Number.isFinite(r.intervalMs)
        ? Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(r.intervalMs)))
        : fallback.intervalMs,
    // Strictly `true` — a truthy string from a hand-edited file must not opt in.
    showLabels: typeof r.showLabels === 'boolean' ? r.showLabels : fallback.showLabels,
    openPrLinksInCanvas:
      typeof r.openPrLinksInCanvas === 'boolean'
        ? r.openPrLinksInCanvas
        : fallback.openPrLinksInCanvas
  }
}

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'pr-stack-prefs.json')
}

export async function readPrefs(): Promise<PrStackPrefs> {
  try {
    return normalizePrefs(JSON.parse(await fs.readFile(prefsPath(), 'utf8')))
  } catch {
    return defaultPrefs()
  }
}

export async function writePrefs(raw: unknown): Promise<PrStackPrefs> {
  const next = normalizePrefs(raw)
  try {
    await fs.writeFile(prefsPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* disk full / read-only userData — the in-memory value still applies */
  }
  return next
}
