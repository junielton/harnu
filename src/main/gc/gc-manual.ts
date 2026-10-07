// Manual cleaning as a background job (design: workspace-gc §4, operator decision "manual
// clean is a background job"). `submitManualClean` acknowledges at once with a job id; the
// work runs on the shared serial queue, so it never overlaps an autopilot cycle or another
// click, and it streams one progress event per requested id.
//
// This is the only caller of the forced ops. The operator's `confirmDecide` is what lets a
// Decide worktree or an orphan volume through; the autopilot (gc-cycle.ts) has no way to
// reach either, and Alive items, main checkouts and neverClean paths are refused here
// against the current prefs before any op runs.

import type { WorktreeBundle } from './bundle-core'
import { refusalFor } from './autopilot-core'
import type { CycleState } from './gc-cycle'
import type { JobQueue } from './gc-jobs-core'
import type { GcPrefs } from './gc-prefs'
import { volumeItemId, type OrphanVolumeItem } from './gc-housekeeping-input'
import type { HousekeepingResult } from './housekeeping-core'
import { runBatch, type GcItemResult, type GcOps } from './pipeline-core'
import type { GcCleanAck, GcCleanOptions } from './gc-wire'

const VOLUME_PREFIX = volumeItemId('')

export interface ManualCleanDeps {
  /** Read fresh: `neverClean` may have changed since the snapshot the operator clicked on. */
  prefs(): GcPrefs
  /** A fresh gather: refusals and the orphan-volume plan are judged on this, not on the click's snapshot. */
  gather(): Promise<{ bundles: WorktreeBundle[]; orphanVolumes: OrphanVolumeItem[] }>
  /** `forced` ops archive before anything destructive and waive the Decide-only guards. */
  opsFor(actor: 'operator', forced: boolean): GcOps
  /** `docker volume rm` for exactly these names. */
  removeOrphanVolumes(names: string[]): Promise<HousekeepingResult>
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
  const confirmDecide = opts.confirmDecide === true
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
      const refusal = refusalFor(b, prefs, { confirmDecide })
      if (refusal) return refused(id, refusal)
      // Anything that is not a proven corpse got here only through the operator's
      // confirmation, and takes the forced ops.
      const forced = b.bucket !== 'corpse'
      const batchOpts: { removeVolumes: boolean; confirmDecide?: boolean } = {
        removeVolumes: prefs.removeVolumes,
        confirmDecide: forced
      }
      const [result] = await runBatch([b], deps.opsFor('operator', forced), batchOpts)
      return result!
    }

    const cleanVolume = async (id: string): Promise<GcItemResult> => {
      if (!confirmDecide) return refused(id, 'needs-confirmation')
      const item = orphans.get(id)
      // The plan was recomputed just now: a volume a container or a live folder claimed since
      // the click is no longer an orphan, and is left alone.
      if (!item) return refused(id, 'no-longer-orphan')
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
      return { id, ok: true, haltedAt: null, freedBytes: r.volumeBytes }
    }

    for (const id of unique) {
      reporter.onStart(id)
      const result = id.startsWith(VOLUME_PREFIX) ? await cleanVolume(id) : await cleanBundle(id)
      results.push(result)
      if (result.ok) deps.state.failures.delete(id)
      else if (result.haltedAt !== 'reprobe' && result.haltedAt !== null) {
        deps.state.failures.set(id, {
          step: result.haltedAt,
          error: result.error ?? 'failed',
          at: deps.now()
        })
      }
      reporter.onItem(result)
    }
    return results
  })
  return { jobId, queued }
}
