// The Docker slot of the cleanup cycle (U3.1 AC-3, AC-4): its own switch and report-only first
// cycle, a per-cycle cap, a failure-streak kill switch that says why, one lock across Harnu
// instances, and a global pause that makes the whole cycle act on nothing. The planner is empty in
// this unit, so the cap, the streak and the lock are proven with fake actions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createCycleState, runGcCycle, type GcCycleDeps } from '../src/main/gc/gc-cycle'
import {
  runDockerCycle,
  type DockerAction,
  type DockerCycleDeps,
  type DockerOutcome
} from '../src/main/gc/docker-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import {
  defaultGcPrefs,
  withDockerAcknowledged,
  withShelveAcknowledged,
  type GcPrefs
} from '../src/main/gc/gc-prefs'
import type { CycleRecord, DockerCycleRecord } from '../src/main/gc/gc-wire'
import { withLockFile } from '../src/main/gc/repo-lock-shell'
import { runShelveCycle, type ShelveCycleDeps } from '../src/main/gc/shelve-cycle'
import { bundle, DAY, NOW, reapItem } from './gc-fixtures'

const action = (n: number): DockerAction => ({
  kind: 'prune-network',
  id: `net-${n}`,
  reason: `empty network ${n}`
})
const actions = (n: number): DockerAction[] => Array.from({ length: n }, (_, i) => action(i + 1))

const acked = (over: Partial<GcPrefs['docker']> = {}): GcPrefs => {
  const p = withDockerAcknowledged(defaultGcPrefs())
  return { ...p, docker: { ...p.docker, ...over } }
}

interface Rig {
  deps: DockerCycleDeps
  state: ReturnType<typeof createCycleState>
  planned: number
  executed: string[]
  locks: number
  disabled: number
  notices: Array<{ title: string; body: string }>
}

function rig(
  prefs: GcPrefs,
  opts: {
    plan?: () => Promise<DockerAction[]>
    execute?: (a: DockerAction, n: number) => DockerOutcome
    locked?: boolean
    state?: ReturnType<typeof createCycleState>
    lock?: DockerCycleDeps['lock']
  } = {}
): Rig {
  const r: Rig = {
    state: opts.state ?? createCycleState(),
    planned: 0,
    executed: [],
    locks: 0,
    disabled: 0,
    notices: [],
    deps: undefined as unknown as DockerCycleDeps
  }
  r.deps = {
    prefs: () => prefs,
    plan: async () => {
      r.planned++
      return opts.plan ? opts.plan() : []
    },
    execute: async (a) => {
      r.executed.push(a.id)
      return (opts.execute ?? (() => ({ ok: true })))(a, r.executed.length)
    },
    lock:
      opts.lock ??
      (async (work) => {
        r.locks++
        if (opts.locked) return { ok: false, reason: 'locked', holder: null }
        return { ok: true, value: await work() }
      }),
    disableDocker: async () => {
      r.disabled++
    },
    notify: (n) => r.notices.push(n),
    now: () => NOW
  }
  return r
}

describe('runDockerCycle: switch, pause, report-only (AC-3, AC-4)', () => {
  it('switch off: nothing is planned, locked or run', async () => {
    const r = rig(acked({ enabled: false }), { plan: async () => actions(3) })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ mode: 'off', found: 0, acted: 0 })
    expect(r.planned).toBe(0)
    expect(r.locks).toBe(0)
  })

  it('global pause: the cycle reports paused and acts on nothing, the acknowledgement is kept', async () => {
    const prefs = { ...acked(), pauseAutonomous: true }
    const r = rig(prefs, { plan: async () => actions(3) })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ mode: 'paused', found: 0, acted: 0 })
    expect(r.planned).toBe(0)
    expect(r.locks).toBe(0)
    expect(r.executed).toEqual([])
    expect(r.notices).toEqual([])
    expect(prefs.docker.firstReportAcknowledged).toBe(true)
  })

  it('unacknowledged (the default): records what it would do and acts on nothing', async () => {
    const r = rig(defaultGcPrefs(), { plan: async () => actions(3) })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ mode: 'report', found: 3, acted: 0, deferred: 0 })
    expect(r.executed).toEqual([])
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]!.body).toMatch(/3 Docker items would be handled/)
    // the same report is not announced twice
    await runDockerCycle(r.deps, r.state)
    expect(r.notices).toHaveLength(1)
  })

  it('with the empty planner it records an empty report and says nothing', async () => {
    const r = rig(defaultGcPrefs())
    expect(await runDockerCycle(r.deps, r.state)).toMatchObject({
      mode: 'report',
      found: 0,
      acted: 0
    })
    expect(r.notices).toEqual([])
    const acting = rig(acked())
    expect(await runDockerCycle(acting.deps, acting.state)).toMatchObject({
      mode: 'act',
      found: 0,
      acted: 0
    })
  })
})

describe('runDockerCycle: cap, streak, kill switch (AC-4)', () => {
  it('runs at most maxPerCycle actions and leaves the rest for the next cycle', async () => {
    const r = rig(acked({ maxPerCycle: 5 }), { plan: async () => actions(7) })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(r.executed).toEqual(['net-1', 'net-2', 'net-3', 'net-4', 'net-5'])
    expect(rec).toMatchObject({ mode: 'act', found: 7, acted: 5, deferred: 2 })
  })

  it('a streak of failureLimit failures stops the cycle, switches Docker off and says why', async () => {
    const r = rig(acked({ failureLimit: 3, maxPerCycle: 10 }), {
      plan: async () => actions(6),
      execute: (_a, n) => ({ ok: false, reason: `daemon said no ${n}` })
    })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(r.executed).toHaveLength(3) // stopped at the limit, the other three never ran
    expect(r.disabled).toBe(1)
    expect(rec).toMatchObject({ failed: 3, paused: true })
    expect(rec.pausedReason).toMatch(/3 failures in a row/)
    expect(rec.pausedReason).toMatch(/daemon said no 3/)
    const why = r.notices.find((n) => /paused itself/i.test(n.body))
    expect(why?.body).toMatch(/3 failures in a row/)
    expect(why?.body).toMatch(/daemon said no 3/)
    expect(r.state.dockerStreak).toBe(0)
  })

  it('actions the kill switch kept from running are counted as deferred, so found adds up', async () => {
    const r = rig(acked({ failureLimit: 3, maxPerCycle: 10 }), {
      plan: async () => actions(6),
      execute: () => ({ ok: false, reason: 'daemon said no' })
    })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ found: 6, failed: 3, deferred: 3 })
    expect(rec.acted + rec.refused + rec.failed + rec.deferred).toBe(rec.found)
  })

  it('found adds up when both the cap and the kill switch leave actions behind', async () => {
    const r = rig(acked({ failureLimit: 3, maxPerCycle: 4 }), {
      plan: async () => actions(7),
      execute: () => ({ ok: false, reason: 'daemon said no' })
    })
    const rec = await runDockerCycle(r.deps, r.state)
    // 3 ran and failed; 1 of the 4 allowed never ran (kill switch); 3 were over the cap.
    expect(rec).toMatchObject({ found: 7, failed: 3, deferred: 4 })
    expect(rec.acted + rec.refused + rec.failed + rec.deferred).toBe(rec.found)
  })

  it('the streak carries across cycles and resets on a success', async () => {
    const state = createCycleState()
    const fail = rig(acked({ failureLimit: 3 }), {
      state,
      plan: async () => actions(2),
      execute: () => ({ ok: false, reason: 'boom' })
    })
    await runDockerCycle(fail.deps, state) // 2 failures, below the limit
    expect(state.dockerStreak).toBe(2)
    expect(fail.disabled).toBe(0)
    const good = rig(acked({ failureLimit: 3 }), { state, plan: async () => actions(1) })
    await runDockerCycle(good.deps, state)
    expect(state.dockerStreak).toBe(0)
  })

  it('a refusal (the world moved) is not a failure and never counts toward the kill switch', async () => {
    const r = rig(acked({ failureLimit: 2, maxPerCycle: 10 }), {
      plan: async () => actions(5),
      execute: () => ({ ok: false, reason: 'changed since decided', refusal: true })
    })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ refused: 5, failed: 0, paused: false })
    expect(r.disabled).toBe(0)
  })

  it('another instance holds the lock: nothing is planned or run', async () => {
    const r = rig(acked(), { plan: async () => actions(2), locked: true })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ locked: true, found: 0, acted: 0 })
    expect(r.planned).toBe(0)
    expect(r.executed).toEqual([])
  })
})

describe('runDockerCycle: one Docker slot across two Harnu instances', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-dcycle-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('two overlapping cycles over the real lock file: exactly one runs the slot', async () => {
    const file = path.join(root, 'docker.lock')
    let open!: () => void
    const wait = new Promise<void>((r) => (open = r))
    const lock: DockerCycleDeps['lock'] = (work) => withLockFile(file, work)
    // two instances: separate state, separate deps, one lock file
    const a = rig(acked(), {
      lock,
      plan: async () => {
        await wait
        return actions(1)
      }
    })
    const b = rig(acked(), { lock, plan: async () => actions(1) })
    const first = runDockerCycle(a.deps, a.state)
    await new Promise((r) => setTimeout(r, 30))
    const second = await runDockerCycle(b.deps, b.state)
    open()
    const firstRec = await first
    expect(second.locked).toBe(true)
    expect(b.executed).toEqual([])
    expect(firstRec).toMatchObject({ locked: false, acted: 1 })
  })
})

// ---- inside the cycle --------------------------------------------------------------------------

const noHousekeeping = {
  volumes: [],
  containers: [],
  dirExists: () => true,
  knownFolders: [],
  protectedProjects: new Set<string>()
}

function cycleRig(
  prefs: GcPrefs,
  extra: Partial<GcCycleDeps> = {}
): {
  deps: GcCycleDeps
  log: string[]
  cycles: CycleRecord[]
  notices: Array<{ title: string; body: string }>
} {
  const log: string[] = []
  const cycles: CycleRecord[] = []
  const notices: Array<{ title: string; body: string }> = []
  let n = 0
  const ready = bundle('/ws/wt/a', 'ready', {
    lastSignOfLifeAt: NOW - 5 * DAY,
    item: reapItem('/ws/wt/a', { diskBytes: 1e9 })
  })
  const deps: GcCycleDeps = {
    prefs: () => prefs,
    gather: async () => ({ bundles: [structuredClone(ready)], housekeeping: noHousekeeping }),
    opsFor: () => {
      log.push('opsFor')
      return {
        reprobe: async () => ({ ok: true }),
        stopStacks: async () => undefined,
        removeContainers: async () => undefined,
        removeVolumes: async () => undefined,
        dropDeps: async () => 1,
        recheck: async () => ({ ok: true }),
        cleanGit: async () => {
          log.push('cleanGit')
        }
      }
    },
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: () => undefined,
      emitDone: () => undefined
    }),
    housekeeping: async () => {
      log.push('housekeeping')
      return { buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] }
    },
    notify: (x) => notices.push(x),
    emitCycle: (r) => cycles.push(r),
    expireArchives: async () => {
      log.push('expireArchives')
      return { deleted: 0, failed: 0 }
    },
    shelve: async () => {
      log.push('shelve')
      return {
        mode: 'off',
        found: 0,
        foundBytes: 0,
        shelved: [],
        refused: 0,
        failed: 0,
        deferred: 0,
        paused: false,
        locked: 0,
        journalFailed: 0
      }
    },
    docker: async () => {
      log.push('docker')
      return dockerRecord()
    },
    state: createCycleState(),
    now: () => NOW,
    ...extra
  }
  return { deps, log, cycles, notices }
}

const dockerRecord = (over: Partial<DockerCycleRecord> = {}): DockerCycleRecord => ({
  mode: 'report',
  found: 0,
  acted: 0,
  refused: 0,
  failed: 0,
  deferred: 0,
  locked: false,
  paused: false,
  pausedReason: null,
  items: [],
  ...over
})

const liveAutopilot = (over: Partial<GcPrefs> = {}): GcPrefs => ({
  ...defaultGcPrefs(),
  autopilot: true,
  firstReportAcknowledged: true,
  ...over
})

describe('runGcCycle: the Docker slot', () => {
  it('runs after the clean and after shelving, and the record carries it', async () => {
    const r = cycleRig(liveAutopilot())
    const rec = await runGcCycle(r.deps, 'timer')
    expect(r.log.indexOf('shelve')).toBeGreaterThan(r.log.indexOf('cleanGit'))
    expect(r.log.indexOf('docker')).toBeGreaterThan(r.log.indexOf('shelve'))
    expect(rec.docker).toEqual(dockerRecord())
  })

  it('a throwing Docker slot is logged and never fails the cycle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const r = cycleRig(liveAutopilot(), {
      docker: async () => {
        throw new Error('docker exploded')
      }
    })
    const rec = await runGcCycle(r.deps, 'timer')
    expect(rec.docker).toBeUndefined()
    expect(rec.cleaned).toHaveLength(1)
    expect(r.log).toContain('shelve')
    expect(warn).toHaveBeenCalledWith('[gc] docker autonomy failed', 'docker exploded')
    warn.mockRestore()
  })

  it('works without a Docker slot wired', async () => {
    const r = cycleRig(liveAutopilot(), { docker: undefined })
    expect((await runGcCycle(r.deps, 'timer')).docker).toBeUndefined()
  })
})

describe('runGcCycle: global pause (AC-3)', () => {
  it('acts on nothing: no clean, no housekeeping, no expiry, no shelve, no Docker, no notice', async () => {
    const r = cycleRig(liveAutopilot({ pauseAutonomous: true, archiveAutoExpire: true }))
    const rec = await runGcCycle(r.deps, 'timer')
    expect(r.log).toEqual([])
    expect(r.notices).toEqual([])
    expect(rec).toMatchObject({
      mode: 'off',
      paused: true,
      cleaned: [],
      freedBytes: 0,
      housekeeping: null,
      jobId: null,
      notified: false
    })
    expect(rec.shelve).toBeUndefined()
    expect(rec.docker).toBeUndefined()
    // the record is still emitted and remembered, so the screen can say "paused"
    expect(r.cycles).toEqual([rec])
    expect(r.deps.state.last).toBe(rec)
  })

  it('resuming (pause off) acts again', async () => {
    const r = cycleRig(liveAutopilot({ pauseAutonomous: false }))
    const rec = await runGcCycle(r.deps, 'timer')
    expect(rec.mode).toBe('clean')
    expect(rec.paused).toBeUndefined()
  })

  it('runShelveCycle under the pause probes nothing and shelves nothing', async () => {
    const probed: string[] = []
    const p = withShelveAcknowledged({ ...defaultGcPrefs(), pauseAutonomous: true })
    const deps = {
      prefs: () => p,
      driftedCwds: () => [],
      probe: async (b: { item: { path: string | null } }) => {
        probed.push(b.item.path ?? '')
        throw new Error('must not probe')
      },
      shelve: async () => {
        throw new Error('must not shelve')
      },
      lock: async () => {
        throw new Error('must not lock')
      },
      queue: createJobQueue({
        newId: () => 'j',
        emitProgress: () => undefined,
        emitDone: () => undefined
      }),
      journal: async () => undefined,
      disableShelving: async () => undefined,
      notify: () => undefined,
      now: () => NOW
    } as unknown as ShelveCycleDeps
    const idle = bundle('/ws/trees/x', 'review', {
      item: reapItem('/ws/trees/x', { branch: 'feat/x', diskBytes: 1 }),
      lastSignOfLifeAt: NOW - 9 * DAY
    })
    const rec = await runShelveCycle(deps, [idle], createCycleState())
    expect(rec.mode).toBe('paused')
    expect(rec.found).toBe(0)
    expect(probed).toEqual([])
  })
})
