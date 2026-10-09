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
import type { GcDockerCard, OrphanVolumesHidden } from './gc-docker-card'
import type {
  GcOpinionAck,
  GcOpinionDone,
  GcOpinionResult,
  Opinion,
  OpinionRefusal,
  OpinionVerdict
} from './opinion-core'

export type {
  GcDockerCard,
  OrphanVolumesHidden,
  GcOpinionAck,
  GcOpinionDone,
  GcOpinionResult,
  Opinion as GcOpinion,
  OpinionRefusal as GcOpinionRefusal,
  OpinionVerdict as GcOpinionVerdict,
  CycleMode,
  GcJobDone,
  GcJobInfo,
  GcJobProgress,
  OrphanVolumeItem,
  GcItemResult
}

/** What one pass of the autopilot did. Pushed on `gc:cycle` and kept as `lastCycle`. */
export interface CycleRecord {
  at: number
  trigger: 'timer' | 'manual'
  mode: CycleMode
  /** Eligible ready items seen this cycle. */
  found: number
  /** Disk those ready items occupy. */
  foundBytes: number
  cleaned: GcItemResult[]
  /** Bytes the worktree cleanups freed plus what Docker housekeeping reclaimed. */
  freedBytes: number
  /** Eligible ready items the per-cycle cap left for a later cycle. */
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
  /** Orphan volumes offered in Needs review. Removed only by an explicit, confirmed action. */
  orphanVolumes: OrphanVolumeItem[]
  /**
   * The Docker card: `buildCacheReclaimableBytes`, `danglingImages { count, bytes }` and
   * `orphanVolumesHidden { reason, folders } | null`. The first two are null when docker was
   * absent or did not answer for them; the last says why the orphan list is empty when an
   * unresolved compose name or a scan limit hides it (null when nothing is hidden, and also null when no volume is left unused by a container, since then there is nothing to hide).
   */
  docker: GcDockerCard
  prefs: GcPrefs
  lastCycle: CycleRecord | null
  /** When the next timer tick fires, or null when the Reaper background scan is off. */
  nextCycleAt: number | null
  /**
   * What the next cycle would clean once cleaning is allowed (autopilot on, report acknowledged):
   * the figure the first-cycle banner discloses before the operator enables it. Null when the
   * worktrees category is off.
   */
  nextClean: { count: number; bytes: number } | null
}

/**
 * The facts a Cleanup row showed the operator for one item. `gc:clean` compares them with a
 * fresh gather when the job runs and refuses an item that differs (`changed-since-confirm`).
 *
 * For a worktree bundle they are read straight off the `WorktreeBundle` in the snapshot:
 * `bucket`, `reason?.code` (`reasonCode`, null for a ready item), `localTip` (`headSha`),
 * `stackIds`, `ownedVolumes`, `item.diskBytes` (`bytes`). For an orphan volume (id
 * `volume:<name>`): `bucket: 'orphan-volume'`, `reasonCode` the item's reason code, `bytes`
 * its `sizeBytes`, `project` its compose project, `ownedVolumes: [name]`.
 *
 * "Different" means a different folder, bucket, reason or head, any stack or volume that was not
 * listed, or (for a volume) a different size or project. `bytes` of a worktree is not
 * compared: disk use drifts without anything having changed.
 */
export interface GcExpected {
  bucket: 'ready' | 'review' | 'in-use' | 'orphan-volume'
  reasonCode: string | null
  headSha: string | null
  stackIds: string[]
  ownedVolumes: string[]
  bytes: number | null
  /**
   * The folder of the worktree the operator was looking at (`bundle.item.path`; null for an
   * orphan volume). A worktree moved with `git worktree move` keeps its id, its head and its
   * reason, so only the path tells the confirmation no longer describes it. Compared after
   * normalization (slashes, `.` and `..`), so a spelling difference is not a change.
   */
  path: string | null
  /** Orphan volumes only: the compose project shown with the volume. */
  project?: string | null
}

/**
 * The `gc:clean(ids, opts)` contract.
 *
 * - `expected` is REQUIRED for every id, ready items included. An id without an entry is refused
 *   `missing-expected`; an item whose fresh facts differ is refused `changed-since-confirm`.
 * - `confirmed` lists the ids the operator explicitly confirmed. A review worktree and an
 *   orphan volume (`volume:<name>`) need their OWN entry: confirming one id confirms no
 *   other, and without it the item is refused `needs-confirmation`. A ready item needs none.
 * - The autopilot never passes `confirmed`; there is no boolean "confirm everything".
 * - in-use items, main checkouts, `neverClean` paths and Keep marks are refused whatever is
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
