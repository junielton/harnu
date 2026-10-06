/**
 * The command channel's shell (T389 P2W1 §7.3, §7.4, §7.5): the `poll` handler and its parking, the
 * per-binding queues, the one `enqueue()` through which every command enters, the audit rows that
 * precede the queue, `command.result` intake and the hooks into the lease, the binding table and
 * the kill switch. Every rule is decided in `command-queue-core.ts` and `command-gate-core.ts`;
 * this file holds the state and the timers.
 *
 * Electron-free on purpose: the host facade, the clock, the audit writer and the arbiter are
 * injected, so the tests drive it with a real host core over a real socket.
 *
 * `enqueue()` is the ONLY way a command enters a queue (SEC-5). A static test greps for the queue's
 * write functions outside this file.
 */

import { randomUUID } from 'node:crypto'
import { commandAuditRecord, auditOutcome, type AuditMeta, type AuditRecord } from './audit-core'
import {
  ackQueue,
  cancelCommand,
  commitEnqueue,
  createQueue,
  dropQueue,
  planEnqueue,
  recordResult,
  sweepQueue,
  takeCommands,
  type BindingQueue
} from './command-queue-core'
import {
  checkOrigin,
  gateRowFor,
  profileRefusal,
  shadowRefusal,
  validateArgs,
  type ChannelMode,
  type GateRow
} from './command-gate-core'
import type {
  CommandCause,
  CommandOutcome,
  DropWhy,
  EnqueueRefusal,
  QueuedCommand,
  Settlement
} from './command-types'
import {
  CMD_TTL_MS,
  POLL_HOLD_MS,
  type BootId,
  type CmdId,
  type Command,
  type CommandArgs,
  type CommandName,
  type ErrorCode,
  type FeatureId,
  type PollRequest,
  type PollResponse,
  type Sid,
  type WireEvent
} from './contract'
import { registerPrefsKey, prefsKey } from './companion-prefs'
import { registerFeaturePolicy } from './feature-policy'
import type { CompanionHostFacade } from './host-core'
import type { BindingView } from './session-table'

export { registerGateRow } from './command-gate-core'

// ---- rollout: the `channel` key and the four actuator rows (contract §11.1, §11.5) ----------

const CHANNEL_MODES: readonly ChannelMode[] = ['off', 'shadow', 'active']

/**
 * `shadow` runs the poll loop so its reliability can be measured and admits the observe-only set;
 * `active` is the flip, gated on the ledger (ARB-6d). A CLI above the tested ceiling is capped at
 * `shadow` by `prefsKey` itself. Idempotent: a second call replaces the rows.
 */
export function registerChannelPolicies(): void {
  registerPrefsKey<ChannelMode>('channel', {
    default: 'shadow',
    observeCap: 'shadow',
    parse: (raw) => (CHANNEL_MODES.includes(raw as ChannelMode) ? (raw as ChannelMode) : 'shadow')
  })
  registerFeaturePolicy('act.channel', () => prefsKey<ChannelMode>('channel') !== 'off')
  for (const f of ['act.turn', 'act.compact', 'act.ui']) {
    registerFeaturePolicy(f, () => prefsKey<ChannelMode>('channel') === 'active')
  }
}
registerChannelPolicies()

/** What the channel adds to `EnqueueRefusal` for a failure of its own audit write (SEC-6). */
export type ChannelRefusal = EnqueueRefusal | 'AUDIT_FAILED'

export interface EnqueueRequest<N extends CommandName> {
  sessionKey: string | null // null only for an external binding
  sid?: Sid // names an external binding
  name: N
  args: CommandArgs[N]
  cause: CommandCause
  ttlMs?: number // default CMD_TTL_MS
  /** What the enqueuing wave records beside the argument digest: closed, short values, never text. */
  meta?: AuditMeta
}

export type EnqueueResult =
  | { ok: true; cmd: CmdId; n: number; settled: Promise<CommandOutcome> }
  | { ok: false; reason: ChannelRefusal }

export type ChannelHost = Pick<
  CompanionHostFacade,
  | 'bindingForSession'
  | 'bindingForSid'
  | 'bus'
  | 'hold'
  | 'markProven'
  | 'onBindingChange'
  | 'registerEventTypes'
  | 'setCommandSource'
  | 'setPollHandler'
>

export interface ChannelDeps {
  host: ChannelHost
  /** The running listener's boot id, or null while there is none. */
  bootId(): BootId | null
  /** `prefsKey('channel')`. */
  channelMode(): ChannelMode
  appendAudit(rec: AuditRecord): void
  /** Epoch ms: the clock of `issuedAt`, `expiresAt` and every deadline. */
  now?(): number
  /** `resolveAgentTarget` for a verb cause (a Harnu-spawned session, never an operator's own). */
  agentTarget?(sessionKey: string): 'ok' | 'not_found' | 'not_harnu_spawned' | 'operator_owned'
  /** `isFolderDenied` for a verb cause. */
  folderBlocked?(cwd: string): boolean
  isStickyLegacy(sessionKeyOrSid: string): boolean
  reportFailedProof(sessionKeyOrSid: string, feature: FeatureId): void
  /** True only while the `companion:debug:enqueue` route is registered (§7.6). */
  debug?: boolean
  /** The parked poll's hold, capped at `POLL_HOLD_MS`. */
  pollHoldMs?(): number
  /** The parity ledger (`recordFact('channel', ...)`); optional. */
  record?(sid: string, k: string, d: Record<string, string | number | boolean | null>): void
  mintCmd?(): CmdId
  log?(message: string): void
}

export interface CommandChannel {
  enqueue<N extends CommandName>(req: EnqueueRequest<N>): EnqueueResult
  cancelIfUndelivered(cmd: CmdId): boolean
  pendingFor(b: BindingView, cursor?: number): Command[]
  /** Answers every parked poll `HOST_SHUTTING_DOWN` and drops every queue (`host-shutdown`). */
  shutdown(): void
  dispose(): void
  /** Test aid: how many polls are parked, and how many live commands each queue holds. */
  inspect(): { parked: number; live: number }
}

/** The hold of a parked poll never exceeds the protocol's `POLL_HOLD_MS` (§7.3 step 5). */
export const clampHold = (ms: number): number =>
  Math.max(1, Math.min(Number.isFinite(ms) ? ms : POLL_HOLD_MS, POLL_HOLD_MS))

const SWEEP_MS = 5_000
const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'CMD_EXPIRED',
  'CMD_UNSUPPORTED',
  'CMD_PRECONDITION',
  'CMD_FAILED',
  'FEATURE_DISABLED'
])
const RESULT_MESSAGE_MAX = 512

/** Attempt-proven features (contract §11.2): a successful result is the proof. */
const isAttemptProven = (f: FeatureId): boolean =>
  f.startsWith('act.') || f === 'ui.band' || f === 'gate.guard'

interface Parked {
  reply: (r: PollResponse) => void
  timer: ReturnType<typeof setTimeout>
  release: () => void
  cursor: number
  since: number
}

interface BindingState {
  queue: BindingQueue
  parked?: Parked
  boundSid: Sid
  /** A poll arrived under an id that is not the bound one: wait for `session.rebound`. */
  unsettled: boolean
  enabledAct: boolean
  holdMs?: number
  proofMarked: Set<FeatureId>
  view: BindingView
}

interface Waiter {
  promise: Promise<CommandOutcome>
  resolve(o: CommandOutcome): void
  enqueuedAt: number
}

const failure = (code: ErrorCode): PollResponse => ({ ok: false, code })

export function createCommandChannel(deps: ChannelDeps): CommandChannel {
  const { host } = deps
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((m: string): void => console.warn(`[companion] ${m}`))
  const mintCmd = deps.mintCmd ?? ((): CmdId => `cmd_${randomUUID().replace(/-/g, '')}`)
  const states = new Map<number, BindingState>()
  const waiters = new Map<CmdId, Waiter>()
  let auditFailureLogged = false

  // ---- audit --------------------------------------------------------------------------------

  /** Appends one row; refusals and outcomes never fail a caller, the decision row does (SEC-6). */
  function appendQuiet(rec: AuditRecord): boolean {
    try {
      deps.appendAudit(rec)
      return true
    } catch {
      if (!auditFailureLogged) {
        auditFailureLogged = true
        log('command audit append failed')
      }
      return false
    }
  }

  const folderOf = (b: BindingView | null): string => b?.cwd ?? ''

  // ---- state --------------------------------------------------------------------------------

  function stateOf(b: BindingView, create: boolean): BindingState | null {
    let st = states.get(b.key) ?? null
    const boot = deps.bootId()
    if (st && boot !== null && st.queue.bootId !== boot) {
      // The listener restarted under a binding that stayed in memory: nothing queued survives.
      settleAll(st, dropQueue(st.queue, 'host-shutdown'))
      st.queue = createQueue(boot)
    }
    if (!st && create && boot !== null) {
      st = {
        queue: createQueue(boot),
        boundSid: b.sid,
        unsettled: false,
        enabledAct: b.enabled.includes('act.channel'),
        proofMarked: new Set(),
        view: b
      }
      states.set(b.key, st)
    }
    if (st) st.view = b
    return st
  }

  // ---- settling -----------------------------------------------------------------------------

  function settleAll(st: BindingState, list: Settlement[]): void {
    for (const s of list) onSettled(st, s)
  }

  function onSettled(st: BindingState, s: Settlement): void {
    const { item, outcome } = s
    const b = st.view
    appendQuiet(
      commandAuditRecord({
        phase: 'outcome',
        ts: now(),
        cmd: item.command.cmd,
        n: item.command.n,
        sessionKey: b.sessionKey,
        sid: item.sidAtEnqueue,
        folder: folderOf(b),
        name: item.command.name,
        cause: item.cause,
        args: item.command.args,
        outcome: auditOutcome(outcome)
      })
    )
    const w = waiters.get(item.command.cmd)
    if (w) {
      waiters.delete(item.command.cmd)
      w.resolve(outcome)
    }
    const row = gateRowFor(item.command.name)
    if (outcome.state === 'resulted' && outcome.ok && row) {
      // A successful result is the proof of an attempt-proven feature, once per feature.
      if (isAttemptProven(row.feature) && !st.proofMarked.has(row.feature)) {
        st.proofMarked.add(row.feature)
        try {
          host.markProven(b, row.feature)
        } catch {
          // a consumer's failure never fails the intake
        }
      }
      if (item.command.name === 'config.update') {
        const hold = (item.command.args as { config: { pollHoldMs?: number } }).config.pollHoldMs
        if (hold !== undefined) st.holdMs = hold
      }
    }
    if (outcome.state === 'lost' && row) {
      // Delivered, no result: a failed proof (contract §11.2). The families that need the feature
      // read legacy for the rest of the session (ARB-4c).
      try {
        deps.reportFailedProof(b.sessionKey ?? b.sid, row.feature)
      } catch {
        // as above
      }
    }
    if (item.command.name === 'flush' && outcome.state === 'resulted') {
      deps.record?.(item.sidAtEnqueue, 'flush', {
        ok: outcome.ok,
        enqueueToResultMs: Math.max(0, now() - item.command.issuedAt)
      })
    }
  }

  function dropAll(st: BindingState, why: DropWhy, keep?: (i: QueuedCommand) => boolean): void {
    settleAll(st, dropQueue(st.queue, why, keep))
  }

  // ---- polling ------------------------------------------------------------------------------

  function endPark(
    st: BindingState,
    how: 'timeout' | 'command' | 'superseded' | 'close',
    body: PollResponse
  ): void {
    const p = st.parked
    if (!p) return
    st.parked = undefined
    clearTimeout(p.timer)
    try {
      p.release()
    } catch {
      // releasing a hold on a closed binding is harmless
    }
    deps.record?.(st.view.sid, 'poll', { how, heldMs: Math.max(0, now() - p.since) })
    try {
      p.reply(body)
    } catch {
      // the request is gone: nothing to answer
    }
  }

  const resync = (): PollResponse => ({ ok: true, commands: [], resync: true })

  function pollHandler(b: BindingView, req: PollRequest, reply: (r: PollResponse) => void): void {
    // P1W1 has validated the envelope, resolved the binding and touched the lease.
    if (
      b.profile !== 'interactive' ||
      !b.enabled.includes('act.channel') ||
      deps.channelMode() === 'off'
    ) {
      return reply(failure('FEATURE_DISABLED'))
    }
    const boot = deps.bootId()
    if (boot === null) return reply(failure('HOST_SHUTTING_DOWN'))
    const st = stateOf(b, true)
    if (!st) return reply(failure('HOST_SHUTTING_DOWN'))
    if (req.bootId !== boot) return reply(resync())
    if (req.sid !== b.sid) {
      // An envelope sid that is not the bound one never re-keys: wait for `session.rebound`.
      st.unsettled = true
      return reply(resync())
    }
    st.unsettled = false
    const t = now()
    ackQueue(st.queue, req.cursor)
    settleAll(st, sweepQueue(st.queue, t))
    const commands = takeCommands(st.queue, req.cursor, t)
    if (commands.length > 0) {
      // A poll that was parked is superseded by this one even when this one answers at once.
      if (st.parked) endPark(st, 'superseded', { ok: true, commands: [] })
      return reply({ ok: true, commands })
    }
    // One parked poll per binding: the newer supersedes the older (a reload, a duplicated loop).
    if (st.parked) endPark(st, 'superseded', { ok: true, commands: [] })
    const release = host.hold(b)
    const hold = clampHold(st.holdMs ?? deps.pollHoldMs?.() ?? POLL_HOLD_MS)
    const timer = setTimeout(() => endPark(st, 'timeout', { ok: true, commands: [] }), hold)
    timer.unref?.()
    st.parked = { reply, timer, release, cursor: req.cursor, since: t }
  }

  function pendingFor(b: BindingView, cursor?: number): Command[] {
    if (!b.enabled.includes('act.channel') || deps.channelMode() === 'off') return []
    const st = stateOf(b, false)
    if (!st || st.unsettled) return []
    const t = now()
    if (cursor !== undefined) ackQueue(st.queue, cursor)
    settleAll(st, sweepQueue(st.queue, t))
    return takeCommands(st.queue, cursor ?? st.queue.ackedCursor, t)
  }

  // ---- enqueue ------------------------------------------------------------------------------

  function refuse(
    req: EnqueueRequest<CommandName>,
    b: BindingView | null,
    reason: ChannelRefusal
  ): EnqueueResult {
    appendQuiet(
      commandAuditRecord({
        phase: 'decision',
        ts: now(),
        sessionKey: req.sessionKey,
        ...(b ? { sid: b.sid } : req.sid !== undefined ? { sid: req.sid } : {}),
        folder: folderOf(b),
        name: req.name,
        cause: req.cause,
        args: req.args,
        ...(req.meta ? { meta: req.meta } : {}),
        decision: reason as EnqueueRefusal
      })
    )
    return { ok: false, reason }
  }

  function findBinding(req: EnqueueRequest<CommandName>): BindingView | null {
    const b =
      req.sessionKey !== null
        ? host.bindingForSession(req.sessionKey)
        : req.sid !== undefined
          ? host.bindingForSid(req.sid)
          : null
    return b && b.state === 'bound' ? b : null
  }

  function enqueue<N extends CommandName>(request: EnqueueRequest<N>): EnqueueResult {
    const req = request as unknown as EnqueueRequest<CommandName>
    // 1. Binding and lease.
    const b = findBinding(req)
    if (!b) return refuse(req, null, 'NO_BINDING')
    if (b.lease !== 'live') return refuse(req, b, 'NO_LEASE')
    if (deps.isStickyLegacy(b.sessionKey ?? b.sid)) return refuse(req, b, 'STICKY_LEGACY')
    const st = stateOf(b, true)
    if (!st) return refuse(req, b, 'NO_LEASE')
    if (st.unsettled) return refuse(req, b, 'SID_UNSETTLED')
    // 2. Profile and feature.
    const profile = profileRefusal(b.profile, req.name)
    if (profile) return refuse(req, b, profile)
    const row = gateRowFor(req.name)
    if (row && !b.enabled.includes(row.feature)) return refuse(req, b, 'FEATURE_OFF')
    // 3. Key.
    const key = shadowRefusal(deps.channelMode(), req.name, req.args)
    if (key) return refuse(req, b, key)
    // 4. Origin.
    const origin = checkOrigin(req.name, req.cause, { debug: deps.debug === true })
    if (!origin.ok) return refuse(req, b, origin.reason)
    // 5. Target.
    const target = targetRefusal(req.cause, b)
    if (target) return refuse(req, b, target)
    // 6. Arguments.
    const args = validateArgs(req.name, req.args)
    if (!args.ok) return refuse(req, b, args.reason)
    // 7. Audit, then queue.
    return queueIt(req, b, st, origin.row)
  }

  function targetRefusal(
    cause: CommandCause,
    b: BindingView
  ): 'TARGET_DENIED' | 'FOLDER_BLOCKED' | null {
    if (cause.kind === 'verb') {
      if (b.sessionKey === null || deps.agentTarget?.(b.sessionKey) !== 'ok') return 'TARGET_DENIED'
      return deps.folderBlocked?.(b.cwd) ? 'FOLDER_BLOCKED' : null
    }
    // An operator gesture reaches a Harnu-spawned binding only, never the external class (P4W3).
    if (cause.kind === 'operator' && b.owner === null) return 'TARGET_DENIED'
    return null
  }

  function queueIt(
    req: EnqueueRequest<CommandName>,
    b: BindingView,
    st: BindingState,
    row: GateRow
  ): EnqueueResult {
    void row
    const t = now()
    const plan = planEnqueue(
      st.queue,
      {
        cmd: mintCmd(),
        name: req.name,
        args: req.args as Command['args'],
        cause: req.cause,
        sid: b.sid,
        ttlMs: req.ttlMs ?? CMD_TTL_MS
      },
      t
    )
    if (!plan.ok) return refuse(req, b, plan.reason)
    // No audit, no command: the decision row is written before the command is queued.
    const written = (() => {
      try {
        deps.appendAudit(
          commandAuditRecord({
            phase: 'decision',
            ts: t,
            cmd: plan.cmd,
            n: plan.n,
            sessionKey: b.sessionKey,
            sid: b.sid,
            folder: folderOf(b),
            name: req.name,
            cause: req.cause,
            args: req.args,
            ...(req.meta ? { meta: req.meta } : {}),
            decision: 'queued'
          })
        )
        return true
      } catch {
        return false
      }
    })()
    if (!written) return { ok: false, reason: 'AUDIT_FAILED' }
    const done = commitEnqueue(st.queue, plan)
    for (const s of done.replaced) onSettled(st, s)
    const cmd = done.item.command.cmd
    let w = waiters.get(cmd)
    if (!w) {
      let resolve!: (o: CommandOutcome) => void
      const promise = new Promise<CommandOutcome>((r) => (resolve = r))
      w = { promise, resolve, enqueuedAt: t }
      waiters.set(cmd, w)
    }
    // A parked poll is answered before any timer fires (§7.3 step 8).
    if (st.parked) {
      const commands = takeCommands(st.queue, st.parked.cursor, t)
      if (commands.length > 0) endPark(st, 'command', { ok: true, commands })
    }
    return { ok: true, cmd, n: done.item.command.n, settled: w.promise }
  }

  function cancelIfUndelivered(cmd: CmdId): boolean {
    for (const st of states.values()) {
      const s = cancelCommand(st.queue, cmd)
      if (s) {
        onSettled(st, s)
        return true
      }
    }
    return false
  }

  // ---- result intake and hooks into earlier waves ----------------------------------------------

  const offs: (() => void)[] = []

  function onResultEvent(b: BindingView, ev: WireEvent): void {
    if (ev.t !== 'command.result') return
    const st = states.get(b.key)
    if (!st) return
    const d = ev.d as unknown
    // Untrusted input (SEC-3b): it can only settle a command this host queued for this binding.
    if (typeof d !== 'object' || d === null) return
    const r = d as Record<string, unknown>
    if (typeof r.cmd !== 'string' || typeof r.ok !== 'boolean') return
    const settled = recordResult(st.queue, r.cmd as CmdId, {
      ok: r.ok,
      ...(typeof r.code === 'string' && KNOWN_CODES.has(r.code)
        ? { code: r.code as ErrorCode }
        : {}),
      ...(typeof r.message === 'string' ? { message: r.message.slice(0, RESULT_MESSAGE_MAX) } : {}),
      ...(typeof r.data === 'object' && r.data !== null ? { data: r.data } : {})
    })
    st.view = b
    if (settled) onSettled(st, settled)
  }

  function onBindingChange(view: BindingView): void {
    const st = states.get(view.key)
    if (!st) return
    st.view = view
    if (view.state !== 'bound') {
      dropAll(st, 'session-end')
      endPark(st, 'close', failure('STALE_CONN'))
      states.delete(view.key)
      return
    }
    const hadAct = st.enabledAct
    st.enabledAct = view.enabled.includes('act.channel')
    if (hadAct && !st.enabledAct) {
      // The kill switch: the conn is revoked and the re-hello is answered `enable: []`. Callers
      // fall back at once instead of waiting for a TTL (contract §3 item 9).
      dropAll(st, 'revoked')
      endPark(st, 'close', failure('STALE_CONN'))
      return
    }
    if (view.sid !== st.boundSid) {
      st.boundSid = view.sid
      st.unsettled = false
      // A `session.rebound` drops what was queued for the old id, except housekeeping.
      dropAll(
        st,
        'rebound',
        (i) => i.command.name === 'flush' || i.command.name === 'config.update'
      )
    }
  }

  offs.push(
    host.bus.on('event', onResultEvent),
    host.bus.on('lease', (b) => {
      const st = states.get(b.key)
      if (st) dropAll(st, 'lease-lost')
    }),
    host.bus.on('end', (b) => {
      const st = states.get(b.key)
      if (!st) return
      dropAll(st, 'session-end')
      endPark(st, 'close', failure('STALE_CONN'))
      states.delete(b.key)
    }),
    host.bus.on('hello', (b, kind) => {
      const st = states.get(b.key)
      // A re-hello re-reads `hello.config`: a tracked `pollHoldMs` override is gone with it.
      if (st && kind === 'resume') st.holdMs = undefined
      if (st) st.view = b
    }),
    host.onBindingChange(onBindingChange)
  )
  host.registerEventTypes(['command.result'])
  host.setPollHandler(pollHandler)
  host.setCommandSource(pendingFor)

  const sweepTimer = setInterval(() => {
    const t = now()
    for (const st of states.values()) settleAll(st, sweepQueue(st.queue, t))
  }, SWEEP_MS)
  sweepTimer.unref?.()

  function shutdown(): void {
    for (const st of [...states.values()]) {
      endPark(st, 'close', failure('HOST_SHUTTING_DOWN'))
      dropAll(st, 'host-shutdown')
    }
    states.clear()
  }

  return {
    enqueue,
    cancelIfUndelivered,
    pendingFor,
    shutdown,
    dispose() {
      clearInterval(sweepTimer)
      for (const off of offs.splice(0)) off()
      shutdown()
    },
    inspect: () => ({
      parked: [...states.values()].filter((s) => s.parked).length,
      live: [...states.values()].reduce((n, s) => n + s.queue.items.length, 0)
    })
  }
}

// ---- The app's one channel ------------------------------------------------------------------

let current: CommandChannel | null = null

/** Called once by `host.ts`; replaces any earlier instance (tests). */
export function configureCommandChannel(deps: ChannelDeps): CommandChannel {
  current?.dispose()
  current = createCommandChannel(deps)
  return current
}

/** With no channel configured every command is refused `NO_BINDING`: the caller falls back. */
export function enqueue<N extends CommandName>(req: EnqueueRequest<N>): EnqueueResult {
  return current ? current.enqueue(req) : { ok: false, reason: 'NO_BINDING' }
}

export function cancelIfUndelivered(cmd: CmdId): boolean {
  return current?.cancelIfUndelivered(cmd) ?? false
}

export function pendingFor(b: BindingView, cursor?: number): Command[] {
  return current?.pendingFor(b, cursor) ?? []
}

export function closeCommandChannel(): void {
  current?.dispose()
  current = null
}
