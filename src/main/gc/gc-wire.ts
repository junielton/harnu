// Wire types of the workspace-GC IPC surface. Plain data only: everything here survives
// `JSON.parse(JSON.stringify(x))`, and the file imports types only, so the preload and the
// renderer can read it without pulling in a main-process module.

import type { WorktreeBundle } from './bundle-core'
import type { CycleMode } from './autopilot-core'
import type { GcPrefs } from './gc-prefs'
import type { GcItemResult } from './pipeline-core'
import type { HousekeepingResult } from './housekeeping-core'
import type { OrphanVolumeItem } from './gc-housekeeping-input'
import type { GcJobDone, GcJobInfo, GcJobProgress } from './gc-jobs-core'

export type { CycleMode, GcJobDone, GcJobInfo, GcJobProgress, OrphanVolumeItem, GcItemResult }

/** What one pass of the autopilot did. Pushed on `gc:cycle` and kept as `lastCycle`. */
export interface CycleRecord {
  at: number
  trigger: 'timer' | 'manual'
  mode: CycleMode
  /** Eligible corpses seen this cycle. */
  found: number
  /** Disk those corpses occupy. */
  foundBytes: number
  cleaned: GcItemResult[]
  /** Bytes the worktree cleanups freed plus what Docker housekeeping reclaimed. */
  freedBytes: number
  /** Eligible corpses the per-cycle cap left for a later cycle. */
  deferred: number
  housekeeping: HousekeepingResult | null
  /** Whether this cycle raised its one notification. */
  notified: boolean
  /** The job the cycle ran through, when it ran one. */
  jobId: string | null
}

/** `gc:snapshot`: everything the Cleanup surface shows, from the last gather. */
export interface GcSnapshot {
  scannedAt: number
  bundles: WorktreeBundle[]
  /** Orphan volumes offered in Decide. Removed only by an explicit, confirmed action. */
  orphanVolumes: OrphanVolumeItem[]
  prefs: GcPrefs
  lastCycle: CycleRecord | null
  /** When the next timer tick fires, or null when the Reaper background scan is off. */
  nextCycleAt: number | null
}

/**
 * The facts a Cleanup row showed the operator for one item. `gc:clean` compares them with a
 * fresh gather when the job runs and refuses an item that differs (`changed-since-confirm`).
 *
 * For a worktree bundle they are read straight off the `WorktreeBundle` in the snapshot:
 * `bucket`, `reason?.code` (`reasonCode`, null for a corpse), `localTip` (`headSha`),
 * `stackIds`, `ownedVolumes`, `item.diskBytes` (`bytes`). For an orphan volume (id
 * `volume:<name>`): `bucket: 'orphan-volume'`, `reasonCode` the item's reason code, `bytes`
 * its `sizeBytes`, `project` its compose project, `ownedVolumes: [name]`.
 *
 * "Different" means a different bucket, reason or head, any stack or volume that was not
 * listed, or (for a volume) a different size or project. `bytes` of a worktree is not
 * compared: disk use drifts without anything having changed.
 */
export interface GcExpected {
  bucket: 'corpse' | 'decide' | 'alive' | 'orphan-volume'
  reasonCode: string | null
  headSha: string | null
  stackIds: string[]
  ownedVolumes: string[]
  bytes: number | null
  /** Orphan volumes only: the compose project shown with the volume. */
  project?: string | null
}

/**
 * The `gc:clean(ids, opts)` contract.
 *
 * - `expected` is REQUIRED for every id, corpses included. An id without an entry is refused
 *   `missing-expected`; an item whose fresh facts differ is refused `changed-since-confirm`.
 * - `confirmed` lists the ids the operator explicitly confirmed. A Decide worktree and an
 *   orphan volume (`volume:<name>`) need their OWN entry: confirming one id confirms no
 *   other, and without it the item is refused `needs-confirmation`. A corpse needs none.
 * - The autopilot never passes `confirmed`; there is no boolean "confirm everything".
 * - Alive items, main checkouts, `neverClean` paths and Keep marks are refused whatever is
 *   confirmed.
 */
export interface GcCleanOptions {
  confirmed?: string[]
  expected?: Record<string, GcExpected>
}

/** `gc:clean` acknowledges at once; the work streams on `gc:progress` and ends on `gc:done`. */
export interface GcCleanAck {
  jobId: string
  /** True when another job was already running and this one waits its turn. */
  queued: boolean
}
