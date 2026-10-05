import { describe, it, expect, vi } from 'vitest'
import {
  parseActRequest,
  refusalFor,
  runContainersAction,
  type ActionDeps,
  type DockerBatchResult
} from '../src/main/containers/containers-actions'
import { parseJournal, serializeTombstone } from '../src/main/containers/containers-journal'
import {
  NEEDS_YOU_VERDICTS,
  VERDICTS,
  type ContainersSnapshot,
  type StackRow,
  type Tombstone,
  type VolumeRow
} from '../src/main/containers/containers-wire'
import { GONE, NOW, WT, available, containerRow, stackRow } from './containers-fixtures'

/**
 * T340 — the sweep verb: one operator gesture that stops-then-removes every
 * sweep-eligible stack (zombie or orphan, running or exited), with an opt-in
 * volume removal and ONE journal tombstone. The single-stack `remove` contract
 * it deliberately does not widen is pinned in `containers-actions.test.ts`.
 */

type DockerOp = 'stop' | 'start' | 'removeContainers' | 'removeVolumes'

function fakeDeps(
  snap: ContainersSnapshot,
  opts: { fail?: Partial<Record<DockerOp, (ids: string[]) => DockerBatchResult>> } = {}
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
      tombstones.push(t)
    }),
    now: () => NOW
  }
  return { deps, calls, tombstones }
}

/** Every verdict, so a widening bug shows up as a stack that should not be here. */
function wholeMachine(): StackRow[] {
  return [
    stackRow({ id: 'z-run', verdict: 'zombie' }),
    stackRow({ id: 'z-off', verdict: 'zombie', running: false }),
    stackRow({ id: 'o-run', verdict: 'orphan' }),
    stackRow({ id: 'o-off', verdict: 'orphan', running: false }),
    stackRow({ id: 'active', verdict: 'active' }),
    stackRow({ id: 'protected', verdict: 'protected' }),
    stackRow({ id: 'pending', verdict: 'pending' }),
    stackRow({ id: 'unknown', verdict: 'unknown' })
  ]
}

describe('parseActRequest — the sweep request carries no stack list (T340 AC-1)', () => {
  it('accepts a bare sweep, with removeVolumes off by default', () => {
    expect(parseActRequest({ verb: 'sweep' })).toEqual({
      ok: true,
      req: { verb: 'sweep', removeVolumes: false }
    })
  })

  it('accepts removeVolumes', () => {
    expect(parseActRequest({ verb: 'sweep', removeVolumes: true })).toEqual({
      ok: true,
      req: { verb: 'sweep', removeVolumes: true }
    })
  })

  it.each([
    [{ verb: 'sweep', stacks: ['a'] }, 'sweep picks its own targets; it takes no stack list'],
    [{ verb: 'sweep', stacks: [] }, 'sweep picks its own targets; it takes no stack list'],
    [{ verb: 'sweep', stack: 'a' }, 'sweep picks its own targets; it takes no stack list'],
    [{ verb: 'sweep', removeVolumes: 1 }, 'removeVolumes must be a boolean']
  ])('refuses %j', (raw, message) => {
    const parsed = parseActRequest(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.verb).toBe('sweep')
      expect(parsed.message).toBe(message)
    }
  })

  it('a widened sweep never reaches docker or a scan', async () => {
    const { deps, calls } = fakeDeps(available(wholeMachine()))
    const res = await runContainersAction({ verb: 'sweep', stacks: ['active'] }, 'operator', deps)
    expect(res).toMatchObject({ ok: false, verb: 'sweep', error: 'BAD_REQUEST', results: [] })
    expect(deps.scan).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

describe('the sweep target set is picked in main (T340 AC-2)', () => {
  it('sweeps every zombie and orphan, running or exited, and nothing else', async () => {
    const { deps } = fakeDeps(available(wholeMachine()))
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(res.results.map((r) => r.stack)).toEqual(['z-run', 'z-off', 'o-run', 'o-off'])
    expect(res.ok).toBe(true)
  })

  it('a flag the caller smuggles in cannot widen the set', async () => {
    const { deps } = fakeDeps(available(wholeMachine()))
    const res = await runContainersAction(
      { verb: 'sweep', force: true, bulk: true, actor: 'operator' },
      'operator',
      deps
    )
    expect(res.results.map((r) => r.stack)).toEqual(['z-run', 'z-off', 'o-run', 'o-off'])
  })

  it('the tier table refuses a sweep of every verdict outside "Needs you"', () => {
    const cells = {
      unknown: 'STACK_NOT_ATTRIBUTABLE',
      active: 'STACK_IN_USE',
      protected: 'STACK_PROTECTED',
      pending: 'STACK_PENDING',
      orphan: null,
      zombie: null
    } as const
    for (const [verdict, expected] of Object.entries(cells)) {
      for (const running of [true, false]) {
        expect(refusalFor('sweep', { verdict: verdict as StackRow['verdict'], running })).toBe(
          expected
        )
      }
    }
  })

  it('a sweep is refused for every verdict that is not listed under "Needs you"', () => {
    for (const verdict of VERDICTS) {
      const listed = NEEDS_YOU_VERDICTS.includes(verdict)
      expect(refusalFor('sweep', { verdict, running: true }) === null).toBe(listed)
    }
  })

  it('a verdict the tier table has never heard of is never swept', async () => {
    const future = stackRow({ id: 'future', verdict: 'quarantined' as StackRow['verdict'] })
    const { deps, calls, tombstones } = fakeDeps(
      available([stackRow({ id: 'z-run', verdict: 'zombie' }), future])
    )
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(res.results.map((r) => r.stack)).toEqual(['z-run'])
    const touched = new Set(calls.flatMap(([, ids]) => ids))
    expect(future.containers.some((c) => touched.has(c.id))).toBe(false)
    expect(tombstones).toHaveLength(1)
  })

  it('a machine with nothing to sweep changes nothing and writes no tombstone', async () => {
    const { deps, calls, tombstones } = fakeDeps(
      available([stackRow({ id: 'active', verdict: 'active' })])
    )
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(res).toMatchObject({ ok: true, results: [], tombstone: null })
    expect(calls).toEqual([])
    expect(tombstones).toEqual([])
  })
})

function vol(name: string, over: Partial<VolumeRow> = {}): VolumeRow {
  return { name, sizeBytes: 100, shared: false, ...over }
}

describe('a sweep stops before it removes (T340 AC-3)', () => {
  it('stops a running stack, then removes it — never --force', async () => {
    const run = containerRow({ memBytes: 600, ports: [8082, 5182] })
    const z = stackRow({ id: 'z', verdict: 'zombie', containers: [run] })
    const { deps, calls } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(calls).toEqual([
      ['stop', [run.id]],
      ['removeContainers', [run.id]]
    ])
    expect(res.results[0]).toMatchObject({
      ok: true,
      containerIds: [run.id],
      removedContainers: [run.id],
      freedRamBytes: 600,
      portsReleased: [5182, 8082]
    })
  })

  it('an exited stack is removed without a stop', async () => {
    const off = containerRow({ running: false })
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false, containers: [off] })
    const { deps, calls } = fakeDeps(available([z]))
    await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(calls).toEqual([['removeContainers', [off.id]]])
  })

  it('a stack whose stop fails is never removed anyway', async () => {
    const a = containerRow()
    const b = containerRow()
    const z = stackRow({ id: 'z', verdict: 'zombie', containers: [a, b], volumes: [vol('z_db')] })
    const { deps, calls, tombstones } = fakeDeps(available([z]), {
      fail: { stop: () => ({ done: [a.id], error: 'permission denied' }) }
    })
    const res = await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(calls.map(([op]) => op)).toEqual(['stop'])
    expect(res.ok).toBe(false)
    expect(res.results[0]).toMatchObject({
      ok: false,
      error: 'DOCKER_FAILED',
      message: 'permission denied',
      removedContainers: [],
      keptVolumes: ['z_db']
    })
    // The containers that did stop are still journalled.
    expect(tombstones[0]!.stacks[0]!.containerIds).toEqual([a.id])
  })
})

describe('a sweep removes volumes last, and only the ones nothing else needs (T340 AC-4)', () => {
  it('keeps every volume by default', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false, volumes: [vol('z_db')] })
    const { deps, calls, tombstones } = fakeDeps(available([z]))
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(calls.map(([op]) => op)).toEqual(['removeContainers'])
    expect(res.results[0]).toMatchObject({ removedVolumes: [], keptVolumes: ['z_db'] })
    expect(tombstones[0]!.stacks[0]).toMatchObject({
      keptVolumes: ['z_db'],
      keptVolumeBytes: 100
    })
  })

  it('removes volumes only after every container removal, in one call', async () => {
    const a = stackRow({ id: 'a', verdict: 'zombie', running: false, volumes: [vol('a_db')] })
    const b = stackRow({ id: 'b', verdict: 'orphan', running: false, volumes: [vol('b_db')] })
    const { deps, calls } = fakeDeps(available([a, b]))
    await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(calls.map(([op]) => op)).toEqual([
      'removeContainers',
      'removeContainers',
      'removeVolumes'
    ])
    expect(calls[2]![1]).toEqual(['a_db', 'b_db'])
  })

  it('a volume two swept stacks share goes once both are gone, counted once', async () => {
    const shared = vol('team_cache', { shared: true, sizeBytes: 50 })
    const a = stackRow({
      id: 'a',
      verdict: 'zombie',
      running: false,
      volumes: [vol('a_db'), shared]
    })
    const b = stackRow({ id: 'b', verdict: 'zombie', running: false, volumes: [shared] })
    const { deps, calls } = fakeDeps(available([a, b]))
    const res = await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(calls.at(-1)).toEqual(['removeVolumes', ['a_db', 'team_cache']])
    expect(res.results[0]).toMatchObject({
      removedVolumes: ['a_db', 'team_cache'],
      keptVolumes: [],
      freedVolumeBytes: 150
    })
    expect(res.results[1]).toMatchObject({
      removedVolumes: [],
      keptVolumes: [],
      freedVolumeBytes: 0
    })
  })

  it('a volume a stack outside the sweep mounts is kept, with its own size', async () => {
    const shared = vol('team_cache', { shared: true, sizeBytes: 50 })
    const z = stackRow({
      id: 'z',
      verdict: 'zombie',
      running: false,
      volumes: [vol('z_db'), shared]
    })
    const live = stackRow({ id: 'live', verdict: 'active', volumes: [shared] })
    const { deps, calls, tombstones } = fakeDeps(available([z, live]))
    const res = await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(calls.at(-1)).toEqual(['removeVolumes', ['z_db']])
    expect(res.results[0]).toMatchObject({
      removedVolumes: ['z_db'],
      keptVolumes: ['team_cache'],
      freedVolumeBytes: 100
    })
    expect(tombstones[0]!.stacks[0]).toMatchObject({
      keptVolumes: ['team_cache'],
      keptVolumeBytes: 50
    })
  })

  it('a volume docker flags as another project\u2019s is kept even inside the sweep', async () => {
    // `shared` with no other stack mounting it: the volume belongs to another
    // compose project the sweep is not clearing.
    const z = stackRow({
      id: 'z',
      verdict: 'zombie',
      running: false,
      volumes: [vol('other_project_db', { shared: true })]
    })
    const { deps, calls, tombstones } = fakeDeps(available([z]))
    await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(calls.map(([op]) => op)).toEqual(['removeContainers'])
    expect(tombstones[0]!.stacks[0]).toMatchObject({ keptVolumes: ['other_project_db'] })
  })

  it('a stack whose containers did not go keeps its volumes', async () => {
    const a = stackRow({ id: 'a', verdict: 'zombie', running: false, volumes: [vol('a_db')] })
    const b = stackRow({ id: 'b', verdict: 'zombie', running: false, volumes: [vol('b_db')] })
    const { deps, calls } = fakeDeps(available([a, b]), {
      fail: (() => {
        let first = true
        return {
          removeContainers: (ids: string[]) => {
            const fail = first
            first = false
            return fail ? { done: [], error: 'container is in use' } : { done: ids, error: null }
          }
        }
      })()
    })
    const res = await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(calls.at(-1)).toEqual(['removeVolumes', ['b_db']])
    expect(res.results[0]).toMatchObject({ ok: false, keptVolumes: ['a_db'], removedVolumes: [] })
    expect(res.results[1]).toMatchObject({ ok: true, removedVolumes: ['b_db'] })
  })

  it('a volume docker refuses stays kept and fails only its own stack', async () => {
    const a = stackRow({ id: 'a', verdict: 'zombie', running: false, volumes: [vol('a_db')] })
    const b = stackRow({ id: 'b', verdict: 'zombie', running: false, volumes: [vol('b_db')] })
    const { deps } = fakeDeps(available([a, b]), {
      fail: { removeVolumes: () => ({ done: ['b_db'], error: 'volume is in use' }) }
    })
    const res = await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(res.ok).toBe(false)
    expect(res.results[0]).toMatchObject({
      ok: false,
      error: 'DOCKER_FAILED',
      keptVolumes: ['a_db']
    })
    expect(res.results[1]).toMatchObject({ ok: true, removedVolumes: ['b_db'] })
  })
})

describe('a sweep writes exactly one tombstone (T340 AC-5)', () => {
  it('one line, listing every stack it actually changed', async () => {
    const stacks = [
      stackRow({ id: 'z-run', verdict: 'zombie' }),
      stackRow({ id: 'o-off', verdict: 'orphan', running: false }),
      stackRow({ id: 'active', verdict: 'active' })
    ]
    const { deps, tombstones } = fakeDeps(available(stacks))
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(deps.appendTombstone).toHaveBeenCalledTimes(1)
    expect(tombstones[0]).toMatchObject({ at: NOW, actor: 'operator', verb: 'sweep' })
    expect(tombstones[0]!.stacks.map((s) => s.stack)).toEqual(['z-run', 'o-off'])
    expect(res.tombstone).toEqual(tombstones[0])
  })

  it('a batch no single command restores carries no hint', async () => {
    const a = stackRow({ id: 'a', verdict: 'zombie', running: false })
    const b = stackRow({ id: 'b', verdict: 'zombie', running: false })
    const { deps, tombstones } = fakeDeps(available([a, b]))
    await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(tombstones[0]!.restoreHint).toBeNull()
  })

  it('a sweep of one recreatable stack carries that stack\u2019s recreate command', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false })
    const { deps, tombstones } = fakeDeps(available([z]))
    await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(tombstones[0]!.restoreHint).toBe(`docker compose -p z --project-directory ${WT} up -d`)
  })

  it('a sweep of one orphan has nothing to recreate', async () => {
    const o = stackRow({ id: 'o', verdict: 'orphan', running: false })
    const { deps, tombstones } = fakeDeps(available([o]))
    await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(tombstones[0]!.stacks[0]!.path).toBe(GONE)
    expect(tombstones[0]!.restoreHint).toBeNull()
  })

  it('a sweep tombstone reads back out of the journal', async () => {
    const z = stackRow({ id: 'z', verdict: 'zombie', running: false })
    const { deps, tombstones } = fakeDeps(available([z]))
    await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(parseJournal(serializeTombstone(tombstones[0]!))).toEqual([tombstones[0]])
  })
})

describe('a partial sweep still commits what worked (T340 AC-8)', () => {
  it('reports one row per target and keeps the successes in the tombstone', async () => {
    const bad = stackRow({ id: 'bad', verdict: 'zombie', running: false })
    const good = stackRow({ id: 'good', verdict: 'zombie', running: false })
    const badId = bad.containers[0]!.id
    const { deps, tombstones } = fakeDeps(available([bad, good]), {
      fail: {
        removeContainers: (ids) =>
          ids[0] === badId ? { done: [], error: 'No such container' } : { done: ids, error: null }
      }
    })
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(res.ok).toBe(false)
    expect(res.results.map((r) => [r.stack, r.ok, r.error])).toEqual([
      ['bad', false, 'DOCKER_FAILED'],
      ['good', true, undefined]
    ])
    expect(tombstones[0]!.stacks.map((s) => s.stack)).toEqual(['good'])
  })

  it('a docker call that throws fails that stack, not the sweep', async () => {
    const a = stackRow({ id: 'a', verdict: 'zombie' })
    const b = stackRow({ id: 'b', verdict: 'zombie', running: false })
    const { deps } = fakeDeps(available([a, b]))
    deps.stop = async () => {
      throw new Error('spawn failed')
    }
    const res = await runContainersAction({ verb: 'sweep' }, 'operator', deps)
    expect(res.results.map((r) => [r.stack, r.ok])).toEqual([
      ['a', false],
      ['b', true]
    ])
    expect(res.results[0]!.message).toBe('spawn failed')
  })
})

describe('sweep is an operator action (T340 AC-7)', () => {
  it('refuses a sweep that arrives with an agent actor', async () => {
    const { deps, calls } = fakeDeps(available([stackRow({ id: 'z', verdict: 'zombie' })]))
    const res = await runContainersAction({ verb: 'sweep' }, 'agent', deps)
    expect(res).toMatchObject({ ok: false, verb: 'sweep', error: 'BAD_REQUEST', results: [] })
    expect(deps.scan).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

/**
 * BUG-137 — the clean-up dialog is binding. Main re-scans at act time, so the
 * set it sweeps can differ from the one the dialog disclosed. The dialog now
 * sends what it showed, and a set that moved refuses the whole sweep rather
 * than deleting something the operator never read.
 */
describe('BUG-137 — a sweep whose disclosed set moved is refused (AC-2)', () => {
  it('refuses the whole sweep, before any docker call, when a stack joined the set', async () => {
    const shown = stackRow({
      id: 'z-1',
      verdict: 'zombie',
      running: false,
      volumes: [vol('z1_db')]
    })
    // Crossed its "unused for" threshold after the dialog rendered its list:
    // the operator never read it, so it must not be removed under their confirm.
    const latecomer = stackRow({
      id: 'z-2',
      verdict: 'zombie',
      running: false,
      volumes: [vol('z2_db')]
    })
    const { deps, calls, tombstones } = fakeDeps(available([shown, latecomer]))
    const res = await runContainersAction(
      { verb: 'sweep', removeVolumes: true, disclosed: { stacks: ['z-1'], volumes: ['z1_db'] } },
      'operator',
      deps
    )
    expect(res).toMatchObject({
      ok: false,
      verb: 'sweep',
      error: 'SWEEP_SET_CHANGED',
      results: [],
      tombstone: null
    })
    // A refusal of its own, never the malformed-request code.
    expect(res.error).not.toBe('BAD_REQUEST')
    // The fresh scan is the only thing that ran: nothing stopped, nothing
    // removed, no volume gone, no journal line.
    expect(deps.scan).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
    expect(tombstones).toEqual([])
  })

  it('refuses when a stack left the set between the disclosure and the click', async () => {
    const { deps, calls, tombstones } = fakeDeps(
      available([stackRow({ id: 'z-1', verdict: 'zombie', running: false })])
    )
    const res = await runContainersAction(
      { verb: 'sweep', disclosed: { stacks: ['z-1', 'z-2'], volumes: [] } },
      'operator',
      deps
    )
    expect(res).toMatchObject({ ok: false, error: 'SWEEP_SET_CHANGED', results: [] })
    expect(calls).toEqual([])
    expect(tombstones).toEqual([])
  })

  it('refuses when the stacks still match but the volumes moved', async () => {
    const z = stackRow({
      id: 'z-1',
      verdict: 'zombie',
      running: false,
      volumes: [vol('z1_db'), vol('z1_cache')]
    })
    const { deps, calls } = fakeDeps(available([z]))
    const res = await runContainersAction(
      { verb: 'sweep', removeVolumes: true, disclosed: { stacks: ['z-1'], volumes: ['z1_db'] } },
      'operator',
      deps
    )
    expect(res).toMatchObject({ ok: false, error: 'SWEEP_SET_CHANGED' })
    expect(calls).toEqual([])
  })

  it('compares the volumes even when the box was left unticked', async () => {
    // The dialog discloses the volumes either way, and a confirm is a promise
    // about the whole list it showed — not only the part it would delete.
    const z = stackRow({
      id: 'z-1',
      verdict: 'zombie',
      running: false,
      volumes: [vol('z1_db'), vol('z1_cache')]
    })
    const { deps, calls } = fakeDeps(available([z]))
    const res = await runContainersAction(
      { verb: 'sweep', removeVolumes: false, disclosed: { stacks: ['z-1'], volumes: ['z1_db'] } },
      'operator',
      deps
    )
    expect(res).toMatchObject({ ok: false, error: 'SWEEP_SET_CHANGED' })
    expect(calls).toEqual([])
  })

  it('a disclosure that still matches sweeps normally, order and all', async () => {
    const a = stackRow({ id: 'a', verdict: 'zombie', running: false, volumes: [vol('a_db')] })
    const b = stackRow({ id: 'b', verdict: 'orphan', running: false, volumes: [vol('b_db')] })
    const { deps, calls, tombstones } = fakeDeps(available([a, b]))
    const res = await runContainersAction(
      // Reversed: the assertion is about the SET, not the order it is written in.
      {
        verb: 'sweep',
        removeVolumes: true,
        disclosed: { stacks: ['b', 'a'], volumes: ['b_db', 'a_db'] }
      },
      'operator',
      deps
    )
    expect(res.ok).toBe(true)
    expect(res.results.map((r) => r.stack)).toEqual(['a', 'b'])
    expect(calls.at(-1)).toEqual(['removeVolumes', ['a_db', 'b_db']])
    expect(tombstones).toHaveLength(1)
  })

  it('a volume the sweep would keep is not part of the disclosure it checks', async () => {
    // `sweepPlan` lists a survivor-mounted volume as KEPT, not offered, so the
    // disclosure names only what the sweep would take.
    const shared = vol('team_cache', { shared: true })
    const z = stackRow({
      id: 'z',
      verdict: 'zombie',
      running: false,
      volumes: [vol('z_db'), shared]
    })
    const live = stackRow({ id: 'live', verdict: 'active', volumes: [shared] })
    const { deps } = fakeDeps(available([z, live]))
    const res = await runContainersAction(
      { verb: 'sweep', removeVolumes: true, disclosed: { stacks: ['z'], volumes: ['z_db'] } },
      'operator',
      deps
    )
    expect(res.ok).toBe(true)
    expect(res.results[0]).toMatchObject({ removedVolumes: ['z_db'], keptVolumes: ['team_cache'] })
  })
})

describe('BUG-137 — the disclosure is an assertion, never a target list (AC-1)', () => {
  it('cannot add a stack the tier table refuses: the sweep is refused, not widened', async () => {
    const stacks = wholeMachine()
    const { deps, calls } = fakeDeps(available(stacks))
    const res = await runContainersAction(
      {
        verb: 'sweep',
        disclosed: { stacks: ['z-run', 'z-off', 'o-run', 'o-off', 'active'], volumes: [] }
      },
      'operator',
      deps
    )
    expect(res).toMatchObject({ ok: false, error: 'SWEEP_SET_CHANGED', results: [] })
    expect(calls).toEqual([])
  })

  it('cannot narrow the sweep either: a shorter disclosure refuses instead of trimming', async () => {
    const { deps, calls } = fakeDeps(available(wholeMachine()))
    const res = await runContainersAction(
      { verb: 'sweep', disclosed: { stacks: ['z-run'], volumes: [] } },
      'operator',
      deps
    )
    expect(res).toMatchObject({ ok: false, error: 'SWEEP_SET_CHANGED', results: [] })
    expect(calls).toEqual([])
  })

  it('a matching disclosure changes nothing about which stacks are swept', async () => {
    const bare = fakeDeps(available(wholeMachine()))
    const asserted = fakeDeps(available(wholeMachine()))
    const withoutIt = await runContainersAction({ verb: 'sweep' }, 'operator', bare.deps)
    const withIt = await runContainersAction(
      {
        verb: 'sweep',
        disclosed: { stacks: ['z-run', 'z-off', 'o-run', 'o-off'], volumes: [] }
      },
      'operator',
      asserted.deps
    )
    expect(withIt.results.map((r) => r.stack)).toEqual(withoutIt.results.map((r) => r.stack))
    expect(asserted.calls.map(([op]) => op)).toEqual(bare.calls.map(([op]) => op))
  })
})

describe('BUG-137 — a sweep with no disclosure behaves exactly as before (AC-3)', () => {
  it('parses to the same request it always did', () => {
    expect(parseActRequest({ verb: 'sweep' })).toEqual({
      ok: true,
      req: { verb: 'sweep', removeVolumes: false }
    })
    expect(parseActRequest({ verb: 'sweep', removeVolumes: true })).toEqual({
      ok: true,
      req: { verb: 'sweep', removeVolumes: true }
    })
  })

  it('sweeps the whole fresh set, however far it moved since anyone looked', async () => {
    const a = stackRow({ id: 'a', verdict: 'zombie', running: false, volumes: [vol('a_db')] })
    const b = stackRow({ id: 'b', verdict: 'orphan', running: false, volumes: [vol('b_db')] })
    const { deps, calls, tombstones } = fakeDeps(available([a, b]))
    const res = await runContainersAction({ verb: 'sweep', removeVolumes: true }, 'operator', deps)
    expect(res.ok).toBe(true)
    expect(res.results.map((r) => r.stack)).toEqual(['a', 'b'])
    expect(calls.at(-1)).toEqual(['removeVolumes', ['a_db', 'b_db']])
    expect(tombstones).toHaveLength(1)
  })

  it('carries the disclosure on the parsed request only when one was sent', () => {
    const parsed = parseActRequest({
      verb: 'sweep',
      disclosed: { stacks: ['a'], volumes: ['a_db'] }
    })
    expect(parsed).toEqual({
      ok: true,
      req: { verb: 'sweep', removeVolumes: false, disclosed: { stacks: ['a'], volumes: ['a_db'] } }
    })
  })

  it.each([
    [{ verb: 'sweep', disclosed: null }, 'disclosed must be an object'],
    [{ verb: 'sweep', disclosed: ['a'] }, 'disclosed must be an object'],
    [
      { verb: 'sweep', disclosed: { stacks: ['a'] } },
      'disclosed.stacks and disclosed.volumes must be lists of names'
    ],
    [
      { verb: 'sweep', disclosed: { stacks: 'a', volumes: [] } },
      'disclosed.stacks and disclosed.volumes must be lists of names'
    ],
    [
      { verb: 'sweep', disclosed: { stacks: [''], volumes: [] } },
      'disclosed.stacks and disclosed.volumes must be lists of names'
    ],
    [
      { verb: 'sweep', disclosed: { stacks: [], volumes: [7] } },
      'disclosed.stacks and disclosed.volumes must be lists of names'
    ]
  ])('refuses a malformed disclosure %j as BAD_REQUEST', async (raw, message) => {
    const parsed = parseActRequest(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toBe(message)
    const { deps, calls } = fakeDeps(available(wholeMachine()))
    const res = await runContainersAction(raw, 'operator', deps)
    expect(res).toMatchObject({ ok: false, error: 'BAD_REQUEST' })
    expect(deps.scan).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
