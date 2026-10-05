// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePrStackStore } from '../src/renderer/src/stores/pr-stack'
import type { PrStackSnapshot } from '../src/main/pr-stack-core'

const REPO = '/home/u/repo'

function snapshot(): PrStackSnapshot {
  return {
    repoPath: REPO,
    defaultBranch: 'main',
    graph: { defaultBranch: 'main', nodes: [], chains: [] },
    placements: [
      { id: '412', x: 0, y: 58 },
      { id: '418', x: 304, y: 58 }
    ],
    edges: [],
    worktrees: [],
    kpis: { open: 2, chains: 2, readyToMerge: 0, needsRetarget: 0, stagingTips: 2 },
    world: { width: 608, height: 224 },
    shape: 'shape-1',
    fetchedAt: 1_700_000_000_000,
    ghAvailable: true,
    ghFailure: null,
    behind: {}
  }
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: { prStackLoad: vi.fn(async () => snapshot()) }
    })
  )
})

describe('position overrides', () => {
  /**
   * REGRESSION (QA 2026-08-03): dragging a card wrote to localStorage but moved
   * nothing on screen. `currentRepo` was a plain `let`, so the `overrides`
   * computed evaluated once while it was still null, short-circuited before
   * ever reading `overridesByRepo`, and ended up with ZERO reactive
   * dependencies — permanently frozen at `{}`. These assertions read through
   * the reactive path on purpose; asserting on localStorage alone would have
   * passed while the feature was dead.
   */
  it('reflects a moved card in the reactive placements, not only on disk', async () => {
    const store = usePrStackStore()

    // The ORDER is the whole test. A component renders and reads the computed
    // BEFORE the first load resolves, so the first evaluation happens with no
    // repo open. That is the pass where the old code short-circuited and lost
    // its reactive dependency for good.
    expect(store.movedCount).toBe(0)
    expect(store.placements).toEqual([])

    await store.load(REPO)
    expect(store.movedCount).toBe(0)

    store.moveNode('412', 999, 42)

    expect(store.movedCount).toBe(1)
    expect(store.placements.find((p) => p.id === '412')).toEqual({ id: '412', x: 999, y: 42 })
    // An untouched card keeps flowing with the computed layout.
    expect(store.placements.find((p) => p.id === '418')).toEqual({ id: '418', x: 304, y: 58 })
  })

  it('does not touch localStorage per frame, and commits at the end of the drag', async () => {
    const store = usePrStackStore()
    expect(store.movedCount).toBe(0) // read before load, as a component would
    await store.load(REPO)

    store.moveNode('412', 10, 20)
    expect(localStorage.getItem('om2tab.prStack.overrides')).toBe(null)

    store.commitMove()
    const saved = JSON.parse(localStorage.getItem('om2tab.prStack.overrides') as string)
    expect(saved[REPO]['412']).toEqual({ x: 10, y: 20 })
  })

  it('restores a saved arrangement on the next session', async () => {
    localStorage.setItem(
      'om2tab.prStack.overrides',
      JSON.stringify({ [REPO]: { '418': { x: 7, y: 7 } } })
    )
    setActivePinia(createPinia())
    const store = usePrStackStore()
    expect(store.movedCount).toBe(0) // read before load, as a component would
    await store.load(REPO)

    expect(store.movedCount).toBe(1)
    expect(store.placements.find((p) => p.id === '418')).toEqual({ id: '418', x: 7, y: 7 })
  })

  it('drops an override whose PR is no longer on the board', async () => {
    localStorage.setItem(
      'om2tab.prStack.overrides',
      JSON.stringify({ [REPO]: { '412': { x: 1, y: 1 }, '999': { x: 2, y: 2 } } })
    )
    setActivePinia(createPinia())
    const store = usePrStackStore()
    expect(store.movedCount).toBe(0) // read before load, as a component would
    await store.load(REPO)

    expect(store.movedCount).toBe(1)
    expect(Object.keys(store.overrides)).toEqual(['412'])
  })

  it('relayout returns every card to the computed layout', async () => {
    const store = usePrStackStore()
    expect(store.movedCount).toBe(0) // read before load, as a component would
    await store.load(REPO)
    store.moveNode('412', 999, 42)
    store.commitMove()

    store.relayout()

    expect(store.movedCount).toBe(0)
    expect(store.placements.find((p) => p.id === '412')).toEqual({ id: '412', x: 0, y: 58 })
  })

  it('keeps each repo arrangement separate', async () => {
    const store = usePrStackStore()
    await store.load(REPO)
    store.moveNode('412', 999, 42)
    store.commitMove()

    await store.load('/home/u/other')
    expect(store.movedCount).toBe(0)

    await store.load(REPO)
    expect(store.movedCount).toBe(1)
  })
})

describe('focusPr', () => {
  const VIEW = { width: 1000, height: 600 }

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('centres the card and rings it, keeping the current zoom', async () => {
    const store = usePrStackStore()
    store.setViewport(VIEW.width, VIEW.height)
    await store.load(REPO)
    store.scale = 1

    store.focusPr(418, REPO)

    expect(store.pendingFocus).toBeNull()
    expect(store.highlightedId).toBe('418')
    expect(store.scale).toBe(1)
    // card 418 sits at world (304, 58); full-LOD card is 272x101.
    expect(store.panX).toBe(VIEW.width / 2 - (304 + 272 / 2))
    expect(store.panY).toBe(VIEW.height / 2 - (58 + 101 / 2))
  })

  it('clears the ring after about two seconds', async () => {
    const store = usePrStackStore()
    store.setViewport(VIEW.width, VIEW.height)
    await store.load(REPO)

    store.focusPr(412, REPO)
    expect(store.highlightedId).toBe('412')
    vi.advanceTimersByTime(1_900)
    expect(store.highlightedId).toBe('412')
    vi.advanceTimersByTime(200)
    expect(store.highlightedId).toBeNull()
  })

  it('moves the ring on a second focus instead of stacking two', async () => {
    const store = usePrStackStore()
    store.setViewport(VIEW.width, VIEW.height)
    await store.load(REPO)

    store.focusPr(412, REPO)
    vi.advanceTimersByTime(1_500)
    store.focusPr(418, REPO)
    vi.advanceTimersByTime(1_000)
    // The first timer would have fired by now; it must not clear the second ring.
    expect(store.highlightedId).toBe('418')
    vi.advanceTimersByTime(1_100)
    expect(store.highlightedId).toBeNull()
  })

  it('waits for the snapshot when asked before it lands, then focuses', async () => {
    const store = usePrStackStore()
    store.setViewport(VIEW.width, VIEW.height)

    store.focusPr(418, REPO)
    expect(store.pendingFocus).toBe(418)
    expect(store.highlightedId).toBeNull()

    await store.load(REPO)

    expect(store.pendingFocus).toBeNull()
    expect(store.highlightedId).toBe('418')
  })

  it('waits for the viewport to be measured', async () => {
    const store = usePrStackStore()
    await store.load(REPO)

    store.focusPr(418, REPO)
    expect(store.pendingFocus).toBe(418)

    store.setViewport(VIEW.width, VIEW.height)
    expect(store.pendingFocus).toBeNull()
    expect(store.highlightedId).toBe('418')
  })

  it('does not satisfy a request for repo B from repo A snapshot', async () => {
    const store = usePrStackStore()
    store.setViewport(VIEW.width, VIEW.height)
    await store.load(REPO)

    store.focusPr(418, '/home/u/other')

    expect(store.highlightedId).toBeNull()
    expect(store.pendingFocus).toBe(418)
  })

  it('gives up when a load lands without the PR, rather than waiting forever', async () => {
    const store = usePrStackStore()
    store.setViewport(VIEW.width, VIEW.height)
    store.focusPr(999, REPO)

    await store.load(REPO)

    expect(store.pendingFocus).toBeNull()
    expect(store.highlightedId).toBeNull()
  })

  it('drops a request nobody picked up after its time-to-live', async () => {
    const store = usePrStackStore()
    store.setViewport(VIEW.width, VIEW.height)
    store.focusPr(418, REPO)
    vi.advanceTimersByTime(20_000)

    await store.load(REPO)

    expect(store.highlightedId).toBeNull()
    expect(store.pendingFocus).toBeNull()
  })
})

describe('holdsOpenPr', () => {
  it('is true only for an open PR in the snapshot held for that same repo', async () => {
    const store = usePrStackStore()
    const snap = snapshot()
    snap.graph.nodes = [
      { pr: { number: 412, state: 'OPEN' } },
      { pr: { number: 418, state: 'MERGED' } }
    ] as unknown as typeof snap.graph.nodes
    ;(window.api as unknown as { prStackLoad: () => Promise<PrStackSnapshot> }).prStackLoad =
      async () => snap
    await store.load(REPO)

    expect(store.holdsOpenPr(REPO, 412)).toBe(true)
    expect(store.holdsOpenPr(REPO, 418)).toBe(false)
    expect(store.holdsOpenPr(REPO, 7)).toBe(false)
    expect(store.holdsOpenPr('/home/u/other', 412)).toBe(false)
  })
})

describe('ensurePrefs', () => {
  it('reads once and caches; a failed read leaves the opt-ins unknown (off)', async () => {
    const store = usePrStackStore()
    const read = vi.fn(async () => ({ openPrLinksInCanvas: true }))
    ;(window.api as unknown as Record<string, unknown>).prStackPrefs = read
    expect(await store.ensurePrefs()).toMatchObject({ openPrLinksInCanvas: true })
    await store.ensurePrefs()
    expect(read).toHaveBeenCalledTimes(1)

    setActivePinia(createPinia())
    const fresh = usePrStackStore()
    ;(window.api as unknown as Record<string, unknown>).prStackPrefs = vi.fn(async () => {
      throw new Error('boom')
    })
    expect(await fresh.ensurePrefs()).toBeNull()
  })
})

describe('refresh failure (BUG-148)', () => {
  const load = (
    store: ReturnType<typeof usePrStackStore>,
    next: PrStackSnapshot
  ): Promise<void> => {
    window.api.prStackLoad = vi.fn(async () => next)
    return store.load(REPO)
  }

  it('keeps the previous snapshot on a transient failure and does not advance fetchedAt', async () => {
    const store = usePrStackStore()
    await store.load(REPO)
    const good = store.snapshot

    await load(store, {
      ...snapshot(),
      placements: [],
      shape: 'empty',
      fetchedAt: 1_800_000_000_000,
      ghFailure: 'timeout'
    })

    expect(store.snapshot).toBe(good)
    expect(store.snapshot?.fetchedAt).toBe(1_700_000_000_000)
    expect(store.snapshot?.placements).toHaveLength(2)
    expect(store.refreshFailure).toBe('timeout')
  })

  it('keeps the previous snapshot when the IPC call itself rejects', async () => {
    const store = usePrStackStore()
    await store.load(REPO)
    const good = store.snapshot
    window.api.prStackLoad = vi.fn(async () => {
      throw new Error('ipc down')
    })
    await store.load(REPO)

    expect(store.snapshot).toBe(good)
    expect(store.error).toBe('ipc down')
    expect(store.refreshFailure).toBe('other')
  })

  it('stores the failed snapshot when there is nothing to keep, so the empty state can offer retry', async () => {
    const store = usePrStackStore()
    await load(store, { ...snapshot(), placements: [], ghFailure: 'timeout' })

    expect(store.snapshot?.ghFailure).toBe('timeout')
    expect(store.refreshFailure).toBe('timeout')
  })

  it('clears the failure on the next good refresh and takes the new snapshot', async () => {
    const store = usePrStackStore()
    await store.load(REPO)
    await load(store, { ...snapshot(), ghFailure: 'network' })
    expect(store.refreshFailure).toBe('network')

    await load(store, { ...snapshot(), fetchedAt: 1_900_000_000_000 })

    expect(store.refreshFailure).toBeNull()
    expect(store.snapshot?.fetchedAt).toBe(1_900_000_000_000)
  })

  it('a genuinely unavailable gh replaces the snapshot and is not a refresh failure', async () => {
    const store = usePrStackStore()
    await store.load(REPO)
    await load(store, { ...snapshot(), placements: [], ghAvailable: false })

    expect(store.snapshot?.ghAvailable).toBe(false)
    expect(store.refreshFailure).toBeNull()
  })
})
