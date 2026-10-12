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
import { WORK_STAMP_UNKNOWN } from './gc-work-stamp'
import {
  refusalOf as pipelineRefusal,
  runBatch,
  WORK_CHANGED,
  type GcItemResult,
  type GcOps
} from './pipeline-core'
import type { PrepResult } from './gc-guided'
import type { GcCleanAck, GcCleanOptions, GcPrep } from './gc-wire'

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
   * A gather that STARTS now, for the facts a guided action's prep just changed (the lock, the
   * session, the stack). Required, with `prepare`, for any id that carries a prep.
   */
  gatherFresh?(): Promise<{ bundles: WorktreeBundle[] }>
  /** The one preparatory step of a guided "…and remove" (see gc-guided.ts `prepareClean`). */
  /** Whether a worktree folder is still on disk; used to tell a halt that left it from one that trashed it. */
  folderExists?(path: string): Promise<boolean>
  prepare?(prep: GcPrep, b: WorktreeBundle, opts?: { dry?: boolean }): Promise<PrepResult>
  /**
   * The read-only reprobe of the ordinary ops on `b` (carrying `assume`): what the remove would say if
   * the prep's cause were already fixed. `forced` selects the review path's view of the item.
   */
  dryReprobe?(
    b: WorktreeBundle,
    forced: boolean
  ): Promise<{ ok: true } | { ok: false; reason: string }>
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

/** The steps after the folder is trashed: once one of these halts, the folder is gone. */
const POST_TRASH: ReadonlySet<string> = new Set(['prune', 'branch-delete', 'detach'])

/** The order the steps run in: reversible ones first, the one that cannot be undone (a parked session) last. */
const STEP_ORDER: Record<GcPrep['kind'], number> = {
  unlock: 0,
  'stop-stack': 1,
  'leave-stack': 1,
  'close-session': 2
}

/** What was asked for one id, as a list in running order. */
function prepsOf(raw: GcPrep | GcPrep[] | undefined): GcPrep[] {
  if (raw === undefined) return []
  return (Array.isArray(raw) ? [...raw] : [raw]).sort(
    (x, y) => STEP_ORDER[x.kind] - STEP_ORDER[y.kind]
  )
}

/** The bundle as the dry run judges it: every step's own cause is taken as fixed, nothing else is. */
function assumeFor(preps: readonly GcPrep[], b: WorktreeBundle): WorktreeBundle {
  let out: WorktreeBundle = b
  for (const prep of preps) {
    switch (prep.kind) {
      case 'unlock':
        out = { ...out, assume: { ...out.assume, unlock: true } }
        break
      case 'close-session':
        out = { ...out, assume: { ...out.assume, closeSession: true } }
        break
      case 'stop-stack':
        out = {
          ...out,
          assume: {
            ...out.assume,
            stoppedStacks: [...(out.assume?.stoppedStacks ?? []), ...prep.stackIds]
          }
        }
        break
      case 'leave-stack':
        out = {
          ...out,
          sharedStackIds: out.sharedStackIds.filter((x) => !prep.stackIds.includes(x))
        }
        break
    }
  }
  return out
}

/**
 * The fresh bundle once the steps ran. The lock and the session are really gone (the reprobe checks them
 * for real now); stopped stacks stay listed, with stopped containers, and a left stack is simply no
 * longer counted against the worktree.
 */
function afterPrep(preps: readonly GcPrep[], again: WorktreeBundle): WorktreeBundle {
  let out: WorktreeBundle = again
  for (const prep of preps) {
    if (prep.kind === 'stop-stack') {
      out = {
        ...out,
        assume: { stoppedStacks: [...(out.assume?.stoppedStacks ?? []), ...prep.stackIds] }
      }
    } else if (prep.kind === 'leave-stack') {
      out = { ...out, sharedStackIds: out.sharedStackIds.filter((x) => !prep.stackIds.includes(x)) }
    }
  }
  return out
}

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
      let b = bundles.get(id)
      if (!b) return refused(id, 'unknown-item')
      // The hard refusals come first and no confirmation lifts them.
      const hard = refusalFor(b, prefs, { confirmed: true })
      if (hard) return refused(id, hard)
      // The operator confirmed what they were shown, not whatever is there now.
      const seen = expected[id]
      if (!seen) return refused(id, 'missing-expected')
      if (bundleChangedSince(b, seen)) return refused(id, 'changed-since-confirm')
      const retryOf = (x: WorktreeBundle): boolean => x.bucket === 'review' && x.retryAs === 'ready'
      /**
       * The force path waives the dirty guard, so it re-reads the uncommitted work and halts when it
       * is not what the dialog showed: a file edited since then would otherwise go to the trash
       * unseen. The scan could not read it at all (`unknown`): nothing to compare against.
       */
      const workRefusal = async (x: WorktreeBundle, forcedNow: boolean): Promise<string | null> => {
        const where = x.item.path
        if (!forcedNow || !where) return null
        if (seen.workStamp === WORK_STAMP_UNKNOWN) return 'work-unreadable'
        let live: string | null
        try {
          live = await deps.workStampOf(where)
        } catch (err) {
          return `probe-failed: ${err instanceof Error ? err.message : String(err)}`
        }
        return (seen.workStamp ?? null) !== live ? WORK_CHANGED : null
      }

      // A guided action's one preparatory step ("Unlock and remove", "Close session and remove", ...).
      // The step is the LAST thing standing between the item and a successful remove: every other
      // guard is judged first, as a dry run that treats the step's own cause as already fixed, and the
      // step runs only when nothing else refuses. What it changed is put back if the remove then fails.
      const preps = prepsOf(opts.prepare?.[id])
      /** What each step that ran can do to put itself back (and clear its journal entry), in running order. */
      const ran: Array<{
        undo: (() => Promise<void>) | null
        settle: (() => Promise<void>) | null
      }> = []
      /** Puts back what ran, in reverse; the error text gains what could not be put back. */
      const rollBack = async (error: string | undefined): Promise<string | undefined> => {
        const failures: string[] = []
        for (const step of ran.splice(0).reverse()) {
          try {
            if (step.undo) await step.undo()
            else await step.settle?.()
          } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err))
          }
        }
        if (failures.length === 0) return error
        const e = error ?? 'failed'
        return `${e}${e.includes(':') ? '; ' : ': '}rollback-failed (${failures.join('; ')})`
      }
      /** Ends the item as `r`, first putting back what the prep steps changed (when they still can be). */
      const bail = async (r: GcItemResult): Promise<GcItemResult> => {
        if (ran.length === 0) return r
        const error = await rollBack(r.error)
        return error === r.error ? r : { ...r, error }
      }
      /** The item ended without needing the undo: clear the journal. A failure here is logged, never the item's. */
      const settleAll = async (): Promise<void> => {
        for (const step of ran.splice(0)) {
          try {
            await step.settle?.()
          } catch (err) {
            console.warn('[gc] clearing the prep journal failed', err)
          }
        }
      }
      if (preps.length > 0) {
        // Nothing a step does may escape: a throw is that item's failure, the steps that ran are put back
        // (in reverse), and the job goes on with the next id.
        try {
          if (!confirmed.has(id)) return refused(id, 'needs-confirmation')
          if (!deps.prepare || !deps.gatherFresh || !deps.dryReprobe) {
            return refused(id, 'prep-not-applicable')
          }
          const forcedPre = b.bucket !== 'ready' && !retryOf(b)
          // 1. The work guards, before anything is touched.
          const work = await workRefusal(b, forcedPre)
          if (work) return refused(id, work)
          // 2. Everything else the remove would meet, with every step's own cause assumed fixed.
          const adapted = assumeFor(preps, b)
          const pipeline = pipelineRefusal(adapted, {
            removeVolumes: false,
            confirmReview: forcedPre
          })
          if (pipeline) return refused(id, pipeline)
          for (const prep of preps) {
            const vetted = await deps.prepare(prep, b, { dry: true })
            if (!vetted.ok) return refused(id, vetted.error)
          }
          try {
            const dry = await deps.dryReprobe(
              retryOf(adapted) ? { ...adapted, bucket: 'ready', reason: null } : adapted,
              forcedPre
            )
            if (!dry.ok) return refused(id, dry.reason)
          } catch (err) {
            return refused(id, `probe-failed: ${err instanceof Error ? err.message : String(err)}`)
          }
          // 3. Only now the steps, in order. A failing step puts back the ones before it.
          for (const prep of preps) {
            const prepared = await deps.prepare(prep, b)
            if (!prepared.ok) return bail(refused(id, prepared.error))
            ran.push({ undo: prepared.undo ?? null, settle: prepared.settle ?? null })
          }
          let again: WorktreeBundle | undefined
          try {
            again = (await deps.gatherFresh()).bundles.find((x) => x.item.id === id)
          } catch (err) {
            return bail(
              refused(id, `probe-failed: ${err instanceof Error ? err.message : String(err)}`)
            )
          }
          if (!again) return bail(refused(id, 'unknown-item'))
          const hardAgain = refusalFor(again, prefs, { confirmed: true })
          if (hardAgain) return bail(refused(id, hardAgain))
          // Everything the operator saw must still hold; only the bucket and reason may differ now.
          const drift = bundleChangedSince(again, {
            ...seen,
            bucket: again.bucket,
            reasonCode: again.reason?.code ?? null
          })
          if (drift) return bail(refused(id, 'changed-since-confirm'))
          b = afterPrep(preps, again)
        } catch (err) {
          return bail(
            refused(id, `prep-failed: ${err instanceof Error ? err.message : String(err)}`)
          )
        }
      }
      // Anything that is not a proven ready item needs its OWN confirmation, and then takes
      // the forced ops.
      // A ready item whose cleanup halted is shown as `cleanup-failed` review (`retryAs`), but its
      // facts still say ready: its Retry takes the same guarded path the autopilot did, with the
      // dirty and unpushed guards and `branch -d`, not the operator's force path.
      const retryAsReady = retryOf(b)
      const forced = b.bucket !== 'ready' && !retryAsReady
      const path = b.item.path
      let result: GcItemResult
      try {
        if (forced && !confirmed.has(id)) return bail(refused(id, 'needs-confirmation'))
        const work = await workRefusal(b, forced)
        if (work) return bail(refused(id, work))
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
        result = (await runBatch([runnable], guarded, batchOpts))[0]!
      } catch (err) {
        // Nothing after the prep may escape the rollback: the steps that ran are put back (the folder is
        // still there, or this would not have thrown before the remove), and the item records why.
        return bail(
          refused(
            id,
            `${preps.length > 0 ? 'prep-failed' : 'probe-failed'}: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      }
      if (result.ok) {
        // The item IS removed: bookkeeping that fails now is logged, never turned into a failure.
        try {
          deps.rememberLeftovers?.(leftBehind(b, gathered.housekeeping?.volumes ?? []))
        } catch (err) {
          console.warn('[gc] remembering leftovers failed', err)
        }
        await settleAll()
        return result
      }
      // Still refused (or stopped) after the prep: the lock goes back, the containers restart, as long
      // as the folder is still there. Once it is trashed there is nothing to roll back to: re-locking
      // a registration that is gone, or starting containers whose bind source is gone, would be wrong.
      const r = result
      const gone =
        POST_TRASH.has(r.haltedAt ?? '') ||
        (r.haltedAt === 'trash' && !!path && deps.folderExists
          ? !(await deps.folderExists(path))
          : false)
      if (!gone) return bail(r)
      await settleAll()
      return preps.some((p) => p.kind === 'stop-stack')
        ? { ...r, error: `${r.error ?? 'failed'}; prep-left (stack-stopped)` }
        : r
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
      // The last net: whatever throws for one id is that id's failure, never the whole job's.
      let result: GcItemResult
      try {
        result = id.startsWith(VOLUME_PREFIX) ? await cleanVolume(id) : await cleanBundle(id)
      } catch (err) {
        result = refused(id, `probe-failed: ${err instanceof Error ? err.message : String(err)}`)
      }
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
