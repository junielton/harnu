// U3.3 AC-3: the garbage planner and executor run in U3.1's Docker cycle slot. The first cycle only
// reports; after acknowledgement it acts; the global pause, the per-cycle cap and the failure-streak
// kill switch hold; every action is journaled as the autopilot.

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { runDockerCycle, type DockerCycleDeps } from '../src/main/gc/docker-cycle'
import { createDockerGarbage, type GarbageDeps } from '../src/main/gc/docker-garbage-shell'
import { defaultGcPrefs, withDockerAcknowledged, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { DockerNetworkFact } from '../src/main/containers/docker-networks-core'
import type { Tombstone } from '../src/main/containers/containers-wire'
import { available, containerRow, NOW, stackRow } from './containers-fixtures'

const net = (n: number): DockerNetworkFact => ({
  id: `id${n}`,
  name: `u33fixture-${n}_default`,
  driver: 'bridge',
  project: `u33fixture-${n}`,
  subnets: []
})

interface Rig {
  deps: DockerCycleDeps
  state: ReturnType<typeof createCycleState>
  calls: string[]
  tombstones: Tombstone[]
  notices: string[]
  disabled: number
}

function rig(
  prefs: GcPrefs,
  opts: { networks?: number; orphans?: number; netFails?: boolean } = {}
): Rig {
  const r: Rig = {
    state: createCycleState(),
    calls: [],
    tombstones: [],
    notices: [],
    disabled: 0,
    deps: undefined as unknown as DockerCycleDeps
  }
  const orphans = Array.from({ length: opts.orphans ?? 0 }, (_, i) =>
    stackRow({
      id: `u33fixture-orphan-${i}`,
      verdict: 'orphan',
      running: false,
      containers: [containerRow({ id: `c${i}`, running: false })]
    })
  )
  const garbageDeps: GarbageDeps = {
    emptyNetworks: async () => ({
      ok: true,
      value: { garbage: Array.from({ length: opts.networks ?? 0 }, (_, i) => net(i + 1)), held: [] }
    }),
    scan: async () => available(orphans),
    shelvedPaths: async () => [],
    mutators: {
      stop: async (ids) => ({ done: ids, error: null }),
      removeContainers: async (ids) => {
        r.calls.push(`rm ${ids.join(' ')}`)
        return { done: ids, error: null }
      },
      removeNetwork: async (id) => {
        r.calls.push(`network rm ${id}`)
        return opts.netFails
          ? { ok: false, error: 'permission denied', active: false }
          : { ok: true }
      }
    },
    appendTombstone: async (t) => {
      r.tombstones.push(t)
    },
    now: () => NOW
  }
  const garbage = createDockerGarbage(garbageDeps)
  r.deps = {
    prefs: () => prefs,
    plan: garbage.plan,
    execute: garbage.execute,
    lock: async (work) => ({ ok: true, value: await work() }),
    disableDocker: async () => {
      r.disabled++
    },
    notify: (n) => r.notices.push(n.body),
    now: () => NOW
  }
  return r
}

const acked = (over: Partial<GcPrefs['docker']> = {}): GcPrefs => {
  const p = withDockerAcknowledged(defaultGcPrefs())
  return { ...p, docker: { ...p.docker, ...over } }
}

describe('Docker garbage in the cycle slot (AC-3)', () => {
  it('the report-only first cycle records the plan and acts on nothing', async () => {
    const r = rig(defaultGcPrefs(), { networks: 2, orphans: 1 })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ mode: 'report', found: 3, acted: 0 })
    expect(r.calls).toEqual([])
    expect(r.tombstones).toEqual([])
    expect(r.notices.join(' ')).toMatch(/3 Docker items would be handled/)
  })

  it('after acknowledgement it clears the 2 networks and the orphan, journaled as the autopilot', async () => {
    const r = rig(acked(), { networks: 2, orphans: 1 })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ mode: 'act', found: 3, acted: 3, failed: 0, refused: 0 })
    expect(r.calls).toEqual(['network rm id1', 'network rm id2', 'rm c0'])
    expect(r.tombstones).toHaveLength(3)
    expect(r.tombstones.every((t) => t.actor === 'autopilot' && !!t.reason)).toBe(true)
    expect(r.notices.join(' ')).toMatch(/Volumes were kept/)
  })

  it('the global pause acts on nothing, even after acknowledgement', async () => {
    const r = rig({ ...acked(), pauseAutonomous: true }, { networks: 2, orphans: 1 })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ mode: 'paused', acted: 0 })
    expect(r.calls).toEqual([])
  })

  it('the per-cycle cap leaves the rest for the next cycle', async () => {
    const r = rig(acked({ maxPerCycle: 2 }), { networks: 3 })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ found: 3, acted: 2, deferred: 1 })
    expect(r.calls).toEqual(['network rm id1', 'network rm id2'])
  })

  it('a streak of failures switches Docker off and the skipped actions are counted', async () => {
    const r = rig(acked({ failureLimit: 2, maxPerCycle: 10 }), { networks: 4, netFails: true })
    const rec = await runDockerCycle(r.deps, r.state)
    expect(rec).toMatchObject({ failed: 2, deferred: 2, paused: true })
    expect(r.disabled).toBe(1)
    expect(r.tombstones).toEqual([])
  })
})

describe('gc-ipc wiring', () => {
  const src = readFileSync(path.join(__dirname, '..', 'src/main/gc/gc-ipc.ts'), 'utf8')

  it('no longer plans nothing and refuses everything', () => {
    expect(src).not.toMatch(/not implemented yet/)
    expect(src).not.toMatch(/plan: async \(\) => \[\]/)
    expect(src).toMatch(/createDockerGarbage\(/)
  })

  it('hands the executor the existing docker actions and the containers journal', () => {
    expect(src).toMatch(/dockerActions/)
    expect(src).toMatch(/readEmptyComposeNetworks/)
    expect(src).toMatch(/readShelvedForUpdate/)
  })
})
