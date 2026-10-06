/**
 * The pure per-binding command queue (T389 P2W1 §7.2): ordinals, delivery by cursor, expiry, the
 * per-command result grace, the cap, coalescing, cancel and drop.
 */
import { describe, expect, it } from 'vitest'
import {
  ackQueue,
  cancelCommand,
  commitEnqueue,
  createQueue,
  dropQueue,
  enqueueCommand,
  liveCount,
  planEnqueue,
  recordResult,
  sweepQueue,
  takeCommands,
  type EnqueueSpec
} from '../../src/main/companion/command-queue-core'
import {
  CMD_QUEUE_MAX,
  CMD_TTL_MS,
  type BootId,
  type CmdId,
  type CommandName
} from '../../src/main/companion/contract'

const BOOT = 'b_test' as BootId
const SID = '11111111-1111-4111-8111-111111111111'
let seq = 0
const spec = <N extends CommandName>(
  name: N,
  args: unknown = {},
  over: Partial<EnqueueSpec> = {}
): EnqueueSpec => ({
  cmd: `cmd_${++seq}` as CmdId,
  name,
  args: args as never,
  cause: { kind: 'internal', subsystem: 'arbitration' },
  sid: SID,
  ttlMs: CMD_TTL_MS,
  ...over
})
const add = (
  q: ReturnType<typeof createQueue>,
  s: EnqueueSpec,
  now = 1000
): ReturnType<typeof enqueueCommand> => enqueueCommand(q, s, now)

describe('ordinals and delivery', () => {
  it('assigns ordinals per binding and boot', () => {
    const q = createQueue(BOOT)
    const a = add(q, spec('ui.toast', { text: 'a' }))
    const b = add(q, spec('ui.toast', { text: 'b' }))
    expect(a.ok && a.item.command.n).toBe(1)
    expect(b.ok && b.item.command.n).toBe(2)
    expect(takeCommands(q, 0, 1000).map((c) => c.n)).toEqual([1, 2])
  })

  it('stamps issuedAt, expiresAt and the result deadline from the clock and the name', () => {
    const q = createQueue(BOOT)
    const r = add(q, spec('session.compact'), 5000)
    if (!r.ok) throw new Error('refused')
    expect(r.item.command.issuedAt).toBe(5000)
    expect(r.item.command.expiresAt).toBe(5000 + CMD_TTL_MS)
    expect(r.item.resultDeadline).toBe(5000 + CMD_TTL_MS + 120_000)
    const f = add(createQueue(BOOT), spec('flush'), 5000)
    if (!f.ok) throw new Error('refused')
    expect(f.item.resultDeadline).toBe(5000 + CMD_TTL_MS + 5000)
  })

  it('re-sends an unanswered command above the cursor', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.toast', { text: 'a' }))
    ackQueue(q, 1) // delivered, no result yet
    expect(takeCommands(q, 0, 2000).map((c) => c.n)).toEqual([1])
    expect(takeCommands(q, 1, 2000)).toEqual([])
  })

  it('a cursor above the highest ordinal is ignored and counted', () => {
    const q = createQueue(BOOT)
    add(q, spec('flush'))
    ackQueue(q, 99)
    expect(q.ackedCursor).toBe(0)
    expect(q.stats.badCursors).toBe(1)
    expect(q.items[0]?.state).toBe('queued')
  })

  it('a cursor never moves backwards', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.toast', { text: 'a' }))
    add(q, spec('ui.toast', { text: 'b' }))
    ackQueue(q, 2)
    ackQueue(q, 1)
    expect(q.ackedCursor).toBe(2)
  })
})

describe('expiry and the result grace', () => {
  it('expires an undelivered command', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.toast', { text: 'a' }), 1000)
    const settled = sweepQueue(q, 1000 + CMD_TTL_MS)
    expect(settled.map((s) => s.outcome)).toEqual([{ state: 'expired' }])
    expect(takeCommands(q, 0, 1000 + CMD_TTL_MS)).toEqual([])
    expect(liveCount(q)).toBe(0)
  })

  it('take never returns a command past expiresAt, even before the sweep ran', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.toast', { text: 'a' }), 1000)
    expect(takeCommands(q, 0, 1000 + CMD_TTL_MS)).toEqual([])
  })

  it('result grace is per command: not lost yet', () => {
    const q = createQueue(BOOT)
    add(q, spec('session.compact'), 0)
    ackQueue(q, 1)
    expect(sweepQueue(q, 30_000)).toEqual([])
    expect(q.items[0]?.state).toBe('delivered')
  })

  it('result grace is per command: lost after the grace', () => {
    const q = createQueue(BOOT)
    add(q, spec('session.compact'), 0)
    ackQueue(q, 1)
    expect(sweepQueue(q, 149_999)).toEqual([])
    const settled = sweepQueue(q, 150_000)
    expect(settled.map((s) => s.outcome)).toEqual([{ state: 'lost' }])
    expect(liveCount(q)).toBe(0)
  })

  it('an ordinary command is lost five seconds after it expires', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.toast', { text: 'a' }), 0)
    ackQueue(q, 1)
    expect(sweepQueue(q, CMD_TTL_MS + 4_999)).toEqual([])
    expect(sweepQueue(q, CMD_TTL_MS + 5_000).map((s) => s.outcome.state)).toEqual(['lost'])
  })
})

describe('the cap', () => {
  it('refuses over the cap', () => {
    const q = createQueue(BOOT)
    for (let i = 0; i < CMD_QUEUE_MAX; i++) {
      expect(add(q, spec('ui.toast', { text: `t${i}` })).ok).toBe(true)
    }
    const over = add(q, spec('ui.toast', { text: 'one more' }))
    expect(over).toEqual({ ok: false, reason: 'QUEUE_FULL' })
    expect(liveCount(q)).toBe(CMD_QUEUE_MAX)
    expect(q.items[0]?.state).toBe('queued') // nothing evicted
  })

  it('a replacement at the cap is not growth', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.status', { text: 's' }))
    for (let i = 1; i < CMD_QUEUE_MAX; i++) add(q, spec('ui.toast', { text: `t${i}` }))
    expect(liveCount(q)).toBe(CMD_QUEUE_MAX)
    expect(add(q, spec('ui.status', { text: 's2' })).ok).toBe(true)
    expect(liveCount(q)).toBe(CMD_QUEUE_MAX)
  })
})

describe('coalescing (undelivered only)', () => {
  it('a new ui.status replaces an older undelivered one', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.status', { text: 'one' }))
    const r = add(q, spec('ui.status', { text: 'two' }))
    if (!r.ok) throw new Error('refused')
    expect(r.replaced.map((s) => s.outcome)).toEqual([
      { state: 'dropped', why: 'cancelled', delivered: false }
    ])
    expect(takeCommands(q, 0, 1000).map((c) => c.args)).toEqual([{ text: 'two' }])
  })

  it('does not replace a delivered ui.status', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.status', { text: 'one' }))
    ackQueue(q, 1)
    add(q, spec('ui.status', { text: 'two' }))
    expect(liveCount(q)).toBe(2)
  })

  it('config.update merges into one command, the newest value winning', () => {
    const q = createQueue(BOOT)
    add(q, spec('config.update', { config: { flushMs: 100, ringMax: 64 } }))
    add(q, spec('config.update', { config: { flushMs: 200 } }))
    const out = takeCommands(q, 0, 1000)
    expect(out.length).toBe(1)
    expect(out[0]?.args).toEqual({ config: { flushMs: 200, ringMax: 64 } })
  })

  it('a second flush is deduped onto the first', () => {
    const q = createQueue(BOOT)
    const a = add(q, spec('flush'))
    const b = add(q, spec('flush'))
    if (!a.ok || !b.ok) throw new Error('refused')
    expect(b.item).toBe(a.item)
    expect(b.coalesced).toBe(true)
    expect(liveCount(q)).toBe(1)
  })

  it('plan and commit are separate so the audit row can come between them', () => {
    const q = createQueue(BOOT)
    const plan = planEnqueue(q, spec('ui.toast', { text: 'a' }), 1000)
    if (!plan.ok) throw new Error('refused')
    expect(plan.n).toBe(1)
    expect(liveCount(q)).toBe(0) // planning mutates nothing
    commitEnqueue(q, plan)
    expect(liveCount(q)).toBe(1)
  })
})

describe('results, cancel and drop', () => {
  it('the first result wins and settles the item', () => {
    const q = createQueue(BOOT)
    const r = add(q, spec('flush'))
    if (!r.ok) throw new Error('refused')
    const first = recordResult(q, r.item.command.cmd, { ok: true })
    expect(first?.outcome).toEqual({ state: 'resulted', ok: true })
    expect(recordResult(q, r.item.command.cmd, { ok: false, code: 'CMD_FAILED' })).toBeNull()
    expect(q.stats.ignoredResults).toBe(1)
    expect(liveCount(q)).toBe(0)
  })

  it('a result for an unknown command is ignored and counted', () => {
    const q = createQueue(BOOT)
    expect(recordResult(q, 'cmd_nope' as CmdId, { ok: true })).toBeNull()
    expect(q.stats.ignoredResults).toBe(1)
  })

  it('cancel succeeds only while the command is queued', () => {
    const q = createQueue(BOOT)
    const a = add(q, spec('ui.toast', { text: 'a' }))
    const b = add(q, spec('ui.toast', { text: 'b' }))
    if (!a.ok || !b.ok) throw new Error('refused')
    ackQueue(q, 1)
    expect(cancelCommand(q, a.item.command.cmd)).toBeNull() // delivered
    expect(cancelCommand(q, b.item.command.cmd)?.outcome).toEqual({
      state: 'dropped',
      why: 'cancelled',
      delivered: false
    })
  })

  it('drop settles every live item and says whether it was delivered', () => {
    const q = createQueue(BOOT)
    add(q, spec('ui.toast', { text: 'a' }))
    add(q, spec('ui.toast', { text: 'b' }))
    ackQueue(q, 1)
    const out = dropQueue(q, 'lease-lost')
    expect(out.map((s) => s.outcome)).toEqual([
      { state: 'dropped', why: 'lease-lost', delivered: true },
      { state: 'dropped', why: 'lease-lost', delivered: false }
    ])
    expect(liveCount(q)).toBe(0)
  })

  it('drop can keep flush and config.update (a rebound)', () => {
    const q = createQueue(BOOT)
    add(q, spec('flush'))
    add(q, spec('config.update', { config: { flushMs: 100 } }))
    add(q, spec('ui.status', { text: 'x' }))
    const out = dropQueue(
      q,
      'rebound',
      (i) => i.command.name === 'flush' || i.command.name === 'config.update'
    )
    expect(out.map((s) => s.item.command.name)).toEqual(['ui.status'])
    expect(liveCount(q)).toBe(2)
  })
})
