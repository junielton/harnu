/**
 * The gather's persistence, and the agent seam over it (design: workspace-gc §6, §10).
 *
 * `gc-ipc` wires the real I/O in; every decision about what a gather WRITES lives here, with no
 * electron import, so a test can run it with spies.
 *
 *  - {@link Gatherer.gather}: the timer's and the operator's gather. It feeds the Containers
 *    view, caches the result, clears outdated Keep and release marks and prunes the leftovers
 *    file. One at a time.
 *  - {@link Gatherer.peek}: a read-only gather for an agent's `list_cleanup`. It persists
 *    nothing, feeds nothing and caches nothing, so an observe read can never write.
 */

import { applyFailures, pruneFailures } from './autopilot-core'
import type { CycleState } from './gc-cycle'
import { pruneLeftovers, toDirMap, type LeftoverFile } from './gc-leftovers'
import { withReleased, withoutReleased, type GcPrefs, type ReleasedFrom } from './gc-prefs'
import { withoutStaleKeeps } from './gc-keep'
import type { GcAgentService } from './gc-service-registry'
import type { GcGathered } from './gc-scan-shell'
import type { GcSnapshot } from './gc-wire'

export interface GathererDeps {
  prefs: () => GcPrefs
  /** Replaces the live prefs and writes them. */
  persistPrefs: (next: GcPrefs) => Promise<unknown>
  gatherGc: (
    prefs: GcPrefs,
    now: number,
    remembered: ReadonlyMap<string, readonly string[]>
  ) => Promise<GcGathered>
  state: CycleState
  leftovers: { get: () => LeftoverFile; set: (next: LeftoverFile) => void }
  /**
   * Ids a gather that began at `startedAt` must not clear a Keep for: marks written since it
   * began, and marks still provisional. Absent protects none.
   */
  protectedKeeps?: (startedAt: number) => ReadonlySet<string>
  /** Hands the bundles' buckets to the Containers view. */
  feed: (g: GcGathered) => void
  now: () => number
}

export interface Gatherer {
  gather(): Promise<GcGathered>
  /** A gather that STARTS after this call: waits for the one in flight, which may predate it. */
  fresh(): Promise<GcGathered>
  peek(): Promise<GcGathered>
  /** The last persisting gather, or null before the first one. */
  cached(): GcGathered | null
}

export function createGatherer(deps: GathererDeps): Gatherer {
  let cache: GcGathered | null = null
  let gathering: Promise<GcGathered> | null = null
  let peeking: Promise<GcGathered> | null = null

  /** The raw gather with the failure overlay on top: a halted item reads Needs review. */
  const read = async (persisting: boolean): Promise<GcGathered> => {
    const now = deps.now()
    const g = await deps.gatherGc(deps.prefs(), now, toDirMap(deps.leftovers.get()))
    // Pruning forgets failure notes for bundles it cannot see, so only a persisting gather does.
    if (persisting) pruneFailures(deps.state.failures, g.bundles, now)
    return { ...g, bundles: applyFailures(g.bundles, deps.state.failures) }
  }

  const self: Gatherer = {
    cached: () => cache,
    fresh: async () => {
      if (gathering) await gathering.catch(() => undefined)
      return self.gather()
    },
    gather: () => {
      gathering ??= (async () => {
        try {
          // Which release marks this gather judged: a release made while it ran is a newer
          // mark, and must survive the verdict on the one it replaced (as a Keep does).
          const startedAt = deps.now()
          const judgedReleases = { ...deps.prefs().released }
          const g = await read(true)
          // A project with no volume left in Docker has nothing to review. Only judged when
          // docker answered: an outage says nothing about what exists.
          if (g.dockerAvailable) {
            const current = deps.leftovers.get()
            const pruned = pruneLeftovers(current, g.housekeeping.volumes)
            if (Object.keys(pruned.projects).length !== Object.keys(current.projects).length) {
              deps.leftovers.set(pruned)
            }
          }
          cache = g
          deps.feed(g)
          if (g.staleKeeps.length > 0)
            await deps.persistPrefs(
              withoutStaleKeeps(deps.prefs(), g.staleKeeps, deps.protectedKeeps?.(startedAt))
            )
          const staleReleases = g.staleReleases.filter(
            (id) => deps.prefs().released[id] === judgedReleases[id]
          )
          if (staleReleases.length > 0) {
            await deps.persistPrefs(withoutReleased(deps.prefs(), staleReleases))
          }
          return g
        } finally {
          gathering = null
        }
      })()
      return gathering
    },
    peek: () => {
      peeking ??= read(false).finally(() => {
        peeking = null
      })
      return peeking
    }
  }
  return self
}

export interface AgentServiceDeps {
  gatherer: Gatherer
  snapshotOf: (g: GcGathered) => GcSnapshot
  prefs: () => GcPrefs
  persistPrefs: (next: GcPrefs) => Promise<unknown>
}

/**
 * What an agent may do with the GC: read the current picture and mark a bundle released.
 * Reading serves the last gather; with none yet it takes one read-only gather. Nothing here
 * cleans, keeps or edits settings.
 */
export function createAgentService(deps: AgentServiceDeps): GcAgentService {
  return {
    snapshot: async () => deps.snapshotOf(deps.gatherer.cached() ?? (await deps.gatherer.peek())),
    release: async (bundleId: string, atMs: number, from: ReleasedFrom) => {
      await deps.persistPrefs(withReleased(deps.prefs(), bundleId, atMs, from))
      // The release changes the bucket, so refresh what the Cleanup surface reads.
      void deps.gatherer
        .gather()
        .catch((err) => console.error('[gc] refresh after release failed', err))
    }
  }
}
