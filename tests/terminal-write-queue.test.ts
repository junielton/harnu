/**
 * T482 (agent terminals B5) — `terminal-write-queue`: FIFO per terminal, the 10 s queue bound,
 * the 60-per-minute rate limit, `othersWrote`, the Esc gap and the settle (spec §4.4).
 * Everything runs on an injected clock and timer: no real waiting.
 */
import { describe, it, expect } from 'vitest'
import {
  QUEUE_WAIT_MS,
  RATE_LIMIT_PER_MIN,
  SETTLE_CAP_MS,
  SETTLE_QUIET_MS,
  TerminalWriteQueue,
  settleAfterSend,
  writeSegments,
  type WriteScope
} from '../src/main/terminal-write-queue'
import { ESC_GAP_MS } from '../src/main/terminal-keys'

/** A manual clock with timers: `advance(ms)` fires everything that came due, in order. */
function fakeClock(): {
  now: () => number
  startTimer: (fn: () => void, ms: number) => () => void
  advance: (ms: number) => void
  pending: () => number
} {
  let t = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    startTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: t + ms, fn })
      return () => timers.delete(id)
    },
    advance: (ms) => {
      const target = t + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].fn()
      }
      t = target
    },
    pending: () => timers.size
  }
}

function admit(q: TerminalWriteQueue, id: string): WriteScope {
  const r = q.admit(id)
  if (!r.ok) throw new Error(r.error)
  return r.scope
}

describe('AC-B5-6 — FIFO', () => {
  it('serialises writes to one terminal in arrival order', async () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    const order: string[] = []
    const a = admit(q, 't')
    const b = admit(q, 't')
    const c = admit(q, 't')
    const run = async (name: string, scope: WriteScope): Promise<void> => {
      if (!(await q.acquire('t', scope))) throw new Error('busy')
      order.push(`${name}:start`)
      await Promise.resolve()
      order.push(`${name}:end`)
      q.release('t', scope)
    }
    // Start them out of order of completion: all three queue behind the first.
    await Promise.all([run('a', a), run('b', b), run('c', c)])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
  })

  it('a second call does not start until the first releases', async () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 't')
    const b = admit(q, 't')
    expect(await q.acquire('t', a)).toBe(true)
    let bGot = false
    const bp = q.acquire('t', b).then((v) => (bGot = v))
    await Promise.resolve()
    expect(bGot).toBe(false)
    q.release('t', a)
    await bp
    expect(bGot).toBe(true)
  })

  it('different terminals do not wait for each other', async () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 't1')
    const b = admit(q, 't2')
    expect(await q.acquire('t1', a)).toBe(true)
    expect(await q.acquire('t2', b)).toBe(true)
  })
})

describe('F1 — tickets: arrival order, not queue-entry order', () => {
  const place = (q: TerminalWriteQueue, id: string): { ticket: number; key: object } => {
    const key = {}
    q.reserve(key, id)
    return { key, ticket: q.claim(key, id) }
  }

  it('a call that arrived first goes first even though it reaches the line second', async () => {
    const q = new TerminalWriteQueue(fakeClock())
    const early = place(q, 't')
    const late = place(q, 't')
    const order: string[] = []
    const run = async (name: string, ticket: number): Promise<void> => {
      const r = q.admit('t', ticket)
      if (!r.ok) throw new Error(r.error)
      if (!(await q.acquire('t', r.scope))) throw new Error('busy')
      order.push(name)
      q.release('t', r.scope)
    }
    const lateRun = run('late', late.ticket)
    await Promise.resolve()
    // The late call is first at the line but an earlier ticket is still on its way: it waits.
    expect(order).toEqual([])
    await Promise.all([run('early', early.ticket), lateRun])
    expect(order).toEqual(['early', 'late'])
  })

  it('a ticket that is abandoned stops holding the calls behind it', async () => {
    const q = new TerminalWriteQueue(fakeClock())
    const gone = place(q, 't')
    const next = place(q, 't')
    const r = q.admit('t', next.ticket)
    if (!r.ok) throw new Error(r.error)
    let got = false
    void q.acquire('t', r.scope).then((v) => (got = v))
    await Promise.resolve()
    expect(got).toBe(false)
    q.abandonTicket('t', gone.ticket)
    await Promise.resolve()
    expect(got).toBe(true)
  })

  it('dropping an unclaimed reservation also releases the line, and is idempotent', async () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = {}
    const b = {}
    q.reserve(a, 't')
    q.reserve(b, 't')
    const tb = q.claim(b, 't')
    const r = q.admit('t', tb)
    if (!r.ok) throw new Error(r.error)
    let got = false
    void q.acquire('t', r.scope).then((v) => (got = v))
    await Promise.resolve()
    expect(got).toBe(false)
    q.drop(a)
    q.drop(a)
    await Promise.resolve()
    expect(got).toBe(true)
  })

  it('a ticket that never arrives costs the calls behind it the 10 s bound, not more', async () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    place(q, 't') // never reaches the line
    const next = place(q, 't')
    const r = q.admit('t', next.ticket)
    if (!r.ok) throw new Error(r.error)
    let result: boolean | undefined
    void q.acquire('t', r.scope).then((v) => (result = v))
    clock.advance(QUEUE_WAIT_MS - 1)
    await Promise.resolve()
    expect(result).toBeUndefined()
    clock.advance(1)
    await Promise.resolve()
    expect(result).toBe(false)
  })

  it('a call without a reservation takes its place when claimed', () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = q.claim({}, 't')
    const b = q.claim({}, 't')
    expect(b).toBeGreaterThan(a)
  })
})

describe('AC-B5-6 — an 11 s queue wait is TERMINAL_BUSY', () => {
  it('gives up after exactly 10 s, and leaves the line', async () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    const holder = admit(q, 't')
    expect(await q.acquire('t', holder)).toBe(true)

    const waiter = admit(q, 't')
    let result: boolean | undefined
    const p = q.acquire('t', waiter).then((v) => (result = v))
    clock.advance(QUEUE_WAIT_MS - 1)
    await Promise.resolve()
    expect(result).toBeUndefined()
    clock.advance(1)
    await p
    expect(result).toBe(false)
    expect(QUEUE_WAIT_MS).toBe(10_000)
  })

  it('an 11 s hold makes the next call BUSY, but the holder still releases cleanly', async () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    const holder = admit(q, 't')
    await q.acquire('t', holder)
    const waiter = admit(q, 't')
    const p = q.acquire('t', waiter)
    clock.advance(11_000)
    expect(await p).toBe(false)
    q.release('t', holder)
    // The timed-out waiter is gone: the line is free for a fresh call.
    const fresh = admit(q, 't')
    expect(await q.acquire('t', fresh)).toBe(true)
  })

  it('a waiter granted the line cancels its timer', async () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    const a = admit(q, 't')
    const b = admit(q, 't')
    await q.acquire('t', a)
    const p = q.acquire('t', b)
    q.release('t', a)
    expect(await p).toBe(true)
    expect(clock.pending()).toBe(0)
  })

  it('a waiter that timed out is skipped when the line frees up', async () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    const a = admit(q, 't')
    const b = admit(q, 't')
    const c = admit(q, 't')
    await q.acquire('t', a)
    const pb = q.acquire('t', b)
    clock.advance(6_000)
    const pc = q.acquire('t', c)
    clock.advance(5_000) // b is past 10 s, c has waited 5 s
    expect(await pb).toBe(false)
    q.release('t', a)
    expect(await pc).toBe(true)
  })
})

describe('AC-B5-6 — 61 sends in a minute is TERMINAL_RATE_LIMIT', () => {
  it('admits 60 and refuses the 61st', () => {
    const q = new TerminalWriteQueue(fakeClock())
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) expect(q.admit('t').ok).toBe(true)
    expect(q.admit('t')).toEqual({ ok: false, error: 'TERMINAL_RATE_LIMIT' })
    expect(RATE_LIMIT_PER_MIN).toBe(60)
  })

  it('the window rolls: a slot frees a minute after it was taken', () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    for (let i = 0; i < 60; i++) {
      q.admit('t')
      clock.advance(500) // 60 sends over 30 s
    }
    expect(q.admit('t').ok).toBe(false)
    clock.advance(30_000) // the first send is now 60 s old
    expect(q.admit('t').ok).toBe(true)
  })

  it('is per terminal', () => {
    const q = new TerminalWriteQueue(fakeClock())
    for (let i = 0; i < 60; i++) q.admit('t1')
    expect(q.admit('t1').ok).toBe(false)
    expect(q.admit('t2').ok).toBe(true)
  })

  it('a refused call does not take a slot, finished calls still count', () => {
    const clock = fakeClock()
    const q = new TerminalWriteQueue(clock)
    const scopes: WriteScope[] = []
    for (let i = 0; i < 60; i++) scopes.push(admit(q, 't'))
    for (const s of scopes) q.finish('t', s)
    expect(q.admit('t').ok).toBe(false) // finishing does not give the slot back
    clock.advance(60_001)
    expect(q.admit('t').ok).toBe(true)
  })
})

describe('AC-B5-6 — othersWrote', () => {
  it('a write by one call marks the OTHER calls open on that terminal, not itself', () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 't')
    const b = admit(q, 't')
    q.noteWrite('t', a)
    expect(a.othersWrote).toBe(false)
    expect(b.othersWrote).toBe(true)
  })

  it('a call that finished is not marked by a later write', () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 't')
    const b = admit(q, 't')
    q.finish('t', a)
    q.noteWrite('t', b)
    expect(a.othersWrote).toBe(false)
  })

  it('a write on another terminal marks nobody here', () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 't1')
    const b = admit(q, 't2')
    q.noteWrite('t2', b)
    expect(a.othersWrote).toBe(false)
  })

  it('a lone call is never othersWrote', () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 't')
    q.noteWrite('t', a)
    expect(a.othersWrote).toBe(false)
  })
})

describe('finish / prune', () => {
  it('finishing a scope that still holds the line frees it', async () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 't')
    const b = admit(q, 't')
    await q.acquire('t', a)
    const pb = q.acquire('t', b)
    q.finish('t', a)
    expect(await pb).toBe(true)
  })

  it('prune drops the lines of terminals the registry forgot, never one in use', async () => {
    const q = new TerminalWriteQueue(fakeClock())
    const a = admit(q, 'gone')
    q.finish('gone', a)
    const live = admit(q, 'busy')
    q.prune(() => false)
    // `busy` still has an open call: its scope keeps working.
    expect(await q.acquire('busy', live)).toBe(true)
  })
})

describe('AC-B5-5 — an Esc and the bytes after it are two writes, 50 ms apart', () => {
  it('writes pieces in order with the Esc gap between them, and only between them', async () => {
    const calls: { at: string; data: string }[] = []
    const sleeps: number[] = []
    const r = await writeSegments(['\x1b', ':q!\r'], {
      write: (d) => {
        calls.push({ at: `after ${sleeps.length} sleeps`, data: d })
        return true
      },
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })
    expect(r).toEqual({ written: 2, complete: true })
    expect(calls).toEqual([
      { at: 'after 0 sleeps', data: '\x1b' },
      { at: 'after 1 sleeps', data: ':q!\r' }
    ])
    expect(sleeps).toEqual([ESC_GAP_MS])
    expect(ESC_GAP_MS).toBe(50)
  })

  it('one segment is one write and no sleep', async () => {
    const writes: string[] = []
    const sleeps: number[] = []
    await writeSegments(['ls -l\r'], {
      write: (d) => (writes.push(d), true),
      sleep: async (ms) => void sleeps.push(ms)
    })
    expect(writes).toEqual(['ls -l\r'])
    expect(sleeps).toEqual([])
  })

  it('the second write really waits 50 ms (real timers)', async () => {
    const stamps: number[] = []
    await writeSegments(['\x1b', 'x'], {
      write: () => (stamps.push(performance.now()), true),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms))
    })
    expect(stamps).toHaveLength(2)
    // setTimeout may fire a hair early on some platforms; never by more than a couple of ms.
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(ESC_GAP_MS - 2)
  })

  it('stops at the first write that fails and says how far it got', async () => {
    const sleeps: number[] = []
    let n = 0
    const r = await writeSegments(['a', 'b', 'c'], {
      write: () => ++n < 2,
      sleep: async (ms) => void sleeps.push(ms)
    })
    expect(r).toEqual({ written: 1, complete: false })
    expect(n).toBe(2)
  })
})

describe('settleAfterSend — the 150 ms settle, capped at 1 s', () => {
  function harness(lastOutputs: (t: number) => number): {
    run: (sentAt: number) => Promise<number>
    clock: ReturnType<typeof fakeClock>
  } {
    const clock = fakeClock()
    return {
      clock,
      run: (sentAt) =>
        settleAfterSend({
          now: clock.now,
          sleep: async (ms) => clock.advance(ms),
          lastOutputAt: () => lastOutputs(clock.now()),
          sentAt
        })
    }
  }

  it('returns 150 ms after the send when nothing prints', async () => {
    const h = harness(() => 0)
    h.clock.advance(1000)
    expect(await h.run(h.clock.now())).toBe(SETTLE_QUIET_MS)
    expect(SETTLE_QUIET_MS).toBe(150)
  })

  it('output that keeps arriving extends the wait, until the 1 s cap', async () => {
    const h = harness((t) => t) // output at every instant
    expect(await h.run(0)).toBe(SETTLE_CAP_MS)
    expect(SETTLE_CAP_MS).toBe(1000)
  })

  it('output that stops early returns 150 ms after its last byte', async () => {
    const h = harness((t) => Math.min(t, 300))
    expect(await h.run(0)).toBe(450)
  })

  it('output from before the send does not count as quiet or as noise', async () => {
    const h = harness(() => -5000)
    h.clock.advance(10)
    expect(await h.run(h.clock.now())).toBe(SETTLE_QUIET_MS)
  })
})
