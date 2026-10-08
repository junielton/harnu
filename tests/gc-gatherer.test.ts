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
