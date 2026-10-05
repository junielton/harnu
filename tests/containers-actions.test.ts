import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  parseActRequest,
  refusalFor,
  runContainersAction,
  type ActionDeps,
  type DockerBatchResult
} from '../src/main/containers/containers-actions'
import {
  ACT_VERBS,
  VERDICTS,
  type ActErrorCode,
  type ContainersSnapshot,
  type StackRow,
  type Tombstone,
  type Verdict
} from '../src/main/containers/containers-wire'
import { GONE, NOW, WT, available, containerRow, stackRow } from './containers-fixtures'

type DockerOp = 'stop' | 'start' | 'removeContainers' | 'removeVolumes'

function fakeDeps(
  snap: ContainersSnapshot,
  opts: {
    fail?: Partial<Record<DockerOp, (ids: string[]) => DockerBatchResult>>
    appendFails?: boolean
  } = {}
): { deps: ActionDeps; calls: Array<[DockerOp, string[]]>; tombstones: Tombstone[] } {
  const calls: Array<[DockerOp, string[]]> = []
  const tombstones: Tombstone[] = []
  const op =
    (name: DockerOp) =>
    async (ids: string[]): Promise<DockerBatchResult> => {
      calls.push([name, ids])
      return opts.fail?.[name]?.(ids) ?? { done: ids, error: null }
    }
  const deps: ActionDeps = {
    scan: vi.fn(async () => snap),
    stop: op('stop'),
    start: op('start'),
    removeContainers: op('removeContainers'),
    removeVolumes: op('removeVolumes'),
    appendTombstone: vi.fn(async (t: Tombstone) => {
      if (opts.appendFails) throw new Error('disk full')
      tombstones.push(t)
    }),
    now: () => NOW
  }
  return { deps, calls, tombstones }
}

describe('parseActRequest — the renderer and MCP payloads are untrusted', () => {
  it.each([
    [null, 'request must be an object'],
    [[], 'request must be an object'],
    [{ verb: 'kill', stacks: ['a'] }, 'unknown verb: kill'],
    [{ verb: 'stop' }, 'stacks must be a non-empty list of stack ids'],
    [{ verb: 'stop', stacks: [] }, 'stacks must be a non-empty list of stack ids'],
    [{ verb: 'stop', stacks: [''] }, 'stacks must be a non-empty list of stack ids'],
    [{ verb: 'stop', stacks: ['a'], force: 'yes' }, 'force and bulk must be booleans'],
    [{ verb: 'start', stacks: 'a' }, 'stacks must be a non-empty list of stack ids'],
    [
      { verb: 'remove', stacks: ['a', 'b'] },
      'remove takes exactly one stack; there is no bulk form'
    ],
    [{ verb: 'remove' }, 'stack must be a stack id'],
    [{ verb: 'remove', stack: 'a', removeVolumes: 1 }, 'removeVolumes must be a boolean']
  ])('refuses %j', (raw, message) => {
    const parsed = parseActRequest(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toBe(message)
  })

  it('accepts the three verbs and drops keys it does not know', () => {
    expect(parseActRequest({ verb: 'stop', stacks: ['a'], actor: 'agent' })).toEqual({
      ok: true,
      req: { verb: 'stop', stacks: ['a'], force: false }
    })
    expect(parseActRequest({ verb: 'stop', bulk: true, stacks: ['x'] })).toEqual({
      ok: true,
      req: { verb: 'stop', bulk: true }
    })
    expect(parseActRequest({ verb: 'start', stacks: ['a'] })).toEqual({
      ok: true,
      req: { verb: 'start', stacks: ['a'] }
    })
    expect(parseActRequest({ verb: 'remove', stack: 'a', removeVolumes: true })).toEqual({
      ok: true,
      req: { verb: 'remove', stack: 'a', removeVolumes: true }
    })
  })

  it('the action function accepts stop, start, remove and sweep (MCP parity basis)', () => {
    // `sweep` (T340) is the one verb no MCP op exposes; the exclusion itself is
    // asserted in `mcp-containers-actions.test.ts`.
    expect(new Set(ACT_VERBS)).toEqual(new Set(['stop', 'start', 'remove', 'sweep']))
  })
})

// PRD §3.4 + the MCP spec, cell by cell. `null` = allowed.
const NA: ActErrorCode = 'STACK_NOT_ATTRIBUTABLE'
const TIERS: Record<string, Record<Verdict, ActErrorCode | null>> = {
  'stop running': {
    unknown: NA,
    orphan: null,
    active: 'STACK_IN_USE',
    protected: 'STACK_PROTECTED',
    pending: null,
    zombie: null
  },
  'stop running, force': {
    unknown: NA,
    orphan: null,
    active: null,
    protected: null,
    pending: null,
    zombie: null
  },
  'start stopped': {
    unknown: NA,
    orphan: 'WORKTREE_GONE',
    active: null,
    protected: null,
    pending: null,
    zombie: null
  },
  'remove stopped': {
    unknown: NA,
    orphan: null,
    active: 'STACK_IN_USE',
    protected: 'STACK_PROTECTED',
    pending: 'STACK_PENDING',
    zombie: null
  },
  'remove running': {
    unknown: NA,
    orphan: 'STACK_RUNNING',
    active: 'STACK_IN_USE',
    protected: 'STACK_PROTECTED',
    pending: 'STACK_PENDING',
    zombie: 'STACK_RUNNING'
  }
}

function requestFor(cell: string, id: string): Record<string, unknown> {
  if (cell.startsWith('stop')) return { verb: 'stop', stacks: [id], force: cell.includes('force') }
  if (cell.startsWith('start')) return { verb: 'start', stacks: [id] }
  return { verb: 'remove', stack: id }
}

const CELLS = Object.entries(TIERS).flatMap(([cell, row]) =>
  VERDICTS.map((verdict) => [cell, verdict, row[verdict]] as const)
)

describe('the tier table (PRD §3.4)', () => {
  it.each(CELLS)('%s %s → %s', (cell, verdict, expected) => {
    const running = cell.includes('running')
    const verb = cell.split(' ')[0] as 'stop' | 'start' | 'remove'
    expect(refusalFor(verb, { verdict, running }, { force: cell.includes('force') })).toBe(expected)
  })

  it.each(CELLS)('runContainersAction: %s %s → %s', async (cell, verdict, expected) => {
    const running = cell.includes('running')
    const stack = stackRow({ id: 's', verdict, running })
    const { deps, calls, tombstones } = fakeDeps(available([stack]))
    const res = await runContainersAction(requestFor(cell, 's'), 'operator', deps)
    if (expected) {
      expect(res.ok).toBe(false)
      expect(res.results).toEqual([
        expect.objectContaining({ stack: 's', ok: false, error: expected })
      ])
      expect(calls).toEqual([]) // a refusal never reaches docker
      expect(tombstones).toEqual([])
    } else {
      expect(res.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(tombstones).toHaveLength(1)
    }
  })
})

describe('runContainersAction', () => {
  it('refuses a malformed request without scanning or touching docker', async () => {
    const { deps, calls } = fakeDeps(available([]))
    const res = await runContainersAction({ verb: 'remove', stacks: ['a'] }, 'operator', deps)
    expect(res).toMatchObject({ ok: false, verb: 'remove', error: 'BAD_REQUEST', results: [] })
    expect(deps.scan).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('refuses everything when docker is unavailable', async () => {
    const { deps, calls } = fakeDeps({
      scannedAt: NOW,
      dockerAvailable: false,
      dockerError: 'Cannot connect to the Docker daemon',
      zombieAfterDays: 2,
      recent: []
    })
    const res = await runContainersAction({ verb: 'stop', bulk: true }, 'agent', deps)
    expect(res).toEqual({
      ok: false,
      verb: 'stop',
      error: 'DOCKER_UNAVAILABLE',
      message: 'Cannot connect to the Docker daemon',
      results: [],
      tombstone: null
    })
    expect(calls).toEqual([])
  })

  it('reports an unknown stack id as STACK_NOT_FOUND, per stack', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie' })
    const { deps, calls } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'stop', stacks: ['nope', 'z'] }, 'agent', deps)
    expect(res.ok).toBe(false)
    expect(res.results.map((r) => [r.stack, r.ok, r.error])).toEqual([
      ['nope', false, 'STACK_NOT_FOUND'],
      ['z', true, undefined]
    ])
    expect(calls).toHaveLength(1)
  })

  it('stop: stops the running containers and journals one tombstone', async () => {
    const run = containerRow({ memBytes: 600, ports: [8082, 5182] })
    const off = containerRow({ running: false })
    const z = stackRow({ id: 'proj-82', verdict: 'zombie', containers: [run, off] })
    const { deps, calls, tombstones } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'stop', stacks: ['proj-82'] }, 'agent', deps)
    expect(calls).toEqual([['stop', [run.id]]])
    expect(res.results[0]).toMatchObject({
      ok: true,
      containerIds: [run.id],
      freedRamBytes: 600,
      portsReleased: [5182, 8082]
    })
    expect(tombstones).toEqual([
      {
        at: NOW,
        actor: 'agent',
        verb: 'stop',
        stacks: [
          {
            stack: 'proj-82',
            name: 'proj-82',
            path: WT,
            containerIds: [run.id],
            freed: { ramBytes: 600, ports: [5182, 8082], volumes: [], volumeBytes: 0 }
          }
        ],
        restoreHint: `docker start ${run.id.slice(0, 12)}`
      }
    ])
    expect(res.tombstone).toEqual(tombstones[0])
  })

  it('stop on an already-stopped stack is a no-op: no docker call, no tombstone', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false })
    const { deps, calls, tombstones } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'stop', stacks: ['z'] }, 'operator', deps)
    expect(res.ok).toBe(true)
    expect(res.tombstone).toBeNull()
    expect(calls).toEqual([])
    expect(tombstones).toEqual([])
  })

  it('bulk stop: every running zombie and orphan, one tombstone listing each', async () => {
    const stacks: StackRow[] = [
      stackRow({ id: 'z-run', verdict: 'zombie' }),
      stackRow({ id: 'o-run', verdict: 'orphan' }),
      stackRow({ id: 'z-off', verdict: 'zombie', running: false }),
      stackRow({ id: 'active', verdict: 'active' }),
      stackRow({ id: 'protected', verdict: 'protected' }),
      stackRow({ id: 'pending', verdict: 'pending' }),
      stackRow({ id: 'unknown', verdict: 'unknown' })
    ]
    const { deps, calls, tombstones } = fakeDeps(available(stacks))
    const res = await runContainersAction(
      { verb: 'stop', bulk: true, stacks: ['active', 'unknown'], force: true },
      'operator',
      deps
    )
    expect(res.ok).toBe(true)
    expect(res.results.map((r) => r.stack)).toEqual(['z-run', 'o-run'])
    expect(calls.map(([op]) => op)).toEqual(['stop', 'stop'])
    expect(deps.appendTombstone).toHaveBeenCalledTimes(1)
    expect(tombstones[0]!.stacks.map((s) => s.stack)).toEqual(['z-run', 'o-run'])
    const ids = [stacks[0]!, stacks[1]!].map((s) => s.containers[0]!.id.slice(0, 12))
    expect(tombstones[0]!.restoreHint).toBe(`docker start ${ids.join(' ')}`)
  })

  it('bulk stop with nothing to stop writes no tombstone', async () => {
    const { deps, tombstones } = fakeDeps(available([stackRow({ id: 'a', verdict: 'active' })]))
    const res = await runContainersAction({ verb: 'stop', bulk: true }, 'operator', deps)
    expect(res).toMatchObject({ ok: true, results: [], tombstone: null })
    expect(tombstones).toEqual([])
  })

  it('start: starts the stopped containers; the tombstone has no restore hint', async () => {
    const off = containerRow({ running: false })
    const z = stackRow({ id: 'z', verdict: 'zombie', containers: [off, containerRow()] })
    const { deps, calls, tombstones } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'start', stacks: ['z'] }, 'operator', deps)
    expect(res.ok).toBe(true)
    expect(calls).toEqual([['start', [off.id]]])
    expect(tombstones[0]).toMatchObject({ verb: 'start', restoreHint: null })
  })

  it('remove: containers only unless asked, never a volume by default', async () => {
    const vols = [{ name: 'z_mysql', sizeBytes: 212_100_000, shared: false }]
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false, volumes: vols })
    const { deps, calls, tombstones } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'remove', stack: 'z' }, 'operator', deps)
    expect(calls).toEqual([['removeContainers', [z.containers[0]!.id]]])
    expect(res.results[0]).toMatchObject({
      ok: true,
      removedVolumes: [],
      keptVolumes: ['z_mysql'],
      freedVolumeBytes: 0
    })
    expect(tombstones[0]!.restoreHint).toBe(`docker compose -p z --project-directory ${WT} up -d`)
  })

  it('remove without volumes records the kept volumes on the tombstone (T331)', async () => {
    const vols = [{ name: 'z_mysql', sizeBytes: 212_100_000, shared: false }]
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false, volumes: vols })
    const { deps, tombstones } = fakeDeps(available([z]))
    await runContainersAction(
      { verb: 'remove', stack: 'z', removeVolumes: false },
      'operator',
      deps
    )
    expect(tombstones[0]!.stacks[0]).toMatchObject({
      keptVolumes: ['z_mysql'],
      keptVolumeBytes: 212_100_000
    })
  })

  it('a kept volume of unknown size leaves keptVolumeBytes off instead of recording 0 (T331)', async () => {
    const vols = [{ name: 'z_mysql', sizeBytes: null, shared: false }]
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false, volumes: vols })
    const { deps, tombstones } = fakeDeps(available([z]))
    await runContainersAction(
      { verb: 'remove', stack: 'z', removeVolumes: false },
      'operator',
      deps
    )
    const stack = tombstones[0]!.stacks[0]!
    expect(stack.keptVolumes).toEqual(['z_mysql'])
    expect(stack).not.toHaveProperty('keptVolumeBytes')
  })

  it('remove with volumes records no kept volumes when every volume went (T331)', async () => {
    const vols = [{ name: 'z_mysql', sizeBytes: 100, shared: false }]
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false, volumes: vols })
    const { deps, tombstones } = fakeDeps(available([z]))
    await runContainersAction({ verb: 'remove', stack: 'z', removeVolumes: true }, 'operator', deps)
    const stack = tombstones[0]!.stacks[0]!
    expect(stack.freed.volumes).toEqual(['z_mysql'])
    expect(stack).not.toHaveProperty('keptVolumes')
    expect(stack).not.toHaveProperty('keptVolumeBytes')
  })

  it('a shared volume a removal leaves in place is recorded as kept (T331)', async () => {
    const vols = [
      { name: 'z_mysql', sizeBytes: 100, shared: false },
      { name: 'shared_cache', sizeBytes: 50, shared: true }
    ]
    const z = stackRow({ id: 'z', verdict: 'orphan', running: false, volumes: vols })
    const { deps, tombstones } = fakeDeps(available([z]))
    await runContainersAction({ verb: 'remove', stack: 'z', removeVolumes: true }, 'operator', deps)
    expect(tombstones[0]!.stacks[0]).toMatchObject({
      keptVolumes: ['shared_cache'],
      keptVolumeBytes: 50
    })
  })

  it('a stop tombstone never carries kept volumes (T331)', async () => {
    const vols = [{ name: 'z_mysql', sizeBytes: 100, shared: false }]
    const z = stackRow({ id: 'z', verdict: 'zombie', volumes: vols })
    const { deps, tombstones } = fakeDeps(available([z]))
    await runContainersAction({ verb: 'stop', stacks: ['z'] }, 'operator', deps)
    expect(tombstones[0]!.stacks[0]).not.toHaveProperty('keptVolumes')
  })

  it('remove with volumes: containers first, then the non-shared volumes', async () => {
    const vols = [
      { name: 'z_mysql', sizeBytes: 100, shared: false },
      { name: 'z_redis', sizeBytes: 5, shared: false },
      { name: 'shared_cache', sizeBytes: 50, shared: true }
    ]
    const z = stackRow({ id: 'z', verdict: 'orphan', running: false, volumes: vols })
    const { deps, calls, tombstones } = fakeDeps(available([z]))
    const res = await runContainersAction(
      { verb: 'remove', stack: 'z', removeVolumes: true },
      'agent',
      deps
    )
    expect(calls).toEqual([
      ['removeContainers', [z.containers[0]!.id]],
      ['removeVolumes', ['z_mysql', 'z_redis']]
    ])
    expect(res.results[0]).toMatchObject({
      ok: true,
      removedContainers: [z.containers[0]!.id],
      removedVolumes: ['z_mysql', 'z_redis'],
      keptVolumes: ['shared_cache'],
      freedVolumeBytes: 105
    })
    expect(tombstones[0]).toMatchObject({
      actor: 'agent',
      verb: 'remove',
      restoreHint: null, // the orphan's worktree is gone: nothing can recreate it
      stacks: [
        {
          stack: 'z',
          path: GONE,
          freed: { volumes: ['z_mysql', 'z_redis'], volumeBytes: 105 }
        }
      ]
    })
  })

  it('remove of a standalone container has no recreate hint', async () => {
    const c = stackRow({ id: 'c', kind: 'container', verdict: 'zombie', running: false })
    const { deps, tombstones } = fakeDeps(available([c]))
    await runContainersAction({ verb: 'remove', stack: 'c' }, 'operator', deps)
    expect(tombstones[0]!.restoreHint).toBeNull()
  })

  it('a partial container removal keeps every volume and fails the stack', async () => {
    const a = containerRow({ running: false })
    const b = containerRow({ running: false })
    const vols = [{ name: 'z_mysql', sizeBytes: 100, shared: false }]
    const z = stackRow({ id: 'z', verdict: 'zombie', containers: [a, b], volumes: vols })
    const { deps, calls, tombstones } = fakeDeps(available([z]), {
      fail: { removeContainers: () => ({ done: [a.id], error: 'No such container' }) }
    })
    const res = await runContainersAction(
      { verb: 'remove', stack: 'z', removeVolumes: true },
      'operator',
      deps
    )
    expect(calls.map(([op]) => op)).toEqual(['removeContainers'])
    expect(res.ok).toBe(false)
    expect(res.results[0]).toMatchObject({
      ok: false,
      error: 'DOCKER_FAILED',
      message: 'No such container',
      removedContainers: [a.id],
      keptVolumes: ['z_mysql']
    })
    expect(tombstones[0]!.stacks[0]!.containerIds).toEqual([a.id])
  })

  it('a volume docker refuses stays kept and fails the stack', async () => {
    const vols = [
      { name: 'v1', sizeBytes: 10, shared: false },
      { name: 'v2', sizeBytes: 20, shared: false }
    ]
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false, volumes: vols })
    const { deps } = fakeDeps(available([z]), {
      fail: { removeVolumes: () => ({ done: ['v1'], error: 'volume is in use' }) }
    })
    const res = await runContainersAction(
      { verb: 'remove', stack: 'z', removeVolumes: true },
      'operator',
      deps
    )
    expect(res.results[0]).toMatchObject({
      ok: false,
      removedVolumes: ['v1'],
      keptVolumes: ['v2'],
      freedVolumeBytes: 10
    })
  })

  it('a partial stop still journals the containers that did stop', async () => {
    const a = containerRow()
    const b = containerRow()
    const z = stackRow({ id: 'z', verdict: 'zombie', containers: [a, b] })
    const { deps, tombstones } = fakeDeps(available([z]), {
      fail: { stop: () => ({ done: [a.id], error: null }) }
    })
    const res = await runContainersAction({ verb: 'stop', stacks: ['z'] }, 'operator', deps)
    expect(res.results[0]).toMatchObject({ ok: false, error: 'DOCKER_FAILED' })
    expect(tombstones[0]!.restoreHint).toBe(`docker start ${a.id.slice(0, 12)}`)
  })

  it('a docker call that throws fails that stack, not the whole request', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie' })
    const { deps } = fakeDeps(available([z]))
    deps.stop = async () => {
      throw new Error('spawn failed')
    }
    const res = await runContainersAction({ verb: 'stop', stacks: ['z'] }, 'operator', deps)
    expect(res.results[0]).toMatchObject({
      ok: false,
      error: 'DOCKER_FAILED',
      message: 'spawn failed'
    })
    expect(res.tombstone).toBeNull()
  })

  it('a journal write failure fails the result, never silently', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie' })
    const { deps } = fakeDeps(available([z]), { appendFails: true })
    const res = await runContainersAction({ verb: 'stop', stacks: ['z'] }, 'operator', deps)
    expect(res.ok).toBe(false)
    expect(res.message).toBe('journal write failed: disk full')
    expect(res.tombstone).toBeNull()
    expect(res.results[0]!.ok).toBe(true)
  })

  it('de-duplicates repeated stack ids', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie' })
    const { deps, calls } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'stop', stacks: ['z', 'z'] }, 'operator', deps)
    expect(res.results).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('the docker shell never passes --force, and rm never takes volumes with it', () => {
    // Code only: the shell's comments say "never --force" in so many words.
    const src = readFileSync(
      path.join(__dirname, '../src/main/containers/containers-shell.ts'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    // (`-v` alone is legitimate: `docker system df -v` is the verbose listing.)
    expect(src).not.toMatch(/--force|['"]-f['"]|['"]-fv['"]|['"]--volumes['"]/)
    expect(src).toMatch(
      /removeContainers: \(ids: string\[\]\): Promise<DockerBatchResult> => batch\(\['rm'\], ids\)/
    )
  })
})
