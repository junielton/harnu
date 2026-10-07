/**
 * Outside sessions on the host (T389 P4W3 §7.4 to §7.7, contract §21): the decision on a
 * tokenless hello, corroboration by Harnu's own watchers, the buffer of what an uncorroborated
 * binding said, the origin gate that refuses every actuator, and the switch that revokes them all.
 *
 * An outside binding is a CLAIM (smoke D6: nothing a mod sends is authenticated). So:
 *  - it is invisible to every consumer until Harnu's own watchers report the same session id;
 *  - it never displaces a session Harnu spawned;
 *  - it is only ever told `flush`, `config.update` and `ui.band.set`.
 *
 * Electron-free: the facade, the switch, the clock and the watchers' answer are injected.
 */

import { isAbsolute } from 'node:path'
import { posix, win32 } from 'node:path'
import type { AuditRecord } from './audit-core'
import {
  EXTERNAL_CORROBORATE_MS,
  EXTERNAL_MAX_BINDINGS,
  RING_MAX,
  type Command,
  type FeatureId,
  type HelloRequest,
  type WireEvent
} from './contract'
import type { CompanionHostFacade } from './host-core'
import type { CompanionMode } from './mode'
import type { ExternalHelloDecision } from './server'
import type { BindingView, EnablePolicy } from './session-table'

/** The only commands the host ever issues to an outside session (contract §21 item 5). */
export const EXTERNAL_COMMANDS: ReadonlySet<string> = new Set([
  'flush',
  'config.update',
  'ui.band.set'
])

export const externalCommandAllowed = (name: string): boolean => EXTERNAL_COMMANDS.has(name)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Retry hint for a tokenless hello over the bound: long enough not to spin, short enough to recover. */
const SLOW_DOWN_RETRY_MS = 5_000

type HostPort = Pick<
  CompanionHostFacade,
  | 'bus'
  | 'onBindingChange'
  | 'revoke'
  | 'markProven'
  | 'registerEventTypes'
  | 'setExternalHello'
  | 'setExternalEventHold'
  | 'setCommandGate'
  | 'replayEvents'
  | 'externalBindings'
  | 'spawnedBindingForSid'
  | 'corroborate'
  | 'dropBinding'
>

export interface ExternalBindingDeps {
  host: HostPort
  /** The `external` prefs key: true only while the switch is on. */
  isOn(): boolean
  mode(): CompanionMode
  /** `sessionOwnedByHarnu` (`pty.ts`): a session Harnu spawned, live or parked. */
  sessionOwnedByHarnu(sid: string): boolean
  /** Harnu's own watchers: the PID registry or the transcript watcher knows this session. */
  corroborates(sid: string, cwd: string): Promise<boolean>
  /** Monotonic ms. */
  now(): number
  epochNow?(): number
  appendAudit?(rec: AuditRecord): void
  /** §7.7: the folder is on the interceptor ramp. */
  onRamp?(cwd: string): boolean
  /** §7.7: the `approval` family is `active` for the folder. */
  approvalActive?(cwd: string): boolean
  log?(line: string): void
}

export interface ExternalBinding {
  /** The hello handler the host registers (synchronous, runs on the hello's path). */
  decide(req: HelloRequest): ExternalHelloDecision
  /** Wraps the enable policy: an outside binding gets nothing while the switch is off. */
  wrapPolicy(inner: EnablePolicy): EnablePolicy
  /** One pass: corroboration checks, then the clock. The shell calls it on an interval. */
  sweep(): Promise<void>
  /** The switch changed. Off revokes every live outside binding at once (contract §21 item 8). */
  setSwitch(on: boolean): void
  /** §7.7: `gate.approval` may be enabled for this binding. */
  approvalEligible(b: BindingView): boolean
  /** Epoch ms of the last corroborated outside session activity, or null. */
  lastSeenAt(): number | null
  /** What the pane and the diagnostics read. */
  counts(): { live: number; corroborated: number; held: number }
  dispose(): void
}

interface Tracked {
  buffer: WireEvent[]
  firstTurnAt: number | null
  sid: string
  checking: boolean
}

export function isAbsolutePath(p: string): boolean {
  return posix.isAbsolute(p) || win32.isAbsolute(p) || isAbsolute(p)
}

export function createExternalBinding(deps: ExternalBindingDeps): ExternalBinding {
  const { host } = deps
  const log = deps.log ?? ((): void => undefined)
  const epochNow = deps.epochNow ?? ((): number => Date.now())
  const tracked = new Map<number, Tracked>()
  let lastSeen: number | null = null
  const refusalsLogged = new Set<string>()

  const trackOf = (b: BindingView): Tracked => {
    let t = tracked.get(b.key)
    if (!t) tracked.set(b.key, (t = { buffer: [], firstTurnAt: null, sid: b.sid, checking: false }))
    return t
  }

  // The turn event types this wave's clock needs; the sensors' own wave registers the rest.
  host.registerEventTypes(['turn.started'])

  // ---- the hello -------------------------------------------------------------------------

  function decide(req: HelloRequest): ExternalHelloDecision {
    // 1. Off means off: the key, or the kill switch / CLI gate through the mode.
    if (!deps.isOn() || deps.mode() === 'off') return { ok: false, code: 'FEATURE_DISABLED' }
    // SEC-3c: a claim is untrusted input.
    if (!UUID.test(req.sid))
      return { ok: false, code: 'BAD_ENVELOPE', message: 'sid is not a uuid' }
    if (!isAbsolutePath(req.cwd)) {
      return { ok: false, code: 'BAD_ENVELOPE', message: 'cwd must be absolute' }
    }
    // 2. A claim never displaces a session Harnu spawned.
    if (host.spawnedBindingForSid(req.sid) !== null || deps.sessionOwnedByHarnu(req.sid)) {
      return { ok: false, code: 'UNAUTHORIZED' }
    }
    // 3. Bounded. A fresh claim for a sid that already has a live outside binding replaces it,
    //    so it does not count against the bound.
    const live = host.externalBindings()
    const others = live.filter((v) => v.sid !== req.sid).length
    if (others >= EXTERNAL_MAX_BINDINGS) {
      return { ok: false, code: 'SLOW_DOWN', retryAfterMs: SLOW_DOWN_RETRY_MS }
    }
    return { ok: true }
  }
  host.setExternalHello(decide)

  // ---- hold, corroborate, replay ---------------------------------------------------------

  /** Takes every event of an uncorroborated outside binding: nothing reaches a consumer. */
  function hold(b: BindingView, ev: WireEvent): boolean {
    const t = trackOf(b)
    t.buffer.push(ev)
    if (t.buffer.length > RING_MAX) t.buffer.splice(0, t.buffer.length - RING_MAX)
    if (ev.t === 'turn.started' && t.firstTurnAt === null) t.firstTurnAt = deps.now()
    void check(b)
    return true
  }
  host.setExternalEventHold(hold)

  async function check(b: BindingView): Promise<void> {
    const t = trackOf(b)
    if (t.checking || b.state !== 'bound') return
    t.checking = true
    try {
      const ok = await deps.corroborates(b.sid, b.cwd)
      if (!ok) return
      // The binding may have moved on (rebound, dropped, revoked) while the watcher answered.
      const live = host.externalBindings().find((v) => v.key === b.key)
      if (!live || live.sid !== b.sid || live.corroborated === true) return
      host.corroborate(live)
      if (live.enabled.includes('sense.identity')) host.markProven(live, 'sense.identity')
      lastSeen = epochNow()
      const pending = t.buffer.splice(0)
      const rest = host.replayEvents(live, pending)
      if (rest.length > 0) t.buffer.unshift(...rest) // a rebound inside the buffer: wait again
    } catch {
      // a watcher failure is "not corroborated": the binding stays invisible
    } finally {
      t.checking = false
    }
  }

  // A rebound re-keys the binding; corroboration is required again for the new id (§8, §21).
  const offChange = host.onBindingChange((b) => {
    if (b.profile !== 'external') return
    const t = tracked.get(b.key)
    if (b.state !== 'bound') {
      tracked.delete(b.key)
      return
    }
    if (t && t.sid !== b.sid) {
      t.sid = b.sid
      t.firstTurnAt = null
      if (b.corroborated === true) host.corroborate(b, false)
      void check(b)
    }
  })
  const offEvent = host.bus.on('event', (b) => {
    if (b.profile === 'external' && b.corroborated === true) lastSeen = epochNow()
  })

  async function sweep(): Promise<void> {
    const live = host.externalBindings()
    for (const k of [...tracked.keys()]) if (!live.some((v) => v.key === k)) tracked.delete(k)
    for (const b of live) {
      if (b.corroborated === true) continue
      await check(b)
      const t = tracked.get(b.key)
      const now = host.externalBindings().find((v) => v.key === b.key)
      if (!t || !now || now.corroborated === true) continue
      // The one anchor is the first `turn.started`: a binding that has not run a turn waits.
      if (t.firstTurnAt !== null && deps.now() - t.firstTurnAt >= EXTERNAL_CORROBORATE_MS) {
        host.dropBinding(now)
        tracked.delete(b.key)
        log('an outside claim was never corroborated and was dropped')
      }
    }
  }

  // ---- the origin gate (contract §21 item 5) ---------------------------------------------

  host.setCommandGate((b: BindingView, cmds: Command[]): Command[] => {
    if (b.profile !== 'external') return cmds
    const kept: Command[] = []
    for (const c of cmds) {
      if (externalCommandAllowed(c.name)) {
        kept.push(c)
        continue
      }
      // A refusal is audited by name, never by text (SEC-8); one record per command.
      try {
        deps.appendAudit?.({
          kind: 'command-refused',
          ts: epochNow(),
          command: c.name,
          sid: b.sid,
          sessionKey: b.sessionKey,
          profile: 'external'
        })
      } catch {
        const once = `${c.name}`
        if (!refusalsLogged.has(once)) {
          refusalsLogged.add(once)
          log('could not audit a refused command for an outside session')
        }
      }
    }
    return kept
  })

  // ---- policy, switch, approvals ----------------------------------------------------------

  function approvalEligible(b: BindingView): boolean {
    if (b.profile !== 'external' || b.corroborated !== true || !b.cwd) return false
    return deps.onRamp?.(b.cwd) === true && deps.approvalActive?.(b.cwd) === true
  }

  function wrapPolicy(inner: EnablePolicy): EnablePolicy {
    return (b) => {
      if (b.profile !== 'external') return inner(b)
      // A revoked binding's resume hello lands here with the switch off: answered `enable: []`.
      if (!deps.isOn()) return []
      const set = inner(b)
      return set.filter((f: FeatureId) => f !== 'gate.approval' || approvalEligible(b))
    }
  }

  function setSwitch(on: boolean): void {
    if (on) return
    for (const b of host.externalBindings()) host.revoke(b)
    tracked.clear()
  }

  return {
    decide,
    wrapPolicy,
    sweep,
    setSwitch,
    approvalEligible,
    lastSeenAt: () => lastSeen,
    counts: () => {
      const live = host.externalBindings()
      return {
        live: live.length,
        corroborated: live.filter((v) => v.corroborated === true).length,
        held: [...tracked.values()].reduce((n, t) => n + t.buffer.length, 0)
      }
    },
    dispose() {
      offChange()
      offEvent()
      host.setExternalHello(null)
      host.setExternalEventHold(null)
      host.setCommandGate(null)
      tracked.clear()
    }
  }
}
