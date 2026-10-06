/**
 * The companion host's decisions, free of Electron (T389 P1W1 §7.7): the `companionHost` facade,
 * the typed in-process bus, the lease sweep, the listener lifecycle (`reconcileListener`) and the
 * diagnostics snapshot. `host.ts` is the thin shell that feeds it Electron's `app`, `powerMonitor`
 * and the real mode seam; every rule is here, where it is tested without a stub of `electron`.
 *
 * Nothing here ever hands out `conn`, a spawn token or the endpoint token: facade methods and bus
 * listeners receive `BindingView`s only (SEC-8).
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { bindingAuditRecord, type AuditRecord, type BindingChange } from './audit-core'
import {
  LEASE_SWEEP_MS,
  LEASE_TTL_MS,
  type AskKind,
  type AskRequest,
  type AskResponse,
  type BootId,
  type Command,
  type Conn,
  type FeatureId,
  type PollRequest,
  type PollResponse,
  type Sid,
  type SpawnToken,
  type WireEvent
} from './contract'
import type { IdentityDiagnostics } from './identity-core'
import type { CompanionMode } from './mode'
import {
  startCompanionServer,
  type AskHandler,
  type CompanionServer,
  type PollHandler,
  type ServerHooks,
  type ServerStat,
  type StartOptions
} from './server'
import {
  SessionTable,
  type Binding,
  type BindingView,
  type EnablePolicy,
  type SpawnMeta,
  type SpawnOwner,
  type SpawnRecordView,
  type TrustClass
} from './session-table'

export interface CompanionBus {
  on(type: 'hello', fn: (b: BindingView, kind: 'spawn' | 'resume' | 'external') => void): () => void
  on(type: 'event', fn: (b: BindingView, ev: WireEvent) => void): () => void
  on(type: 'lease', fn: (b: BindingView, state: 'lost') => void): () => void
  on(type: 'end', fn: (b: BindingView, reason: string) => void): () => void
  /** P1W4: an adapter proved a feature, or its proof was revoked (the arbiter's stickiness). */
  on(
    type: 'proof',
    fn: (b: BindingView, feature: FeatureId, change: 'proven' | 'revoked') => void
  ): () => void
}

export interface CompanionDiagnostics {
  mode: CompanionMode
  listener:
    | { state: 'off' }
    | { state: 'failed'; reason: string }
    | { state: 'listening'; transport: 'unix' | 'tcp'; bootId: BootId; startedAt: number }
  totals: { helloOk: number; helloRefused: Record<string, number>; http4xx: Record<string, number> }
  pendingSpawns: number
  /** P1W3: claims and counters of the identity adapter; absent until it registers. */
  identity?: IdentityDiagnostics
  bindings: {
    sessionKey: string | null
    sid: Sid
    trust: TrustClass
    state: Binding['state']
    lease: 'live' | 'lost'
    lastRequestAgoMs: number
    proto: number
    profile: string
    cliVersion: string
    modVersion: string
    declared: FeatureId[]
    enabled: FeatureId[]
    /** P1W3: features a hello that redeemed a spawn token has proven. */
    proven: FeatureId[]
    /** P1W3: ms from the spawn to the first hello (the parity gate's p95 input). */
    helloAfterSpawnMs: number
    counters: Binding['counters']
  }[]
}

type ReleaseWhy = 'pty-exit' | 'spawn-aborted' | 'tick-done'
type HelloKind = 'spawn' | 'resume' | 'external'

export interface CompanionHostFacade {
  mintSpawnToken(meta: SpawnMeta): SpawnToken | null
  releaseSpawn(owner: SpawnOwner, reason: ReleaseWhy): void
  bindingForSession(sessionKey: string): BindingView | null
  bindingForSid(sid: Sid): BindingView | null
  getBinding(sidOrSessionKey: string): BindingView | null
  onBindingChange(fn: (b: BindingView) => void): () => void
  spawnRecord(owner: SpawnOwner): SpawnRecordView | null
  setEnablePolicy(fn: EnablePolicy): void
  setPollHandler(
    fn: (b: BindingView, req: PollRequest, reply: (r: PollResponse) => void) => void
  ): void
  registerAskKind<K extends AskKind>(
    kind: K,
    fn: (b: BindingView, req: AskRequest<K>, reply: (r: AskResponse<K>) => void) => void
  ): void
  setCommandSource(fn: (b: BindingView, cursor?: number) => Command[]): void
  beforeHello(fn: (b: BindingView, kind: HelloKind) => void): () => void
  hold(b: BindingView): () => void
  revoke(b: BindingView): void
  markProven(b: BindingView, feature: FeatureId): void
  revokeProof(b: BindingView, feature: FeatureId): void
  verifyStamp(
    handle: string,
    nonce: string,
    tool: string,
    mac: string
  ): { binding: BindingView; verdict: 'verified' | 'bad-mac' | 'replayed' } | 'unknown-binding'
  registerEventTypes(names: readonly string[]): void
  /** Only caller: the `session.rebound` handler (P1W3), through the table's `rebind`. */
  rebind(b: BindingView, sid: Sid): void
  /** Harnu's row key of the binding whose bound `sid` this is (claimed or bound), or null. */
  sessionKeyForSid(sid: Sid): string | null
  /**
   * The row key of a PTY owner changed (`pty:rekey` moved the index): the binding of that owner
   * now reads the new `sessionKey`. Fires `onBindingChange`; a no-op for an owner with no binding.
   */
  notifySessionKeyChange(owner: SpawnOwner): void
  /** The identity adapter's contribution to `diagnostics()`. */
  setIdentityDiagnostics(fn: (() => IdentityDiagnostics) | null): void
  bus: CompanionBus
  diagnostics(): CompanionDiagnostics
}

export interface HostCoreDeps {
  /** `<userData>/companion`. A getter lets the Electron shell resolve it lazily. */
  dir: string | (() => string)
  mode: {
    getMode(): CompanionMode
    listenerWanted(): boolean
    hydrate(): Promise<void>
    onChange(fn: () => void): () => void
    /**
     * P1W4: the kill switch (`false` means off). When it turns off the host revokes every
     * binding's `conn` and answers each re-hello with `enable: []` (contract §3 item 9, §11.2).
     */
    enabled?(): boolean
  }
  start?: (opts: StartOptions) => Promise<CompanionServer>
  /** Monotonic: the lease clock (never wall time). */
  now?: () => number
  /** Epoch ms for audit rows. */
  epochNow?: () => number
  appendAudit?: (rec: AuditRecord) => void
  sessionKeyOf?: (owner: SpawnOwner) => string | null
  log?: (message: string) => void
  /** Subscribe to "the machine resumed from sleep". */
  onResume?: (fn: () => void) => () => void
}

export interface CompanionHostCore {
  facade: CompanionHostFacade
  register(): Promise<void>
  /** Starts the listener when wanted and none runs; never stops a running one. */
  reconcileListener(): Promise<void>
  /** One lease sweep, now. The interval calls it every `LEASE_SWEEP_MS`. */
  sweepNow(): void
  setSessionKeyResolver(fn: ((owner: SpawnOwner) => string | null) | null): void
  /** Developer aid (LV-P1W3-g): stops and starts the listener; the table stays in memory. */
  restartListener(): Promise<void>
  close(): Promise<void>
}

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; name?: unknown }
  if (typeof e?.code === 'string') return e.code
  return typeof e?.name === 'string' ? e.name : 'error'
}

export function createCompanionHost(deps: HostCoreDeps): CompanionHostCore {
  const now = deps.now ?? ((): number => performance.now())
  const epochNow = deps.epochNow ?? ((): number => Date.now())
  const log = deps.log ?? ((m: string): void => console.warn(`[companion] ${m}`))
  const start = deps.start ?? startCompanionServer
  const dirOf = (): string => (typeof deps.dir === 'function' ? deps.dir() : deps.dir)

  let resolveKey: ((owner: SpawnOwner) => string | null) | null = deps.sessionKeyOf ?? null
  let identityDiagnostics: (() => IdentityDiagnostics) | null = null
  const table = new SessionTable({
    now,
    mintConn: () => `c_${randomBytes(16).toString('hex')}` as Conn,
    mintToken: () => `sp_${randomUUID()}` as SpawnToken,
    sessionKeyOf: (owner) => resolveKey?.(owner) ?? null
  })

  // ---- extension points -------------------------------------------------------------------
  let enablePolicy: EnablePolicy = () => []
  let pollHandler: PollHandler | undefined
  let commandSource: ((b: BindingView, cursor?: number) => Command[]) | undefined
  const askKinds = new Map<string, AskHandler>()
  const known = new Set<string>()
  const beforeHello = new Set<(b: BindingView, kind: HelloKind) => void>()

  // ---- bus and change fan-out -------------------------------------------------------------
  type Listener = (...args: never[]) => void
  const busListeners = new Map<string, Set<Listener>>()
  const changeListeners = new Set<(b: BindingView) => void>()

  function emit(type: string, ...args: unknown[]): void {
    for (const fn of [...(busListeners.get(type) ?? [])]) {
      try {
        ;(fn as (...a: unknown[]) => void)(...args)
      } catch {
        // each listener runs inside its own try/catch
      }
    }
  }
  function notifyChange(view: BindingView): void {
    for (const fn of [...changeListeners]) {
      try {
        fn(view)
      } catch {
        // as above
      }
    }
  }
  const bus: CompanionBus = {
    on(type: string, fn: Listener): () => void {
      let set = busListeners.get(type)
      if (!set) busListeners.set(type, (set = new Set()))
      set.add(fn)
      return () => void set.delete(fn)
    }
  }

  let auditFailureLogged = false
  function audit(change: BindingChange, view: BindingView, prevSid?: Sid): void {
    if (!deps.appendAudit) return
    try {
      deps.appendAudit(bindingAuditRecord(change, view, epochNow(), prevSid))
    } catch {
      if (!auditFailureLogged) {
        auditFailureLogged = true
        log('audit append failed; the binding change was applied without a record')
      }
    }
  }

  // ---- totals -----------------------------------------------------------------------------
  const totals = {
    helloOk: 0,
    helloRefused: {} as Record<string, number>,
    http4xx: {} as Record<string, number>
  }
  function onStat(s: ServerStat): void {
    if (s.status >= 400)
      totals.http4xx[String(s.status)] = (totals.http4xx[String(s.status)] ?? 0) + 1
    if (s.endpoint !== 'hello' || s.status !== 200) return
    if (s.ok) totals.helloOk++
    else if (s.code) totals.helloRefused[s.code] = (totals.helloRefused[s.code] ?? 0) + 1
  }

  // Bindings the kill switch revoked: their re-hello is answered `enable: []` even after the
  // switch is back on, because turning it back on reaches new sessions only (ARB-7d).
  const killed = new Set<number>()
  const killedAwarePolicy: EnablePolicy = (v) => (killed.has(v.key) ? [] : enablePolicy(v))

  // The server reads these at request time, so a later `setPollHandler` needs no restart.
  const hooks: ServerHooks = {
    enablePolicy: () => killedAwarePolicy,
    known: () => known,
    commandSource: (b, cursor) => commandSource?.(b, cursor) ?? [],
    get pollHandler() {
      return pollHandler
    },
    askHandler: (kind) => askKinds.get(kind),
    beforeHello: (b, kind) => {
      for (const fn of [...beforeHello]) {
        try {
          fn(b, kind)
        } catch {
          // a listener's failure never fails the hello
        }
      }
    },
    onHello: (b, kind) => {
      if (kind !== 'resume') audit('bound', b)
      emit('hello', b, kind)
      notifyChange(b)
    },
    onEvent: (b, ev) => emit('event', b, ev),
    onEnd: (b, reason) => {
      audit('ended', b)
      emit('end', b, reason)
      notifyChange(b)
    },
    onStat
  }

  // ---- listener lifecycle -----------------------------------------------------------------
  let server: CompanionServer | null = null
  let starting: Promise<void> | null = null
  let failedReason: string | null = null
  let failureLogged = false
  let lastToken: string | undefined

  function reconcileListener(): Promise<void> {
    if (!deps.mode.listenerWanted() || server || starting) return starting ?? Promise.resolve()
    starting = (async () => {
      try {
        const s = await start({ dir: dirOf(), table, hooks, tokenHint: lastToken, log })
        server = s
        lastToken = s.endpoint.token
        failedReason = null
      } catch (err) {
        failedReason = errorCode(err)
        if (!failureLogged) {
          failureLogged = true
          log(`listener failed to start (${failedReason}); sessions spawn without the Harnu mod`)
        }
      } finally {
        starting = null
      }
    })()
    return starting
  }

  // ---- lease sweep ------------------------------------------------------------------------
  function sweepNow(): void {
    for (const b of table.sweep()) {
      const view = table.viewOf(b)
      audit('lease-lost', view)
      emit('lease', view, 'lost')
      notifyChange(view)
    }
  }

  /** The kill switch turned off: revoke every live binding at once, spawned or external. */
  function revokeAll(): void {
    for (const b of table.all()) {
      if (b.state !== 'bound') continue
      killed.add(b.key)
      table.revoke(table.viewOf(b))
      const view = table.viewOf(b)
      audit('revoked', view)
      notifyChange(view)
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null
  const unsubscribers: (() => void)[] = []
  let registered = false

  async function register(): Promise<void> {
    if (registered) return
    registered = true
    await deps.mode.hydrate()
    timer = setInterval(sweepNow, LEASE_SWEEP_MS)
    timer.unref?.()
    if (deps.onResume) unsubscribers.push(deps.onResume(() => table.grace(LEASE_TTL_MS)))
    unsubscribers.push(
      deps.mode.onChange(() => {
        if (deps.mode.enabled && !deps.mode.enabled()) revokeAll()
        void reconcileListener()
      })
    )
    await reconcileListener()
  }

  async function restartListener(): Promise<void> {
    await starting
    const s = server
    server = null
    if (s) await s.stop().catch(() => undefined)
    await reconcileListener()
  }

  async function close(): Promise<void> {
    registered = false
    if (timer) clearInterval(timer)
    timer = null
    for (const off of unsubscribers.splice(0)) off()
    await starting
    const s = server
    server = null
    if (s) await s.stop().catch(() => undefined)
  }

  // ---- facade -----------------------------------------------------------------------------
  function emitProof(b: BindingView, feature: FeatureId, change: 'proven' | 'revoked'): void {
    const live = table.byKey(b.key)
    if (live) emit('proof', table.viewOf(live), feature, change)
  }
  const keyOf = (b: BindingView): Binding | null => table.byKey(b.key)

  const views = (): BindingView[] => table.view()
  /** A live binding wins over an ended or closed one that kept the same key or sid. */
  function pick(matches: BindingView[]): BindingView | null {
    return matches.find((v) => v.state === 'bound') ?? matches[matches.length - 1] ?? null
  }

  const facade: CompanionHostFacade = {
    mintSpawnToken: (meta) => (server ? table.mint(meta) : null),
    releaseSpawn(owner, reason) {
      const b = table.release(owner, reason)
      if (!b) return
      const view = table.viewOf(b)
      audit('ended', view)
      emit('end', view, reason)
      notifyChange(view)
    },
    bindingForSession: (key) => pick(views().filter((v) => v.sessionKey === key)),
    bindingForSid: (sid) => pick(views().filter((v) => v.sid === sid)),
    getBinding: (x) => facade.bindingForSession(x) ?? facade.bindingForSid(x),
    onBindingChange(fn) {
      changeListeners.add(fn)
      return () => void changeListeners.delete(fn)
    },
    spawnRecord: (owner) => table.spawnRecord(owner),
    setEnablePolicy(fn) {
      enablePolicy = fn
    },
    setPollHandler(fn) {
      pollHandler = fn
    },
    registerAskKind(kind, fn) {
      askKinds.set(kind, fn as unknown as AskHandler)
    },
    setCommandSource(fn) {
      commandSource = fn
    },
    beforeHello(fn) {
      beforeHello.add(fn)
      return () => void beforeHello.delete(fn)
    },
    hold: (b) => table.hold(b),
    revoke(b) {
      table.revoke(b)
      const live = keyOf(b)
      if (!live) return
      const view = table.viewOf(live)
      audit('revoked', view)
      notifyChange(view)
    },
    markProven(b, f) {
      table.markProven(b, f)
      emitProof(b, f, 'proven')
    },
    revokeProof(b, f) {
      table.revokeProof(b, f)
      emitProof(b, f, 'revoked')
    },
    verifyStamp: (handle, nonce, tool, mac) => table.verifyStamp(handle, nonce, tool, mac),
    registerEventTypes(names) {
      for (const n of names) known.add(n)
    },
    sessionKeyForSid: (sid) => pick(views().filter((v) => v.sid === sid))?.sessionKey ?? null,
    notifySessionKeyChange(owner) {
      for (const view of views()) {
        if (!view.owner || JSON.stringify(view.owner) !== JSON.stringify(owner)) continue
        notifyChange(view)
      }
    },
    setIdentityDiagnostics(fn) {
      identityDiagnostics = fn
    },
    rebind(b, sid) {
      const live = keyOf(b)
      if (!live) return
      const prev = live.sid
      table.rebind(live, sid)
      const view = table.viewOf(live)
      audit('rebound', view, prev)
      notifyChange(view)
    },
    bus,
    diagnostics(): CompanionDiagnostics {
      const t = now()
      return {
        mode: deps.mode.getMode(),
        listener: server
          ? {
              state: 'listening',
              transport: server.transport,
              bootId: server.bootId,
              startedAt: server.startedAt
            }
          : failedReason !== null
            ? { state: 'failed', reason: failedReason }
            : { state: 'off' },
        totals: {
          helloOk: totals.helloOk,
          helloRefused: { ...totals.helloRefused },
          http4xx: { ...totals.http4xx }
        },
        pendingSpawns: table.pendingSpawns(),
        ...(identityDiagnostics ? { identity: identityDiagnostics() } : {}),
        bindings: table.all().map((b) => ({
          sessionKey: table.viewOf(b).sessionKey,
          sid: b.sid,
          trust: b.trust,
          state: b.state,
          lease: table.leaseOf(b),
          lastRequestAgoMs: Math.max(0, Math.round(t - b.lastRequestAt)),
          proto: b.proto,
          profile: b.profile,
          cliVersion: b.cliVersion,
          modVersion: b.modVersion,
          declared: [...b.declared],
          enabled: [...b.enabled],
          proven: [...b.proven],
          helloAfterSpawnMs: Math.round(b.helloAfterSpawnMs),
          counters: { ...b.counters }
        }))
      }
    }
  }

  return {
    facade,
    register,
    reconcileListener,
    sweepNow,
    setSessionKeyResolver: (fn) => {
      resolveKey = fn
    },
    restartListener,
    close
  }
}
