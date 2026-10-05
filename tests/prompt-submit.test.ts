import { describe, it, expect } from 'vitest'
import { createPromptSubmitter } from '../src/renderer/src/components/prompt-submit'

/**
 * T62 / BUG-9 — an agent's injected pre-prompt must AUTO-SUBMIT. The old code
 * pressed Enter on a fixed 50 ms timeout, which raced the bracketed paste of a
 * large prompt so the `\r` landed inside the paste and never submitted. This is
 * the pure decision core: driven by data-arrival pings + injected timers, it
 * decides WHEN to submit — quiescence, with a hard cap and one safe retry.
 */

/** A deterministic virtual clock: fires injected timers in chronological order. */
function makeClock(): {
  setTimer: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (h: ReturnType<typeof setTimeout>) => void
  advance: (ms: number) => void
  readonly now: number
} {
  let now = 0
  let seq = 0
  const timers = new Map<number, { fireAt: number; cb: () => void }>()
  return {
    setTimer(cb: () => void, ms: number) {
      const id = ++seq
      timers.set(id, { fireAt: now + ms, cb })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer(h: ReturnType<typeof setTimeout>) {
      timers.delete(h as unknown as number)
    },
    advance(ms: number) {
      const target = now + ms
      // Fire due timers in order; re-check after each so a timer that arms a new
      // one inside the window still fires when due (the retry-after-submit case).
      for (;;) {
        let nextId = -1
        let nextAt = Infinity
        for (const [id, t] of timers) {
          if (t.fireAt <= target && t.fireAt < nextAt) {
            nextAt = t.fireAt
            nextId = id
          }
        }
        if (nextId === -1) break
        const t = timers.get(nextId)!
        timers.delete(nextId)
        now = t.fireAt
        t.cb()
      }
      now = target
    },
    get now() {
      return now
    }
  }
}

const CFG = { quietMs: 200, capMs: 2500, retryMs: 600 }

describe('createPromptSubmitter (quiescence submit — T62/BUG-9)', () => {
  it('submits after the paste echo settles, then fires one safe retry', () => {
    const clock = makeClock()
    const submits: number[] = []
    let settled = 0
    const s = createPromptSubmitter({
      submit: () => submits.push(clock.now),
      onSettled: () => settled++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    // Echo arrives at t=10 and t=30, then goes silent.
    clock.advance(10)
    s.onData()
    clock.advance(20) // now=30
    s.onData()
    clock.advance(199) // now=229 — quiet window (30+200=230) not elapsed yet
    expect(submits).toEqual([])
    clock.advance(1) // now=230 — quiescence → first submit
    expect(submits).toEqual([230])
    expect(settled).toBe(0)
    clock.advance(600) // retry at 230+600=830
    expect(submits).toEqual([230, 830]) // exactly two — first + one retry
    expect(settled).toBe(1)
  })

  it('waits through continuous output and submits only after it stops', () => {
    const clock = makeClock()
    const submits: number[] = []
    const s = createPromptSubmitter({
      submit: () => submits.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    // A burst every 50 ms (< quietMs) keeps re-arming the quiet timer.
    for (let i = 0; i < 20; i++) {
      clock.advance(50)
      s.onData()
    }
    expect(submits).toEqual([]) // never silent for 200 ms → never submitted mid-paste
    clock.advance(200) // last onData at 1000 → quiet fires at 1200
    expect(submits).toEqual([1200])
  })

  it('submits at the hard cap when output never settles', () => {
    const clock = makeClock()
    const submits: number[] = []
    const s = createPromptSubmitter({
      submit: () => submits.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    // Output every 100 ms (< quietMs) up to the cap — quiescence never triggers.
    for (let i = 0; i < 25; i++) {
      clock.advance(100)
      s.onData()
    } // now=2500 → the cap fires on the last advance
    // The cap (2500) must have submitted despite the unending stream.
    expect(submits).toEqual([2500])
    clock.advance(600) // retry at 2500+600=3100
    expect(submits).toEqual([2500, 3100])
  })

  it('cancels cleanly with no submit when the PTY dies before it settles', () => {
    const clock = makeClock()
    const submits: number[] = []
    let settled = 0
    const s = createPromptSubmitter({
      submit: () => submits.push(clock.now),
      onSettled: () => settled++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.advance(50)
    s.onData()
    s.cancel() // PTY exited between paste and submit
    clock.advance(5000)
    expect(submits).toEqual([]) // no stray \r into a dead PTY
    expect(settled).toBe(1) // settled exactly once
  })

  it('ignores output that arrives after the first submit (no extra \\r)', () => {
    const clock = makeClock()
    const submits: number[] = []
    const s = createPromptSubmitter({
      submit: () => submits.push(clock.now),
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.advance(10)
    s.onData()
    clock.advance(200) // quiet fires at 210 → first submit
    expect(submits).toEqual([210])
    // Claude starts echoing/thinking during the retry wait — must not add a submit.
    clock.advance(100)
    s.onData()
    s.onData()
    expect(submits).toEqual([210])
    clock.advance(500) // retry at 210+600=810
    expect(submits).toEqual([210, 810])
  })

  it('onSettled is idempotent — a cancel after natural settle does nothing', () => {
    const clock = makeClock()
    let settled = 0
    const s = createPromptSubmitter({
      submit: () => {},
      onSettled: () => settled++,
      ...CFG,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    clock.advance(10)
    s.onData()
    clock.advance(200 + 600) // settle + retry
    expect(settled).toBe(1)
    s.cancel()
    expect(settled).toBe(1)
  })
})
