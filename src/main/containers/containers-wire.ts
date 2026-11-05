/**
 * Wire contract for the Containers feature (T320, PRD §5, ADR-0014 §1).
 *
 * Plain data only: every type here survives `JSON.parse(JSON.stringify(x))`
 * unchanged — no `Map`, `Set`, `Date`, `undefined`-valued keys or class
 * instances. This file imports NOTHING: not Electron, not a sibling
 * main-process module. The renderer view and the MCP verbs read this one
 * contract, and neither ever derives a verdict — the main process does.
 */

/** PRD §3.3, in precedence order. `pending` is provisional. */
export type Verdict = 'unknown' | 'orphan' | 'active' | 'protected' | 'pending' | 'zombie'

/** Every verdict, in PRD §3.3 precedence order. */
export const VERDICTS: readonly Verdict[] = [
  'unknown',
  'orphan',
  'active',
  'protected',
  'pending',
  'zombie'
]

/** The verdicts listed under "Needs you" — the only ones a bulk stop or a sweep touches. */
export const NEEDS_YOU_VERDICTS: readonly Verdict[] = ['zombie', 'orphan']

/** Which rung of the attribution ladder matched (PRD §3.2). */
export type AttributionRung = 'compose-label' | 'bind-mount' | 'none'

/**
 * What the attributed path resolved to against Harnu's folders (PRD §3.2).
 *
 * - `main-checkout` — git places the path in a repo's main checkout (any subfolder of it included).
 * - `worktree`      — git places the path in a linked worktree. The only kind that can become a zombie.
 * - `gone`          — the attributed path lies in a Harnu folder but no longer exists on disk.
 * - `plain`         — git can't vouch for the path (no repo, or the probe failed). Classified `protected`.
 * - `untracked`     — the path lies outside every Harnu folder, whether or not it exists. Classified `unknown`.
 *
 * Main vs worktree is decided from the attributed path, never from the Harnu
 * folder containing it. `plain` and `untracked` are not named by the PRD; both
 * resolve to a "leave alone" verdict so an unanticipated shape can never be
 * offered for a bulk stop or a removal.
 */
export type FolderKind = 'main-checkout' | 'worktree' | 'gone' | 'plain' | 'untracked'

export interface Attribution {
  rung: AttributionRung
  /** The attributed path (the compose working_dir, or the Harnu folder a bind mount lies in). */
  path: string | null
  /** The deepest Harnu folder containing `path`, when there is one. */
  folderPath: string | null
  folderKind: FolderKind | null
}

export interface ContainerRow {
  /** Full container id. */
  id: string
  name: string
  /** `com.docker.compose.service`, or null for a standalone container. */
  service: string | null
  image: string
  /** Docker's `State.Status`: running, exited, created, paused, restarting, dead, removing. */
  state: string
  /** True while the container holds resources: running, paused or restarting. */
  running: boolean
  /** Epoch ms of `State.StartedAt`, or null when never started. */
  startedAt: number | null
  /** Epoch ms of `State.FinishedAt`, or null when never stopped. */
  finishedAt: number | null
  /** Resident memory from `docker stats`; null when stopped or unmeasured. */
  memBytes: number | null
  /** Distinct host ports published while running. */
  ports: number[]
  /** Named and anonymous volumes mounted by this container. */
  volumes: string[]
}

export interface VolumeRow {
  name: string
  /** From `docker system df -v`; null when unmeasured. */
  sizeBytes: number | null
  /**
   * True when the volume is also mounted by a container outside this stack, or
   * belongs to another compose project. A shared volume is never removed with
   * the stack, even when `removeVolumes` is set.
   */
  shared: boolean
}

/** What the compose labels say about how a stack was started (U3.4); the restore command reads it. */
export interface StackCompose {
  /** `com.docker.compose.project.config_files`, split on commas; `[]` when the label is missing. */
  configFiles: string[]
  /** `com.docker.compose.project.environment_file` (the first one), or null. */
  envFile: string | null
}

/**
 * Everything `docker compose up -d` needs to bring a stack back the way it ran (U3.4). `project`
 * is null only for a hint built without a project name.
 */
export interface ComposeRestoreFacts {
  project: string | null
  /** The directory the stack was started from (`--project-directory`). */
  workingDir: string
  configFiles: string[]
  /** Profiles of the services that were running; the restored set needs them to come back. */
  profiles: string[]
  envFile: string | null
  /** True when a restored service has a `build:` section, so `up -d` needs `--build`. */
  hasBuild: boolean
}

export interface StackRow {
  /** Stable key every action targets: the compose project name, or the container name. */
  id: string
  /** Display name. */
  name: string
  kind: 'compose' | 'container'
  /** `com.docker.compose.project`, or null for a standalone container. */
  project: string | null
  attribution: Attribution
  verdict: Verdict
  /** True when any container in the stack is running. */
  running: boolean
  containers: ContainerRow[]
  /** Sum of running containers' memory. */
  ramBytes: number
  /** Distinct host ports held by running containers. */
  ports: number[]
  volumes: VolumeRow[]
  /** Sum of the stack's measured, non-shared volume sizes. */
  volumeBytes: number
  /** Epoch ms of the last activity of any Harnu session in the attributed folder. */
  lastSessionActivityAt: number | null
  /** Epoch ms of the latest start/stop that counts toward the clock (PRD §3.3). */
  lastContainerEventAt: number | null
  /** "Unused for" (PRD §3.3), in ms; null when the verdict does not use the clock. */
  unusedForMs: number | null
  /** For `pending` only: ms until the stack becomes a zombie. */
  zombieInMs: number | null
  /** A live Harnu session in the attributed folder ("Go to session"), or null. */
  liveSessionId: string | null
  /** Compose start-up facts from the labels; null for a standalone container (U3.4). */
  compose?: StackCompose | null
}

export interface ContainersTotals {
  /** RAM of running "Needs you" stacks (zombie + orphan): what the bulk stop frees. */
  zombieRamBytes: number
  /** Distinct host ports held by running "Needs you" stacks. */
  zombiePorts: number
  /** Non-shared volume bytes of "Needs you" stacks: removal needs the operator's confirm. */
  volumeBytesAtStake: number
  /** RAM held by running stacks, grouped by verdict (the meter). */
  ramByVerdict: Record<Verdict, number>
  /** Stacks under "Needs you". */
  needsYou: number
  /** Running stacks under "Needs you": the N in "Stop N running". */
  stoppable: number
}

/**
 * Who did a journaled action: the operator in the UI, an agent over MCP, or the `autopilot` (Harnu
 * acting on its own, autonomous cleanup U3). Automatic actions are told apart from the other two.
 */
export const ACTORS = ['operator', 'agent', 'autopilot'] as const
export type Actor = (typeof ACTORS)[number]

export type ActVerb = 'stop' | 'start' | 'remove' | 'sweep'

/** Every verb the action function accepts. The MCP parity test reads this. */
export const ACT_VERBS: readonly ActVerb[] = ['stop', 'start', 'remove', 'sweep']

/**
 * The verbs an agent may drive over MCP: every verb but `sweep` (T340). A sweep
 * is one operator gesture that clears the whole "Needs you" list at once; an
 * agent still stops and removes stacks one at a time, so the exclusion is a
 * type the MCP verb-to-op map is checked against, never a comment.
 */
export type AgentActVerb = Exclude<ActVerb, 'sweep'>

/**
 * What a pause recorded about the stack it brought down (autonomous cleanup U3.4): everything
 * `docker compose up -d` needs, the host ports it freed, and the ready-to-paste command.
 */
export interface PausedRecord extends ComposeRestoreFacts {
  /** Host ports the stack held while running; a restore needs them free again. */
  ports: number[]
  /** `docker compose -p P --project-directory WD [-f F]… [--profile X]… [--env-file E] up -d [--build]`. */
  restoreCommand: string
  /** Epoch ms of the pause. */
  pausedAt: number
}

export interface TombstoneStack {
  stack: string
  name: string
  /** The attributed path, when there was one. */
  path: string | null
  /** Containers this action actually changed. */
  containerIds: string[]
  freed: {
    ramBytes: number
    ports: number[]
    volumes: string[]
    volumeBytes: number
  }
  /**
   * A removal only: the stack's volumes left in place — not requested, shared,
   * or refused by docker. Absent when nothing was kept (or the verb isn't
   * `remove`), so a journal line written before this field existed reads the
   * same as "unknown", never as "kept nothing".
   */
  keptVolumes?: string[]
  /** Sum of the kept volumes' measured sizes; present exactly when `keptVolumes` is. */
  keptVolumeBytes?: number
  /** A pause only (U3.4): the stack was brought down with `compose down`, volumes untouched. */
  paused?: PausedRecord
  /**
   * Who the kept volumes belonged to, written when Harnu removed an orphan stack on its own
   * (autonomous cleanup U3.3): the project and the folder that no longer exists. A live project
   * that later mounts one of `keptVolumes` can be warned that it inherits a removed worktree's
   * data (U3.7). Absent on every other removal.
   */
  keptVolumeOwner?: {
    reason: 'worktree-removed'
    project: string | null
    worktreePath: string | null
  }
}

/** One journal line (PRD §3.5): one per action, however many stacks it touched. */
export interface Tombstone {
  at: number
  actor: Actor
  verb: ActVerb
  stacks: TombstoneStack[]
  /**
   * After a stop or a removal of a compose stack: its `docker compose … up -d` command (never
   * `docker start`, which fails once a stack is down); `docker start <ids>` only for a standalone
   * container that was merely stopped; null otherwise. A sweep carries a hint only when ONE command
   * honestly restores the whole batch — a batch no single command describes
   * stores null rather than a hint for one arbitrary stack (T340).
   */
  restoreHint: string | null
  /**
   * Why an automatic action happened, in one English sentence (autonomous cleanup U3.3, and the
   * pauses of U3.5): "Removed empty network `x` — no containers", "Paused `x` — idle 3 h · bring
   * back: `docker compose … up -d`". The digest reads it. Absent on operator and agent lines
   * and on every line written before this field existed. A network removal has no stack, so its
   * `stacks` is empty and this sentence is the whole line.
   */
  reason?: string
}

/**
 * What the clean-up dialog disclosed before the operator confirmed (BUG-137):
 * the stacks it listed, and the volumes it offered to remove.
 *
 * An ASSERTION, never a target list. Main keeps picking its own targets from a
 * scan taken after the click (T340); this only says what the operator read, so
 * a set that moved in between refuses the whole sweep instead of deleting
 * something that was never on screen.
 */
export interface SweepDisclosure {
  /** The stack ids the dialog listed. */
  stacks: string[]
  /** The volume names the dialog offered to remove (not the ones it named as kept). */
  volumes: string[]
}

/** What the renderer or an MCP handler asks for. The actor is never part of the request. */
export type ActRequest =
  | {
      verb: 'stop'
      /** Required unless `bulk` is set. */
      stacks?: string[]
      /** Allows stopping `active` and `protected` stacks. Never allows `unknown`. */
      force?: boolean
      /** "Stop N running": every running zombie and orphan, chosen by main. Ignores `stacks`. */
      bulk?: boolean
    }
  | { verb: 'start'; stacks: string[] }
  | {
      verb: 'remove'
      /** Exactly one stack: a removal names one stack (PRD §7.3, T340). */
      stack: string
      /** Also remove the stack's non-shared volumes, after its containers. */
      removeVolumes?: boolean
    }
  | {
      /**
       * "Clear the list": stop-then-remove every sweep-eligible stack (T340).
       * Main picks the set — every zombie and orphan, running or exited — so a
       * caller can neither name a stack nor widen the set with a flag.
       */
      verb: 'sweep'
      /** Also remove the swept stacks' volumes, after every container removal. */
      removeVolumes?: boolean
      /**
       * The stacks the operator left ticked (T342). A NARROWING, never a target
       * list: main intersects it with the set its own tier table allows, so an
       * unknown or ineligible id is ignored and no selection can widen a sweep.
       * Absent means "everything eligible" — the one-click sweep, unchanged.
       * Deliberately separate from `disclosed`: this decides the targets, that
       * one is the promise they are checked against (BUG-137).
       */
      only?: string[]
      /** What the confirm dialog showed. An assertion, never a target list (BUG-137). */
      disclosed?: SweepDisclosure
      stacks?: never
      stack?: never
    }

/** Refusal and failure codes (MCP spec, T328/T329). */
export type ActErrorCode =
  | 'STACK_NOT_FOUND'
  | 'STACK_NOT_ATTRIBUTABLE'
  | 'STACK_IN_USE'
  | 'STACK_PROTECTED'
  | 'STACK_PENDING'
  | 'STACK_RUNNING'
  | 'WORKTREE_GONE'
  | 'DOCKER_UNAVAILABLE'
  | 'DOCKER_FAILED'
  | 'BAD_REQUEST'
  /** A sweep whose disclosed set no longer matches the fresh scan (BUG-137). */
  | 'SWEEP_SET_CHANGED'

export interface StackActResult {
  stack: string
  ok: boolean
  error?: ActErrorCode
  message?: string
  /** Containers this action changed (stopped, started or removed). */
  containerIds: string[]
  /** RAM released by a stop; 0 for a removal, whose containers are already stopped. */
  freedRamBytes: number
  /** Disk released by a removal's volumes; 0 unless volumes were removed. */
  freedVolumeBytes: number
  /** Host ports released by a stop or removal. */
  portsReleased: number[]
  removedContainers: string[]
  removedVolumes: string[]
  /** Volumes left in place: not requested, shared, or refused by docker. */
  keptVolumes: string[]
}

export interface ActResult {
  /** True when every targeted stack succeeded and nothing was refused. */
  ok: boolean
  /** The requested verb; null only when the request was too malformed to name one. */
  verb: ActVerb | null
  /** A request-level refusal (`BAD_REQUEST`, `DOCKER_UNAVAILABLE`); `results` is then empty. */
  error?: ActErrorCode
  message?: string
  results: StackActResult[]
  /** The journal line this action wrote, or null when nothing changed. */
  tombstone: Tombstone | null
}

/** PRD §6. Labels and defaults are provisional. */
export interface ContainersPrefs {
  version: 1
  autoScan: boolean
  intervalMs: number
  zombieAfterDays: number
  notifyOnNewZombies: boolean
}

/** The `containers:newZombies` push (T332): stacks that just became zombies for the first time. */
export interface NewZombiesAlert {
  count: number
  /** Display names, in snapshot order. */
  names: string[]
}

/**
 * The `containers:staleVolumes` push (U3.7): live compose projects that just began mounting a volume
 * Harnu kept for a removed worktree, so their data may be stale. Names only, already deduped by main.
 */
export interface StaleVolumesAlert {
  warnings: Array<{ volume: string; project: string; worktree: string }>
}

interface SnapshotBase {
  scannedAt: number
  /** The zombie threshold the verdicts were computed with. */
  zombieAfterDays: number
  /** Journal tombstones, newest first. */
  recent: Tombstone[]
}

/**
 * A stack Cleanup brought down with `compose down` and that has not come back (U3.4, shown as
 * "Paused"). It has no containers, so it is not a {@link StackRow} and no verdict applies to it.
 */
export interface PausedStack extends PausedRecord {
  /** The stack id the pause was journaled under (the compose project). */
  stack: string
  name: string
  /** Who paused it: the autopilot on its own, or an operator or agent. */
  actor: Actor
}

export interface ContainersSnapshotAvailable extends SnapshotBase {
  dockerAvailable: true
  totals: ContainersTotals
  stacks: StackRow[]
  /** Paused stacks, newest first; derived from the journal, never from a second file. */
  paused: PausedStack[]
}

/** Docker is missing or its daemon is down. Deliberately carries no `stacks` (PRD §5). */
export interface ContainersSnapshotUnavailable extends SnapshotBase {
  dockerAvailable: false
  dockerError: string
}

export type ContainersSnapshot = ContainersSnapshotAvailable | ContainersSnapshotUnavailable
