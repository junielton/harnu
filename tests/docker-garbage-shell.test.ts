// U3.3 AC-2, AC-4, AC-5: the garbage executor over fake mutators. Every docker call the executor
// can make goes through three injected mutators (stop, rm, network rm); this suite records them
// all, so "no code path issues a volume removal" is asserted over everything that can be emitted.

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createDockerGarbage,
  type GarbageDeps,
  type GarbageMutators
} from '../src/main/gc/docker-garbage-shell'
import type { DockerAction, DockerOutcome } from '../src/main/gc/docker-cycle'
import type { DockerFactsResult } from '../src/main/containers/docker-facts-shell'
import type {
  DockerNetworkFact,
  EmptyNetworkPlan
} from '../src/main/containers/docker-networks-core'
import type {
  ContainersSnapshot,
  StackRow,
  Tombstone
} from '../src/main/containers/containers-wire'
import { available, containerRow, GONE, NOW, stackRow, WT } from './containers-fixtures'

const net = (name: string, project: string | null = 'proj'): DockerNetworkFact => ({
  id: `id${name}`,
  name,
  driver: 'bridge',
  project,
  subnets: []
})

const orphan = (id: string, over: Partial<StackRow> = {}): StackRow =>
  stackRow({ id, verdict: 'orphan', running: false, ...over })

interface Rig {
  deps: GarbageDeps
  calls: string[]
  tombstones: Tombstone[]
  stacks: StackRow[]
  networks: EmptyNetworkPlan
  facts: DockerFactsResult<EmptyNetworkPlan>
  shelved: readonly string[] | Error
  scanDown: boolean
  stopResult: { done: string[]; error: string | null } | null
  netResult: Awaited<ReturnType<GarbageMutators['removeNetwork']>>
  journalError: Error | null
}

function rig(): Rig {
  const r = {
    calls: [] as string[],
    tombstones: [] as Tombstone[],
    stacks: [] as StackRow[],
    networks: { garbage: [], held: [] } as EmptyNetworkPlan,
    facts: null as unknown as DockerFactsResult<EmptyNetworkPlan>,
    shelved: [] as readonly string[] | Error,
    scanDown: false,
    stopResult: null as Rig['stopResult'],
    netResult: { ok: true } as Rig['netResult'],
    journalError: null as Error | null
  } as Rig
  r.facts = { ok: true, value: r.networks }
  const scan = async (): Promise<ContainersSnapshot> =>
    r.scanDown
      ? ({
          dockerAvailable: false,
          dockerError: 'daemon down',
          scannedAt: NOW,
          zombieAfterDays: 2,
          recent: []
        } as ContainersSnapshot)
      : available(r.stacks)
  r.deps = {
    emptyNetworks: async () => (r.facts.ok ? { ok: true, value: r.networks } : r.facts),
    scan,
    shelvedPaths: async () => {
      if (r.shelved instanceof Error) throw r.shelved
      return r.shelved
    },
    mutators: {
      stop: async (ids) => {
        r.calls.push(`stop ${ids.join(' ')}`)
        if (r.stopResult) return r.stopResult
        for (const s of r.stacks) {
          s.containers = s.containers.map((c) =>
            ids.includes(c.id) ? { ...c, running: false, state: 'exited' } : c
          )
          s.running = s.containers.some((c) => c.running)
        }
        return { done: ids, error: null }
      },
      removeContainers: async (ids) => {
        r.calls.push(`rm ${ids.join(' ')}`)
        return { done: ids, error: null }
      },
      removeNetwork: async (id) => {
        r.calls.push(`network rm ${id}`)
        return r.netResult
      }
    },
    appendTombstone: async (t) => {
      if (r.journalError) throw r.journalError
      r.tombstones.push(t)
    },
    now: () => NOW
  }
  return r
}

const planOf = async (
  r: Rig
): Promise<{ g: ReturnType<typeof createDockerGarbage>; actions: DockerAction[] }> => {
  const g = createDockerGarbage(r.deps)
  return { g, actions: await g.plan() }
}

const refusal = (o: DockerOutcome): string => {
  expect(o.ok).toBe(false)
  if (o.ok) return ''
  expect(o.refusal).toBe(true)
  return o.reason
}

let r: Rig
beforeEach(() => {
  r = rig()
})

describe('plan()', () => {
  it('plans empty networks and orphans, and leaves held networks and shelved orphans out', async () => {
    r.networks = {
      garbage: [net('a_default')],
      held: [{ network: net('shared'), reason: 'external' }]
    }
    r.stacks = [
      orphan('gone-app'),
      orphan('shelved-app', {
        attribution: {
          rung: 'compose-label',
          path: `${WT}-shelved`,
          folderPath: null,
          folderKind: 'gone'
        }
      }),
      stackRow({ id: 'live', verdict: 'active' })
    ]
    r.shelved = [`${WT}-shelved`]
    const { actions } = await planOf(r)
    expect(actions.map((a) => a.id)).toEqual(['net:ida_default', 'stack:gone-app'])
  })

  it('plans nothing, and does not throw, when docker is unavailable', async () => {
    r.facts = { ok: false, error: { kind: 'docker-unavailable', message: 'down' } }
    r.scanDown = true
    expect((await planOf(r)).actions).toEqual([])
  })

  it('plans no orphan, but still the empty networks, when the shelved list is unreadable', async () => {
    r.networks = { garbage: [net('n')], held: [] }
    r.stacks = [orphan('gone-app')]
    r.shelved = new Error('corrupt')
    expect((await planOf(r)).actions.map((a) => a.id)).toEqual(['net:idn'])
  })

  it('plans no network when the facts could not be read', async () => {
    r.facts = { ok: false, error: { kind: 'failed', message: 'boom' } }
    r.stacks = [orphan('gone-app')]
    expect((await planOf(r)).actions.map((a) => a.id)).toEqual(['stack:gone-app'])
  })
})

describe('execute(): an empty network (AC-2, AC-5)', () => {
  beforeEach(() => {
    r.networks = { garbage: [net('p_default', 'p')], held: [] }
  })

  it('removes it with `network rm` and journals one line with the reason, as the autopilot', async () => {
    const { g, actions } = await planOf(r)
    expect(await g.execute(actions[0]!)).toEqual({ ok: true })
    expect(r.calls).toEqual(['network rm idp_default'])
    expect(r.tombstones).toEqual([
      {
        at: NOW,
        actor: 'autopilot',
        verb: 'remove',
        stacks: [],
        restoreHint: null,
        reason: 'Removed empty network `p_default` — no containers'
      }
    ])
  })

  it('refuses "changed since decided" when a container attached in the meantime', async () => {
    const { g, actions } = await planOf(r)
    r.networks = { garbage: [], held: [] }
    expect(refusal(await g.execute(actions[0]!))).toMatch(/^changed since decided: /)
    expect(r.calls).toEqual([])
    expect(r.tombstones).toEqual([])
  })

  it('refuses when a stack has declared it external in the meantime', async () => {
    const { g, actions } = await planOf(r)
    r.networks = { garbage: [], held: [{ network: net('p_default', 'p'), reason: 'external' }] }
    expect(refusal(await g.execute(actions[0]!))).toMatch(/^changed since decided: .*external/)
    expect(r.calls).toEqual([])
  })

  it('refuses, not fails, when docker is unreachable at re-probe time', async () => {
    const { g, actions } = await planOf(r)
    r.facts = { ok: false, error: { kind: 'docker-unavailable', message: 'down' } }
    refusal(await g.execute(actions[0]!))
    expect(r.calls).toEqual([])
  })

  it('fails when the facts cannot be read for another reason', async () => {
    const { g, actions } = await planOf(r)
    r.facts = { ok: false, error: { kind: 'failed', message: 'boom' } }
    expect(await g.execute(actions[0]!)).toMatchObject({ ok: false })
    expect(r.calls).toEqual([])
  })

  it('refuses when docker says the network has active endpoints', async () => {
    const { g, actions } = await planOf(r)
    r.netResult = { ok: false, error: 'has active endpoints', active: true }
    refusal(await g.execute(actions[0]!))
    expect(r.tombstones).toEqual([])
  })

  it('fails on any other docker error', async () => {
    const { g, actions } = await planOf(r)
    r.netResult = { ok: false, error: 'permission denied', active: false }
    const o = await g.execute(actions[0]!)
    expect(o).toMatchObject({ ok: false, reason: expect.stringContaining('permission denied') })
    expect((o as { refusal?: boolean }).refusal).toBeUndefined()
  })

  it('fails, never silently, when the removal happened but the journal write did not', async () => {
    const { g, actions } = await planOf(r)
    r.journalError = new Error('disk full')
    const o = await g.execute(actions[0]!)
    expect(o).toMatchObject({ ok: false, reason: expect.stringContaining('disk full') })
  })
})

describe('execute(): an orphan stack (AC-2, AC-4, AC-5)', () => {
  const volumes = [
    { name: 'proj-13_data', sizeBytes: 100, shared: false },
    { name: 'proj-13_cache', sizeBytes: 50, shared: true }
  ]

  it('removes a stopped orphan with `rm` only, keeps every volume and journals who owned them', async () => {
    r.stacks = [
      orphan('proj-13', { containers: [containerRow({ id: 'c1', running: false })], volumes })
    ]
    const { g, actions } = await planOf(r)
    expect(await g.execute(actions[0]!)).toEqual({ ok: true })
    expect(r.calls).toEqual(['rm c1'])
    expect(r.tombstones).toHaveLength(1)
    const t = r.tombstones[0]!
    expect(t).toMatchObject({
      actor: 'autopilot',
      verb: 'remove',
      restoreHint: null,
      reason:
        'Removed orphan stack `proj-13` — worktree gone, volumes kept: proj-13_data, proj-13_cache'
    })
    expect(t.stacks[0]).toMatchObject({
      stack: 'proj-13',
      containerIds: ['c1'],
      keptVolumes: ['proj-13_data', 'proj-13_cache'],
      keptVolumeBytes: 150,
      keptVolumeOwner: { reason: 'worktree-removed', project: 'proj-13', worktreePath: GONE }
    })
    expect(t.stacks[0]!.freed.volumes).toEqual([])
  })

  it('stops a running orphan first (graceful, never forced), then removes it: two journal lines', async () => {
    r.stacks = [orphan('run', { containers: [containerRow({ id: 'c1', running: true })] })]
    const { g, actions } = await planOf(r)
    expect(await g.execute(actions[0]!)).toEqual({ ok: true })
    expect(r.calls).toEqual(['stop c1', 'rm c1'])
    expect(r.tombstones.map((t) => [t.actor, t.verb])).toEqual([
      ['autopilot', 'stop'],
      ['autopilot', 'remove']
    ])
    expect(r.tombstones[0]!.reason).toBe('Stopped orphan stack `run` before removing it')
  })

  it('fails and removes nothing when the stop does not finish', async () => {
    r.stacks = [orphan('run', { containers: [containerRow({ id: 'c1', running: true })] })]
    const { g, actions } = await planOf(r)
    r.stopResult = { done: [], error: 'timeout' }
    expect(await g.execute(actions[0]!)).toMatchObject({ ok: false })
    expect(r.calls).toEqual(['stop c1'])
  })

  it('refuses when the verdict is no longer orphan', async () => {
    r.stacks = [orphan('s')]
    const { g, actions } = await planOf(r)
    r.stacks = [stackRow({ id: 's', verdict: 'active', running: false })]
    expect(refusal(await g.execute(actions[0]!))).toMatch(/^changed since decided: .*active/)
    expect(r.calls).toEqual([])
  })

  it('refuses when a container appeared that the plan never listed', async () => {
    r.stacks = [orphan('s', { containers: [containerRow({ id: 'c1', running: false })] })]
    const { g, actions } = await planOf(r)
    r.stacks = [
      orphan('s', {
        containers: [
          containerRow({ id: 'c1', running: false }),
          containerRow({ id: 'c2', running: true })
        ]
      })
    ]
    expect(refusal(await g.execute(actions[0]!))).toMatch(/^changed since decided: .*container/)
    expect(r.calls).toEqual([])
  })

  it('refuses when its worktree was shelved after the plan was made', async () => {
    r.stacks = [orphan('s')]
    const { g, actions } = await planOf(r)
    r.shelved = [GONE]
    expect(refusal(await g.execute(actions[0]!))).toMatch(/^changed since decided: .*shelved/)
    expect(r.calls).toEqual([])
  })

  it('refuses when the stack is already gone', async () => {
    r.stacks = [orphan('s')]
    const { g, actions } = await planOf(r)
    r.stacks = []
    expect(refusal(await g.execute(actions[0]!))).toMatch(/^changed since decided: .*gone/)
  })

  it('refuses when docker is unavailable at act time', async () => {
    r.stacks = [orphan('s')]
    const { g, actions } = await planOf(r)
    r.scanDown = true
    refusal(await g.execute(actions[0]!))
    expect(r.calls).toEqual([])
  })
})

describe('execute(): anything else', () => {
  it('refuses an action that is not part of the current plan', async () => {
    const g = createDockerGarbage(r.deps)
    refusal(await g.execute({ kind: 'prune-network', id: 'net:never', reason: 'x' }))
    expect(r.calls).toEqual([])
  })

  it('refuses an action it has already run', async () => {
    r.networks = { garbage: [net('p_default', 'p')], held: [] }
    const { g, actions } = await planOf(r)
    await g.execute(actions[0]!)
    refusal(await g.execute(actions[0]!))
    expect(r.calls).toEqual(['network rm idp_default'])
  })
})

describe('no code path removes a volume (AC-4)', () => {
  it('emits only stop, rm and network rm across every scenario above, over ids and nothing else', async () => {
    r.networks = { garbage: [net('p_default', 'p')], held: [] }
    r.stacks = [
      orphan('a', {
        containers: [containerRow({ id: 'ca', running: true })],
        volumes: [{ name: 'a_vol', sizeBytes: 1, shared: false }]
      }),
      orphan('b', {
        containers: [containerRow({ id: 'cb', running: false })],
        volumes: [{ name: 'b_vol', sizeBytes: 1, shared: true }]
      })
    ]
    const { g, actions } = await planOf(r)
    for (const a of actions) await g.execute(a)
    expect(r.calls.length).toBeGreaterThan(0)
    for (const call of r.calls) {
      expect(call).toMatch(/^(stop|rm|network rm) [A-Za-z0-9_.-]+( [A-Za-z0-9_.-]+)*$/)
      expect(call).not.toMatch(/volume|prune|--volumes|--force| -v\b| -f\b/)
    }
    const kept = r.tombstones.flatMap((t) => t.stacks.flatMap((s) => s.keptVolumes ?? []))
    expect(kept.sort()).toEqual(['a_vol', 'b_vol'])
    expect(r.tombstones.flatMap((t) => t.stacks.flatMap((s) => s.freed.volumes))).toEqual([])
  })

  it('the garbage sources name no volume removal, prune or force at all', () => {
    for (const f of ['docker-garbage-core.ts', 'docker-garbage-shell.ts']) {
      const src = readFileSync(path.join(__dirname, '..', 'src/main/gc', f), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code, f).not.toMatch(
        /volume rm|'volume'|prune\(|'prune'|--volumes|--force|removeVolumes: true/
      )
    }
  })
})
