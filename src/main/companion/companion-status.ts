/**
 * `companionStatus()` (T389 P1W4 §7.6): what the renderer's Harnu mod surfaces read. The facts
 * come from injected dependencies, so the assembly is tested without Electron; `companion-ipc.ts`
 * only registers the channel and pushes `companion:updated` (debounced) when something changed.
 *
 * Token-free: no `conn`, no spawn token, no socket path (SEC-8).
 */

import type { PolicyProbeClass } from '../claude-policy-probe-core'
import {
  FAMILY_FEATURES,
  effectiveMode,
  type FactSource,
  type OwnReason,
  type RolloutView
} from './arbitration-core'
import {
  HELLO_GRACE_MS,
  deriveCompanionState,
  type CompanionState,
  type StateFacts
} from './companion-state-core'
import type { CompanionHostFacade } from './host-core'
import type { CompanionMode, FactFamily } from './mode'
import type { SessionArbiter } from './session-arbiter'
import type { SpawnOwner } from './session-table'
import type { CliGate } from './version-gate'

const FAMILIES = Object.keys(FAMILY_FEATURES) as FactFamily[]

export interface SessionStatus {
  state: CompanionState | null
  ownership: Record<FactFamily, { owner: FactSource; reason: OwnReason }>
}

export interface CompanionStatus {
  enabled: boolean
  disclosureShownAt: number | null
  stagedDir: string | null
  modVersion: string
  cliGate: CliGate
  /** The effective mode of each family for a folder that is not on the ramp. */
  families: Record<FactFamily, CompanionMode>
  /** Keyed by Harnu's row key, and again by the bound `sid` when that differs. */
  sessions: Record<string, SessionStatus>
  probe: PolicyProbeClass | null
}

export interface StatusDeps {
  enabled(): boolean
  disclosureShownAt(): number | null
  stagedDir(): string | null
  modVersion(): string
  rollout(): RolloutView
  arbiter: Pick<
    SessionArbiter,
    'ownerFor' | 'injectDecisionFor' | 'sideloadExitFor' | 'wasMinted' | 'spawnOwners'
  >
  host: Pick<
    CompanionHostFacade,
    'bindingForSession' | 'bindingForSid' | 'spawnRecord' | 'helloRefusalFor'
  >
  sessionKeyOf(owner: SpawnOwner): string | null
  /** What the PTY behind this owner was spawned as, or null when none runs. */
  kindOf(owner: SpawnOwner): string | null
  now(): number
  probe(): PolicyProbeClass | null
  /** Starts the lazy one-shot probe; never awaited here. */
  requestProbe(): void
  /** The recorded sideload-refusal texts (LV-P1W4-e); empty until a managed run records them. */
  refusalTexts: readonly string[]
}

export function buildCompanionStatus(deps: StatusDeps): CompanionStatus {
  const r = deps.rollout()
  const sessions: Record<string, SessionStatus> = {}
  const killSwitchOff = !r.enabled
  let probeWanted = false

  for (const { owner, at } of deps.arbiter.spawnOwners()) {
    const key = deps.sessionKeyOf(owner)
    if (key === null) continue
    const kind = deps.kindOf(owner)
    const view = deps.host.bindingForSession(key)
    const inject = deps.arbiter.injectDecisionFor(owner)
    const exit = deps.arbiter.sideloadExitFor(owner)
    const refusal = deps.host.helloRefusalFor(owner)
    const hostRestart =
      view === null &&
      inject?.inject === true &&
      deps.arbiter.wasMinted(owner) &&
      deps.host.spawnRecord(owner) === null
    const spawnAgeMs = Math.max(0, deps.now() - at)
    const facts: StateFacts = {
      pty: kind === null ? null : { kind },
      killSwitchOff,
      inject,
      sideload: exit === null ? null : { respawnedBare: true, output: exit },
      refusal: refusal === null ? null : { code: refusal.code },
      hostRestart,
      binding: view
        ? {
            enabledEmpty: view.enabled.length === 0,
            leaseLive: view.state === 'bound' && view.lease === 'live',
            ended: view.state !== 'bound'
          }
        : null,
      spawnAgeMs,
      probe: deps.probe(),
      refusalTexts: deps.refusalTexts
    }
    // Row 11 is the only row that reads the probe: ask for it only when it could matter.
    if (
      !killSwitchOff &&
      kind?.startsWith('claude-') &&
      inject?.inject === true &&
      view === null &&
      exit === null &&
      refusal === null &&
      !hostRestart &&
      spawnAgeMs >= HELLO_GRACE_MS
    ) {
      probeWanted = true
    }
    const status: SessionStatus = {
      state: deriveCompanionState(facts),
      ownership: Object.fromEntries(
        FAMILIES.map((f) => [f, deps.arbiter.ownerFor(key, f)])
      ) as SessionStatus['ownership']
    }
    sessions[key] = status
    if (view && view.sid !== key) sessions[view.sid] = status
  }
  if (probeWanted && deps.probe() === null) deps.requestProbe()

  return {
    enabled: deps.enabled(),
    disclosureShownAt: deps.disclosureShownAt(),
    stagedDir: deps.stagedDir(),
    modVersion: deps.modVersion(),
    cliGate: r.cliGate,
    families: Object.fromEntries(FAMILIES.map((f) => [f, effectiveMode(f, null, r)])) as Record<
      FactFamily,
      CompanionMode
    >,
    sessions,
    probe: deps.probe()
  }
}
