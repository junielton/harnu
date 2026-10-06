/**
 * The stateful shell of arbitration (T389 P1W4 §7.1): builds an `ArbiterBinding` from the host's
 * binding table, keeps the sticky reversions (ARB-4c) and answers the questions every consumer
 * asks. Electron-free: the host facade and the rollout view are injected, so the tests drive it
 * with a real host core and a fake clock. The app has one instance, wired by `host.ts`.
 *
 * Fail-safe: with no host wired, or a session with no binding, every answer is `legacy`.
 */

import {
  FAMILY_FEATURES,
  normalizeFolder,
  ownerOf,
  type ArbiterBinding,
  type CompanionInjectDecision,
  type FactSource,
  type OwnReason,
  type RolloutView
} from './arbitration-core'
import type { CompanionHostFacade } from './host-core'
import type { FeatureId, Sid } from './contract'
import type { FactFamily } from './mode'
import type { BindingView, SpawnOwner } from './session-table'

export type ArbiterHost = Pick<CompanionHostFacade, 'getBinding' | 'onBindingChange' | 'bus'>

export interface SessionArbiterDeps {
  host: ArbiterHost | null
  rollout(): RolloutView
  /** Epoch ms of a spawn decision; default `Date.now()`. */
  now?(): number
}

export interface SessionArbiter {
  owns(sessionKeyOrSid: string, family: FactFamily): boolean
  ownerFor(sessionKeyOrSid: string, family: FactFamily): { owner: FactSource; reason: OwnReason }
  isStickyLegacy(sessionKeyOrSid: string, family?: FactFamily): boolean
  reportFailedProof(sessionKeyOrSid: string, feature: FeatureId): void
  onOwnershipChange(fn: (sessionKey: string | null, sid: Sid) => void): () => void
  bindingCounters(sessionKeyOrSid: string): { modErrors: number; leaseLosses: number }
  /** The arbiter's view of a binding, for the state derivation and the hub. */
  arbiterBinding(view: BindingView): ArbiterBinding
  /** The spawn-owner keyed facts that P1W1's spawn record does not carry. */
  recordInjectDecision(owner: SpawnOwner, d: CompanionInjectDecision): void
  injectDecisionFor(owner: SpawnOwner): CompanionInjectDecision | null
  /** A spawn token was really minted for this owner (the listener was up). */
  noteMinted(owner: SpawnOwner): void
  wasMinted(owner: SpawnOwner): boolean
  reportSideloadExit(owner: SpawnOwner, output: string): void
  sideloadExitFor(owner: SpawnOwner): string | null
  /** Fires when a spawn decision is recorded: the state line has a time-based row to age into. */
  onSpawnDecision(fn: (owner: SpawnOwner, d: CompanionInjectDecision) => void): () => void
  forgetSpawn(owner: SpawnOwner): void
  /** The owners with a recorded decision (a live `claude` PTY) and when each was decided. */
  spawnOwners(): { owner: SpawnOwner; at: number }[]
  dispose(): void
}

const ALL_FAMILIES = Object.keys(FAMILY_FEATURES) as FactFamily[]
const ownerKey = (o: SpawnOwner): string =>
  o.kind === 'pty' ? `pty:${o.ptyId}` : `tick:${o.workerId}:${o.runId}`

/** The kept tail of a sideload exit's output: bounded, never logged. */
const SIDELOAD_OUTPUT_CAP = 2048

export function createSessionArbiter(deps: SessionArbiterDeps): SessionArbiter {
  const { host } = deps
  /** Keyed by the binding's table-local ordinal: it follows a re-key, never a sid. */
  const revoked = new Map<number, Set<FactFamily>>()
  const counters = new Map<number, { modErrors: number; leaseLosses: number }>()
  const injectDecisions = new Map<
    string,
    { owner: SpawnOwner; d: CompanionInjectDecision; at: number }
  >()
  const now = deps.now ?? ((): number => Date.now())
  const sideloadExits = new Map<string, string>()
  const minted = new Set<string>()
  const spawnListeners = new Set<(owner: SpawnOwner, d: CompanionInjectDecision) => void>()
  const listeners = new Set<(sessionKey: string | null, sid: Sid) => void>()

  const revokedOf = (key: number): Set<FactFamily> => {
    let s = revoked.get(key)
    if (!s) revoked.set(key, (s = new Set()))
    return s
  }
  const countersOf = (key: number): { modErrors: number; leaseLosses: number } => {
    let c = counters.get(key)
    if (!c) counters.set(key, (c = { modErrors: 0, leaseLosses: 0 }))
    return c
  }

  function fire(b: BindingView): void {
    for (const fn of [...listeners]) {
      try {
        fn(b.sessionKey, b.sid)
      } catch {
        // one listener's failure never stops the others
      }
    }
  }

  const unsubscribers: (() => void)[] = []
  if (host) {
    unsubscribers.push(
      host.bus.on('lease', (b) => {
        countersOf(b.key).leaseLosses++
        // An inert binding has no lease to lose (contract §11.3): no sticky reason.
        if (b.enabled.length > 0) for (const f of ALL_FAMILIES) revokedOf(b.key).add(f)
        fire(b)
      }),
      host.bus.on('end', (b) => {
        revoked.delete(b.key)
        counters.delete(b.key)
        fire(b)
      }),
      host.bus.on('event', (b, ev) => {
        if (ev.t === 'mod.error') countersOf(b.key).modErrors++
      }),
      host.bus.on('proof', (b, feature, change) => {
        if (change === 'revoked') revokeFamiliesNeeding(b.key, feature)
        fire(b)
      }),
      host.bus.on('hello', (b) => fire(b))
    )
  }

  function revokeFamiliesNeeding(key: number, feature: FeatureId): void {
    for (const f of ALL_FAMILIES) {
      if (FAMILY_FEATURES[f].includes(feature)) revokedOf(key).add(f)
    }
  }

  const viewOf = (x: string): BindingView | null => host?.getBinding(x) ?? null

  function arbiterBinding(v: BindingView): ArbiterBinding {
    return {
      sessionKey: v.sessionKey,
      folder: v.cwd ? normalizeFolder(v.cwd) : null,
      leaseLive: v.state === 'bound' && v.lease === 'live',
      enabled: new Set(v.enabled),
      proven: new Set(v.proven),
      revoked: new Set(revoked.get(v.key) ?? [])
    }
  }

  function ownerFor(x: string, family: FactFamily): { owner: FactSource; reason: OwnReason } {
    const v = viewOf(x)
    return ownerOf(family, v ? arbiterBinding(v) : null, deps.rollout())
  }

  return {
    ownerFor,
    owns: (x, family) => ownerFor(x, family).owner === 'companion',
    isStickyLegacy(x, family) {
      const v = viewOf(x)
      const set = v ? revoked.get(v.key) : undefined
      if (!set || set.size === 0) return false
      return family === undefined ? true : set.has(family)
    },
    reportFailedProof(x, feature) {
      const v = viewOf(x)
      if (!v) return
      revokeFamiliesNeeding(v.key, feature)
      fire(v)
    },
    onOwnershipChange(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    bindingCounters(x) {
      const v = viewOf(x)
      const c = v ? counters.get(v.key) : undefined
      return { modErrors: c?.modErrors ?? 0, leaseLosses: c?.leaseLosses ?? 0 }
    },
    arbiterBinding,
    recordInjectDecision(owner, d) {
      injectDecisions.set(ownerKey(owner), { owner, d, at: now() })
      for (const fn of [...spawnListeners]) {
        try {
          fn(owner, d)
        } catch {
          // one listener's failure never stops the others
        }
      }
    },
    onSpawnDecision(fn) {
      spawnListeners.add(fn)
      return () => void spawnListeners.delete(fn)
    },
    injectDecisionFor: (owner) => injectDecisions.get(ownerKey(owner))?.d ?? null,
    spawnOwners: () => [...injectDecisions.values()].map(({ owner, at }) => ({ owner, at })),
    reportSideloadExit: (owner, output) =>
      void sideloadExits.set(ownerKey(owner), output.slice(-SIDELOAD_OUTPUT_CAP)),
    sideloadExitFor: (owner) => sideloadExits.get(ownerKey(owner)) ?? null,
    noteMinted: (owner) => void minted.add(ownerKey(owner)),
    wasMinted: (owner) => minted.has(ownerKey(owner)),
    forgetSpawn(owner) {
      minted.delete(ownerKey(owner))
      injectDecisions.delete(ownerKey(owner))
      sideloadExits.delete(ownerKey(owner))
    },
    dispose() {
      for (const off of unsubscribers.splice(0)) off()
      listeners.clear()
      spawnListeners.clear()
    }
  }
}

// ---- The app's one arbiter -----------------------------------------------------------------

let current: SessionArbiter = createSessionArbiter({
  host: null,
  rollout: () => ({
    enabled: false,
    cliGate: 'unknown',
    families: {},
    allFolders: false,
    rampFolders: new Set()
  })
})

/** Called once by `host.ts`; replaces the fail-safe default (everything `legacy`). */
export function configureSessionArbiter(deps: SessionArbiterDeps): SessionArbiter {
  current.dispose()
  current = createSessionArbiter(deps)
  return current
}

export const sessionArbiter = (): SessionArbiter => current
export const owns: SessionArbiter['owns'] = (x, f) => current.owns(x, f)
export const ownerFor: SessionArbiter['ownerFor'] = (x, f) => current.ownerFor(x, f)
export const isStickyLegacy: SessionArbiter['isStickyLegacy'] = (x, f) =>
  current.isStickyLegacy(x, f)
export const reportFailedProof: SessionArbiter['reportFailedProof'] = (x, f) =>
  current.reportFailedProof(x, f)
export const onOwnershipChange: SessionArbiter['onOwnershipChange'] = (fn) =>
  current.onOwnershipChange(fn)
export const bindingCounters: SessionArbiter['bindingCounters'] = (x) => current.bindingCounters(x)
