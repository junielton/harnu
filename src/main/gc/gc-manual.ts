// Manual cleaning as a background job (design: workspace-gc §4, operator decision "manual
// clean is a background job"). `submitManualClean` acknowledges at once with a job id; the
// work runs on the shared serial queue, so it never overlaps an autopilot cycle or another
// click, and it streams one progress event per requested id.
//
// This is the only caller of the forced ops. The operator's per-id `confirmed` entries, bound
// to the facts they were shown (`expected`), are what let a review worktree or an orphan volume through; the autopilot (gc-cycle.ts) has no way to
// reach either, and in-use items, main checkouts and neverClean paths are refused here
// against the current prefs before any op runs.

import type { WorktreeBundle } from './bundle-core'
import { refusalFor, rememberReprobeRefusal } from './autopilot-core'
import { bundleChangedSince, volumeChangedSince } from './gc-confirm'
import type { CycleState } from './gc-cycle'
import type { JobQueue } from './gc-jobs-core'
import type { GcPrefs } from './gc-prefs'
import { volumeItemId, type OrphanVolumeItem } from './gc-housekeeping-input'
import type { HousekeepingResult, HousekeepingVolume } from './housekeeping-core'
import { leftBehind, type Leftover } from './gc-leftovers'
import { runBatch, type GcItemResult, type GcOps } from './pipeline-core'
import type { GcCleanAck, GcCleanOptions } from './gc-wire'

const VOLUME_PREFIX = volumeItemId('')

export interface ManualCleanDeps {
  /** Read fresh: `neverClean` may have changed since the snapshot the operator clicked on. */
  prefs(): GcPrefs
  /** A fresh gather: refusals and the orphan-volume plan are judged on this, not on the click's snapshot. */
  gather(): Promise<{
    bundles: WorktreeBundle[]
    orphanVolumes: OrphanVolumeItem[]
    housekeeping?: { volumes: HousekeepingVolume[] }
  }>
  /** `forced` ops archive before anything destructive and waive the review-only guards. */
  opsFor(actor: 'operator', forced: boolean): GcOps
  /**
   * The orphan volumes according to a gather that STARTS now. The job's own gather may predate
   * the click (a gather in flight is shared), so the check right before `docker volume rm`
   * uses this one: a project folder that reappeared, or a container that took the volume,
   * since then keeps it.
   */
  freshOrphans(): Promise<OrphanVolumeItem[]>
  /** `docker volume rm` for exactly these names. */
  removeOrphanVolumes(names: string[]): Promise<HousekeepingResult>
  /** What a cleaned worktree leaves in Docker, so its volumes can be offered for review. */
  rememberLeftovers?(entries: Leftover[]): void
  queue: JobQueue
  state: CycleState
  now(): number
}

const refused = (id: string, error: string): GcItemResult => ({
  id,
  ok: false,
  haltedAt: 'reprobe',
  error,
  freedBytes: 0
})

export function submitManualClean(
  deps: ManualCleanDeps,
  ids: readonly string[],
  opts: GcCleanOptions
): GcCleanAck {
  const unique = [...new Set(ids)]
  // Only an id the operator named confirms itself; there is no blanket flag.
  const confirmed = new Set(opts.confirmed ?? [])
  const expected = opts.expected ?? {}
  const queued = deps.queue.busy()

  const { jobId } = deps.queue.submit('manual', unique, async (reporter) => {
    const prefs = deps.prefs()
    const gathered = await deps.gather()
    const bundles = new Map(gathered.bundles.map((b) => [b.item.id, b]))
    const orphans = new Map(gathered.orphanVolumes.map((o) => [o.id, o]))
    const results: GcItemResult[] = []

    const cleanBundle = async (id: string): Promise<GcItemResult> => {
      const b = bundles.get(id)
      if (!b) return refused(id, 'unknown-item')
      // The hard refusals come first and no confirmation lifts them.
      const hard = refusalFor(b, prefs, { confirmed: true })
      if (hard) return refused(id, hard)
      // The operator confirmed what they were shown, not whatever is there now.
      const seen = expected[id]
      if (!seen) return refused(id, 'missing-expected')
      if (bundleChangedSince(b, seen)) return refused(id, 'changed-since-confirm')
      // Anything that is not a proven ready item needs its OWN confirmation, and then takes
      // the forced ops.
      const forced = b.bucket !== 'ready'
      if (forced && !confirmed.has(id)) return refused(id, 'needs-confirmation')
      const batchOpts: { removeVolumes: boolean; confirmReview?: boolean } = {
        // D1: worktree cleanup never removes a volume, ready or reviewed, bulk or single. What
        // it leaves behind comes back as an orphan-volume review item.
        removeVolumes: false,
        // S2's own gate: set ONLY for an item the operator confirmed by id (checked above),
        // never by the autopilot.
        confirmReview: forced
      }
      const [result] = await runBatch([b], deps.opsFor('operator', forced), batchOpts)
      if (result!.ok) {
        deps.rememberLeftovers?.(leftBehind(b, gathered.housekeeping?.volumes ?? []))
      }
      return result!
    }

    const cleanVolume = async (id: string): Promise<GcItemResult> => {
      if (!confirmed.has(id)) return refused(id, 'needs-confirmation')
      const seen = expected[id]
      if (!seen) return refused(id, 'missing-expected')
      const item = orphans.get(id)
      // The plan was recomputed just now: a volume a container or a live folder claimed since
      // the click is no longer an orphan, and is left alone.
      if (!item) return refused(id, 'no-longer-orphan')
      if (volumeChangedSince(item, seen)) return refused(id, 'changed-since-confirm')
      // Right before the removal, look again: with a fresh existence check of the project
      // folder and the containers that reference the volume. Failing to look is a refusal.
      let fresh: OrphanVolumeItem | undefined
      try {
        fresh = (await deps.freshOrphans()).find((o) => o.id === id)
      } catch (err) {
        return refused(id, `probe-failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!fresh) return refused(id, 'no-longer-orphan')
      if (volumeChangedSince(fresh, seen)) return refused(id, 'changed-since-confirm')
      const r = await deps.removeOrphanVolumes([item.name])
      if (r.errors.length > 0) {
        return {
          id,
          ok: false,
          haltedAt: 'rm-volumes',
          error: r.errors.join('; '),
          freedBytes: 0
        }
      }
      // `docker volume rm` prints no size, so the size the operator saw is what was freed.
      return { id, ok: true, haltedAt: null, freedBytes: item.sizeBytes ?? 0 }
    }

    for (const id of unique) {
      reporter.onStart(id)
      const result = id.startsWith(VOLUME_PREFIX) ? await cleanVolume(id) : await cleanBundle(id)
      results.push(result)
      if (result.ok) deps.state.failures.delete(id)
      else if (result.haltedAt === 'reprobe') {
        // The engine's own refusals (a locked worktree, an unknown tip) are remembered; the
        // click-time ones (a stale confirm, a missing confirmation) are not facts about the item.
        rememberReprobeRefusal(
          deps.state.failures,
          result,
          deps.now(),
          bundles.get(id)?.localTip ?? null
        )
      } else if (result.haltedAt !== null) {
        deps.state.failures.set(id, {
          step: result.haltedAt,
          error: result.error ?? 'failed',
          at: deps.now()
        })
        console.warn('[gc] cleanup halted', id, result.haltedAt, result.error)
      }
      reporter.onItem(result)
    }
    return results
  })
  return { jobId, queued }
}
