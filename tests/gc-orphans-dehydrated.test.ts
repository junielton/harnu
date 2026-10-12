import { describe, it, expect } from 'vitest'
import { AS_GIVEN, buildBundles, type BuildBundlesInput } from '../src/main/gc/bundle-core'
import type { HydrationInfo, ReapItem } from '../src/main/reaper/reaper-core'
import { HEAD, NOW, OTHER, REPO, WT, collect, pr, scanInput } from './gc-scan-fixtures'

/**
 * AC-D4 (unit D): a dehydrated worktree is still judged by its branch fate, exactly like a
 * hydrated one. Dehydration only removes gitignored dependency directories; it must never move
 * the verdict, so a merged skeleton reaches Ready after grace and a closed-unmerged one reads
 * its ordinary review reason, never a silent "nothing to do".
 */

const dehydrated: HydrationInfo = {
  state: 'dehydrated',
  removable: [],
  skipped: [],
  reclaimableBytes: null,
  canRehydrate: true,
  rehydrateChanged: []
}

function bundlesFor(hydrated: boolean, input = scanInput(), over: Partial<BuildBundlesInput> = {}) {
  const { items, fateInputs } = collect(input)
  const withHydration: ReapItem[] = items.map((i) => ({
    ...i,
    hydration: hydrated ? null : dehydrated,
    diskBytes: hydrated ? 900_000_000 : 6_000_000
  }))
  return buildBundles({
    items: withHydration,
    fateInputs,
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions: new Map(),
    keep: new Set(),
    neverClean: new Set(),
    now: NOW,
    graceDays: 2,
    volumes: new Map(),
    knownFolders: [],
    protectedProjects: new Set(),
    canonical: AS_GIVEN,
    foreignCheckouts: new Map(withHydration.map((i) => [i.id, []])),
    ...over
  })
}

const feature = (bs: ReturnType<typeof bundlesFor>) => bs.find((b) => b.item.path === WT)!

describe('a dehydrated worktree is judged by branch fate (AC-D4)', () => {
  it('a merged one moves to ready after grace exactly like a hydrated one', () => {
    const hydrated = feature(bundlesFor(true))
    const skeleton = feature(bundlesFor(false))
    expect(hydrated.bucket).toBe('ready')
    expect(skeleton.bucket).toBe('ready')
    expect(skeleton.reason).toEqual(hydrated.reason)
    expect(skeleton.item.hydration?.state).toBe('dehydrated')
  })

  it('stays inside its grace window like a hydrated one (in use, not review)', () => {
    const young = feature(bundlesFor(false, scanInput(), { graceDays: 30 }))
    expect(young.bucket).toBe('in-use')
    expect(feature(bundlesFor(true, scanInput(), { graceDays: 30 })).bucket).toBe('in-use')
  })

  it('a closed-unmerged one reads its ordinary review reason, same as hydrated', () => {
    const input = scanInput({
      prByBranch: new Map([
        ['feat/slug', { ...pr(HEAD), state: 'CLOSED' as const, mergedAt: null }]
      ])
    })
    // A closed PR carries no merge time, so the last sign of life comes from an old session.
    const over = {
      sessions: new Map([
        [WT, { presence: 'none' as const, lastActivityAt: NOW - 10 * 86_400_000 }]
      ])
    }
    const hydrated = feature(bundlesFor(true, input, over))
    const skeleton = feature(bundlesFor(false, input, over))
    expect(skeleton.bucket).toBe('review')
    expect(skeleton.reason?.code).toBe('closed-unmerged')
    expect(skeleton.reason).toEqual(hydrated.reason)
  })

  it('a weak merge signal is still a review item, not ready, when dehydrated', () => {
    const input = scanInput({
      prByBranch: new Map([['feat/slug', pr(OTHER)]])
    })
    const skeleton = feature(bundlesFor(false, input))
    expect(skeleton.bucket).toBe('review')
    expect(skeleton.reason?.code).toBe('weak-merge-signal')
  })

  it('the main checkout stays out of every bucket it was never in', () => {
    const main = bundlesFor(false).find((b) => b.item.path === REPO)
    // The scan lists no bundle for the main checkout, dehydrated or not.
    expect(main?.bucket ?? 'in-use').toBe('in-use')
  })
})
