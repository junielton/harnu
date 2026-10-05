import { describe, it, expect, vi } from 'vitest'
import {
  parseActRequest,
  runContainersAction,
  type ActionDeps,
  type DockerBatchResult
} from '../src/main/containers/containers-actions'
import type {
  ContainersSnapshot,
  StackRow,
  Tombstone,
  VolumeRow
} from '../src/main/containers/containers-wire'
import { NOW, available, stackRow } from './containers-fixtures'

/**
 * T342 — the clean-up selection, main's half.
 *
 * The operator can untick a stack, so the request gained `only`. It is a
 * NARROWING and nothing else: main still derives the eligible set from its own
 * tier table (T340) and merely intersects it with what was ticked. A selection
 * can take a stack out of the sweep; no selection can put one in. `only` is also
 * kept apart from `disclosed` on purpose — `only` decides the targets,
 * `disclosed` is the promise main checks them against (BUG-137), and a field
 * that did both would let the assertion steer the outcome.
 */

type DockerOp = 'stop' | 'start' | 'removeContainers' | 'removeVolumes'

function fakeDeps(snap: ContainersSnapshot): {
  deps: ActionDeps
  calls: Array<[DockerOp, string[]]>
  tombstones: Tombstone[]
} {
  const calls: Array<[DockerOp, string[]]> = []
  const tombstones: Tombstone[] = []
  const op =
    (name: DockerOp) =>
    async (ids: string[]): Promise<DockerBatchResult> => {
      calls.push([name, ids])
      return { done: ids, error: null }
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

function vol(name: string, over: Partial<VolumeRow> = {}): VolumeRow {
  return { name, sizeBytes: 100, shared: false, ...over }
}

async function sweep(
  stacks: StackRow[],
  req: Record<string, unknown>
): Promise<{
  swept: string[]
  volumesRemoved: string[]
  error: string | null
  ok: boolean
  scanned: boolean
  tombstones: Tombstone[]
}> {
  const { deps, calls, tombstones } = fakeDeps(available(stacks))
  const res = await runContainersAction({ verb: 'sweep', ...req }, 'operator', deps)
  return {
    swept: res.results.map((r) => r.stack),
    volumesRemoved: calls.filter(([op]) => op === 'removeVolumes').flatMap(([, ids]) => ids),
    error: res.error ?? null,
    ok: res.ok,
    scanned: (deps.scan as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    tombstones
  }
}

describe('T342 AC-1: `only` narrows the sweep, and can only ever narrow it', () => {
  it('sweeps just the ticked stacks out of the eligible set', async () => {
    const r = await sweep(wholeMachine(), { only: ['z-off', 'o-run'] })
    expect(r.swept).toEqual(['z-off', 'o-run'])
    expect(r.ok).toBe(true)
  })

  it('keeps snapshot order, whatever order the selection arrived in', async () => {
    const r = await sweep(wholeMachine(), { only: ['o-off', 'z-run'] })
    expect(r.swept).toEqual(['z-run', 'o-off'])
  })

  it('cannot add a stack the tier table refuses: the id is simply ignored', async () => {
    const r = await sweep(wholeMachine(), { only: ['active', 'protected', 'pending', 'unknown'] })
    // Nothing eligible was ticked, so nothing is swept — and nothing is refused
    // per stack either: `only` never turns an ineligible stack into a target.
    expect(r.swept).toEqual([])
    expect(r.tombstones).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('ignores an ineligible id sitting next to a ticked one', async () => {
    const r = await sweep(wholeMachine(), { only: ['active', 'z-run'] })
    expect(r.swept).toEqual(['z-run'])
  })

  it('ignores an id no scan knows', async () => {
    const r = await sweep(wholeMachine(), { only: ['no-such-stack', 'z-run'] })
    expect(r.swept).toEqual(['z-run'])
  })

  it('absent `only` sweeps the whole eligible set, exactly as before', async () => {
    const r = await sweep(wholeMachine(), {})
    expect(r.swept).toEqual(['z-run', 'z-off', 'o-run', 'o-off'])
    expect(r.ok).toBe(true)
  })

  it('an empty selection is refused BAD_REQUEST, before any scan or docker call', async () => {
    const r = await sweep(wholeMachine(), { only: [] })
    expect(r.error).toBe('BAD_REQUEST')
    expect(r.swept).toEqual([])
    expect(r.scanned).toBe(false)
    expect(r.volumesRemoved).toEqual([])
  })
})

describe('T342 AC-1: `parseActRequest` validates `only` like every other id list', () => {
  it('carries it on the parsed request only when one was sent', () => {
    expect(parseActRequest({ verb: 'sweep' })).toEqual({
      ok: true,
      req: { verb: 'sweep', removeVolumes: false }
    })
    expect(parseActRequest({ verb: 'sweep', only: ['a', 'b'] })).toEqual({
      ok: true,
      req: { verb: 'sweep', removeVolumes: false, only: ['a', 'b'] }
    })
  })

  it('takes `only` alongside a disclosure without merging the two', () => {
    const parsed = parseActRequest({
      verb: 'sweep',
      only: ['a'],
      disclosed: { stacks: ['a'], volumes: ['a_data'] }
    })
    expect(parsed).toEqual({
      ok: true,
      req: {
        verb: 'sweep',
        removeVolumes: false,
        only: ['a'],
        disclosed: { stacks: ['a'], volumes: ['a_data'] }
      }
    })
  })

  it.each([
    [{ verb: 'sweep', only: [] }, 'only must be a non-empty list of stack ids'],
    [{ verb: 'sweep', only: 'a' }, 'only must be a non-empty list of stack ids'],
    [{ verb: 'sweep', only: ['a', ''] }, 'only must be a non-empty list of stack ids'],
    [{ verb: 'sweep', only: ['a', 7] }, 'only must be a non-empty list of stack ids'],
    [
      { verb: 'sweep', only: Array.from({ length: 501 }, (_, i) => `s-${i}`) },
      'only must be a non-empty list of stack ids'
    ]
  ])('refuses %j', (raw, message) => {
    const parsed = parseActRequest(raw)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.verb).toBe('sweep')
      expect(parsed.message).toBe(message)
    }
  })

  it('still refuses a stack list, selection or not', () => {
    const parsed = parseActRequest({ verb: 'sweep', only: ['a'], stacks: ['a'] })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok)
      expect(parsed.message).toBe('sweep picks its own targets; it takes no stack list')
  })
})

describe('T342 AC-2: the disclosure is checked against the NARROWED set', () => {
  it('refuses a disclosure that lists a stack the selection left out', async () => {
    const r = await sweep(wholeMachine(), {
      only: ['z-run'],
      disclosed: { stacks: ['z-run', 'z-off', 'o-run', 'o-off'], volumes: [] }
    })
    expect(r.error).toBe('SWEEP_SET_CHANGED')
    expect(r.swept).toEqual([])
    expect(r.tombstones).toEqual([])
  })

  it('sweeps when the disclosure matches the selection', async () => {
    const r = await sweep(wholeMachine(), {
      only: ['z-run', 'o-off'],
      disclosed: { stacks: ['o-off', 'z-run'], volumes: [] }
    })
    expect(r.swept).toEqual(['z-run', 'o-off'])
    expect(r.error).toBeNull()
    expect(r.ok).toBe(true)
  })
})

describe('T342 AC-2: an unticked eligible stack is a survivor for the volume rule', () => {
  const sharedPair = (): StackRow[] => [
    stackRow({ id: 'z-1', verdict: 'zombie', volumes: [vol('both', { shared: true })] }),
    stackRow({ id: 'z-2', verdict: 'zombie', volumes: [vol('both', { shared: true })] })
  ]

  it('keeps a volume the unticked stack still mounts, and says so in the result', async () => {
    const { deps, calls } = fakeDeps(available(sharedPair()))
    const res = await runContainersAction(
      {
        verb: 'sweep',
        removeVolumes: true,
        only: ['z-1'],
        disclosed: { stacks: ['z-1'], volumes: [] }
      },
      'operator',
      deps
    )
    expect(res.ok).toBe(true)
    expect(calls.some(([op]) => op === 'removeVolumes')).toBe(false)
    expect(res.results.map((r) => r.keptVolumes)).toEqual([['both']])
  })

  it('takes it once both owners are ticked', async () => {
    const r = await sweep(sharedPair(), {
      removeVolumes: true,
      only: ['z-1', 'z-2'],
      disclosed: { stacks: ['z-1', 'z-2'], volumes: ['both'] }
    })
    expect(r.volumesRemoved).toEqual(['both'])
    expect(r.ok).toBe(true)
  })

  it('refuses a disclosure that offers a volume the selection turned into a survivor', async () => {
    // The renderer and main must agree about this, or the operator is stuck in a
    // refusal loop (BUG-139). If they ever drift, this is the shape it takes.
    const r = await sweep(sharedPair(), {
      removeVolumes: true,
      only: ['z-1'],
      disclosed: { stacks: ['z-1'], volumes: ['both'] }
    })
    expect(r.error).toBe('SWEEP_SET_CHANGED')
    expect(r.volumesRemoved).toEqual([])
  })

  it("still takes a ticked stack's own non-shared volume", async () => {
    const r = await sweep(
      [
        stackRow({ id: 'z-1', verdict: 'zombie', volumes: [vol('z1_data')] }),
        stackRow({ id: 'z-2', verdict: 'zombie', volumes: [vol('z2_data')] })
      ],
      {
        removeVolumes: true,
        only: ['z-1'],
        disclosed: { stacks: ['z-1'], volumes: ['z1_data'] }
      }
    )
    expect(r.volumesRemoved).toEqual(['z1_data'])
    expect(r.ok).toBe(true)
  })
})
