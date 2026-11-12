import { describe, expect, it } from 'vitest'
import {
  attribute,
  createBusyRunTracker,
  createSpanRing,
  createStallAggregator,
  ownerFromFrames,
  parseLog,
  sanitizeRecord,
  shortStack,
  shouldRotate,
  LOG_MAX_BYTES,
  type BusyRun,
  type StallRecord
} from '../src/main/monitor/stall-core'
import {
  callsiteOf,
  timerOwnerName,
  wrapIpcMain,
  type IpcMainLike
} from '../src/main/monitor/stall-owner'

const slice = (startMs: number, endMs: number, activeMs: number) => ({ startMs, endMs, activeMs })

describe('busy run tracker', () => {
  const runs = (
    slices: ReturnType<typeof slice>[],
    opts: { thresholdMs?: number; maxRunMs?: number } = {}
  ): BusyRun[] => {
    const out: BusyRun[] = []
    const t = createBusyRunTracker({ ...opts, onRun: (r) => out.push(r) })
    for (const s of slices) t.push(s)
    t.flush()
    return out
  }

  it('reports one long task as one run', () => {
    expect(runs([slice(0, 5, 0.2), slice(5, 215, 209), slice(215, 220, 0.2)])).toEqual([
      { startMs: 5, endMs: 215, durationMs: 210 }
    ])
  })

  it('treats back-to-back short tasks that never let the loop idle as one run (the BUG-261 shape)', () => {
    const flood = Array.from({ length: 40 }, (_, i) => slice(i * 5, i * 5 + 5, 4.9))
    expect(runs(flood)).toHaveLength(1)
    expect(runs(flood)[0].durationMs).toBe(200)
  })

  it('an idle slice closes the run, and a run under 50 ms is not a stall', () => {
    expect(runs([slice(0, 30, 29), slice(30, 35, 0.1), slice(35, 70, 34)])).toEqual([])
  })

  it('a 50 ms task still counts despite a few idle milliseconds in its first slice', () => {
    expect(runs([slice(0, 55, 50)])).toHaveLength(1)
  })

  it('a loop that works a lot but yields every few milliseconds is not a stall', () => {
    const busyButYielding = Array.from({ length: 100 }, (_, i) => slice(i * 10, i * 10 + 10, 7))
    expect(runs(busyButYielding)).toEqual([])
  })

  it('reports an unbroken saturation in chunks while it is happening', () => {
    const flood = Array.from({ length: 300 }, (_, i) => slice(i * 5, i * 5 + 5, 5))
    const got = runs(flood, { maxRunMs: 500 })
    expect(got.length).toBeGreaterThanOrEqual(3)
    expect(got.every((r) => r.durationMs <= 505)).toBe(true)
  })
})

describe('owner spans', () => {
  it('names the owner that overlapped the stall the most', () => {
    const ring = createSpanRing()
    ring.record('ipc:a', 'ipc', 0, 10)
    ring.record('timer:scan', 'timer', 100, 300)
    expect(ring.best(90, 310)).toEqual({ owner: 'timer:scan', kind: 'timer' })
  })

  it('sums several short spans of the same owner', () => {
    const ring = createSpanRing()
    for (let i = 0; i < 20; i++) ring.record('ipc:pty:write', 'ipc', i * 10, i * 10 + 8)
    ring.record('ipc:other', 'ipc', 50, 60)
    expect(ring.best(0, 200)?.owner).toBe('ipc:pty:write')
  })

  it('an owner that explains only a sliver is a coincidence', () => {
    const ring = createSpanRing()
    ring.record('ipc:a', 'ipc', 0, 3)
    expect(ring.best(0, 400)).toBeNull()
  })

  it('keeps the newest spans when full and ignores sub-millisecond ones', () => {
    const ring = createSpanRing(3)
    ring.record('tiny', 'ipc', 0, 0.2)
    for (let i = 0; i < 5; i++) ring.record(`o${i}`, 'ipc', i * 10, i * 10 + 5)
    expect(ring.size()).toBe(3)
    expect(ring.best(0, 20)).toBeNull() // o0..o1 fell out
    expect(ring.best(40, 45)?.owner).toBe('o4')
  })
})

describe('sampled stacks', () => {
  const f = (functionName: string, url: string, lineNumber = 0) => ({
    functionName,
    url,
    lineNumber
  })
  it('names the innermost application frame and skips node and electron internals', () => {
    const frames = [
      f('access', 'node:fs/promises', 4),
      f('locateTranscript', 'file:///app/out/main/index.js', 119),
      f('tick', 'file:///app/out/main/index.js', 400)
    ]
    expect(ownerFromFrames(frames)).toBe('locateTranscript index.js:120')
    expect(shortStack(frames)).toEqual(['locateTranscript index.js:120', 'tick index.js:401'])
  })

  it('has no owner when every frame is internal', () => {
    expect(ownerFromFrames([f('x', 'node:internal/timers'), f('y', '')])).toBeNull()
  })
})

describe('attribute', () => {
  const run = { startMs: 0, endMs: 200, durationMs: 200 }
  it('prefers a wrapper owner, then the sampled stack, then admits it does not know', () => {
    const ring = createSpanRing()
    expect(attribute(run, ring, null)).toEqual({ owner: 'unattributed', ownerKind: 'unattributed' })
    expect(attribute(run, ring, { owner: 'hold t.ts:3', frames: ['hold t.ts:3'] })).toEqual({
      owner: 'hold t.ts:3',
      ownerKind: 'sampled',
      frames: ['hold t.ts:3']
    })
    ring.record('ipc:fleet:scan', 'ipc', 0, 190)
    expect(attribute(run, ring, { owner: 'x', frames: [] }).owner).toBe('ipc:fleet:scan')
  })
})

describe('aggregator', () => {
  const rec = (over: Partial<StallRecord>): StallRecord => ({
    atMs: 1_000_000,
    thread: 'main',
    durationMs: 60,
    owner: 'ipc:a',
    ownerKind: 'ipc',
    ...over
  })

  it('counts nested buckets and ranks offenders by total stalled time', () => {
    const a = createStallAggregator()
    a.add(rec({ durationMs: 60 }))
    a.add(rec({ durationMs: 120 }))
    a.add(rec({ durationMs: 300, owner: 'timer:scan', ownerKind: 'timer' }))
    a.add(rec({ durationMs: 400, thread: 'renderer', owner: 'action:load', ownerKind: 'action' }))
    const s = a.summary(1_000_100)
    expect(s.main).toMatchObject({ over50: 3, over100: 2, over250: 1 })
    expect(s.main.offenders.map((o) => [o.owner, o.count, o.totalMs, o.worstMs])).toEqual([
      ['timer:scan', 1, 300, 300],
      ['ipc:a', 2, 180, 120]
    ])
    expect(s.renderer.over250).toBe(1)
  })

  it('forgets stalls older than an hour and stays bounded', () => {
    const a = createStallAggregator({ max: 3 })
    a.add(rec({ atMs: 0 }))
    expect(a.summary(3_600_001).main.over50).toBe(0)
    for (let i = 0; i < 10; i++) a.add(rec({ atMs: 5_000_000 + i }))
    expect(a.records()).toHaveLength(3)
  })

  it('keeps the frames of the worst occurrence', () => {
    const a = createStallAggregator()
    a.add(rec({ owner: 's', ownerKind: 'sampled', durationMs: 60, frames: ['old'] }))
    a.add(rec({ owner: 's', ownerKind: 'sampled', durationMs: 90, frames: ['worst'] }))
    expect(a.summary(1_000_100).main.offenders[0].frames).toEqual(['worst'])
  })

  it('sums stalled time per thread inside a span', () => {
    const a = createStallAggregator()
    a.add(rec({ thread: 'renderer', durationMs: 100, atMs: 1000 }))
    a.add(rec({ thread: 'renderer', durationMs: 70, atMs: 50_000 }))
    expect(a.stalledMs('renderer', 60_000, 20_000)).toBe(70)
  })
})

describe('log', () => {
  const now = 10 * 24 * 3600 * 1000
  it('sanitizes untrusted records', () => {
    expect(
      sanitizeRecord(
        {
          atMs: now,
          thread: 'renderer',
          durationMs: 80.4,
          owner: 'x'.repeat(500),
          ownerKind: 'nope'
        },
        now
      )
    ).toMatchObject({
      durationMs: 80,
      ownerKind: 'unattributed'
    })
    expect(sanitizeRecord({ atMs: now, thread: 'gpu', durationMs: 80 }, now)).toBeNull()
    expect(sanitizeRecord({ atMs: now, thread: 'main', durationMs: 10 }, now)).toBeNull()
    expect(
      sanitizeRecord({ atMs: now + 3_600_000, thread: 'main', durationMs: 80 }, now)
    ).toBeNull()
    expect(sanitizeRecord(null, now)).toBeNull()
  })

  it('keeps the last 24 hours and tolerates a torn line', () => {
    const fresh = JSON.stringify({
      atMs: now - 1000,
      thread: 'main',
      durationMs: 90,
      owner: 'a',
      ownerKind: 'ipc'
    })
    const old = JSON.stringify({
      atMs: now - 25 * 3600 * 1000,
      thread: 'main',
      durationMs: 90,
      owner: 'b',
      ownerKind: 'ipc'
    })
    const got = parseLog(`${old}\n${fresh}\n{"atMs": 1, "thr`, now)
    expect(got.map((r) => r.owner)).toEqual(['a'])
  })

  it('rotates at 1 MiB', () => {
    expect(shouldRotate(LOG_MAX_BYTES - 10, 5)).toBe(false)
    expect(shouldRotate(LOG_MAX_BYTES - 10, 20)).toBe(true)
  })
})

describe('owner wrappers', () => {
  it('finds the call site and names a timer', () => {
    expect(callsiteOf('Error\n    at tick (/app/src/main/jobs.ts:42:9)\n    at x')).toBe(
      'jobs.ts:42'
    )
    expect(callsiteOf('Error\n    at stall-owner.ts:1:1\n    at file:///a/b/c.js:7:3')).toBe(
      'c.js:7'
    )
    expect(timerOwnerName({ name: 'sweep' }, 'a.ts:1')).toBe('timer:sweep (a.ts:1)')
    expect(timerOwnerName({ name: '' }, 'a.ts:1')).toBe('timer:a.ts:1')
    expect(timerOwnerName({ name: '' }, null)).toBe('timer:anonymous')
  })

  it('wraps handlers, keeps off() working on the original function and undoes cleanly', () => {
    const added = new Map<string, (...a: never[]) => unknown>()
    const removed: Array<[string, unknown]> = []
    const ipc = {
      handle: (c: string, l: (...a: never[]) => unknown) => added.set(c, l),
      handleOnce: (c: string, l: (...a: never[]) => unknown) => added.set(c, l),
      on: (c: string, l: (...a: never[]) => unknown) => added.set(c, l),
      once: (c: string, l: (...a: never[]) => unknown) => added.set(c, l),
      off: (c: string, l: unknown) => removed.push([c, l]),
      removeListener: (c: string, l: unknown) => removed.push([c, l])
    } as unknown as IpcMainLike
    const originalHandle = ipc.handle
    const undo = wrapIpcMain(ipc)
    const fn = (...args: never[]): unknown => ['ran', ...args]
    ipc.on('chan', fn)
    expect(added.get('chan')).not.toBe(fn)
    expect(added.get('chan')?.(1 as never)).toEqual(['ran', 1])
    ipc.off('chan', fn)
    expect(removed[0][1]).toBe(added.get('chan'))
    undo()
    expect(ipc.handle).toBe(originalHandle)
  })
})
