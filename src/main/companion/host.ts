/**
 * Electron shell of the companion host (T389 P1W1 §7.7). Thin on purpose: it feeds `host-core.ts`
 * the app data directory, the real mode seam, the audit log and the power-monitor `resume` event.
 * Every decision is in the tested cores (`host-core`, `server`, `session-table`, `wire-core`).
 *
 * P1W4: the shipped default is `shadow` (OD-1), so a default install listens; sessions carry the
 * mod only after the one-time disclosure was rendered (`companionInjectDecision`), and the kill
 * switch (`companion-prefs.json` `enabled`) stops the listener from being wanted at all.
 */

import { app, powerMonitor, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { claudeVersionSync, resolveClaudeVersion } from '../claude-cli'
import { companionActivePaths } from '../user-projects'
import { appendAudit, configureAuditDir } from './audit-log'
import { rolloutView, setCompanionCliGate, setRampFolders } from './companion-prefs'
import { registerCompanionIpc } from './companion-ipc'
import { createCompanionHost } from './host-core'
import { gateForCli } from './enable-policy'
import { createEnablePolicy } from './feature-policy'
import { configureHub } from '../detect/task-state-hub'
import { admit } from './arbitration-core'
import { createIdentityAdapter, type IdentityAdapter } from './identity-adapter'
import {
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted,
  onModeChange,
  setCompanionPrefsPath
} from './mode'
import { configureSessionArbiter, sessionArbiter } from './session-arbiter'
import { cliGate } from './version-gate'
import type { SpawnOwner } from './session-table'
import surface from '../../../resources/companion/api-surface.json'

export type { CompanionBus, CompanionDiagnostics, CompanionHostFacade } from './host-core'

const core = createCompanionHost({
  dir: () => join(app.getPath('userData'), 'companion'),
  mode: {
    getMode: getCompanionMode,
    listenerWanted,
    hydrate: hydrateCompanionMode,
    onChange: onModeChange,
    enabled: () => rolloutView().enabled
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

let identity: IdentityAdapter | null = null
let spawnKindOf: ((owner: SpawnOwner) => string | null) | null = null

/** What a PTY owner was spawned as (`claude-new`, `claude-fork`, ...): the shape of a parity record. */
export function setCompanionSpawnKindResolver(
  fn: ((owner: SpawnOwner) => string | null) | null
): void {
  spawnKindOf = fn
}

/** Called once from `src/main/index.ts` beside `registerHookBridge`. */
export async function registerCompanionHost(getWindow: () => BrowserWindow | null): Promise<void> {
  const userData = app.getPath('userData')
  setCompanionPrefsPath(join(userData, 'companion-prefs.json'))
  configureAuditDir(join(userData, 'companion'))
  // P1W4: the CLI gate and the ramp are inputs of the mode. The version is cached-or-null on the
  // spawn path (T200), so the first answer is `unknown` and the settled probe fires `onModeChange`.
  setCompanionCliGate(cliGate(claudeVersionSync(), surface.lastVerifiedCli))
  void resolveClaudeVersion().then((v) => setCompanionCliGate(cliGate(v, surface.lastVerifiedCli)))
  setRampFolders(await companionActivePaths().catch(() => []))
  // The arbiter reads the rollout view and the binding table; every consumer asks it.
  configureSessionArbiter({ host: core.facade, rollout: rolloutView })
  // The task-state hub asks the arbiter before it folds an event (ARB-2). With no binding for the
  // session, or any failure, the answer is the legacy one: every hook event applies.
  configureHub({
    admit: (ev) => {
      const view = core.facade.bindingForSid(ev.sessionId)
      return admit(
        'taskState',
        ev.source === 'hook' ? 'legacy' : 'companion',
        view ? sessionArbiter().arbiterBinding(view) : null,
        rolloutView()
      )
    }
  })
  // P1W4 replaces P1W3's first policy (`sense.identity` only) with `computeEnable`.
  core.facade.setEnablePolicy(
    createEnablePolicy({ rollout: rolloutView, ceiling: surface.lastVerifiedCli })
  )
  identity = createIdentityAdapter({
    host: core.facade,
    getMode: getCompanionMode,
    gateOf: (b) => gateForCli(b.cliVersion, surface.lastVerifiedCli),
    spawnKind: (owner) => spawnKindOf?.(owner) ?? null,
    push: (claims) => getWindow()?.webContents.send('companion:identity', { claims })
  })
  core.facade.setIdentityDiagnostics(identity.diagnostics)
  registerCompanionIpc(core.facade, {
    identityClaims: () => identity?.claims() ?? [],
    identityOutcome: (o) => identity?.recordOutcome(o),
    restartListener: core.restartListener
  })
  await core.register()
}

/** Joins the `before-quit` list beside `closeHookBridge()`. */
export function closeCompanionHost(): Promise<void> {
  return core.close()
}
