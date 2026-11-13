import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { startStallMonitor, type StallMonitor } from '../src/main/monitor/stall-monitor'
import type { IpcMainLike } from '../src/main/monitor/stall-owner'

/** The real monitor on the real event loop: what AC-1 and AC-2 of T697 are about. */

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function hold(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    /* a task that does not yield */
  }
}
const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await wait(20)
}

let monitor: StallMonitor | null = null
let dir = ''
afterEach(async () => {
  await monitor?.stop()
  monitor = null
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function start(
  over: Partial<Parameters<typeof startStallMonitor>[0]> = {}
): Promise<StallMonitor> {
  dir = await mkdtemp(join(tmpdir(), 'harnu-stall-'))
  monitor = startStallMonitor({ logDir: dir, patchTimers: false, watchdog: false, ...over })
  return monitor
}

describe('main-thread stall monitor', () => {
  it('AC-1: an injected 200 ms block shows up with its owner, in the summary and the log', async () => {
    const m = await start()
    await wait(50)
    m.injectMainStall(200)
    await until(() => m.summary().main.over50 > 0)
    const s = m.summary().main
    expect(s.over50).toBe(1)
    expect(s.over100).toBe(1)
    expect(s.over250).toBe(0)
    expect(s.offenders[0]).toMatchObject({ owner: 'diagnostic:injected-stall', count: 1 })
    expect(s.offenders[0].worstMs).toBeGreaterThanOrEqual(190)
    await m.stop()
    monitor = null
    const text = await readFile(join(dir, 'stalls.jsonl'), 'utf8')
    expect(JSON.parse(text.trim().split('\n')[0])).toMatchObject({
      thread: 'main',
      owner: 'diagnostic:injected-stall'
    })
  })

  it('names an IPC handler that blocks as ipc:<channel>', async () => {
    const handlers = new Map<string, (...a: never[]) => unknown>()
    const ipc = {
      handle: (c: string, l: (...a: never[]) => unknown) => handlers.set(c, l),
      handleOnce: () => undefined,
      on: () => undefined,
      once: () => undefined,
      off: () => undefined,
      removeListener: () => undefined
    } as unknown as IpcMainLike
    const m = await start({ ipcMain: ipc })
    ipc.handle('fleet:rescan', () => hold(120))
    await wait(30)
    handlers.get('fleet:rescan')?.()
    await until(() => m.summary().main.over50 > 0)
    expect(m.summary().main.offenders[0]).toMatchObject({
      owner: 'ipc:fleet:rescan',
      ownerKind: 'ipc'
    })
  })

  it('names an interval job by its callback', async () => {
    const m = await start({ patchTimers: true })
    function periodicScan(): void {
      hold(100)
    }
    const t = setInterval(periodicScan, 300)
    await until(() => m.summary().main.over50 > 0)
    clearInterval(t)
    expect(m.summary().main.offenders[0]).toMatchObject({ ownerKind: 'timer' })
    expect(m.summary().main.offenders[0].owner).toMatch(
      /^timer:periodicScan \(stall-monitor\.test\.ts:\d+\)$/
    )
  })

  it('names a stall nobody wrapped from its sampled stack', async () => {
    const m = await start({ watchdog: true })
    await wait(300) // the worker connects
    function unwrappedScan(): void {
      hold(400)
    }
    setTimeout(unwrappedScan, 10)
    await until(() => m.summary().main.over50 > 0, 6000)
    const o = m.summary().main.offenders[0]
    expect(o.ownerKind).toBe('sampled')
    expect(o.owner).toMatch(/hold stall-monitor\.test\.ts|unwrappedScan stall-monitor\.test\.ts/)
    expect(o.frames?.length).toBeGreaterThan(0)
  })

  it('a quiet loop records nothing', async () => {
    const m = await start()
    await wait(300)
    expect(m.summary().main.over50).toBe(0)
  })

  it('accepts renderer reports as renderer stalls, clamped and rate limited', async () => {
    const m = await start()
    const now = Date.now()
    const good = {
      atMs: now,
      thread: 'main',
      durationMs: 220,
      owner: 'action:sessions.load',
      ownerKind: 'action'
    }
    const tooShort = { ...good, durationMs: 10 }
    const bogus = { nope: true }
    expect(m.reportRenderer([good, tooShort, bogus])).toBe(1)
    const r = m.summary().renderer
    expect(r.over50).toBe(1)
    expect(r.offenders[0].owner).toBe('action:sessions.load')
    expect(m.summary().main.over50).toBe(0) // a renderer report never lands on the main thread
    const flood = Array.from({ length: 50 }, () => ({ ...good }))
    expect(m.reportRenderer(flood) + m.reportRenderer(flood)).toBeLessThanOrEqual(20)
  })
})
