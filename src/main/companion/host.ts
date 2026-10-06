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
import { appendAudit, configureAuditDir } from './audit-log'
import { rolloutView, setCompanionCliGate, setRampFolders } from './companion-prefs'
import { registerCompanionIpc } from './companion-ipc'
import { createCompanionHost } from './host-core'
import { gateForCli } from './enable-policy'
import { createEnablePolicy } from './feature-policy'
import { configureHub } from '../detect/task-state-hub'
import { admit, FAMILY_FEATURES, type FactSource } from './arbitration-core'
import { configureParityLedger, flushParityLedger, recordFact } from './parity-ledger'
import type { IdentityParityRecord } from './identity-parity-core'
import { createAppPolicyProbe } from '../claude-policy-probe'
import { buildCompanionStatus } from './companion-status'
import { companionStagedDir } from './spawn-inject'
import { ensureStaged } from './staging'
import { getCompanionPrefs } from './companion-prefs'
import manifest from '../../../resources/companion/.claude-plugin/plugin.json'
import { createIdentityAdapter, type IdentityAdapter } from './identity-adapter'
import {
  familyMode,
  getCompanionMode,
  hydrateCompanionMode,
  type FactFamily,
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
  sessionKeyResolver = fn
  core.setSessionKeyResolver(fn)
}

let identity: IdentityAdapter | null = null
let sessionKeyResolver: ((owner: SpawnOwner) => string | null) | null = null

/**
 * The CLI's sideload-refusal texts recorded from a managed machine (LV-P1W4-e, Q6). Empty until
 * that run happens, so the early-exit reading is never worded as a policy on a guess (DOC-8).
 */
const SIDELOAD_REFUSAL_TEXTS: readonly string[] = []
let spawnKindOf: ((owner: SpawnOwner) => string | null) | null = null

/** What a PTY owner was spawned as (`claude-new`, `claude-fork`, ...): the shape of a parity record. */
export function setCompanionSpawnKindResolver(
  fn: ((owner: SpawnOwner) => string | null) | null
): void {
  spawnKindOf = fn
}

/** One identity comparison (P1W3's `IdentityParityRecord`) as a ledger row; hashes only. */
function recordIdentityParity(rec: IdentityParityRecord): void {
  const label = rec.companion?.sidHash ?? rec.legacy?.keyHash ?? 'none'
  recordFact(
    'identity',
    'companion',
    `identity:${label}`,
    `bind:${rec.verdict}`,
    {
      shape: rec.shape,
      verdict: rec.verdict,
      via: rec.legacy?.via ?? null,
      helloAfterSpawnMs: rec.companion?.helloAfterSpawnMs ?? null,
      legacyAfterSpawnMs: rec.legacy?.afterSpawnMs ?? null
    },
    { ts: rec.at }
  )
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
  // Lazy: `user-projects` pulls the git probe in, and this module is on the scheduler's spawn path.
  setRampFolders(
    await import('../user-projects').then((m) => m.companionActivePaths()).catch(() => [])
  )
  // The arbiter reads the rollout view and the binding table; every consumer asks it.
  configureSessionArbiter({ host: core.facade, rollout: rolloutView })
  // The persisted parity ledger: it asks the arbiter who owned each stream when a fact arrived.
  configureParityLedger({
    dir: join(userData, 'companion'),
    now: () => Date.now(),
    cli: () => {
      const v = claudeVersionSync()
      return v ? `${v.major}.${v.minor}.${v.patch}` : 'unknown'
    },
    modVersion: (sid) => core.facade.bindingForSid(sid)?.modVersion ?? null,
    context: (stream, sid) => {
      const view = core.facade.bindingForSid(sid)
      if (stream in FAMILY_FEATURES) {
        const family = stream as FactFamily
        const o = sessionArbiter().ownerFor(sid, family)
        return { ...o, mode: familyMode(family, view?.cwd ?? null) }
      }
      // A feature key has no legacy rival to own it against (contract §11.5).
      return { owner: 'legacy', reason: 'mode-shadow', mode: getCompanionMode() }
    }
  })
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
    },
    // Companion events are always evidence; a legacy event is worth a record only for a session
    // the mod is bound to, so a machine where the mod never loaded writes nothing per hook.
    record: (ev, disposition) => {
      const source: FactSource = ev.source === 'hook' ? 'legacy' : 'companion'
      if (source === 'legacy' && !core.facade.bindingForSid(ev.sessionId)) return
      recordFact(
        'taskState',
        source,
        ev.sessionId,
        `event:${ev.event}`,
        { state: ev.matcher ?? null },
        { disposition, ts: ev.ts }
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
    push: (claims) => getWindow()?.webContents.send('companion:identity', { claims }),
    onParity: recordIdentityParity
  })
  core.facade.setIdentityDiagnostics(identity.diagnostics)
  // The shared policy probe: one run per boot and CLI binary, lazily, off the spawn path.
  const probe = createAppPolicyProbe(companionStagedDir)
  // Everything the Harnu mod surfaces show is derived on demand; main only says "re-read".
  let updateTimer: ReturnType<typeof setTimeout> | null = null
  const pushUpdated = (): void => {
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = null
      getWindow()?.webContents.send('companion:updated')
    }, 150)
  }
  core.facade.onBindingChange(pushUpdated)
  sessionArbiter().onOwnershipChange(pushUpdated)
  onModeChange(pushUpdated)
  registerCompanionIpc(core.facade, {
    status: () =>
      buildCompanionStatus({
        enabled: () => getCompanionPrefs().enabled,
        disclosureShownAt: () => getCompanionPrefs().disclosureShownAt ?? null,
        stagedDir: companionStagedDir,
        modVersion: () => manifest.version,
        rollout: rolloutView,
        arbiter: sessionArbiter(),
        host: core.facade,
        sessionKeyOf: (o) => sessionKeyResolver?.(o) ?? null,
        kindOf: (o) => spawnKindOf?.(o) ?? null,
        now: () => Date.now(),
        probe: () => probe.result(),
        requestProbe: () => void probe.ensure().then(pushUpdated),
        refusalTexts: SIDELOAD_REFUSAL_TEXTS
      }),
    stagedDir: async () => companionStagedDir() ?? (await ensureStaged()),
    identityClaims: () => identity?.claims() ?? [],
    identityOutcome: (o) => identity?.recordOutcome(o),
    restartListener: core.restartListener
  })
  await core.register()
}

/** Joins the `before-quit` list beside `closeHookBridge()`. */
export function closeCompanionHost(): Promise<void> {
  flushParityLedger()
  return core.close()
}
