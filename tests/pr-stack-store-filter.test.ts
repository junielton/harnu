// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { usePrStackStore } from '../src/renderer/src/stores/pr-stack'
import {
  buildGraph,
  graphEdges,
  kpis,
  layoutGraph,
  type PrEntry,
  type PrStackSnapshot
} from '../src/main/pr-stack-core'

const REPO_A = '/home/u/repo-a'
const REPO_B = '/home/u/repo-b'

function pr(over: Partial<PrEntry> & { number: number }): PrEntry {
  return {
    title: `PR ${over.number}`,
    branch: `feat/${over.number}`,
    base: 'main',
    state: 'OPEN',
    isDraft: false,
    mergeable: true,
    reviewDecision: null,
    ci: 'passing',
    checks: [],
    url: '',
    author: 'alice',
    updatedAt: null,
    headOid: null,
    nodeId: null,
    mergeStateStatus: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewRequests: [],
    labels: [],
    autoMergeRequest: null,
    unresolvedThreads: null,
    outdatedThreads: null,
    threadsTruncated: false,
    ...over
  }
}

/** 1 ◄ 2 ◄ 3 on main, plus a lone approved 4. Only 3 and 4 are by bob. */
function snapshot(repoPath: string): PrStackSnapshot {
  const graph = buildGraph(
    [
      pr({ number: 1, reviewDecision: 'APPROVED' }),
      pr({ number: 2, base: 'feat/1' }),
      pr({ number: 3, base: 'feat/2', author: 'bob' }),
      pr({ number: 4, author: 'bob', reviewDecision: 'APPROVED' })
    ],
    'main'
  )
  const laid = layoutGraph(graph)
  return {
    repoPath,
    defaultBranch: 'main',
    graph,
    placements: laid.placements,
    edges: graphEdges(graph),
    worktrees: [],
    kpis: kpis(graph),
    world: { width: laid.width, height: laid.height },
    shape: 'shape-1',
    fetchedAt: 1_700_000_000_000,
    ghAvailable: true,
    behind: {}
  }
}

async function open(repo = REPO_A) {
  const store = usePrStackStore()
  await store.load(repo)
  return store
}

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: { prStackLoad: vi.fn(async (repo: string) => snapshot(repo)) }
    })
  )
})

describe('filter state', () => {
  it('is inactive until a term is typed, and then counts matches', async () => {
    const store = await open()
    expect(store.filterActive).toBe(false)
    expect(store.matchedNumbers).toBeNull()
    store.setFilterQuery('author:bob')
    expect(store.filterActive).toBe(true)
    expect([...(store.matchedNumbers ?? [])].sort()).toEqual([3, 4])
    expect(store.matchCount).toBe(2)
    expect(store.totalCount).toBe(4)
  })

  it('applies the term still being typed as well as the committed chips', async () => {
    const store = await open()
    store.setFilterQuery('author:bob')
    store.setFilterDraft('review:approved')
    expect([...(store.matchedNumbers ?? [])]).toEqual([4])
    expect(store.filterQuery).toBe('author:bob review:approved')
  })

  it('is kept per repo', async () => {
    const store = await open(REPO_A)
    store.setFilterQuery('is:tip')
    store.setFilterMode('hide')
    await store.load(REPO_B)
    expect(store.filter).toEqual({ query: '', draft: '', mode: 'dim' })
    await store.load(REPO_A)
    expect(store.filter).toMatchObject({ query: 'is:tip', mode: 'hide' })
  })

  it('is session-only: nothing about the filter reaches localStorage', async () => {
    const store = await open()
    const set = vi.spyOn(Storage.prototype, 'setItem')
    store.setFilterQuery('is:tip')
    store.setFilterDraft('x')
    store.setFilterMode('hide')
    store.toggleKpiPreset('ready')
    store.clearFilter()
    expect(set).not.toHaveBeenCalled()
    expect(Object.keys(localStorage)).toEqual([])
  })

  it('survives a background refresh', async () => {
    const store = await open()
    store.setFilterQuery('author:bob')
    await store.load(REPO_A)
    expect(store.filter.query).toBe('author:bob')
    expect(store.matchCount).toBe(2)
  })

  it('clearFilter empties the chips and the draft but keeps the mode', async () => {
    const store = await open()
    store.setFilterQuery('is:tip')
    store.setFilterDraft('foo')
    store.setFilterMode('hide')
    store.clearFilter()
    expect(store.filter).toEqual({ query: '', draft: '', mode: 'hide' })
    expect(store.filterActive).toBe(false)
  })
})

describe('KPI presets', () => {
  it('applies the preset query, and clicking it again clears it', async () => {
    const store = await open()
    store.toggleKpiPreset('ready')
    expect(store.filterQuery).toBe('is:merge-next')
    store.toggleKpiPreset('ready')
    expect(store.filterQuery).toBe('')
  })

  it('replaces whatever was there, and discards a half-typed term', async () => {
    const store = await open()
    store.setFilterQuery('author:bob')
    store.setFilterDraft('foo')
    store.toggleKpiPreset('threads')
    expect(store.filterQuery).toBe('threads:unresolved')
  })

  it('is not "active" once the query is more than the preset', async () => {
    const store = await open()
    store.setFilterQuery('is:merge-next author:bob')
    store.toggleKpiPreset('ready')
    expect(store.filterQuery).toBe('is:merge-next')
  })
})

describe('modes', () => {
  it('Dim keeps the full layout and edges', async () => {
    const store = await open()
    store.setFilterQuery('author:bob')
    expect(store.dimActive).toBe(true)
    expect(store.hideActive).toBe(false)
    expect(store.visiblePlacements).toEqual(store.placements)
    expect(store.visibleEdges).toEqual(store.snapshot?.edges)
    expect(store.ghosts).toEqual([])
  })

  it('Dim with zero matches stays fully dimmed and reads 0 of M', async () => {
    const store = await open()
    store.setFilterQuery('author:nobody')
    expect(store.dimActive).toBe(true)
    expect(store.matchCount).toBe(0)
    expect(store.totalCount).toBe(4)
    expect(store.visiblePlacements).toHaveLength(4)
  })

  it('Hide re-lays out the matches only, with a ghost for the skipped chain', async () => {
    const store = await open()
    store.setFilterQuery('author:bob')
    store.setFilterMode('hide')
    expect(store.hideActive).toBe(true)
    expect(store.visiblePlacements.map((p) => p.id).sort()).toEqual(['3', '4'])
    expect(store.ghosts).toHaveLength(1)
    expect(store.ghosts[0]).toMatchObject({ hidden: [1, 2], matches: [3] })
  })

  it('Hide ignores operator overrides, and turning it off restores them', async () => {
    const store = await open()
    store.moveNode('4', 999, 888)
    store.setFilterQuery('author:bob')
    store.setFilterMode('hide')
    const hidden4 = store.visiblePlacements.find((p) => p.id === '4')
    expect(hidden4).toBeDefined()
    expect(hidden4).not.toMatchObject({ x: 999, y: 888 })
    store.setFilterMode('dim')
    expect(store.visiblePlacements.find((p) => p.id === '4')).toMatchObject({ x: 999, y: 888 })
    expect(store.overrides['4']).toEqual({ x: 999, y: 888 })
  })

  it('Hide fits its own world, not the full one', async () => {
    const store = await open()
    const full = store.activeWorld
    store.setFilterQuery('review:approved is:merge-next')
    store.setFilterMode('hide')
    expect(store.activeWorld.height).toBeLessThanOrEqual(full.height)
  })

  it('revealChain adds chain:#N and drops back to Dim', async () => {
    const store = await open()
    store.setFilterQuery('author:bob')
    store.setFilterMode('hide')
    store.revealChain(3)
    expect(store.filter.mode).toBe('dim')
    expect(store.filterQuery).toBe('author:bob chain:#3')
    expect(store.hideActive).toBe(false)
  })
})
