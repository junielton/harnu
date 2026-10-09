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
import { refusalFor } from './autopilot-core'
import { bundleChangedSince, volumeChangedSince } from './gc-confirm'
import type { CycleState } from './gc-cycle'
import type { JobQueue } from './gc-jobs-core'
import type { GcPrefs } from './gc-prefs'
import { volumeItemId, type OrphanVolumeItem } from './gc-housekeeping-input'
import type { HousekeepingResult, HousekeepingVolume } from './housekeeping-core'
import { leftBehind, type Leftover } from './gc-leftovers'
import { WORK_STAMP_UNKNOWN } from './gc-work-stamp'
import { runBatch, WORK_CHANGED, type GcItemResult, type GcOps } from './pipeline-core'
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
  /**
   * A fresh fingerprint of the uncommitted work in a worktree (null when none); throws when it
   * cannot be read. The force path compares it with the one the dialog was built from.
   */
  workStampOf(path: string): Promise<string | null>
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
      // A ready item whose cleanup halted is shown as `cleanup-failed` review (`retryAs`), but its
      // facts still say ready: its Retry takes the same guarded path the autopilot did, with the
      // dirty and unpushed guards and `branch -d`, not the operator's force path.
      const retryAsReady = b.bucket === 'review' && b.retryAs === 'ready'
      const forced = b.bucket !== 'ready' && !retryAsReady
      if (forced && !confirmed.has(id)) return refused(id, 'needs-confirmation')
      // The force path waives the dirty guard, so it re-reads the uncommitted work and halts when it
      // is not what the dialog showed: a file edited since then would otherwise go to the trash
      // unseen. The tip is already compared above and again by the reprobe.
      const path = b.item.path
      // The scan could not read this worktree's work, so there is nothing to compare against.
      if (forced && path && seen.workStamp === WORK_STAMP_UNKNOWN) {
        return refused(id, 'work-unreadable')
      }
      if (forced && path) {
        let live: string | null
        try {
          live = await deps.workStampOf(path)
        } catch (err) {
          return refused(id, `probe-failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        if ((seen.workStamp ?? null) !== live) return refused(id, WORK_CHANGED)
      }
      const batchOpts: { removeVolumes: boolean; confirmReview?: boolean } = {
        // D1: worktree cleanup never removes a volume, ready or reviewed, bulk or single. What
        // it leaves behind comes back as an orphan-volume review item.
        removeVolumes: false,
        // S2's own gate: set ONLY for an item the operator confirmed by id (checked above),
        // never by the autopilot.
        confirmReview: forced
      }
      // The pipeline only runs ready bundles (or a confirmed review one): a retried item runs as
      // the ready item it still is.
      const runnable: WorktreeBundle = retryAsReady ? { ...b, bucket: 'ready', reason: null } : b
      const ops = deps.opsFor('operator', forced)
      // The same check again at each recheck (before the deps are dropped and before the git
      // cleanup): the docker steps and the deletion take time, and an edit made meanwhile
      // must stop the removal, not be archived and trashed unseen.
      const guarded: GcOps =
        forced && path
          ? {
              ...ops,
              recheck: async (x) => {
                const r = await ops.recheck(x)
                if (!r.ok) return r
                try {
                  return (seen.workStamp ?? null) === (await deps.workStampOf(path))
                    ? r
                    : { ok: false, reason: WORK_CHANGED }
                } catch {
                  return { ok: false, reason: 'probe-failed' }
                }
              }
            }
          : ops
      const [result] = await runBatch([runnable], guarded, batchOpts)
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
