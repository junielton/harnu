/**
 * The per-binding command queue (T389 P2W1 §7.2). Pure: the clock is a parameter, nothing here
 * touches I/O, a timer or a promise. `command-channel.ts` owns the one queue per binding, the poll
 * parking and the audit; every rule about what a command may become lives here.
 *
 * Delivery and execution are separate facts (contract §6, commands 3): the mod's cursor
 * acknowledges DELIVERY (`queued` becomes `delivered`), a `command.result` acknowledges EXECUTION.
 * A live item (queued or delivered) is never evicted to make room: a full queue refuses.
 */

import {
  CMD_QUEUE_MAX,
  CMD_RESULT_GRACE_DEFAULT_MS,
  CMD_RESULT_GRACE_MS,
  type BootId,
  type CmdId,
  type Command,
  type CommandName,
  type ErrorCode,
  type Sid
} from './contract'
import type {
  CommandCause,
  CommandOutcome,
  DropWhy,
  QueuedCommand,
  Settlement
} from './command-types'

export interface QueueStats {
  /** A cursor above the highest ordinal the host ever issued (untrusted input, SEC-3c). */
  badCursors: number
  /** A result for a settled or unknown command. */
  ignoredResults: number
}

export interface BindingQueue {
  bootId: BootId
  nextN: number // starts at 1 per binding and boot
  ackedCursor: number
  items: QueuedCommand[] // live only: queued or delivered, in `n` order
  stats: QueueStats
}

export function createQueue(bootId: BootId): BindingQueue {
  return {
    bootId,
    nextN: 1,
    ackedCursor: 0,
    items: [],
    stats: { badCursors: 0, ignoredResults: 0 }
  }
}

export const liveCount = (q: BindingQueue): number => q.items.length

export const graceFor = (name: CommandName): number =>
  CMD_RESULT_GRACE_MS[name] ?? CMD_RESULT_GRACE_DEFAULT_MS

// ---- enqueue ----------------------------------------------------------------------------------

export interface EnqueueSpec {
  cmd: CmdId
  name: CommandName
  args: Command['args']
  cause: CommandCause
  sid: Sid
  ttlMs: number
}

export interface EnqueuePlan {
  ok: true
  /** The ordinal this command will carry (an existing one for a deduped `flush`). */
  n: number
  cmd: CmdId
  spec: EnqueueSpec
  args: Command['args']
  now: number
  /** Undelivered items this one supersedes; they settle `dropped: cancelled`. */
  replace: QueuedCommand[]
  /** A `flush` that is already waiting: the caller gets this item back and nothing is added. */
  dedupe?: QueuedCommand
}

export type EnqueueOutcome =
  | { ok: true; item: QueuedCommand; coalesced: boolean; replaced: Settlement[] }
  | { ok: false; reason: 'QUEUE_FULL' }

const isQueued = (i: QueuedCommand, name: CommandName): boolean =>
  i.state === 'queued' && i.command.name === name

/**
 * Decides what an enqueue would do without doing it, so the shell can write the audit row between
 * the decision and the write (SEC-6: no audit, no command).
 */
export function planEnqueue(
  q: BindingQueue,
  spec: EnqueueSpec,
  now: number
): EnqueuePlan | { ok: false; reason: 'QUEUE_FULL' } {
  let args = spec.args
  const replace: QueuedCommand[] = []
  if (spec.name === 'flush') {
    const waiting = q.items.find((i) => isQueued(i, 'flush'))
    if (waiting) {
      return {
        ok: true,
        n: waiting.command.n,
        cmd: waiting.command.cmd,
        spec,
        args,
        now,
        replace,
        dedupe: waiting
      }
    }
  } else if (spec.name === 'ui.status') {
    replace.push(...q.items.filter((i) => isQueued(i, 'ui.status')))
  } else if (spec.name === 'config.update') {
    const older = q.items.filter((i) => isQueued(i, 'config.update'))
    replace.push(...older)
    if (older.length > 0) {
      const merged: Record<string, unknown> = {}
      for (const o of older) Object.assign(merged, (o.command.args as { config: object }).config)
      Object.assign(merged, (spec.args as { config: object }).config)
      args = { config: merged } as Command['args']
    }
  }
  if (q.items.length - replace.length >= CMD_QUEUE_MAX) return { ok: false, reason: 'QUEUE_FULL' }
  return { ok: true, n: q.nextN, cmd: spec.cmd, spec, args, now, replace }
}

/** Applies a plan from {@link planEnqueue}. No other call may add to `items`. */
export function commitEnqueue(
  q: BindingQueue,
  plan: EnqueuePlan
): Extract<EnqueueOutcome, { ok: true }> {
  if (plan.dedupe) return { ok: true, item: plan.dedupe, coalesced: true, replaced: [] }
  const replaced = plan.replace.map((i) =>
    settle(q, i, { state: 'dropped', why: 'cancelled', delivered: false })
  )
  const { spec, now } = plan
  const expiresAt = now + spec.ttlMs
  const item: QueuedCommand = {
    command: {
      cmd: spec.cmd,
      n: q.nextN++,
      name: spec.name,
      args: plan.args,
      issuedAt: now,
      expiresAt
    },
    cause: spec.cause,
    sidAtEnqueue: spec.sid,
    state: 'queued',
    resultDeadline: expiresAt + graceFor(spec.name)
  }
  q.items.push(item)
  return { ok: true, item, coalesced: false, replaced }
}

/** Plan and commit in one step (tests, and callers with no audit to interleave). */
export function enqueueCommand(q: BindingQueue, spec: EnqueueSpec, now: number): EnqueueOutcome {
  const plan = planEnqueue(q, spec, now)
  return plan.ok ? commitEnqueue(q, plan) : plan
}

// ---- delivery ---------------------------------------------------------------------------------

/**
 * The mod's cursor: every `queued` item with `n <= cursor` is now `delivered`. A cursor above the
 * highest ordinal ever issued is ignored and counted.
 */
export function ackQueue(q: BindingQueue, cursor: number): void {
  if (cursor > q.nextN - 1) {
    q.stats.badCursors++
    return
  }
  q.ackedCursor = Math.max(q.ackedCursor, cursor)
  for (const i of q.items) {
    if (i.state === 'queued' && i.command.n <= cursor) i.state = 'delivered'
  }
}

/** Items above the cursor with no outcome and not past `expiresAt`, in `n` order. */
export function takeCommands(q: BindingQueue, cursor: number, now: number): Command[] {
  return q.items
    .filter((i) => i.command.n > cursor && now < i.command.expiresAt)
    .map((i) => i.command)
}

// ---- settling ---------------------------------------------------------------------------------

function settle(q: BindingQueue, item: QueuedCommand, outcome: CommandOutcome): Settlement {
  item.outcome = outcome
  item.state = outcome.state
  q.items = q.items.filter((i) => i !== item)
  return { item, outcome }
}

export interface ResultInput {
  ok: boolean
  code?: ErrorCode
  message?: string
  data?: unknown
}

/** The first result wins. A duplicate, or one for a command this queue does not hold, is counted. */
export function recordResult(q: BindingQueue, cmd: CmdId, r: ResultInput): Settlement | null {
  const item = q.items.find((i) => i.command.cmd === cmd)
  if (!item) {
    q.stats.ignoredResults++
    return null
  }
  return settle(q, item, {
    state: 'resulted',
    ok: r.ok,
    ...(r.code !== undefined ? { code: r.code } : {}),
    ...(r.message !== undefined ? { message: r.message } : {}),
    ...(r.data !== undefined ? { data: r.data } : {})
  })
}

/** Only while the item is `queued` (never delivered): P2W3 uses it to avoid a double delivery. */
export function cancelCommand(q: BindingQueue, cmd: CmdId): Settlement | null {
  const item = q.items.find((i) => i.command.cmd === cmd && i.state === 'queued')
  return item ? settle(q, item, { state: 'dropped', why: 'cancelled', delivered: false }) : null
}

/** `queued` past `expiresAt` is `expired`; `delivered` past its result deadline is `lost`. */
export function sweepQueue(q: BindingQueue, now: number): Settlement[] {
  const out: Settlement[] = []
  for (const i of [...q.items]) {
    if (i.state === 'queued' && now >= i.command.expiresAt)
      out.push(settle(q, i, { state: 'expired' }))
    else if (i.state === 'delivered' && now >= i.resultDeadline)
      out.push(settle(q, i, { state: 'lost' }))
  }
  return out
}

/** Settles every live item as dropped, except those `keep` names (a rebound keeps housekeeping). */
export function dropQueue(
  q: BindingQueue,
  why: DropWhy,
  keep?: (i: QueuedCommand) => boolean
): Settlement[] {
  return [...q.items]
    .filter((i) => !keep?.(i))
    .map((i) => settle(q, i, { state: 'dropped', why, delivered: i.state === 'delivered' }))
}
