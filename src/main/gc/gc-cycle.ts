// The autopilot cycle (design: workspace-gc §6). `runGcCycle` runs right after the Reaper
// scan in the same tick: gather the bundles, plan, clean the ready items through the shared job
// queue, run Docker housekeeping, and raise at most one notification. Every effect is an
// injected dep, so the whole cycle is unit-tested with fakes in tests/gc-cycle.test.ts.
//
// The autopilot is the one caller that must never force: it only ever hands `runBatch`
// bundles the planner called ready items, through ops built for the `autopilot` actor.

import type { InspectedContainer } from '../containers/containers-core'
import type { WorktreeBundle } from './bundle-core'
import {
  applyFailures,
  planCycle,
  pruneFailures,
  type CycleFailure,
  type CyclePlan
} from './autopilot-core'
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
  pruneFailures(state.failures, g.bundles, now)
  return { ...g, bundles: applyFailures(g.bundles, state.failures) }
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

/** `1.5 GiB`; bytes print whole, everything else with one decimal. */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${UNITS[unit]}`
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
            hk.rememberedDirs
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
    // A refusal at the reprobe changed nothing: that item just re-buckets on the next scan.
    if (!r.ok && r.haltedAt !== 'reprobe' && r.haltedAt !== null) {
      deps.state.failures.set(r.id, { step: r.haltedAt, error: r.error ?? 'failed', at: now })
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
