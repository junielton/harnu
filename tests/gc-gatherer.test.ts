import { describe, it, expect, vi } from 'vitest'
import { createGatherer, createAgentService } from '../src/main/gc/gc-gatherer'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { LeftoverFile } from '../src/main/gc/gc-leftovers'
import type { GcGathered } from '../src/main/gc/gc-scan-shell'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import { NOW, WT_READY, bundle } from './gc-snapshot-fixtures'

/**
 * T445 delta 2 — the gather's persistence, and the agent seam over it.
 *
 * `gc-ipc` wires these to electron; everything that decides what a gather WRITES lives here,
 * where it can run with spies. The contract: a persisting gather (timer, operator) clears
 * outdated Keep/release marks and prunes the leftovers file; a read-only one (an agent's
 * `list_cleanup`) writes nothing at all.
 */

function gathered(over: Partial<GcGathered> = {}): GcGathered {
  return {
    bundles: [bundle(WT_READY)],
    housekeeping: { volumes: [{ name: 'v1', project: 'proj' }], containers: [] },
    dockerAvailable: true,
    scannedAt: NOW,
    orphanVolumes: [],
    staleKeeps: [],
    staleReleases: [],
    ...over
  } as unknown as GcGathered
}

interface Spies {
  persistPrefs: ReturnType<typeof vi.fn>
  setLeftovers: ReturnType<typeof vi.fn>
  feed: ReturnType<typeof vi.fn>
  gatherGc: ReturnType<typeof vi.fn>
  prefs: GcPrefs
  leftovers: LeftoverFile
  state: ReturnType<typeof createCycleState>
}

function setup(g: GcGathered, prefs: GcPrefs = defaultGcPrefs()) {
  const spies: Spies = {
    persistPrefs: vi.fn(async (next: GcPrefs) => {
      spies.prefs = next
    }),
    setLeftovers: vi.fn((next: LeftoverFile) => {
      spies.leftovers = next
    }),
    feed: vi.fn(),
    gatherGc: vi.fn(async () => g),
    prefs,
    leftovers: { version: 1, projects: { gone: ['/srv/ws/x'], proj: ['/srv/ws/y'] } },
    state: createCycleState()
  }
  const gatherer = createGatherer({
    prefs: () => spies.prefs,
    persistPrefs: spies.persistPrefs,
    gatherGc: spies.gatherGc,
    state: spies.state,
    leftovers: { get: () => spies.leftovers, set: spies.setLeftovers },
    feed: spies.feed,
    now: () => NOW
  })
  return { spies, gatherer }
}

describe('createGatherer: a persisting gather (T445 delta 2)', () => {
  it('I1: stale Keep marks and stale release marks are persisted away', async () => {
    const prefs = {
      ...defaultGcPrefs(),
      keep: { a: 'merged', b: 'merged' },
      released: { r1: 1, r2: 2 },
      releasedFrom: { r1: { repoPath: '/x', path: '/y', localTip: 't' } }
    }
    const { spies, gatherer } = setup(
      gathered({ staleKeeps: [{ id: 'a', marked: 'merged' }], staleReleases: ['r1'] }),
      prefs
    )
    await gatherer.gather()
    expect(spies.persistPrefs).toHaveBeenCalledTimes(2)
    expect(spies.prefs.keep).toEqual({ b: 'merged' })
    expect(spies.prefs.released).toEqual({ r2: 2 })
    expect(spies.prefs.releasedFrom).toEqual({})
  })

  it('S3: a Keep pressed while the gather ran survives that gather’s verdict on the old one', async () => {
    const prefs = { ...defaultGcPrefs(), keep: { a: 'merged' } }
    const { spies, gatherer } = setup(
      gathered({ staleKeeps: [{ id: 'a', marked: 'merged' }] }),
      prefs
    )
    // The operator presses Keep again, now against a newer fate, while the gather is running.
    spies.gatherGc.mockImplementation(async () => {
      spies.prefs = { ...spies.prefs, keep: { a: 'open' } }
      return gathered({ staleKeeps: [{ id: 'a', marked: 'merged' }] })
    })
    await gatherer.gather()
    expect(spies.prefs.keep).toEqual({ a: 'open' })
  })

  it('S3 delta 4: a provisional Keep is protected from the gather’s verdict', async () => {
    const prefs = { ...defaultGcPrefs(), keep: { a: 'merged', b: 'merged' } }
    const spies = setup(
      gathered({
        staleKeeps: [
          { id: 'a', marked: 'merged' },
          { id: 'b', marked: 'merged' }
        ]
      }),
      prefs
    )
    const gatherer = createGatherer({
      prefs: () => spies.spies.prefs,
      persistPrefs: spies.spies.persistPrefs,
      gatherGc: spies.spies.gatherGc,
      state: spies.spies.state,
      leftovers: { get: () => spies.spies.leftovers, set: spies.spies.setLeftovers },
      feed: spies.spies.feed,
      protectedKeeps: () => new Set(['a']),
      now: () => NOW
    })
    await gatherer.gather()
    expect(spies.spies.prefs.keep).toEqual({ a: 'merged' })
  })

  it('a release made while the gather ran survives that gather’s verdict on the old one', async () => {
    const prefs = {
      ...defaultGcPrefs(),
      released: { r1: 1 },
      releasedFrom: { r1: { repoPath: '/x', path: '/y', localTip: 'old' } }
    }
    const { spies, gatherer } = setup(gathered({ staleReleases: ['r1'] }), prefs)
    // The agent releases the worktree again, at its new tip, while the gather is running.
    spies.gatherGc.mockImplementation(async () => {
      spies.prefs = {
        ...spies.prefs,
        released: { r1: 2 },
        releasedFrom: { r1: { repoPath: '/x', path: '/y', localTip: 'new' } }
      }
      return gathered({ staleReleases: ['r1'] })
    })
    await gatherer.gather()
    expect(spies.prefs.released).toEqual({ r1: 2 })
    expect(spies.prefs.releasedFrom.r1!.localTip).toBe('new')
  })

  it('S3: fresh() waits for the gather in flight and then starts its own', async () => {
    const { spies, gatherer } = setup(gathered())
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    spies.gatherGc.mockImplementationOnce(async () => {
      await gate
      return gathered()
    })
    const first = gatherer.gather()
    const fresh = gatherer.fresh()
    expect(spies.gatherGc).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, fresh])
    expect(spies.gatherGc).toHaveBeenCalledTimes(2)
  })

  it('S3: fresh() with nothing in flight just gathers', async () => {
    const { spies, gatherer } = setup(gathered())
    await gatherer.fresh()
    expect(spies.gatherGc).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when no mark is stale', async () => {
    const { spies, gatherer } = setup(gathered())
    await gatherer.gather()
    expect(spies.persistPrefs).not.toHaveBeenCalled()
  })

  it('prunes the leftovers of a project Docker no longer has, only when docker answered', async () => {
    const a = setup(gathered())
    await a.gatherer.gather()
    expect(a.spies.setLeftovers).toHaveBeenCalledTimes(1)
    expect(Object.keys(a.spies.leftovers.projects)).toEqual(['proj'])

    const b = setup(gathered({ dockerAvailable: false } as Partial<GcGathered>))
    await b.gatherer.gather()
    expect(b.spies.setLeftovers).not.toHaveBeenCalled()
  })

  it('applies the failures before it caches and feeds anything (delta 1, item 4)', async () => {
    const b = bundle(WT_READY)
    const { spies, gatherer } = setup(gathered({ bundles: [b] }))
    spies.state.failures.set(b.item.id, { step: 'stack', error: 'boom', at: NOW })
    await gatherer.gather()
    const fed = spies.feed.mock.calls[0]![0] as GcGathered
    expect(fed.bundles[0]!.bucket).toBe('review')
    expect(gatherer.cached()!.bundles[0]!.bucket).toBe('review')
    expect(gatherer.cached()!.bundles[0]!.reason?.code).toBe('cleanup-failed')
  })

  it('drops the failure note of a bundle it cannot see (a persisting gather prunes)', async () => {
    const { spies, gatherer } = setup(gathered())
    spies.state.failures.set('vanished', { step: 'deps', error: 'x', at: NOW })
    await gatherer.gather()
    expect(spies.state.failures.has('vanished')).toBe(false)
  })

  it('feeds the Containers view and caches the result', async () => {
    const g = gathered()
    const { spies, gatherer } = setup(g)
    expect(gatherer.cached()).toBeNull()
    await gatherer.gather()
    expect(spies.feed).toHaveBeenCalledTimes(1)
    expect(gatherer.cached()).not.toBeNull()
  })

  it('is single-flight: two overlapping calls share one gather', async () => {
    const { spies, gatherer } = setup(gathered())
    await Promise.all([gatherer.gather(), gatherer.gather()])
    expect(spies.gatherGc).toHaveBeenCalledTimes(1)
  })

  it('passes the remembered leftover folders to the gather', async () => {
    const { spies, gatherer } = setup(gathered())
    await gatherer.gather()
    const remembered = spies.gatherGc.mock.calls[0]![2] as Map<string, string[]>
    expect(remembered.get('proj')).toEqual(['/srv/ws/y'])
  })
})

describe('createGatherer: a read-only gather writes nothing (T445 delta 2, 5)', () => {
  it('persists no prefs, writes no leftovers, feeds nothing, caches nothing', async () => {
    const prefs = { ...defaultGcPrefs(), keep: { a: 'merged' }, released: { r1: 1 } }
    const { spies, gatherer } = setup(
      gathered({ staleKeeps: [{ id: 'a', marked: 'merged' }], staleReleases: ['r1'] }),
      prefs
    )
    const g = await gatherer.peek()
    expect(g.bundles).toHaveLength(1)
    expect(spies.persistPrefs).not.toHaveBeenCalled()
    expect(spies.setLeftovers).not.toHaveBeenCalled()
    expect(spies.feed).not.toHaveBeenCalled()
    expect(gatherer.cached()).toBeNull()
  })

  it('still applies the failure overlay, without pruning the in-memory failure notes', async () => {
    const b = bundle(WT_READY)
    const { spies, gatherer } = setup(gathered({ bundles: [b] }))
    spies.state.failures.set(b.item.id, { step: 'stack', error: 'boom', at: NOW })
    spies.state.failures.set('some-other-bundle', { step: 'deps', error: 'x', at: NOW })
    const g = await gatherer.peek()
    expect(g.bundles[0]!.bucket).toBe('review')
    expect(g.bundles[0]!.reason?.code).toBe('cleanup-failed')
    // A persisting gather would drop the note of a bundle it cannot see; a peek leaves it.
    expect(spies.state.failures.has('some-other-bundle')).toBe(true)
  })

  it('is single-flight too', async () => {
    const { spies, gatherer } = setup(gathered())
    await Promise.all([gatherer.peek(), gatherer.peek()])
    expect(spies.gatherGc).toHaveBeenCalledTimes(1)
  })
})

describe('createAgentService (T445 delta 2)', () => {
  const snapshotOf = (g: GcGathered): GcSnapshot =>
    ({ scannedAt: g.scannedAt, bundles: g.bundles }) as unknown as GcSnapshot

  function agent(g: GcGathered) {
    const { spies, gatherer } = setup(g)
    const svc = createAgentService({
      gatherer,
      snapshotOf,
      prefs: () => spies.prefs,
      persistPrefs: spies.persistPrefs
    })
    return { spies, gatherer, svc }
  }

  it('serves the cached snapshot without gathering again', async () => {
    const { spies, gatherer, svc } = agent(gathered())
    await gatherer.gather()
    spies.gatherGc.mockClear()
    const snap = await svc.snapshot()
    expect(snap.scannedAt).toBe(NOW)
    expect(spies.gatherGc).not.toHaveBeenCalled()
  })

  it('with no cache yet it peeks: one gather, zero prefs and leftover writes', async () => {
    const { spies, svc } = agent(
      gathered({ staleKeeps: [{ id: 'a', marked: 'merged' }], staleReleases: ['r1'] })
    )
    await svc.snapshot()
    expect(spies.gatherGc).toHaveBeenCalledTimes(1)
    expect(spies.persistPrefs).not.toHaveBeenCalled()
    expect(spies.setLeftovers).not.toHaveBeenCalled()
  })

  it('I2: release persists the mark with its time and where it was, and nothing else', async () => {
    const { spies, svc } = agent(gathered())
    const from = { repoPath: '/srv/ws/r', path: '/srv/ws/r/wt', localTip: 'abc' }
    await svc.release('bundle-1', 1234, from)
    expect(spies.persistPrefs).toHaveBeenCalledTimes(1)
    expect(spies.prefs.released).toEqual({ 'bundle-1': 1234 })
    expect(spies.prefs.releasedFrom).toEqual({ 'bundle-1': from })
  })

  it('release leaves the other marks and Keep untouched', async () => {
    const { spies, svc } = agent(gathered())
    spies.prefs = { ...defaultGcPrefs(), keep: { k: 'merged' }, released: { old: 1 } }
    await svc.release('new', 2, { repoPath: '/r', path: '/r/w', localTip: 't' })
    expect(spies.prefs.keep).toEqual({ k: 'merged' })
    expect(spies.prefs.released).toEqual({ old: 1, new: 2 })
  })

  it('exposes no way to clean, keep or change prefs', () => {
    const { svc } = agent(gathered())
    expect(Object.keys(svc).sort()).toEqual(['release', 'snapshot'])
  })
})

describe('createGatherer: a halted item whose folder is gone stays visible (F0 delta 1, item 1)', () => {
  // `cleanItem` trashes the folder before prune and branch-delete. If it halts there the
  // folder is gone but git still holds a registration and a branch: the item must keep its
  // note and keep reading "Cleanup stopped at …", gather after gather.
  const halted = (): GcGathered => {
    const b = bundle(WT_READY, { bucket: 'review' })
    return gathered({ bundles: [b], goneItemIds: [b.item.id] } as Partial<GcGathered>)
  }

  it('asks the gather to keep the ids that have a failure note', async () => {
    const g = halted()
    const { spies, gatherer } = setup(g)
    spies.state.failures.set(g.bundles[0]!.item.id, { step: 'prune', error: 'locked', at: NOW })
    await gatherer.gather()
    const keep = spies.gatherGc.mock.calls[0]![3] as ReadonlySet<string>
    expect([...keep]).toEqual([g.bundles[0]!.item.id])
  })

  it.each(['prune', 'branch-delete'])(
    'a halt at %s reads cleanup-failed on every gather',
    async (step) => {
      const g = halted()
      const id = g.bundles[0]!.item.id
      const { spies, gatherer } = setup(g)
      spies.state.failures.set(id, { step, error: 'fatal: Unable to create index.lock', at: NOW })
      for (let i = 0; i < 3; i++) {
        const out = await gatherer.gather()
        expect(out.bundles).toHaveLength(1)
        expect(out.bundles[0]).toMatchObject({
          bucket: 'review',
          reason: { code: 'cleanup-failed' }
        })
        expect(spies.state.failures.has(id)).toBe(true)
      }
    }
  )
})

describe('createGatherer: a gather that began before a job ended is stale (F0 delta 1, item 2)', () => {
  const withIds = (...ids: string[]): GcGathered =>
    gathered({ bundles: ids.map((id) => bundle(`/srv/ws/${id}`)) })
  const idsOf = (g: GcGathered): string[] => g.bundles.map((b) => b.item.path as string)

  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('a gather asked for after invalidate() never returns the one already in flight', async () => {
    const { spies, gatherer } = setup(withIds('old'))
    const first = deferred<GcGathered>()
    spies.gatherGc.mockImplementationOnce(() => first.promise)
    spies.gatherGc.mockImplementation(async () => withIds('fresh'))

    const stale = gatherer.gather() // began before the job's trash
    gatherer.invalidate() // the job ended
    const after = gatherer.gather()
    first.resolve(withIds('cleaned-worktree'))

    expect(idsOf(await after)).toEqual(['/srv/ws/fresh'])
    await stale
    // The stale answer was not kept: neither cached nor fed to the Containers view.
    expect(idsOf(gatherer.cached()!)).toEqual(['/srv/ws/fresh'])
    expect(spies.feed).toHaveBeenCalledTimes(1)
  })

  it('without invalidate() a second caller still shares the gather in flight', async () => {
    const { spies, gatherer } = setup(withIds('a'))
    const first = deferred<GcGathered>()
    spies.gatherGc.mockImplementationOnce(() => first.promise)
    const one = gatherer.gather()
    const two = gatherer.gather()
    first.resolve(withIds('a'))
    await Promise.all([one, two])
    expect(spies.gatherGc).toHaveBeenCalledTimes(1)
  })

  it('callers asked for after invalidate() share one fresh gather', async () => {
    const { spies, gatherer } = setup(withIds('a'))
    const first = deferred<GcGathered>()
    spies.gatherGc.mockImplementationOnce(() => first.promise)
    spies.gatherGc.mockImplementation(async () => withIds('fresh'))
    const stale = gatherer.gather()
    gatherer.invalidate()
    const x = gatherer.gather()
    const y = gatherer.gather()
    first.resolve(withIds('a'))
    await Promise.all([stale, x, y])
    expect(spies.gatherGc).toHaveBeenCalledTimes(2)
  })
})

describe('createGatherer: a stale gather does not prune failure notes (F0 delta 3, A)', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }
  const note = { step: 'branch-delete', error: 'locked', at: NOW }

  it('a note recorded while a gather ran, then invalidate(), survives that gather', async () => {
    // The gather began before the trash, so it does not list the halted item.
    const { spies, gatherer } = setup(gathered({ bundles: [] }))
    const first = deferred<GcGathered>()
    spies.gatherGc.mockImplementationOnce(() => first.promise)
    const inFlight = gatherer.gather()
    spies.state.failures.set('X', note) // the job halts after the trash
    gatherer.invalidate() // the job ends
    first.resolve(gathered({ bundles: [] }))
    await inFlight
    expect(spies.state.failures.has('X')).toBe(true)
  })

  it('a note recorded while a gather ran survives it even without an invalidate', async () => {
    const { spies, gatherer } = setup(gathered({ bundles: [] }))
    const first = deferred<GcGathered>()
    spies.gatherGc.mockImplementationOnce(() => first.promise)
    const inFlight = gatherer.gather()
    spies.state.failures.set('X', note)
    first.resolve(gathered({ bundles: [] }))
    await inFlight
    expect(spies.state.failures.has('X')).toBe(true)
  })

  it('a note that existed when the gather began is still pruned when its bundle is gone', async () => {
    const { spies, gatherer } = setup(gathered({ bundles: [] }))
    spies.state.failures.set('old', note)
    await gatherer.gather()
    expect(spies.state.failures.has('old')).toBe(false)
  })

  it('a note replaced while the gather ran is not pruned either', async () => {
    const { spies, gatherer } = setup(gathered({ bundles: [] }))
    const first = deferred<GcGathered>()
    spies.state.failures.set('X', note)
    spies.gatherGc.mockImplementationOnce(() => first.promise)
    const inFlight = gatherer.gather()
    spies.state.failures.set('X', { ...note, at: NOW + 1 }) // a newer halt of the same item
    first.resolve(gathered({ bundles: [] }))
    await inFlight
    expect(spies.state.failures.get('X')?.at).toBe(NOW + 1)
  })
})
