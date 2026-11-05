// U3.6 AC-1/AC-2/AC-3: one capacity-watcher pass and the out-of-capacity notice ladder. Everything
// is injected, so no docker runs here.

import { describe, expect, it } from 'vitest'
import { createCycleState } from '../src/main/gc/gc-cycle'
import {
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
    now: () => 1_000
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

  it('the global pause acts on nothing and reads nothing', async () => {
    const r = rig({ ...acked(), pauseAutonomous: true }, { free: [0], plan: [net(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec).toMatchObject({ mode: 'paused', capacity: null, notice: null })
    expect(r.reads).toBe(0)
    expect(r.notices).toEqual([])
  })

  it('the Docker switch off acts on nothing and reads nothing', async () => {
    const r = rig(acked({ enabled: false }), { free: [0], plan: [net(1)] })
    const rec = await runCapacityPass(r.deps, r.state, 'timer')
    expect(rec).toMatchObject({ mode: 'off', capacity: null })
    expect(r.reads).toBe(0)
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
