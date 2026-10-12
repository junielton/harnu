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
  /** The Reaper's "Automatic background scan" toggle: with it off no cycle ever runs. */
  backgroundScan: boolean
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
  /**
   * Fingerprint of the worktree's uncommitted work as the scan saw it (`item.workStamp`; null
   * when it had none). The force path probes the folder again and refuses (`work-changed-since-
   * confirm`) when the stamp differs: a file edited after the operator looked never rides along.
   * `'unknown'` means the scan's probe could not answer: the force path refuses it (`work-unreadable`).
   */
  workStamp?: string | null
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
  /**
   * A guided action's one preparatory step, per id, run inside the job before that item is judged
   * for the ordinary guarded remove ("No dead ends"). Only a confirmed review worktree takes one, and
   * only when it still applies to what main finds (see `prepareClean`).
   */
  prepare?: Record<string, GcPrep>
}

/** The step a guided "…and remove" runs first. */
export type GcPrep =
  /** `git worktree unlock` on a locked worktree. */
  | { kind: 'unlock' }
  /** Park the idle Harnu sessions open in the worktree. Never a working one. */
  | { kind: 'close-session' }
  /** Stop and remove the containers of these shared stacks. Volumes are never touched. */
  | { kind: 'stop-stack'; stackIds: string[] }
  /** Remove the worktree and leave these shared stacks running (only when none binds the folder). */
  | { kind: 'leave-stack'; stackIds: string[] }

/** One stack other folders use too, as a guided dialog shows it. */
export interface GcGuidedStack {
  id: string
  name: string
  /** Folders (other than this worktree) the stack's containers run from or mount. */
  otherFolders: string[]
  /** Whether any container of the stack runs from, or bind-mounts, this worktree. */
  bindsThisFolder: boolean
  containers: number
  /** The containers a "Stop stack" would stop, by name: the confirm lists them. */
  containerNames: string[]
  /**
   * Why the stack must not be stopped, when it must not: it is the main checkout's own stack, or a
   * folder that has a live or parked session uses it too.
   */
  stopBlocked: 'main-checkout' | 'in-use-elsewhere' | null
}

/**
 * `gc:guide`: what main sees about a refused item right now, for the guided dialog. Each part is
 * null when it does not apply. Read-only.
 */
export interface GcGuidance {
  id: string
  /** Git lists the worktree as locked; `reason` is what `git worktree lock --reason` recorded. */
  lock: { reason: string | null } | null
  /** Harnu sessions open in it: those idle (closable) and those working or waiting (never closed). */
  sessions: { idle: number; busy: number; userOpened: number } | null
  stacks: GcGuidedStack[]
  /** The exact folder the scan could not read, who owns it and a command that fixes it. */
  unreadable: { path: string; owner: string | null; fixCommand: string } | null
  /** The scan ran without Docker: the command that starts it on this platform, when there is one. */
  docker: { hint: string | null } | null
}

/** `gc:clean` acknowledges at once; the work streams on `gc:progress` and ends on `gc:done`. */
export interface GcCleanAck {
  jobId: string
  /** True when another job was already running and this one waits its turn. */
  queued: boolean
}

/**
 * `gc:recheck`: what "Check again" found for one item. `cleared`: nothing refuses it now (the
 * remembered refusal is gone and the next gather shows it as the scan sees it). `still-refused`: main
 * refuses it again for `code`, and it stays demoted. `unchecked`: the check itself could not answer
 * (Docker down, a probe that failed), so nothing was concluded. `unknown-item`: not in the gather.
 */
export interface GcRecheckResult {
  id: string
  outcome: 'cleared' | 'still-refused' | 'unchecked' | 'unknown-item'
  code?: string
}
