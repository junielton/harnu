// U3.6 AC-1/AC-2/AC-3: one capacity-watcher pass and the out-of-capacity notice ladder. Everything
// is injected, so no docker runs here.

import { describe, expect, it } from 'vitest'
import { createCycleState } from '../src/main/gc/gc-cycle'
import {
  ackWatchNotices,
  nextCapacityNotice,
  runCapacityPass,
  type CapacityPassDeps
} from '../src/main/gc/capacity-watcher-core'
import type { DockerAction, DockerOutcome } from '../src/main/gc/docker-cycle'
import { defaultGcPrefs, withDockerAcknowledged, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { DockerFactsResult } from '../src/main/containers/docker-facts-shell'
import type { BridgeCapacity } from '../src/main/containers/docker-capacity-core'

const TOTAL = 31
const known = (free: number): DockerFactsResult<BridgeCapacity> => ({
  ok: true,
  value: { known: true, total: TOTAL, used: TOTAL - free, free, source: 'default' }
})
const net = (n: number): DockerAction => ({
  kind: 'prune-network',
  id: `net-${n}`,
  reason: `empty network ${n}`
})
const park = (n: number): DockerAction => ({ kind: 'park', id: `stack-${n}`, reason: 'idle 3 h' })

const acked = (over: Partial<GcPrefs['docker']> = {}): GcPrefs => {
  const p = withDockerAcknowledged(defaultGcPrefs())
  return { ...p, docker: { ...p.docker, ...over } }
}

interface Rig {
  /** The injected clock, in ms; tests move it. */
  clock: number
  deps: CapacityPassDeps
  state: ReturnType<typeof createCycleState>
  executed: string[]
  notices: Array<{ title: string; body: string }>
  planned: number
  reads: number
  locks: number
  disabled: number
}

/**
 * `free` is the capacity sequence: reads consume it in order (the last value repeats). `after`
 * says how much free capacity each executed action adds, so a fake reflects what a real removal does.
 */
function rig(
  prefs: GcPrefs,
  opts: {
    free?: number[]
    capacity?: () => Promise<DockerFactsResult<BridgeCapacity>>
    plan?: DockerAction[]
    execute?: (a: DockerAction) => DockerOutcome
    locked?: boolean
  } = {}
): Rig {
  const r: Rig = {
    clock: 1_000,
    state: createCycleState(),
    executed: [],
    notices: [],
    planned: 0,
    reads: 0,
    locks: 0,
    disabled: 0,
    deps: undefined as unknown as CapacityPassDeps
  }
  const seq = opts.free ?? [2]
  r.deps = {
    prefs: () => prefs,
    readCapacity: async () => {
      r.reads++
      if (opts.capacity) return opts.capacity()
      return known(seq[Math.min(r.reads - 1, seq.length - 1)]!)
    },
    plan: async () => {
      r.planned++
      return opts.plan ?? []
    },
    execute: async (a) => {
      r.executed.push(a.id)
      return (opts.execute ?? (() => ({ ok: true })))(a)
    },
    lock: async (work) => {
      r.locks++
      if (opts.locked) return { ok: false, reason: 'locked', holder: null }
      return { ok: true, value: await work() }
    },
    disableDocker: async () => {
      r.disabled++
    },
    notify: (n) => r.notices.push(n),
    now: () => r.clock
  }
  return r
}

describe('nextCapacityNotice: one notice per level until capacity recovers (AC-2)', () => {
  it('stays quiet above the mark and resets there', () => {
    expect(nextCapacityNotice('zero', 4, 3, true)).toEqual({ next: 'none', level: null })
  })
  it('fires low once at the mark with nothing left, then not again', () => {
    const first = nextCapacityNotice('none', 3, 3, true)
    expect(first).toEqual({ next: 'low', level: 'low' })
    expect(nextCapacityNotice(first.next, 2, 3, true).level).toBeNull()
  })
  it('fires zero once at zero free slots, one more after low', () => {
    const zero = nextCapacityNotice('low', 0, 3, true)
    expect(zero).toEqual({ next: 'zero', level: 'zero' })
    expect(nextCapacityNotice(zero.next, 0, 3, true).level).toBeNull()
  })
  it('jumping straight to zero fires only the zero notice', () => {
    expect(nextCapacityNotice('none', 0, 3, true)).toEqual({ next: 'zero', level: 'zero' })
  })
  it('does not repeat while oscillating at or below the mark (3 → 2 → 3, 0 → 1 → 0)', () => {
    let s = nextCapacityNotice('none', 3, 3, true)
    expect(s.level).toBe('low')
    s = nextCapacityNotice(s.next, 2, 3, true)
    s = nextCapacityNotice(s.next, 3, 3, true)
    expect(s.level).toBeNull()
    s = nextCapacityNotice(s.next, 0, 3, true)
    expect(s.level).toBe('zero')
    s = nextCapacityNotice(s.next, 1, 3, true)
    s = nextCapacityNotice(s.next, 0, 3, true)
    expect(s.level).toBeNull()
  })
  it('fires again only after capacity went above the mark', () => {
    let s = nextCapacityNotice('none', 3, 3, true)
    s = nextCapacityNotice(s.next, 4, 3, true)
    expect(nextCapacityNotice(s.next, 3, 3, true).level).toBe('low')
  })
  it('never fires while something is still left to free', () => {
    expect(nextCapacityNotice('none', 0, 3, false)).toEqual({ next: 'none', level: null })
  })
})

describe('runCapacityPass: above the mark', () => {
  it('reads capacity, plans nothing, runs nothing', async () => {
    const r = rig(acked(), { free: [4], plan: [net(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec).toMatchObject({ mode: 'act', pressure: false, acted: 0, notice: null })
    expect(rec.capacity).toEqual({
      known: true,
      total: TOTAL,
      used: 27,
      free: 4,
      source: 'default'
    })
    expect(r.planned).toBe(0)
    expect(r.locks).toBe(0)
    expect(r.executed).toEqual([])
  })
})

describe('runCapacityPass: below the mark acts at once (AC-1)', () => {
  it('runs garbage then pauses one at a time and stops once capacity is above the mark', async () => {
    // read 1: pressure (2); after net-1: 3 (still low); after net-2: 4 (recovered)
    const r = rig(acked(), { free: [2, 3, 4], plan: [net(1), net(2), park(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'event')
    expect(r.executed).toEqual(['net-1', 'net-2'])
    expect(rec).toMatchObject({ mode: 'act', pressure: true, found: 3, acted: 2, notice: null })
    expect(rec.capacity).toMatchObject({ known: true, free: 4 })
    expect(r.notices.some((n) => /out of network slots|no free network slot/i.test(n.body))).toBe(
      false
    )
  })

  it('goes on to the pauses when the garbage is not enough', async () => {
    const r = rig(acked(), { free: [1, 1, 1, 5], plan: [net(1), net(2), park(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.executed).toEqual(['net-1', 'net-2', 'stack-1'])
    expect(rec.acted).toBe(3)
  })

  it('honours the per-pass cap: the rest is deferred and nothing is "left to free" yet', async () => {
    const r = rig(acked({ maxPerCycle: 2 }), { free: [0], plan: [net(1), net(2), net(3), net(4)] })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.executed).toEqual(['net-1', 'net-2'])
    expect(rec).toMatchObject({ acted: 2, deferred: 2, nothingLeft: false, notice: null })
  })

  it('a refused action is not a failure and the pass moves on', async () => {
    const r = rig(acked(), {
      free: [1, 1, 9],
      plan: [net(1), net(2)],
      execute: (a) =>
        a.id === 'net-1' ? { ok: false, reason: 'changed', refusal: true } : { ok: true }
    })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec).toMatchObject({ refused: 1, acted: 1, failed: 0 })
    expect(r.state.dockerStreak).toBe(0)
  })

  it('takes the machine-wide lock; a held lock does nothing and says nothing', async () => {
    const r = rig(acked(), { free: [0], plan: [net(1)], locked: true })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec).toMatchObject({ locked: true, acted: 0, notice: null })
    expect(r.executed).toEqual([])
    expect(r.notices).toEqual([])
  })

  it('the failure streak switches Docker autonomy off and says nothing more is freed', async () => {
    const r = rig(acked({ failureLimit: 2 }), {
      free: [0],
      plan: [net(1), net(2), net(3)],
      execute: () => ({ ok: false, reason: 'boom' })
    })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.executed).toEqual(['net-1', 'net-2'])
    expect(r.disabled).toBe(1)
    expect(rec).toMatchObject({ failed: 2, paused: true, deferred: 1 })
    expect(rec.pausedReason).toMatch(/2 failures in a row/)
    expect(r.state.dockerStreak).toBe(0)
  })
})

describe('runCapacityPass: out of capacity (AC-2)', () => {
  it('an empty plan at the mark notifies once; the same state does not notify again', async () => {
    const r = rig(acked(), { free: [3], plan: [] })
    const first = await runCapacityPass(r.deps, r.state, 'timer')
    expect(first.nothingLeft).toBe(true)
    expect(first.notice).toEqual({ level: 'low', free: 3, total: TOTAL, mark: 3 })
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]!.body).toMatch(/3 of 31/)
    const second = await runCapacityPass(r.deps, r.state, 'timer')
    expect(second.notice).toBeNull()
    expect(r.notices).toHaveLength(1)
  })

  it('zero free slots fires one more, once', async () => {
    const r = rig(acked(), { free: [3], plan: [] })
    await runCapacityPass(r.deps, r.state, 'timer')
    const z = rig(acked(), { free: [0], plan: [] })
    z.state.dockerCapacityNotice = r.state.dockerCapacityNotice
    const rec = await runCapacityPass(z.deps, z.state, 'event')
    expect(rec.notice).toMatchObject({ level: 'zero', free: 0 })
    expect(z.notices[0]!.body).toMatch(
      /could not find an available, non-overlapping IPv4 address pool|no free/i
    )
    expect((await runCapacityPass(z.deps, z.state, 'event')).notice).toBeNull()
  })

  it('a plan fully attempted that did not help is "nothing left to free"', async () => {
    const r = rig(acked(), {
      free: [2],
      plan: [net(1), park(1)],
      execute: (a) =>
        a.kind === 'park' ? { ok: false, reason: 'busy', refusal: true } : { ok: true }
    })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec.nothingLeft).toBe(true)
    expect(rec.notice).toMatchObject({ level: 'low', free: 2 })
  })

  it('recovering above the mark re-arms the notice', async () => {
    const r = rig(acked(), { free: [3], plan: [] })
    await runCapacityPass(r.deps, r.state, 'timer')
    const up = rig(acked(), { free: [9] })
    up.state.dockerCapacityNotice = r.state.dockerCapacityNotice
    await runCapacityPass(up.deps, up.state, 'timer')
    expect(up.state.dockerCapacityNotice).toBe('none')
  })
})

describe('runCapacityPass: switches and the report-only first cycle (AC-1)', () => {
  it('report-only: nothing runs, the list is recorded, and no notice while something would be freed', async () => {
    const r = rig(defaultGcPrefs(), { free: [1], plan: [net(1), park(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'event')
    expect(r.executed).toEqual([])
    expect(rec).toMatchObject({ mode: 'report', found: 2, acted: 0, notice: null })
    expect(rec.items).toEqual([
      { kind: 'network', target: 'net-1', reason: 'empty network 1' },
      { kind: 'pause', target: 'stack-1', reason: 'idle 3 h' }
    ])
  })

  it('report-only with an empty plan at the mark still tells the operator', async () => {
    const r = rig(defaultGcPrefs(), { free: [1], plan: [] })
    expect((await runCapacityPass(r.deps, r.state, 'timer')).notice).toMatchObject({ level: 'low' })
  })

  it('the global pause still reads capacity but plans and runs nothing', async () => {
    const r = rig({ ...acked(), pauseAutonomous: true }, { free: [5], plan: [net(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec).toMatchObject({ mode: 'paused', pressure: false, acted: 0, notice: null })
    expect(rec.capacity).toMatchObject({ known: true, free: 5 })
    expect(r.reads).toBe(1)
    expect(r.planned).toBe(0)
    expect(r.locks).toBe(0)
    expect(r.executed).toEqual([])
    expect(r.notices).toEqual([])
  })

  it('the Docker switch off still reads capacity but plans and runs nothing', async () => {
    const r = rig(acked({ enabled: false }), { free: [5], plan: [net(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec).toMatchObject({ mode: 'off', pressure: false })
    expect(rec.capacity).toMatchObject({ known: true, free: 5 })
    expect(r.planned).toBe(0)
  })
})

describe('runCapacityPass: the heads-up still fires while Cleanup is not acting', () => {
  for (const [label, prefs, mode, off] of [
    ['global pause', { ...acked(), pauseAutonomous: true }, 'paused', 'paused'],
    ['Docker switch off', acked({ enabled: false }), 'off', 'off']
  ] as const) {
    it(`${label}: low at the mark, no action, mode stays ${mode}, and the notice says why`, async () => {
      const r = rig(prefs, { free: [3], plan: [net(1), park(1)] })
      const rec = await runCapacityPass(r.deps, r.state, 'timer')
      expect(rec.mode).toBe(mode)
      expect(rec.capacity).toMatchObject({ known: true, free: 3 })
      expect(rec).toMatchObject({ pressure: true, nothingLeft: true, acted: 0, found: 0 })
      expect(rec.notice).toEqual({ level: 'low', free: 3, total: TOTAL, mark: 3, autonomyOff: off })
      expect(r.planned).toBe(0)
      expect(r.locks).toBe(0)
      expect(r.executed).toEqual([])
      expect(r.notices).toHaveLength(1)
      expect(r.notices[0]!.body).toMatch(/automatic cleanup is (off|paused)/i)
    })

    it(`${label}: zero fires one more, and neither repeats`, async () => {
      const r = rig(prefs, { free: [3], plan: [] })
      await runCapacityPass(r.deps, r.state, 'timer')
      const again = await runCapacityPass(r.deps, r.state, 'timer')
      expect(again.notice).toBeNull()
      const z = rig(prefs, { free: [0], plan: [] })
      z.state.dockerCapacityNotice = r.state.dockerCapacityNotice
      const rec = await runCapacityPass(z.deps, z.state, 'event')
      expect(rec.notice).toMatchObject({ level: 'zero', free: 0, autonomyOff: off })
      expect((await runCapacityPass(z.deps, z.state, 'event')).notice).toBeNull()
    })

    it(`${label}: recovering above the mark re-arms it`, async () => {
      const r = rig(prefs, { free: [3] })
      await runCapacityPass(r.deps, r.state, 'timer')
      const up = rig(prefs, { free: [9] })
      up.state.dockerCapacityNotice = r.state.dockerCapacityNotice
      await runCapacityPass(up.deps, up.state, 'timer')
      expect(up.state.dockerCapacityNotice).toBe('none')
    })

    it(`${label}: unknown capacity stays silent`, async () => {
      const r = rig(prefs, {
        capacity: async () => ({ ok: true, value: { known: false, reason: 'Docker Desktop' } })
      })
      const rec = await runCapacityPass(r.deps, r.state, 'timer')
      expect(rec).toMatchObject({ mode, notice: null })
      expect(rec.capacity).toEqual({ known: false, reason: 'Docker Desktop' })
      expect(r.notices).toEqual([])
    })
  }

  it('an acting pass carries no autonomyOff on its notice', async () => {
    const r = rig(acked(), { free: [3], plan: [] })
    expect((await runCapacityPass(r.deps, r.state, 'timer')).notice).not.toHaveProperty(
      'autonomyOff'
    )
  })
})

describe('runCapacityPass: capacity that cannot be known (AC-3)', () => {
  it('known:false keeps the reason, takes no action and raises no notice', async () => {
    const r = rig(acked(), {
      capacity: async () => ({
        ok: true,
        value: { known: false, reason: 'Docker Desktop keeps its address pools inside its VM.' }
      }),
      plan: [net(1)]
    })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec.capacity).toEqual({
      known: false,
      reason: 'Docker Desktop keeps its address pools inside its VM.'
    })
    expect(rec).toMatchObject({ pressure: false, acted: 0, notice: null })
    expect(r.planned).toBe(0)
    expect(r.executed).toEqual([])
    expect(r.notices).toEqual([])
  })

  it('docker unreachable reads as unknown with that reason', async () => {
    const r = rig(acked(), {
      capacity: async () => ({
        ok: false,
        error: { kind: 'docker-unavailable', message: 'Cannot connect to the Docker daemon' }
      })
    })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec.capacity).toMatchObject({ known: false })
    expect(rec.notice).toBeNull()
  })

  it('docker going away mid-pass stops the pass without a notice', async () => {
    let n = 0
    const r = rig(acked(), {
      plan: [net(1), net(2)],
      capacity: async () => {
        n++
        return n === 1
          ? known(1)
          : { ok: false, error: { kind: 'docker-unavailable', message: 'gone' } }
      }
    })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.executed).toEqual(['net-1'])
    expect(rec.capacity).toMatchObject({ known: false })
    expect(rec.notice).toBeNull()
    expect(rec.nothingLeft).toBe(false)
  })

  it('an unknown reading does not reset a notice already given', async () => {
    const r = rig(acked(), { free: [0], plan: [] })
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.state.dockerCapacityNotice).toBe('zero')
    const u = rig(acked(), {
      capacity: async () => ({ ok: true, value: { known: false, reason: 'x' } })
    })
    u.state.dockerCapacityNotice = r.state.dockerCapacityNotice
    await runCapacityPass(u.deps, u.state, 'timer')
    expect(u.state.dockerCapacityNotice).toBe('zero')
  })
})

describe('runCapacityPass: back-off while nothing is left to free (30 s passes stay cheap)', () => {
  const MIN = 60_000

  /** A first pass at the mark with a plan that frees nothing, then a second pass on the same rig state. */
  async function settled(): Promise<Rig> {
    const r = rig(acked(), {
      free: [2],
      plan: [net(1)],
      execute: () => ({ ok: false, reason: 'busy', refusal: true })
    })
    const first = await runCapacityPass(r.deps, r.state, 'timer')
    expect(first.nothingLeft).toBe(true)
    expect(r.planned).toBe(1)
    return r
  }

  it('a timer pass with the same capacity and settings does not plan, lock or run again', async () => {
    const r = await settled()
    r.clock += 30_000
    const again = await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(1)
    expect(r.locks).toBe(1)
    expect(r.executed).toEqual(['net-1'])
    expect(again).toMatchObject({
      pressure: true,
      nothingLeft: true,
      found: 1,
      refused: 1,
      acted: 0,
      notice: null
    })
    expect(again.capacity).toMatchObject({ known: true, free: 2 })
  })

  it('still reads capacity on every pass, so a real change is seen at once', async () => {
    const r = await settled()
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.reads).toBeGreaterThanOrEqual(3)
  })

  it('a network event plans again even when capacity looks the same', async () => {
    const r = await settled()
    r.clock += 2_000
    await runCapacityPass(r.deps, r.state, 'event')
    expect(r.planned).toBe(2)
  })

  it('a change in free slots plans again', async () => {
    const r = await settled()
    r.deps.readCapacity = async () => known(1)
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(2)
  })

  it('a change in the settings (here the acknowledgement or the mark) plans again', async () => {
    const r = await settled()
    r.deps.prefs = () => acked({ lowWaterSlots: 4 })
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(2)
  })

  it('plans again after 10 minutes, because idle time moves without any event', async () => {
    const r = await settled()
    r.clock += 10 * MIN - 1
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(1)
    r.clock += 1
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(2)
  })

  it('clearing a Keep mark or a never-clean path plans again at once (the planner reads both)', async () => {
    const withMarks = {
      ...acked(),
      keep: { 'repo::wt::/a': 'merged' },
      neverClean: ['/protected']
    } as GcPrefs
    const r = rig(withMarks, {
      free: [2],
      plan: [net(1)],
      execute: () => ({ ok: false, reason: 'busy', refusal: true })
    })
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(1)
    // same marks, different object identity, key order and fate: nothing changed for the planner
    r.deps.prefs = () => ({ ...withMarks, keep: { 'repo::wt::/a': 'unmerged' } }) as GcPrefs
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(1)
    // the Keep mark is cleared
    r.deps.prefs = () => ({ ...withMarks, keep: {} }) as GcPrefs
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(2)
    // a never-clean path is removed
    r.deps.prefs = () => ({ ...withMarks, keep: {}, neverClean: [] }) as GcPrefs
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(3)
  })

  it('a pass that was cut short by the cap or found something to do never starts a back-off', async () => {
    const r = rig(acked({ maxPerCycle: 1 }), { free: [0], plan: [net(1), net(2)] })
    await runCapacityPass(r.deps, r.state, 'timer')
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(2)
  })

  it('recovering above the mark clears the back-off', async () => {
    const r = await settled()
    r.deps.readCapacity = async () => known(9)
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    r.deps.readCapacity = async () => known(2)
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(2)
  })

  it('a report-only pass backs off too, and the list it recorded stays', async () => {
    const r = rig(defaultGcPrefs(), { free: [1], plan: [] })
    await runCapacityPass(r.deps, r.state, 'timer')
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.planned).toBe(1)
  })
})

describe('notices waiting for a renderer (the boot pass runs before the window exists)', () => {
  it('a raised notice is kept as pending until it is acknowledged', async () => {
    const r = rig(acked(), { free: [3], plan: [] })
    const rec = await runCapacityPass(r.deps, r.state, 'boot')
    expect(r.state.dockerNoticesPending).toEqual([rec])
  })

  it('a pass without a notice adds nothing; a later notice queues behind the first', async () => {
    const r = rig(acked(), { free: [3], plan: [] })
    const low = await runCapacityPass(r.deps, r.state, 'boot')
    r.clock += 30_000
    await runCapacityPass(r.deps, r.state, 'timer')
    expect(r.state.dockerNoticesPending).toHaveLength(1)
    r.deps.readCapacity = async () => known(0)
    r.clock += 1_000
    const zero = await runCapacityPass(r.deps, r.state, 'event')
    expect(r.state.dockerNoticesPending).toEqual([low, zero])
  })

  it('ackWatchNotices drops exactly the acknowledged ones', async () => {
    const r = rig(acked(), { free: [3], plan: [] })
    const low = await runCapacityPass(r.deps, r.state, 'boot')
    r.deps.readCapacity = async () => known(0)
    r.clock += 1_000
    const zero = await runCapacityPass(r.deps, r.state, 'event')
    ackWatchNotices(r.state, [low.at])
    expect(r.state.dockerNoticesPending).toEqual([zero])
    ackWatchNotices(r.state, [zero.at, 999])
    expect(r.state.dockerNoticesPending).toEqual([])
  })
})
