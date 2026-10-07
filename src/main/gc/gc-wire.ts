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

export interface GcCleanOptions {
  /** The operator confirms removing Decide items (and orphan volumes). Never set by the autopilot. */
  confirmDecide?: boolean
}

/** `gc:clean` acknowledges at once; the work streams on `gc:progress` and ends on `gc:done`. */
export interface GcCleanAck {
  jobId: string
  /** True when another job was already running and this one waits its turn. */
  queued: boolean
}
