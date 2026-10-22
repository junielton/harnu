/**
 * T568 delta 3 — bounds reporting must not depend on requestAnimationFrame alone: an occluded or minimized
 * window stops rAF, so the timer fallback has to run the report.
 */
import { describe, it, expect } from 'vitest'
import { createFrameScheduler, FRAME_FALLBACK_MS } from '../src/renderer/src/lib/frame-scheduler'

function rig(visible = true) {
  const frames = new Map<number, () => void>()
  const timers = new Map<number, { cb: () => void; ms: number }>()
  let id = 0
  const state = { visible, runs: 0 }
  const scheduler = createFrameScheduler(
    {
      requestFrame: (cb) => (frames.set(++id, cb), id),
      cancelFrame: (n) => void frames.delete(n),
      setTimer: (cb, ms) => (timers.set(++id, { cb, ms }), id),
      clearTimer: (h) => void timers.delete(h as number),
      isVisible: () => state.visible
    },
    () => state.runs++
  )
  return {
    scheduler,
    state,
    frames,
    timers,
    fireFrame: () => [...frames.values()][0]?.(),
    fireTimer: () => [...timers.values()][0]?.cb()
  }
}

describe('createFrameScheduler', () => {
  it('runs on the animation frame when the document is visible, and cancels the fallback timer', () => {
    const r = rig()
    r.scheduler.schedule()
    expect(r.frames.size).toBe(1)
    expect([...r.timers.values()][0]?.ms).toBe(FRAME_FALLBACK_MS)
    r.fireFrame()
    expect(r.state.runs).toBe(1)
    expect(r.timers.size).toBe(0)
    expect(r.frames.size).toBe(0)
  })

  it('runs from the timer when the frame never fires (an occluded window), once, and drops the frame', () => {
    const r = rig()
    r.scheduler.schedule()
    r.fireTimer()
    expect(r.state.runs).toBe(1)
    expect(r.frames.size).toBe(0)
    // A late frame (the window came back) must not run it a second time.
    expect(r.scheduler.pending()).toBe(false)
  })

  it('a hidden document uses the timer only', () => {
    const r = rig(false)
    r.scheduler.schedule()
    expect(r.frames.size).toBe(0)
    expect(r.timers.size).toBe(1)
    r.fireTimer()
    expect(r.state.runs).toBe(1)
  })

  it('coalesces schedules while one is pending and allows the next after it ran', () => {
    const r = rig()
    r.scheduler.schedule()
    r.scheduler.schedule()
    r.scheduler.schedule()
    expect(r.frames.size).toBe(1)
    r.fireFrame()
    expect(r.state.runs).toBe(1)
    r.scheduler.schedule()
    r.fireFrame()
    expect(r.state.runs).toBe(2)
  })

  it('cancel drops a pending run, frame and timer both', () => {
    const r = rig()
    r.scheduler.schedule()
    r.scheduler.cancel()
    expect(r.frames.size + r.timers.size).toBe(0)
    expect(r.scheduler.pending()).toBe(false)
    expect(r.state.runs).toBe(0)
  })

  it('may schedule again from inside the run (the settle loop)', () => {
    const r = rig()
    let left = 2
    const loop = createFrameScheduler(
      {
        requestFrame: (cb) => (r.frames.set(99, cb), 99),
        cancelFrame: () => undefined,
        setTimer: () => 1,
        clearTimer: () => undefined,
        isVisible: () => true
      },
      () => {
        if (--left > 0) loop.schedule()
      }
    )
    loop.schedule()
    r.fireFrame()
    r.fireFrame()
    expect(left).toBe(0)
  })
})
