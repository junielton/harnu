/**
 * T571 (browser pane U4, AC-6) — the per-pane write queue (spec §6.4): FIFO in arrival order, 10 s wait →
 * BROWSER_BUSY, 60 writes a minute → BROWSER_RATE_LIMIT, other panes never wait.
 */
import { describe, it, expect } from 'vitest'
import { BrowserWriteQueue } from '../src/main/browser/write-queue'

function rig(opts: { queueWaitMs?: number; ratePerMin?: number } = {}) {
  let clock = 0
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = []
  const q = new BrowserWriteQueue(
    {
      now: () => clock,
      startTimer: (fn, ms) => {
        const t = { at: clock + ms, fn, live: true }
        timers.push(t)
        return () => void (t.live = false)
      }
    },
    opts
  )
  const advance = (ms: number): void => {
    clock += ms
    for (const t of timers) {
      if (t.live && t.at <= clock) {
        t.live = false
        t.fn()
      }
    }
  }
  return { q, advance }
}
const deferred = <T = void>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('BrowserWriteQueue', () => {
  it('serialises writes to one pane in the order they ARRIVED, whatever order they got to the queue', async () => {
    const { q } = rig()
    const order: string[] = []
    const a = {}
    const b = {}
    const c = {}
    // Arrival order a, b, c — reserved synchronously on entry.
    q.reserve(a, 'bp-1')
    q.reserve(b, 'bp-1')
    q.reserve(c, 'bp-1')
    const gate = deferred()
    // They reach `run` in a different order: c, then b, then a.
    const rc = q.run('bp-1', c, async () => void order.push('c'))
    const rb = q.run('bp-1', b, async () => void order.push('b'))
    const ra = q.run('bp-1', a, async () => {
      order.push('a')
      await gate.promise
    })
    await flush()
    expect(order).toEqual(['a'])
    gate.resolve()
    await Promise.all([ra, rb, rc])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('refuses BROWSER_BUSY (and runs nothing) after 10 s behind a stuck write; the stuck one still finishes', async () => {
    const { q, advance } = rig()
    const hold = deferred()
    let ran = false
    const first = q.run('bp-1', {}, () => hold.promise)
    await flush()
    const second = q.run('bp-1', {}, async () => void (ran = true))
    await flush()
    advance(10_000)
    expect(await second).toEqual({ ok: false, error: 'BROWSER_BUSY' })
    expect(ran).toBe(false)
    hold.resolve()
    expect(await first).toMatchObject({ ok: true })
  })

  it('refuses the 61st write inside a minute with BROWSER_RATE_LIMIT, and admits again later', async () => {
    const { q, advance } = rig({ ratePerMin: 3 })
    for (let i = 0; i < 3; i++)
      expect(await q.run('bp-1', {}, async () => i)).toMatchObject({ ok: true })
    expect(await q.run('bp-1', {}, async () => 9)).toEqual({
      ok: false,
      error: 'BROWSER_RATE_LIMIT'
    })
    advance(60_001)
    expect(await q.run('bp-1', {}, async () => 9)).toMatchObject({ ok: true, value: 9 })
  })

  it('does not make different panes wait on each other', async () => {
    const { q } = rig()
    const hold = deferred()
    void q.run('bp-1', {}, () => hold.promise)
    await flush()
    expect(await q.run('bp-2', {}, async () => 'ok')).toMatchObject({ ok: true, value: 'ok' })
    hold.resolve()
  })

  it('reports othersWrote to a write that was open while another one ran', async () => {
    const { q } = rig()
    const hold = deferred()
    const first = q.run('bp-1', {}, () => hold.promise)
    await flush()
    const second = q.run('bp-1', {}, async () => 'b')
    await flush()
    hold.resolve()
    expect(await first).toMatchObject({ ok: true, othersWrote: false })
    expect(await second).toMatchObject({ ok: true, othersWrote: false })
  })

  it('a dropped reservation never holds the calls behind it', async () => {
    const { q } = rig()
    const refused = {}
    q.reserve(refused, 'bp-1')
    const next = {}
    q.reserve(next, 'bp-1')
    const run = q.run('bp-1', next, async () => 'ran')
    await flush()
    q.drop(refused)
    expect(await run).toMatchObject({ ok: true, value: 'ran' })
  })

  it('releases the line when a write throws', async () => {
    const { q } = rig()
    await expect(
      q.run('bp-1', {}, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await q.run('bp-1', {}, async () => 1)).toMatchObject({ ok: true })
  })
})
