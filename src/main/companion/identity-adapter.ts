/**
 * The identity adapter (T389 P1W3 §7.6). It turns the host's facts about bindings into CLAIMS
 * for the renderer: "PTY row `key` is session `sid`". Electron-free: the renderer push, the mode
 * and the CLI gate are injected, so the rules here are unit-tested against the real host core.
 *
 * Rules that matter:
 *  - A binding is re-keyed ONLY by an explicit `session.rebound` (contract §15); an envelope
 *    `sid` that differs never moves it (the server answers `resync`).
 *  - A claim is satisfied (and removed) when the row's key equals its `sid`: the renderer
 *    migrated and `pty:rekey` moved the index.
 *  - A closed or ended binding has no claim and produces no push, so a late request from a dying
 *    process cannot re-animate a parked row (the companion-side twin of ARB-5).
 *  - Nothing here edits a row. The renderer decides, at `session:added`, whether to honour `act`.
 */

import type { Sid } from './contract'
import type { CompanionHostFacade } from './host-core'
import {
  classifyIdentity,
  mayAct,
  type IdentityCause,
  type IdentityClaim,
  type IdentityDiagnostics,
  type IdentityFact
} from './identity-core'
import type { CompanionMode } from './mode'
import type { BindingView } from './session-table'
import type { CliGate } from './version-gate'

export interface IdentityAdapterDeps {
  host: Pick<
    CompanionHostFacade,
    'bus' | 'onBindingChange' | 'markProven' | 'rebind' | 'registerEventTypes'
  >
  getMode(): CompanionMode
  /** The CLI gate for this binding's binary (`hello.cli.version`). */
  gateOf(b: BindingView): CliGate
  /** Full-list push to the renderer. Called only when the list changed. */
  push(claims: IdentityClaim[]): void
}

export interface IdentityAdapter {
  claims(): IdentityClaim[]
  diagnostics(): IdentityDiagnostics
  dispose(): void
}

const CAUSES: ReadonlySet<string> = new Set(['clear', 'resume', 'unknown'])

export function createIdentityAdapter(deps: IdentityAdapterDeps): IdentityAdapter {
  const views = new Map<number, BindingView>()
  const causes = new Map<number, IdentityCause>()
  const claims = new Map<number, IdentityClaim>()
  const conflicted = new Map<number, Sid>() // binding → the sid already counted as a conflict
  const stats = { conflicts: 0, reboundGap: 0, rebounds: 0 }
  let lastPushed = '[]'

  const list = (): IdentityClaim[] => [...claims.values()].map((c) => ({ ...c }))

  function push(): void {
    const body = JSON.stringify(list())
    if (body === lastPushed) return
    lastPushed = body
    try {
      deps.push(list())
    } catch {
      // the renderer may be gone (window reload): it pulls the list again at store init
    }
  }

  /** Another live binding holding `sid`, as its row key. */
  function liveKeyForSid(sid: Sid, exceptBinding: number): string | null {
    for (const v of views.values()) {
      if (
        v.key !== exceptBinding &&
        v.state === 'bound' &&
        v.sid === sid &&
        v.sessionKey !== null
      ) {
        return v.sessionKey
      }
    }
    return null
  }

  function recompute(b: BindingView): void {
    views.set(b.key, b)
    if (b.state !== 'bound' || b.owner === null) {
      claims.delete(b.key)
      conflicted.delete(b.key)
      return
    }
    const fact: IdentityFact = classifyIdentity({
      key: b.sessionKey,
      sid: b.sid,
      cause: causes.get(b.key) ?? 'spawn',
      ownerKind: b.owner.kind,
      liveKeyForSid: liveKeyForSid(b.sid, b.key)
    })
    if (fact.kind === 'claim') {
      conflicted.delete(b.key)
      claims.set(b.key, {
        key: fact.key,
        sid: fact.sid,
        cause: fact.cause,
        act:
          b.enabled.includes('sense.identity') &&
          mayAct({ mode: deps.getMode(), gate: deps.gateOf(b), lease: b.lease, fact })
      })
      return
    }
    claims.delete(b.key)
    if (fact.kind === 'conflict') {
      if (conflicted.get(b.key) !== fact.sid) {
        conflicted.set(b.key, fact.sid)
        stats.conflicts++
      }
    } else {
      conflicted.delete(b.key)
    }
  }

  function onRebound(b: BindingView, d: unknown): void {
    if (b.state !== 'bound' || typeof d !== 'object' || d === null) return
    const { prevSid, sid, cause } = d as Record<string, unknown>
    if (typeof sid !== 'string' || typeof prevSid !== 'string' || !CAUSES.has(String(cause))) return
    if (sid === b.sid) return // a duplicate: nothing to do
    if (prevSid !== b.sid) stats.reboundGap++ // an earlier rebound was lost: accept this one anyway
    stats.rebounds++
    causes.set(b.key, cause as IdentityCause)
    deps.host.rebind(b, sid) // fires onBindingChange, which recomputes
  }

  // The server delivers only event types a wave registered (contract §8): these four are ours.
  deps.host.registerEventTypes(['session.snapshot', 'session.rebound', 'session.end', 'mod.error'])

  const offs = [
    deps.host.bus.on('hello', (b, kind) => {
      if (kind === 'spawn') {
        causes.set(b.key, 'spawn')
        // contract §11.2: a hello that redeemed a spawn token proves `sense.identity`
        if (b.enabled.includes('sense.identity')) deps.host.markProven(b, 'sense.identity')
      }
      recompute(b)
      push()
    }),
    deps.host.bus.on('event', (b, ev) => {
      if (ev.t === 'session.rebound') {
        onRebound(b, ev.d)
        push()
      }
    }),
    deps.host.bus.on('lease', (b) => {
      recompute(b)
      push()
    }),
    deps.host.bus.on('end', (b) => {
      recompute(b)
      push()
    }),
    deps.host.onBindingChange((b) => {
      recompute(b)
      push()
    })
  ]

  return {
    claims: list,
    diagnostics: () => ({ claims: list(), ...stats }),
    dispose() {
      for (const off of offs) off()
    }
  }
}
