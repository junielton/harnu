/**
 * The rollout-mode seam of the companion host (T389 P1W1 §7.2).
 *
 * `<userData>/companion-prefs.json` is owned by P1W4; this wave reads only the developer key
 * `mode`, and a missing, unreadable or invalid file reads `off` (no disclosure exists yet, so
 * nothing may listen on a guess). P1W4 keeps these signatures and replaces the bodies.
 *
 * Electron-free on purpose: the shell tells it where the file is (`setCompanionPrefsPath`), so the
 * seam is unit-tested without a stub of `electron`.
 */

import { promises as fs } from 'node:fs'

export type CompanionMode = 'off' | 'shadow' | 'active'

export type FactFamily =
  | 'identity'
  | 'taskState'
  | 'telemetry'
  | 'planUsage'
  | 'approval'
  | 'guard'
  | 'startPrompt'
  | 'message'

let prefsPath: string | null = null
let mode: CompanionMode = 'off'
const listeners = new Set<() => void>()

const MODES: ReadonlySet<string> = new Set(['off', 'shadow', 'active'])

/** Pure: the developer key `mode` of the prefs file, `off` for anything unusable. */
export function parseCompanionPrefs(raw: string): CompanionMode {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'off'
    const m = (parsed as Record<string, unknown>).mode
    return typeof m === 'string' && MODES.has(m) ? (m as CompanionMode) : 'off'
  } catch {
    return 'off'
  }
}

/** Where `companion-prefs.json` lives; `null` means no file is read and the mode is `off`. */
export function setCompanionPrefsPath(path: string | null): void {
  prefsPath = path
  mode = 'off'
}

/** Sync and cached: the value read by the last `hydrateCompanionMode()`; `off` before that. */
export function getCompanionMode(): CompanionMode {
  return mode
}

/** P1W1: every family follows the global mode. */
export function familyMode(_family: FactFamily, _folder: string | null): CompanionMode {
  return mode
}

/**
 * Should the socket exist? P1W1: `getCompanionMode() !== 'off'`. P1W4 replaces the body (kill
 * switch on, and some family or the developer `mode` key not `off`); it never reads the CLI gate,
 * which is per binary and still `unknown` when the host boots.
 */
export function listenerWanted(): boolean {
  return mode !== 'off'
}

/** Reads the prefs file once; fires `onModeChange` listeners when the answer changed. */
export async function hydrateCompanionMode(): Promise<void> {
  const before = { mode, wanted: listenerWanted() }
  let next: CompanionMode = 'off'
  if (prefsPath !== null) {
    try {
      next = parseCompanionPrefs(await fs.readFile(prefsPath, 'utf8'))
    } catch {
      next = 'off' // a missing file is the normal case
    }
  }
  mode = next
  if (before.mode !== mode || before.wanted !== listenerWanted()) {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        // one listener's failure never stops the others
      }
    }
  }
}

/** Fires when a prefs write, the kill switch or the settled CLI-version probe changes the answer. */
export function onModeChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
