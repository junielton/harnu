// U3.6 AC-1: when the capacity watcher runs a pass. A network event, a 30 s fallback interval and the
// boot all request one; passes never overlap and a burst is one pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCapacityWatcher } from '../src/main/gc/capacity-watcher'

function rig(over: { pass?: (t: string) => Promise<void> } = {}): {
  w: ReturnType<typeof createCapacityWatcher>
  passes: string[]
  fire: () => void
  stopped: () => number
  release: Array<() => void>
} {
  const passes: string[] = []
  let listener: () => void = () => {}
  let stops = 0
  const release: Array<() => void> = []
  const w = createCapacityWatcher({
    pass:
      over.pass ??
      (async (t) => {
        passes.push(t)
      }),
    subscribe: (cb) => {
      listener = cb
      return { stop: () => stops++ }
    },
    intervalMs: 30_000,
    debounceMs: 1_500
  })
  return { w, passes, fire: () => listener(), stopped: () => stops, release }
}

describe('createCapacityWatcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs a boot pass at start and then one per interval', async () => {
    const r = rig()
    r.w.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(r.passes).toEqual(['boot'])
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(r.passes).toEqual(['boot', 'timer', 'timer'])
    r.w.stop()
  })

  it('an event burst inside the debounce window is one pass', async () => {
    const r = rig()
    r.w.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 5; i++) {
      r.fire()
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(r.passes).toEqual(['boot'])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(r.passes).toEqual(['boot', 'event'])
    r.w.stop()
  })

  it('never overlaps: a request during a pass schedules one trailing pass', async () => {
    let inFlight = 0
    let max = 0
    const gates: Array<() => void> = []
    const seen: string[] = []
    const r = rig({
      pass: async (t) => {
        seen.push(t)
        inFlight++
        max = Math.max(max, inFlight)
        await new Promise<void>((res) => gates.push(res))
        inFlight--
      }
    })
    r.w.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual(['boot'])
    r.w.poke('event')
    r.w.poke('event')
    r.w.poke('timer')
    gates.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toHaveLength(2)
    gates.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toHaveLength(2)
    expect(max).toBe(1)
    r.w.stop()
  })

  it('a pass that throws does not stop the loop', async () => {
    let n = 0
    const r = rig({
      pass: async () => {
        n++
        if (n === 1) throw new Error('boom')
      }
    })
    r.w.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(n).toBe(2)
    r.w.stop()
  })

  it('stop clears the timers and the event subscription', async () => {
    const r = rig()
    r.w.start()
    await vi.advanceTimersByTimeAsync(0)
    r.fire()
    r.w.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(r.passes).toEqual(['boot'])
    expect(r.stopped()).toBe(1)
  })
})
