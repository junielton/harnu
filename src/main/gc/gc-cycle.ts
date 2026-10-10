// The autopilot cycle (design: workspace-gc §6). `runGcCycle` runs right after the Reaper
// scan in the same tick: gather the bundles, plan, clean the ready items through the shared job
// queue, run Docker housekeeping, and raise at most one notification. Every effect is an
// injected dep, so the whole cycle is unit-tested with fakes in tests/gc-cycle.test.ts.
//
// The autopilot is the one caller that must never force: it only ever hands `runBatch`
// bundles the planner called ready items, through ops built for the `autopilot` actor.

import type { InspectedContainer } from '../containers/containers-core'
import {
  applyFailures,
  planCycle,
  pruneFailures,
  rememberReprobeRefusal,
  type CycleFailure,
  type CyclePlan
} from './autopilot-core'
import type { WorktreeBundle } from './bundle-core'
import type { JobQueue } from './gc-jobs-core'
import type { GcPrefs } from './gc-prefs'
import type { CycleRecord } from './gc-wire'
import {
  planHousekeeping,
  type HousekeepingPlan,
  type HousekeepingResult,
  type HousekeepingVolume
} from './housekeeping-core'
import { leftBehind, type Leftover } from './gc-leftovers'
import { runBatch, type GcItemResult, type GcOps } from './pipeline-core'

/** What the planner needs to know about Docker and the folders Harnu knows. */
export interface HousekeepingContext {
  volumes: HousekeepingVolume[]
  containers: InspectedContainer[]
  /** Fails closed: anything not proven gone exists. */
  dirExists: (path: string) => boolean
  /** Every folder Harnu knows: fleet, pinned, every worktree of every repo, hidden ones. */
  knownFolders: string[]
  /** Compose project names pinned explicitly by a folder that still exists. */
  protectedProjects: ReadonlySet<string>
  /** Compose project → folders a cleaned worktree ran from (see gc-leftovers.ts). */
  rememberedDirs?: ReadonlyMap<string, readonly string[]>
  /** A compose name could not be resolved, so no volume is provably foreign. */
  protectAllProjects?: boolean
}

export interface GcGather {
  bundles: WorktreeBundle[]
  housekeeping: HousekeepingContext
}

/** In-memory memory of the autopilot between ticks. */
export interface CycleState {
  failures: Map<string, CycleFailure>
  /** The count behind the last report-only notice, so an unchanged report is not repeated. */
  lastReportKey: string | null
  last: CycleRecord | null
}

export function createCycleState(): CycleState {
  return { failures: new Map(), lastReportKey: null, last: null }
}

export interface GcCycleDeps {
  prefs(): GcPrefs
  gather(): Promise<GcGather>
  /** Ops whose journal entries are marked as the autopilot's. Never the forced ops. */
  opsFor(actor: 'autopilot'): GcOps
  queue: JobQueue
  housekeeping(plan: HousekeepingPlan): Promise<HousekeepingResult>
  notify(n: { title: string; body: string }): void
  emitCycle(r: CycleRecord): void
  /** What a cleaned worktree leaves in Docker, so its volumes can be offered for review. */
  rememberLeftovers?(entries: Leftover[]): void
  /** Called with every gather, whether or not the cycle cleans: the Containers feed reads it. */
  onGathered?(g: GcGather): void
  state: CycleState
  now(): number
}

/**
 * The gather as every consumer must see it: a worktree whose last cleanup halted reads as a
 * review item (`cleanup-failed`), not as the ready item it still is on paper. gc-ipc applies this
 * once, inside its single gather, so the snapshot, the Containers feed, the manual job and
 * the cycle agree; applying it again is a no-op.
 */
export function withFailures<G extends GcGather>(g: G, state: CycleState, now: number): G {
  // No pruning of the shared notes here: forgetting a note belongs to the gatherer, which does it
  // only from a gather that is still current. A prune on this side ran against a gather that a
  // manual clean could overlap, and deleted the note of an item that clean had just halted. The
  // same rules run on a copy instead, so an expired note or a refusal the scan has moved past is
  // only skipped, never deleted: after its TTL the autopilot may try again.
  const live = new Map(state.failures)
  pruneFailures(live, g.bundles, now)
  return { ...g, bundles: applyFailures(g.bundles, live, now) }
}

/**
 * Decimal units, exactly as every renderer surface prints them (`formatBytes` in
 * system-monitor-format.ts, which Cleanup uses): `1.20 GB`, `410 MB`, `40 KB`, `12 B`. The
 * renderer file is not part of the main process project, so this is the same rule written
 * here, and tests/gc-cycle.test.ts pins the two to the same output. A notification that said
 * GiB next to a screen that says GB would show two numbers for one amount.
 */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, bytes)
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB'
  if (n >= 1e6) return Math.round(n / 1e6) + ' MB'
  if (n >= 1e3) return Math.round(n / 1e3) + ' KB'
  return Math.round(n) + ' B'
}

const NOTICE_TITLE = 'Workspace cleanup'
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many)
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function emptyHousekeeping(error: string): HousekeepingResult {
  return { buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [error] }
}

const reclaimed = (h: HousekeepingResult | null): number =>
  h ? h.buildCacheBytes + h.imageBytes + h.volumeBytes : 0

export async function runGcCycle(
  deps: GcCycleDeps,
  trigger: 'timer' | 'manual'
): Promise<CycleRecord> {
  const prefs = deps.prefs()
  const now = deps.now()
  const gathered = withFailures(await deps.gather(), deps.state, now)
  const { bundles } = gathered
  deps.onGathered?.(gathered)

  const plan: CyclePlan = planCycle(bundles, prefs)
  // Defense in depth: whatever the planner returned, only a ready item is ever handed on.
  const toClean = plan.toClean.filter((b) => b.bucket === 'ready')
  // Housekeeping deletes things, so it waits for the same acknowledgement the cleaning does.
  const housekeepingOn =
    prefs.autopilot && prefs.firstReportAcknowledged && prefs.categories.dockerCache

  let cleaned: GcItemResult[] = []
  let housekeeping: HousekeepingResult | null = null
  let jobId: string | null = null

  if (toClean.length > 0 || housekeepingOn) {
    const ops = toClean.length > 0 ? deps.opsFor('autopilot') : null
    const submitted = deps.queue.submit(
      'autopilot',
      toClean.map((b) => b.item.id),
      async (reporter) => {
        const results = ops
          ? await runBatch(
              toClean,
              ops,
              // D1: worktree cleanup never removes a volume; they come back as review items.
              { removeVolumes: false },
              {
                onStart: (b) => reporter.onStart(b.item.id),
                onItem: (r) => reporter.onItem(r)
              }
            )
          : []
        if (housekeepingOn) {
          const hk = gathered.housekeeping
          const hkPlan = planHousekeeping(
            // The autopilot never removes a volume outside a ready bundle: orphan volumes
            // are review items that only an explicit operator action can clear.
            { cacheMaxAgeDays: prefs.cacheMaxAgeDays, danglingImages: true, orphanVolumes: false },
            hk.volumes,
            hk.containers,
            hk.dirExists,
            hk.knownFolders,
            hk.protectedProjects,
            hk.rememberedDirs,
            hk.protectAllProjects
          )
          try {
            housekeeping = await deps.housekeeping(hkPlan)
          } catch (err) {
            housekeeping = emptyHousekeeping(`housekeeping: ${messageOf(err)}`)
          }
        }
        return results
      }
    )
    jobId = submitted.jobId
    cleaned = (await submitted.finished).results
  }

  for (const r of cleaned) {
    if (r.ok) {
      deps.state.failures.delete(r.id)
      const done = toClean.find((b) => b.item.id === r.id)
      if (done) deps.rememberLeftovers?.(leftBehind(done, gathered.housekeeping.volumes))
    }
    // A refusal at the reprobe changed nothing. One that describes the item (a locked worktree, an
    // unknown tip) is remembered, so the item leaves the hero and the next cycle spends its cap
    // elsewhere; the rest just re-bucket on the next scan.
    if (!r.ok && r.haltedAt === 'reprobe') {
      const done = toClean.find((b) => b.item.id === r.id)
      rememberReprobeRefusal(deps.state.failures, r, now, done?.localTip ?? null)
    } else if (!r.ok && r.haltedAt !== null) {
      deps.state.failures.set(r.id, { step: r.haltedAt, error: r.error ?? 'failed', at: now })
      console.warn('[gc] cleanup halted', r.id, r.haltedAt, r.error)
    }
  }

  const doneCount = cleaned.filter((r) => r.ok).length
  const freedBytes = cleaned.reduce((sum, r) => sum + r.freedBytes, 0) + reclaimed(housekeeping)

  let notice: string | null = null
  if (plan.mode === 'report') {
    const key = String(plan.found)
    if (plan.found > 0 && key !== deps.state.lastReportKey) {
      notice = `Found ${plan.found} ready to clean, ${formatBytes(plan.reportBytes)} — enable automatic cleanup?`
    }
    deps.state.lastReportKey = key
  } else {
    deps.state.lastReportKey = null
    if (doneCount > 0) {
      notice = `Cleaned ${doneCount} ${plural(doneCount, 'worktree')}, freed ${formatBytes(freedBytes)}`
    } else if (reclaimed(housekeeping) > 0) {
      notice = `Freed ${formatBytes(reclaimed(housekeeping))} of Docker cache`
    }
  }
  if (notice) deps.notify({ title: NOTICE_TITLE, body: notice })

  const record: CycleRecord = {
    at: now,
    trigger,
    mode: plan.mode,
    found: plan.found,
    foundBytes: plan.reportBytes,
    cleaned,
    freedBytes,
    deferred: plan.deferred,
    housekeeping,
    notified: notice !== null,
    jobId
  }
  deps.state.last = record
  deps.emitCycle(record)
  return record
}
