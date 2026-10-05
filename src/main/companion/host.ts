/**
 * Electron shell of the companion host (T389 P1W1 §7.7). Thin on purpose: it feeds `host-core.ts`
 * the app data directory, the real mode seam, the audit log and the power-monitor `resume` event.
 * Every decision is in the tested cores (`host-core`, `server`, `session-table`, `wire-core`).
 *
 * Nothing listens in a default install: the mode file does not exist, so `listenerWanted()` is
 * false and `registerCompanionHost` only hydrates the mode and registers the IPC read.
 */

import { app, powerMonitor, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { appendAudit, configureAuditDir } from './audit-log'
import { registerCompanionIpc } from './companion-ipc'
import { createCompanionHost } from './host-core'
import {
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted,
  onModeChange,
  setCompanionPrefsPath
} from './mode'
import type { SpawnOwner } from './session-table'

export type { CompanionBus, CompanionDiagnostics, CompanionHostFacade } from './host-core'

const core = createCompanionHost({
  dir: () => join(app.getPath('userData'), 'companion'),
  mode: {
    getMode: getCompanionMode,
    listenerWanted,
    hydrate: hydrateCompanionMode,
    onChange: onModeChange
  },
  appendAudit,
  onResume: (fn) => {
    powerMonitor.on('resume', fn)
    return () => void powerMonitor.removeListener('resume', fn)
  }
})

/** What every other wave consumes. Token-free: no `conn`, no spawn token. */
export const companionHost = core.facade

/**
 * Maps a PTY owner to Harnu's row key. P1W2 wires `sessionKeyForPty`; until then a PTY binding's
 * `sessionKey` reads `null` (a tick's key, `tick:<workerId>:<runId>`, needs no resolver).
 */
export function setCompanionSessionKeyResolver(
  fn: ((owner: SpawnOwner) => string | null) | null
): void {
  core.setSessionKeyResolver(fn)
}

/** Called once from `src/main/index.ts` beside `registerHookBridge`. */
export async function registerCompanionHost(_getWindow: () => BrowserWindow | null): Promise<void> {
  const userData = app.getPath('userData')
  setCompanionPrefsPath(join(userData, 'companion-prefs.json'))
  configureAuditDir(join(userData, 'companion'))
  registerCompanionIpc(core.facade)
  await core.register()
}

/** Joins the `before-quit` list beside `closeHookBridge()`. */
export function closeCompanionHost(): Promise<void> {
  return core.close()
}
