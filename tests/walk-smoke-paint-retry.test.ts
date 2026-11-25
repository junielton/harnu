/**
 * BUG-298: the guided-walk smoke test (scripts/verify/guided-test-walk.mjs) failed W-7 and W-8 with "the page does
 * not paint (requestAnimationFrame never fires)". The cause is not the size of docs/harnu-features.md (the doc
 * rides a prompt FILE, so the bytes never reach argv, env, the PTY or the renderer): a freshly started Electron
 * under xvfb sometimes loses its GPU process, and a window with no GPU process never produces a frame. It also
 * happens with the doc at its old size. The smoke harness had a relaunch-until-painting loop for the first
 * window only; a restart inside a case (W-7) or a stall between cases had none. `paintOrRelaunch` is that loop,
 * shared by the warm-up, the restart and every case.
 *
 * Planted faults (each makes the named test red): never relaunch; relaunch forever; swallow the last error.
 */
import { describe, expect, it } from 'vitest'
import { paintOrRelaunch } from '../scripts/verify/guided-test-walk/paint-retry.mjs'

const stall = () =>
  Promise.reject(new Error('the page does not paint (requestAnimationFrame never fires)'))

describe('paintOrRelaunch', () => {
  it('does not relaunch a window that paints', async () => {
    let relaunches = 0
    const n = await paintOrRelaunch({
      waitPainting: async () => {},
      relaunch: async () => {
        relaunches++
      }
    })
    expect(n).toBe(0)
    expect(relaunches).toBe(0)
  })

  it('relaunches a stalled window until it paints, and says how many times it did', async () => {
    let calls = 0
    let relaunches = 0
    const n = await paintOrRelaunch({
      waitPainting: () => (++calls < 3 ? stall() : Promise.resolve()),
      relaunch: async () => {
        relaunches++
      },
      attempts: 3
    })
    expect(n).toBe(2)
    expect(relaunches).toBe(2)
  })

  it('gives up after `attempts` windows and rethrows the last stall (a harness never hides a real freeze)', async () => {
    let relaunches = 0
    await expect(
      paintOrRelaunch({
        waitPainting: stall,
        relaunch: async () => {
          relaunches++
        },
        attempts: 3
      })
    ).rejects.toThrow(/does not paint/)
    expect(relaunches).toBe(2)
  })

  it('relaunches only on a paint stall; any other error passes through at once', async () => {
    let relaunches = 0
    await expect(
      paintOrRelaunch({
        waitPainting: () => Promise.reject(new Error('CDP websocket error')),
        relaunch: async () => {
          relaunches++
        }
      })
    ).rejects.toThrow(/CDP websocket error/)
    expect(relaunches).toBe(0)
  })

  it('logs each relaunch with the reason', async () => {
    const lines: string[] = []
    let calls = 0
    await paintOrRelaunch({
      waitPainting: () => (++calls < 2 ? stall() : Promise.resolve()),
      relaunch: async () => {},
      log: (l: string) => lines.push(l)
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/does not paint/)
    expect(lines[0]).toMatch(/starting the instance again/)
  })
})
