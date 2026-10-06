/**
 * The rollout-mode seam of the companion host (T389 P1W1 §7.2; bodies by P1W4 §7.1, §7.3).
 *
 * P1W1 owns the types and the signatures, P1W4 the bodies: `<userData>/companion-prefs.json`
 * holds the kill switch, the per-family modes and the ramp escape hatch, and the shipped default
 * is `shadow` for every family behind the disclosure (OD-1). The store is `companion-prefs.ts`,
 * the arithmetic `arbitration-core.ts` and `companion-prefs-core.ts`.
 *
 * Electron-free on purpose: the shell tells the store where the file is (`setCompanionPrefsPath`).
 */

import { effectiveMode, normalizeFolder } from './arbitration-core'
import {
  companionMode,
  hydrateCompanionPrefs,
  listenerWantedNow,
  rolloutView
} from './companion-prefs'

export { onModeChange, setCompanionPrefsPath } from './companion-prefs'

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

/**
 * Sync and cached. `off` when the kill switch is off or the CLI gate is `below` or `unknown`;
 * `active` when some family is effectively `active` for some folder; else `shadow`.
 */
export function getCompanionMode(): CompanionMode {
  return companionMode()
}

/** The family's mode for a folder (`null`: no folder, so never on the ramp). */
export function familyMode(family: FactFamily, folder: string | null): CompanionMode {
  return effectiveMode(
    family,
    folder === null || folder === '' ? null : normalizeFolder(folder),
    rolloutView()
  )
}

/**
 * Should the socket exist? The kill switch is on and the developer `mode` key or some family is
 * not `off`. It never reads the CLI gate, which is per binary and still `unknown` when the host
 * boots; the gate decides injection and `enable`, not whether the host exists.
 */
export function listenerWanted(): boolean {
  return listenerWantedNow()
}

/** Reads the prefs file once; fires `onModeChange` listeners when the answer changed. */
export function hydrateCompanionMode(): Promise<void> {
  return hydrateCompanionPrefs()
}
