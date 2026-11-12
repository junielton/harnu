/**
 * The stall monitor's own cost (T697 AC-2: under 1% of each thread, measured).
 *
 * Main thread, idle: how much more time the event loop spends running JavaScript with the monitor on
 * (the 5 ms probe tick plus the watchdog's heartbeat), from event-loop utilisation, which counts
 * exactly that thread. Main thread, hot path: the per-call cost of the IPC wrapper times a heavy
 * 2,000 calls a second. Renderer, hot path: the per-call cost of the Pinia action wrapper times
 * 5,000 calls a second (a store function used by a list row, called once per rendered row); the
 * component render wrapper does the same work per render. The numbers are printed so the report can quote them.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createApp } from 'vue'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { startStallMonitor } from '../../src/main/monitor/stall-monitor'
import { wrapIpcMain, type IpcMainLike } from '../../src/main/monitor/stall-owner'
import { installStoreSpans } from '../../src/renderer/src/lib/stall-observer'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Percent of the calling thread's CPU time spent during `ms` of an otherwise idle process.
 * `process.threadCpuUsage()` (node 22.19+) counts this thread only, so the watchdog worker is excluded:
 * it is a third thread, reported separately.
 */
async function idleThreadCpuPct(ms: number): Promise<number> {
  const before = process.threadCpuUsage()
  const t0 = performance.now()
  await wait(ms)
  const used = process.threadCpuUsage(before)
  return ((used.user + used.system) / 1000 / (performance.now() - t0)) * 100
}

describe('stall monitor overhead', () => {
  it('main thread, idle: under 1% of the thread', async (ctx) => {
    if (typeof process.threadCpuUsage !== 'function') return ctx.skip()
    const dir = await mkdtemp(join(tmpdir(), 'harnu-overhead-'))
    try {
      await wait(200)
      const off: number[] = []
      const on: number[] = []
      for (let round = 0; round < 3; round++) {
        off.push(await idleThreadCpuPct(1500))
        const monitor = startStallMonitor({ logDir: dir, patchTimers: false })
        await wait(300) // the worker connects
        on.push(await idleThreadCpuPct(1500))
        await monitor.stop()
      }
      const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
      const overhead = median(on) - median(off)
      console.log(
        `[overhead] main thread idle: monitor off ${median(off).toFixed(3)}% of a core, on ${median(on).toFixed(3)}%, overhead ${overhead.toFixed(3)}% of the thread`
      )
      expect(overhead).toBeLessThan(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('main thread, hot path: the IPC wrapper costs under 1% at 2,000 calls a second', () => {
    const handlers = new Map<string, (...a: never[]) => unknown>()
    const make = (): IpcMainLike =>
      ({
        handle: (c: string, l: (...a: never[]) => unknown) => handlers.set(c, l),
        handleOnce: () => undefined,
        on: (c: string, l: (...a: never[]) => unknown) => handlers.set(c, l),
        once: () => undefined,
        off: () => undefined,
        removeListener: () => undefined
      }) as unknown as IpcMainLike
    const body = (x: number): number => x + 1
    const N = 400_000
    const run = (): number => {
      const fn = handlers.get('pty:write') as (x: number) => number
      const t0 = performance.now()
      let acc = 0
      for (let i = 0; i < N; i++) acc += fn(i)
      expect(acc).toBeGreaterThan(0)
      return ((performance.now() - t0) * 1e6) / N
    }
    const plain = make()
    plain.on('pty:write', body as never)
    run() // warm up
    const baseline = Math.min(run(), run(), run())
    const wrapped = make()
    const undo = wrapIpcMain(wrapped)
    wrapped.on('pty:write', body as never)
    run() // warm up
    const withWrapper = Math.min(run(), run(), run())
    undo()
    const perCallNs = withWrapper - baseline
    const pct = ((perCallNs * 2_000) / 1e9) * 100
    console.log(
      `[overhead] IPC wrapper: ${perCallNs.toFixed(0)} ns per call → ${pct.toFixed(3)}% of the main thread at 2,000 calls/s`
    )
    expect(pct).toBeLessThan(1)
  })

  it('renderer, hot path: the Pinia action wrapper costs under 1% at 5,000 calls a second', () => {
    const N = 300_000
    const bench = (install: boolean): number => {
      const pinia = createPinia()
      if (install) installStoreSpans(pinia)
      createApp({}).use(pinia)
      setActivePinia(pinia)
      const useStore = defineStore(`bench${install ? 'On' : 'Off'}`, () => {
        const lookup = (id: number): number => id + 1
        return { lookup }
      })
      const store = useStore()
      let acc = 0
      for (let i = 0; i < 20_000; i++) acc += store.lookup(i) // warm up
      const t0 = performance.now()
      for (let i = 0; i < N; i++) acc += store.lookup(i)
      expect(acc).toBeGreaterThan(0)
      return ((performance.now() - t0) * 1e6) / N
    }
    const base = Math.min(bench(false), bench(false), bench(false))
    const wrapped = Math.min(bench(true), bench(true), bench(true))
    const perCallNs = wrapped - base
    const pct = ((perCallNs * 5_000) / 1e9) * 100
    console.log(
      `[overhead] Pinia action wrapper: ${perCallNs.toFixed(0)} ns per call → ${pct.toFixed(3)}% of the renderer thread at 5,000 calls/s`
    )
    expect(pct).toBeLessThan(1)
  })
})
