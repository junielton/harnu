import { claudeVersionSync } from '../claude-cli'
import { insertCompanionPluginDir } from './staging-core'
import { cliGate, gateAllowsInjection, type CliGate } from './version-gate'
import { companionHost } from './host'
import type { CompanionInjectDecision } from './arbitration-core'
import { companionInjectDecision } from './companion-prefs'
import { getCompanionMode, type CompanionMode } from './mode'
import { sessionArbiter } from './session-arbiter'
import { ensureStaged, pinStagedDir } from './staging'
import type { ReleaseReason, SpawnMeta, SpawnOwner, TrustClass } from './session-table'
import type { ClaudeVersion } from '../claude-cli-version'
import surface from '../../../resources/companion/api-surface.json'

/**
 * The companion mod's seam in the spawn path (P1W2 §7.4): the provider that decides whether a
 * `claude` spawn carries the second `--plugin-dir` and a spawn token, and the pure helpers the
 * spawn sites apply. Wiring glue (coverage-excluded): the gate is `version-gate.ts`, argv
 * insertion is `staging-core.ts`, the retry decision is `sideload-retry-core.ts`.
 *
 * Every negative path ends in "spawn exactly as today".
 */

export interface CompanionSpawnPlan {
  pluginDir: string
  /** Called only when `claude` is really about to be spawned. Null → spawn without a token. */
  mintToken(owner: SpawnOwner): string | null
}

export type CompanionSpawnProvider = (ctx: {
  cwd: string
  trust: TrustClass
  /** P1W4: the PTY kind (`claude-new`, ...). A scheduler tick passes none and reads as `claude-tick`. */
  kind?: string
  /** P1W4: who the spawn is for, so the decision can be kept for the state line. */
  owner?: SpawnOwner
}) => Promise<CompanionSpawnPlan | null>

export interface SpawnInjectDeps {
  getMode(): CompanionMode
  /** Cached-or-null. Must never spawn and never be awaited (T200 §3.3). */
  cliVersion(): ClaudeVersion | null
  /** `api-surface.json`'s `lastVerifiedCli`. */
  ceiling: string
  isSideloadBlocked(): boolean
  /** P1W4 (`companionInjectDecision`): enabled, noticed, a usable gate, a `claude-*` kind. */
  decide?(ctx: { kind: string; cliGate: CliGate }): CompanionInjectDecision
  /** P1W4: the arbiter keeps the decision per spawn owner; the state line reads it. */
  recordDecision?(owner: SpawnOwner, d: CompanionInjectDecision): void
  ensureStaged(): Promise<string | null>
  mintSpawnToken(meta: SpawnMeta): string | null
  releaseSpawn(owner: SpawnOwner, reason: ReleaseReason): void
  pinStagedDir(fn: () => string[]): void
}

const ownerKey = (o: SpawnOwner): string =>
  o.kind === 'pty' ? `pty:${o.ptyId}` : `tick:${o.workerId}:${o.runId}`

export function createCompanionSpawnProvider(deps: SpawnInjectDeps): {
  provider: CompanionSpawnProvider
  release(owner: SpawnOwner, reason: ReleaseReason): void
  recordedDirs(): string[]
  gate(): CliGate
} {
  /** The directory each live spawn was handed: garbage collection pins by directory. */
  const records = new Map<string, string>()
  deps.pinStagedDir(() => [...records.values()])

  const gate = (): CliGate => cliGate(deps.cliVersion(), deps.ceiling)

  const provider: CompanionSpawnProvider = async (ctx) => {
    try {
      if (deps.decide) {
        const d = deps.decide({ kind: ctx.kind ?? 'claude-tick', cliGate: gate() })
        if (ctx.owner) deps.recordDecision?.(ctx.owner, d)
        if (!d.inject) return null
      }
      if (deps.getMode() === 'off') return null
      if (!gateAllowsInjection(gate())) return null
      if (deps.isSideloadBlocked()) return null
      const pluginDir = await deps.ensureStaged()
      if (!pluginDir) return null
      return {
        pluginDir,
        mintToken(owner) {
          records.set(ownerKey(owner), pluginDir)
          return deps.mintSpawnToken({ owner, trust: ctx.trust, cwd: ctx.cwd })
        }
      }
    } catch {
      return null
    }
  }

  return {
    provider,
    release(owner, reason) {
      if (records.delete(ownerKey(owner))) deps.releaseSpawn(owner, reason)
    },
    recordedDirs: () => [...records.values()],
    gate
  }
}

// ---- Pure helpers applied by the spawn sites -------------------------------------------

/** Trust class of a spawn: a deliberately weaker session is never upgraded by who started it. */
export function trustFor(o: {
  readOnly?: boolean
  agentControlled?: boolean
  spawnedBy?: 'agent' | 'operator'
}): TrustClass {
  if (o.readOnly) return 'read-only'
  if (o.agentControlled || o.spawnedBy === 'agent') return 'agent'
  return 'operator'
}

/** Runs inside the `withOptionArgs` callback only (BUG-86); no plan → the argv as it was. */
export function applyCompanionArgv(args: string[], plan: CompanionSpawnPlan | null): string[] {
  return plan ? insertCompanionPluginDir(args, plan.pluginDir) : [...args]
}

/**
 * `HARNU_SPAWN_TOKEN` never survives from the parent (a Harnu launched inside a Harnu session
 * would otherwise forward a spent token). A fresh one is minted only for a spawn that really
 * runs `claude`: the missing-directory notice replaces the command, so it gets none.
 */
export function applyCompanionEnv(
  env: Record<string, string>,
  x: { plan: CompanionSpawnPlan | null; owner: SpawnOwner; dirMissing: boolean }
): { minted: boolean } {
  delete env.HARNU_SPAWN_TOKEN
  if (!x.plan || x.dirMissing) return { minted: false }
  const token = x.plan.mintToken(x.owner)
  if (!token) return { minted: false }
  env.HARNU_SPAWN_TOKEN = token
  return { minted: true }
}

/**
 * The env override for a scheduler tick's `spawn`, or `undefined` when the tick's env is to stay
 * exactly as it was (no token minted and none inherited). An inherited token is never forwarded.
 */
export function tickEnv(
  base: NodeJS.ProcessEnv,
  token: string | null
): NodeJS.ProcessEnv | undefined {
  if (token) return { ...base, HARNU_SPAWN_TOKEN: token }
  if (base.HARNU_SPAWN_TOKEN === undefined) return undefined
  const { HARNU_SPAWN_TOKEN: _spent, ...rest } = base
  return rest
}

// ---- Sideload-blocked mark (§7.8) ------------------------------------------------------

let sideloadBlocked = false
let sideloadBlockedOutput = ''

/** In memory for the app run (P1W4 persists it). `output` is the first process's last 2 KiB. */
export function markSideloadBlocked(output: string): void {
  sideloadBlocked = true
  sideloadBlockedOutput = output.slice(-2048)
}

export function isSideloadBlocked(): boolean {
  return sideloadBlocked
}

/** Kept so P1W4 can match it against the real exit text once LV-P1W4-e records it. Never logged. */
export function sideloadBlockedLastOutput(): string {
  return sideloadBlockedOutput
}

// ---- The app's one injector ------------------------------------------------------------

const injector = createCompanionSpawnProvider({
  // Closures, not references: nothing is read until a spawn asks (a module that mocks one of
  // these imports must not break merely by importing this file).
  getMode: () => getCompanionMode(),
  cliVersion: () => claudeVersionSync(),
  ceiling: surface.lastVerifiedCli,
  isSideloadBlocked,
  decide: (c) => companionInjectDecision(c),
  recordDecision: (o, d) => sessionArbiter().recordInjectDecision(o, d),
  ensureStaged,
  mintSpawnToken: (m) => companionHost.mintSpawnToken(m),
  releaseSpawn: (o, r) => companionHost.releaseSpawn(o, r),
  pinStagedDir
})

export const companionSpawnProvider: CompanionSpawnProvider = injector.provider

/**
 * Whether the mod said hello for this spawn: its ledger entry left `minted`. Never true in
 * this wave (no handshake yet), and false when no token was minted at all.
 */
export function companionHelloSeen(owner: SpawnOwner): boolean {
  const rec = companionHost.spawnRecord(owner)
  return rec !== null && rec.state !== 'minted'
}

/**
 * P1W4: the first process of a spawn exited early and was respawned bare. Its kept output feeds
 * the Harnu mod state (row 5 of the state table); it is never logged.
 */
export function reportCompanionSideloadExit(owner: SpawnOwner, output: string): void {
  sessionArbiter().reportSideloadExit(owner, output)
}

/** Drops the spawn record and tells the host; a no-op for an owner that never recorded. */
export function releaseCompanionSpawn(owner: SpawnOwner, reason: ReleaseReason): void {
  injector.release(owner, reason)
  // The decision and the sideload exit outlive a retry's `spawn-aborted`; only the end drops them.
  if (reason !== 'spawn-aborted') sessionArbiter().forgetSpawn(owner)
}

export function companionCliGate(): CliGate {
  return injector.gate()
}
