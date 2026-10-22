import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import {
  leftBehind,
  pruneLeftovers,
  withLeftovers,
  emptyLeftovers
} from '../src/main/gc/gc-leftovers'
import {
  listComposeNetworks,
  parseNetworkList,
  planStackLeftovers,
  runStackLeftoverCleanup,
  stackLeftoverExpectedOf,
  stackLeftoversChangedSince,
  stackLeftoverId,
  type StackLeftoverItem
} from '../src/main/gc/gc-stack-leftovers'
import { parseOptions } from '../src/main/gc/gc-options'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { InspectedContainer } from '../src/main/containers/containers-core'
import type { HousekeepingVolume } from '../src/main/gc/housekeeping-core'
import type { OrphanVolumeItem } from '../src/main/gc/gc-housekeeping-input'
import { bundle, NOW } from './gc-fixtures'

/**
 * AC-D3 (unit D): the stopped containers and the networks of a stack whose worktree Harnu removed
 * are listed on the Docker card as "left by removed worktrees" and cleaned after a confirm. Volumes
 * are listed apart and removed only by their own confirm, never automatically (rule D1).
 */

const GONE = '/ws/org/proj/worktrees/PROJ-1-gone'
const run = promisify(execFile)

function container(
  id: string,
  project: string | null,
  over: Partial<InspectedContainer> = {}
): InspectedContainer {
  return {
    id,
    name: `${project ?? 'solo'}-${id}-1`,
    image: 'img',
    labels: {
      ...(project ? { 'com.docker.compose.project': project } : {}),
      ...(project ? { 'com.docker.compose.project.working_dir': GONE } : {})
    },
    state: 'exited',
    startedAt: null,
    finishedAt: NOW - 86_400_000,
    createdAt: NOW - 2 * 86_400_000,
    ports: [],
    mounts: [],
    ...over
  }
}

const vol = (
  name: string,
  project: string | null,
  sizeBytes: number | null = 1_000
): HousekeepingVolume => ({
  name,
  project,
  sizeBytes
})
const orphan = (
  name: string,
  project: string | null,
  sizeBytes: number | null = 1_000
): OrphanVolumeItem => ({
  id: `volume:${name}`,
  name,
  sizeBytes,
  project,
  reason: { code: 'no-known-worktree', detail: 'x' }
})

const remembered = new Map([['pj', [GONE]]])
const dirGone = (): boolean => false

describe('what a cleaned worktree remembers of its stacks', () => {
  it('records the compose project of a stack even when it has no volume', () => {
    const b = { ...bundle(GONE, 'ready'), stackIds: ['pj'] }
    const out = leftBehind(b, [], [container('c1', 'pj')])
    expect(out).toEqual([{ project: 'pj', dir: GONE }])
  })

  it('does not invent a project for a standalone container stack', () => {
    const b = { ...bundle(GONE, 'ready'), stackIds: ['solo-c1-1'] }
    expect(leftBehind(b, [], [container('c1', null)])).toEqual([])
  })

  it('a project that still has a container or a network is not forgotten', () => {
    const file = withLeftovers(emptyLeftovers(), [{ project: 'pj', dir: GONE }])
    expect(pruneLeftovers(file, [], new Set(['pj'])).projects).toEqual({ pj: [GONE] })
    expect(pruneLeftovers(file, [], new Set()).projects).toEqual({})
    // The old two-argument call keeps its meaning: forgotten once Docker has no volume of it.
    expect(pruneLeftovers(file, [vol('v', 'pj')]).projects).toEqual({ pj: [GONE] })
  })
})

describe('planStackLeftovers', () => {
  const base = {
    remembered,
    dirExists: dirGone,
    containers: [] as InspectedContainer[],
    networks: [] as Array<{ id: string; name: string; project: string }>,
    orphanVolumes: [] as OrphanVolumeItem[]
  }

  it('lists stopped containers, networks and volumes of a removed worktree’s project', () => {
    const [it1] = planStackLeftovers({
      ...base,
      containers: [container('c1', 'pj'), container('c2', 'pj', { state: 'created' })],
      networks: [{ id: 'n1', name: 'pj_default', project: 'pj' }],
      orphanVolumes: [orphan('pj_data', 'pj', 4_096)]
    })
    expect(it1).toEqual<StackLeftoverItem>({
      id: stackLeftoverId('pj'),
      project: 'pj',
      dirs: [GONE],
      containers: [
        { id: 'c1', name: 'pj-c1-1', state: 'exited' },
        { id: 'c2', name: 'pj-c2-1', state: 'created' }
      ],
      networks: [{ id: 'n1', name: 'pj_default' }],
      volumes: [{ id: 'volume:pj_data', name: 'pj_data', sizeBytes: 4_096 }]
    })
  })

  it('a project nobody remembered is not ours to clean', () => {
    expect(
      planStackLeftovers({
        ...base,
        remembered: new Map(),
        containers: [container('c1', 'other')],
        networks: [{ id: 'n1', name: 'other_default', project: 'other' }]
      })
    ).toEqual([])
  })

  it('stays out of a project that has anything running or paused', () => {
    for (const state of ['running', 'restarting', 'paused']) {
      expect(
        planStackLeftovers({
          ...base,
          containers: [container('c1', 'pj'), container('c2', 'pj', { state })],
          networks: [{ id: 'n1', name: 'pj_default', project: 'pj' }]
        })
      ).toEqual([])
    }
  })

  it('stays out of it when a remembered folder exists again, or one cannot be told', () => {
    const args = { ...base, containers: [container('c1', 'pj')] }
    expect(planStackLeftovers({ ...args, dirExists: () => true })).toEqual([])
  })

  it('stays out of a container that a folder which exists still labels', () => {
    const alive = '/ws/org/proj/www'
    const c = container('c1', 'pj', {
      labels: {
        'com.docker.compose.project': 'pj',
        'com.docker.compose.project.working_dir': alive
      }
    })
    expect(planStackLeftovers({ ...base, containers: [c], dirExists: (p) => p === alive })).toEqual(
      []
    )
  })

  it('a project with nothing left has no item', () => {
    expect(planStackLeftovers(base)).toEqual([])
  })

  it('never lists a volume the orphan rules did not clear, or one of another project', () => {
    const [it1] = planStackLeftovers({
      ...base,
      containers: [container('c1', 'pj')],
      orphanVolumes: [orphan('other_data', 'other')]
    })
    expect(it1!.volumes).toEqual([])
  })
})

describe('parseNetworkList', () => {
  it('reads id, name and compose project; drops rows with no project or a bad name', () => {
    const out = [
      'n1\tpj_default\tpj',
      'n2\tbridge\t',
      'n3\t-bad\tpj',
      'n4\tpj_back\tpj',
      'garbage'
    ].join('\n')
    expect(parseNetworkList(out)).toEqual([
      { id: 'n1', name: 'pj_default', project: 'pj' },
      { id: 'n4', name: 'pj_back', project: 'pj' }
    ])
  })
})

// ---- a fake docker on PATH ---------------------------------------------------------------------------

describe('against a fake docker shim', () => {
  let dir: string
  let log: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-docker-shim-'))
    log = path.join(dir, 'calls.log')
    const shim = path.join(dir, 'docker')
    writeFileSync(
      shim,
      `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = "network" ] && [ "$2" = "ls" ]; then
  printf 'n1\\tpj_default\\tpj\\nn2\\tbridge\\t\\nn9\\tother_default\\tother\\n'
  exit 0
fi
if [ "$1" = "rm" ] && [ "$2" = "c-busy" ]; then
  echo "Error response from daemon: cannot remove a running container" >&2
  exit 1
fi
if [ "$1" = "network" ] && [ "$2" = "rm" ] && [ "$3" = "n-inuse" ]; then
  echo "Error response from daemon: network has active endpoints" >&2
  exit 1
fi
echo "$2"
`
    )
    chmodSync(shim, 0o755)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const dockerRun = async (argv: readonly string[]): Promise<{ stdout: string }> =>
    run(path.join(dir, 'docker'), [...argv], { encoding: 'utf8' })
  const calls = (): string[] => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  const item = (over: Partial<StackLeftoverItem> = {}): StackLeftoverItem => ({
    id: stackLeftoverId('pj'),
    project: 'pj',
    dirs: [GONE],
    containers: [{ id: 'c1', name: 'pj-c1-1', state: 'exited' }],
    networks: [{ id: 'n1', name: 'pj_default' }],
    volumes: [],
    ...over
  })

  it('lists the compose networks through docker network ls', async () => {
    expect(await listComposeNetworks(dockerRun)).toEqual([
      { id: 'n1', name: 'pj_default', project: 'pj' },
      { id: 'n9', name: 'other_default', project: 'other' }
    ])
    expect(calls()[0]).toMatch(/^network ls /)
  })

  it('removes containers then networks one at a time, never with force or volumes', async () => {
    const r = await runStackLeftoverCleanup(item(), dockerRun)
    expect(r).toEqual({ removedContainers: 1, removedNetworks: 1, errors: [] })
    expect(calls()).toEqual(['rm c1', 'network rm n1'])
    expect(calls().join(' ')).not.toMatch(/-f|--force|-v\b|volume/)
  })

  it('a refusal on one is reported and the rest still go', async () => {
    const r = await runStackLeftoverCleanup(
      item({
        containers: [
          { id: 'c-busy', name: 'busy', state: 'exited' },
          { id: 'c2', name: 'two', state: 'exited' }
        ],
        networks: [{ id: 'n-inuse', name: 'pj_x' }]
      }),
      dockerRun
    )
    expect(r.removedContainers).toBe(1)
    expect(r.removedNetworks).toBe(0)
    expect(r.errors).toHaveLength(2)
    expect(r.errors.join(' ')).toMatch(/running container|active endpoints/)
    expect(calls()).toEqual(['rm c-busy', 'rm c2', 'network rm n-inuse'])
  })

  it('an id that is not a plain docker id never reaches docker', async () => {
    const r = await runStackLeftoverCleanup(
      item({
        containers: [{ id: '--force', name: 'x', state: 'exited' }],
        networks: [{ id: 'a b', name: 'x' }]
      }),
      dockerRun
    )
    expect(calls()).toEqual([])
    expect(r.errors).toHaveLength(2)
  })
})

// ---- the manual clean ----------------------------------------------------------------------------------

function rig(items: StackLeftoverItem[], fresh?: () => Promise<StackLeftoverItem[]>) {
  const removed: StackLeftoverItem[] = []
  const done: Array<{ results: Array<Record<string, unknown>> }> = []
  let n = 0
  const deps: ManualCleanDeps = {
    prefs: () => defaultGcPrefs(),
    gather: async () => ({
      bundles: [],
      orphanVolumes: [],
      stackLeftovers: structuredClone(items)
    }),
    opsFor: () => {
      throw new Error('no worktree ops expected')
    },
    freshOrphans: async () => [],
    freshStackLeftovers: fresh ?? (async () => items),
    removeStackLeftovers: async (it) => {
      removed.push(it)
      return {
        removedContainers: it.containers.length,
        removedNetworks: it.networks.length,
        errors: []
      }
    },
    workStampOf: async () => null,
    removeOrphanVolumes: async () => ({
      buildCacheBytes: 0,
      imageBytes: 0,
      volumeBytes: 0,
      errors: []
    }),
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: () => undefined,
      emitDone: (d) => done.push(d as never)
    }),
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, removed, done }
}

const stack = (over: Partial<StackLeftoverItem> = {}): StackLeftoverItem => ({
  id: stackLeftoverId('pj'),
  project: 'pj',
  dirs: [GONE],
  containers: [{ id: 'c1', name: 'a', state: 'exited' }],
  networks: [{ id: 'n1', name: 'pj_default' }],
  volumes: [],
  ...over
})

const sent = (it: StackLeftoverItem, over: Record<string, unknown> = {}) =>
  parseOptions(
    structuredClone({
      confirmed: [it.id],
      expected: { [it.id]: stackLeftoverExpectedOf(it) },
      ...over
    })
  )

async function go(r: ReturnType<typeof rig>, ids: string[], opts: ReturnType<typeof parseOptions>) {
  submitManualClean(r.deps, ids, opts)
  await r.deps.queue.idle()
  return r.done[0]!.results
}

describe('the manual clean of stack leftovers', () => {
  it('goes through gc:clean with its own confirmation and removes what was shown', async () => {
    const it1 = stack()
    const r = rig([it1])
    const [res] = await go(r, [it1.id], sent(it1))
    expect(res).toMatchObject({ id: it1.id, ok: true })
    expect(r.removed).toEqual([it1])
  })

  it('refuses without its own confirm or without the facts shown', async () => {
    const it1 = stack()
    const a = rig([it1])
    expect((await go(a, [it1.id], sent(it1, { confirmed: [] })))[0]).toMatchObject({
      ok: false,
      error: 'needs-confirmation'
    })
    const b = rig([it1])
    expect((await go(b, [it1.id], sent(it1, { expected: {} })))[0]).toMatchObject({
      ok: false,
      error: 'missing-expected'
    })
    expect(a.removed.concat(b.removed)).toEqual([])
  })

  it('refuses when something new appeared since it was shown, removes nothing', async () => {
    const shown = stack()
    const now = stack({
      containers: [...shown.containers, { id: 'c-new', name: 'new', state: 'exited' }]
    })
    const r = rig([now])
    expect((await go(r, [shown.id], sent(shown)))[0]).toMatchObject({
      ok: false,
      error: 'changed-since-confirm'
    })
    expect(r.removed).toEqual([])
  })

  it('removes only what a fresh look still lists, when part of it is already gone', async () => {
    const shown = stack({
      containers: [
        { id: 'c1', name: 'a', state: 'exited' },
        { id: 'c2', name: 'b', state: 'exited' }
      ]
    })
    const fresh = stack({ containers: [shown.containers[0]!] })
    const r = rig([shown], async () => [fresh])
    const [res] = await go(r, [shown.id], sent(shown))
    expect(res).toMatchObject({ ok: true })
    expect(r.removed).toEqual([fresh])
  })

  it('refuses when it is no longer a leftover, and when the look itself fails', async () => {
    const it1 = stack()
    const gone = rig([it1], async () => [])
    expect((await go(gone, [it1.id], sent(it1)))[0]).toMatchObject({
      error: 'no-longer-leftover'
    })
    const broken = rig([it1], async () => {
      throw new Error('docker down')
    })
    expect(String((await go(broken, [it1.id], sent(it1)))[0]!.error)).toMatch(/probe-failed/)
    expect(gone.removed.concat(broken.removed)).toEqual([])
  })

  it('docker errors on some items make the job item a failure that names them', async () => {
    const it1 = stack()
    const r = rig([it1])
    r.deps.removeStackLeftovers = async () => ({
      removedContainers: 0,
      removedNetworks: 1,
      errors: ['docker rm c1: cannot remove a running container']
    })
    const [res] = await go(r, [it1.id], sent(it1))
    expect(res).toMatchObject({ ok: false, haltedAt: 'rm-containers' })
    expect(String(res!.error)).toMatch(/running container/)
  })

  it('what changed is judged on the ids, not on counts', () => {
    const it1 = stack()
    expect(stackLeftoversChangedSince(it1, stackLeftoverExpectedOf(it1))).toBeNull()
    const more = stack({ networks: [...it1.networks, { id: 'n2', name: 'x' }] })
    expect(stackLeftoversChangedSince(more, stackLeftoverExpectedOf(it1))).toBe('network')
  })
})

describe('volumes are never cleaned with the stack (D1)', () => {
  it('the stack runner has no volume argv at all', () => {
    const src = readFileSync(
      new URL('../src/main/gc/gc-stack-leftovers.ts', import.meta.url),
      'utf8'
    )
    expect(src).not.toMatch(/'volume'/)
  })
  it('the autopilot cycle never mentions stack leftovers', () => {
    for (const f of ['gc-cycle.ts', 'autopilot-core.ts']) {
      expect(readFileSync(new URL(`../src/main/gc/${f}`, import.meta.url), 'utf8')).not.toMatch(
        /stackLeftover|StackLeftover/
      )
    }
  })
  it('a stack item never carries volume ids into its own expected facts', () => {
    const it1 = stack({ volumes: [{ id: 'volume:v', name: 'v', sizeBytes: 1 }] })
    expect(stackLeftoverExpectedOf(it1).ownedVolumes).toEqual([])
  })
})

describe('a compose name shared with a live folder is never a leftover (delta-2 item 4)', () => {
  const remembered = new Map([['myapp', [GONE]]])
  const stopped = [container('c1', 'myapp')]
  const nets = [{ id: 'n1', name: 'myapp_default', project: 'myapp' }]

  it('a project pinned by the main checkout or any existing worktree is left alone entirely', () => {
    const args = {
      remembered,
      dirExists: dirGone,
      containers: stopped,
      networks: nets,
      orphanVolumes: [orphan('myapp_data', 'myapp')]
    }
    expect(planStackLeftovers(args)).toHaveLength(1)
    expect(planStackLeftovers({ ...args, protectedProjects: new Set(['myapp']) })).toEqual([])
  })

  it('the gather hands the planner the names live folders pin and the default names they run as', () => {
    const src = readFileSync(new URL('../src/main/gc/gc-scan-shell.ts', import.meta.url), 'utf8')
    const call = src.slice(src.indexOf('planStackLeftovers({'))
    expect(call.slice(0, 500)).toMatch(/protectedProjects/)
    expect(src).toMatch(/composeDefaultProject/)
  })
})

describe('no stack leftovers while a compose name is unresolved (delta-3 item 2)', () => {
  const args = {
    remembered: new Map([['pj', [GONE]]]),
    dirExists: dirGone,
    containers: [container('c1', 'pj')],
    networks: [{ id: 'n1', name: 'pj_default', project: 'pj' }],
    orphanVolumes: [] as OrphanVolumeItem[]
  }
  it('offers nothing while a pin could not be resolved, like the orphan-volume planner', () => {
    expect(planStackLeftovers(args)).toHaveLength(1)
    expect(planStackLeftovers({ ...args, protectAll: true })).toEqual([])
  })
  it('the gather passes the unresolved flag it already computes for volumes', () => {
    const src = readFileSync(new URL('../src/main/gc/gc-scan-shell.ts', import.meta.url), 'utf8')
    const call = src.slice(src.indexOf('planStackLeftovers({'))
    expect(call.slice(0, 900)).toMatch(/protectAll:\s*guards\.unresolved/)
  })
})
