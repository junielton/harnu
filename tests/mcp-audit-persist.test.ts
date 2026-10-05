import { describe, it, expect, vi } from 'vitest'
import { createAuditPersister, type TimerHandle } from '../src/main/mcp/audit-persist'

/**
 * T26 part 2 — the trailing-coalesce debouncer for the MCP audit persist. Pure
 * (timers + persist injected), so it's tested with a hand-driven fake clock: one
 * pending timer per burst, coalesced into a single write on fire; `flush()`
 * cancels the timer and writes immediately; writes are serialized (never
 * interleave).
 */

/** A hand-driven timer: `arm` records the callback; `tick` fires the pending one. */
function fakeTimer(): {
  setTimer: (cb: () => void, ms: number) => TimerHandle
  clearTimer: (h: TimerHandle) => void
  tick: () => void
  armed: () => number
} {
  let cb: (() => void) | null = null
  let cleared = 0
  return {
    setTimer: (fn) => {
      cb = fn
      return 1 as unknown as TimerHandle
    },
    clearTimer: () => {
      cb = null
      cleared++
    },
    tick: () => {
      const fn = cb
      cb = null
      fn?.()
    },
    armed: () => (cb ? 1 : 0) + cleared * 0 // 1 if a timer is currently pending
  }
}

describe('createAuditPersister', () => {
  it('coalesces a burst of schedules into a single write on the timer fire', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const t = fakeTimer()
    const p = createAuditPersister({
      persist,
      delayMs: 500,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer
    })

    p.schedule()
    p.schedule()
    p.schedule()
    expect(persist).not.toHaveBeenCalled() // nothing written yet — still in the window

    t.tick()
    await Promise.resolve() // let the chained persist run
    expect(persist).toHaveBeenCalledTimes(1) // the whole burst → one write
  })

  it('does not re-arm the timer while one is already pending', () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const setTimer = vi.fn().mockReturnValue(1 as unknown as TimerHandle)
    const p = createAuditPersister({ persist, delayMs: 500, setTimer, clearTimer: vi.fn() })
    p.schedule()
    p.schedule()
    p.schedule()
    expect(setTimer).toHaveBeenCalledTimes(1) // armed once for the burst
  })

  it('arms a fresh timer for the next burst after the previous one fired', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const setTimer = vi.fn<(cb: () => void, ms: number) => TimerHandle>()
    let cb: (() => void) | null = null
    setTimer.mockImplementation((fn) => {
      cb = fn
      return 1 as unknown as TimerHandle
    })
    const p = createAuditPersister({ persist, delayMs: 500, setTimer, clearTimer: vi.fn() })

    p.schedule()
    cb?.() // fire the first window
    await Promise.resolve()
    p.schedule() // a new burst arms again
    expect(setTimer).toHaveBeenCalledTimes(2)
  })

  it('flush cancels a pending timer and persists immediately', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const clearTimer = vi.fn()
    const t = fakeTimer()
    const p = createAuditPersister({
      persist,
      delayMs: 500,
      setTimer: t.setTimer,
      clearTimer
    })

    p.schedule()
    await p.flush()
    expect(clearTimer).toHaveBeenCalledTimes(1) // the pending timer was cancelled
    expect(persist).toHaveBeenCalledTimes(1) // and written now, not on the (cancelled) timer
  })

  it('flush with no pending timer still persists', async () => {
    const persist = vi.fn().mockResolvedValue(undefined)
    const clearTimer = vi.fn()
    const p = createAuditPersister({ persist, delayMs: 500, setTimer: vi.fn(), clearTimer })
    await p.flush()
    expect(clearTimer).not.toHaveBeenCalled()
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('serializes writes — a flush during an in-flight write does not interleave', async () => {
    const order: string[] = []
    let releaseFirst: () => void = () => {}
    const persist = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            order.push('start-1')
            releaseFirst = () => {
              order.push('end-1')
              resolve()
            }
          })
      )
      .mockImplementationOnce(async () => {
        order.push('start-2')
        order.push('end-2')
      })
    const t = fakeTimer()
    const p = createAuditPersister({
      persist,
      delayMs: 500,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer
    })

    p.schedule()
    t.tick() // starts write #1 (blocks until released)
    const flushed = p.flush() // write #2 must wait for #1
    await Promise.resolve()
    expect(order).toEqual(['start-1']) // #2 has NOT started yet
    releaseFirst()
    await flushed
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']) // strictly serial
  })
})
