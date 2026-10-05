/**
 * Mission v3 S2 (§3.8) — `mapLimit`, the bounded-concurrency, order-preserving
 * map `mission:list` derives its missions through.
 */
import { describe, it, expect } from 'vitest'
import { mapLimit } from '../src/main/map-limit'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('mapLimit', () => {
  it('never runs more than `limit` jobs at once and keeps input order', async () => {
    let running = 0
    let peak = 0
    // Later items finish first, so a completion-ordered result would be reversed.
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running++
      peak = Math.max(peak, running)
      await tick(40 - n * 4)
      running--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90])
    expect(peak).toBe(4)
  })

  it('runs jobs in parallel: 8 jobs of 50 ms with limit 4 take ~2 rounds, not 8', async () => {
    const t0 = Date.now()
    await mapLimit([...Array(8).keys()], 4, () => tick(50))
    expect(Date.now() - t0).toBeLessThan(250)
  })

  it('handles an empty list, a limit above the item count and a limit below 1', async () => {
    expect(await mapLimit([], 4, async (n: number) => n)).toEqual([])
    expect(await mapLimit([1, 2], 10, async (n) => n + 1)).toEqual([2, 3])
    expect(await mapLimit([1, 2, 3], 0, async (n) => n)).toEqual([1, 2, 3])
  })

  it('rejects with the first error and starts no new job after it', async () => {
    const started: number[] = []
    await expect(
      mapLimit([1, 2, 3, 4], 1, async (n) => {
        started.push(n)
        if (n === 2) throw new Error('boom')
        return n
      })
    ).rejects.toThrow('boom')
    expect(started).toEqual([1, 2])
  })
})
