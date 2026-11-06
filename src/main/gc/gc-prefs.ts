// Merged workspace-GC prefs (design: workspace-gc §6). Pure defaults and normalization, plus a
// thin read/atomic-write shell that takes the file path, the same split as
// containers/containers-prefs.ts, so nothing here imports electron.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * There is no switch for removing volumes (D1, 2026-10-08): worktree cleanup never removes
 * one. What a cleaned worktree leaves behind is offered for review, one confirmation per
 * volume. The retired `removeVolumes` and `categories.volumes` keys are ignored on read.
 */
export interface GcPrefs {
  version: 1
  /** Off until the operator turns it on; even then the first cycle only reports. */
  autopilot: boolean
  /** Set by `gc:ackFirstReport`; until then the autopilot cycle is report-only. */
  firstReportAcknowledged: boolean
  /** Mirrors the Reaper timer, which stays the single clock. */
  intervalMs: number
  graceDays: number
  maxItemsPerCycle: number
  categories: { worktrees: boolean; dockerCache: boolean }
  cacheMaxAgeDays: number
  /**
   * "Keep archives for N days": the age past which `refs/archive/**` entries are offered for
   * deletion, behind a confirm that lists them.
   */
  archiveKeepDays: number
  /**
   * "Expire archives automatically": the autopilot itself may delete the archive refs older than
   * `archiveKeepDays`. Off by default, so refs only ever go on an explicit confirm.
   */
  archiveAutoExpire: boolean
  /** Absolute repo or worktree paths the autopilot and manual cleaning never touch. */
  neverClean: string[]
  /** Bundle id → the fate it had when the operator pressed Keep. */
  keep: Record<string, string>
  /**
   * Bundle id → when an agent released it (`release_worktree`). A released bundle skips the
   * grace window and nothing else: `buildBundles` honors it only for a strongly merged fate,
   * and every other rule (dirty, session, shared stack, keep, neverClean) still applies.
   */
  released: Record<string, number>
  /**
   * Where each released worktree was (repo and folder), so a later gather can tell it was
   * cleaned: the repo scanned, the bundle gone, the folder gone. The bundle id alone does not
   * carry the folder. A mark without an entry here is never dropped for being cleaned.
   */
  releasedFrom: Record<string, ReleasedFrom>
  /**
   * Shelving (autonomous cleanup U2.2): an idle worktree whose branch is not proven merged is
   * preserved, verified and removed from disk, and its branch is kept. It has its OWN switch and
   * acknowledgement, independent of `autopilot` / `firstReportAcknowledged`, which are already on
   * for operators who run the autopilot today.
   */
  shelve: ShelvePrefs
  /**
   * Docker autonomy (autonomous cleanup U3.1): pausing idle stacks and removing Docker garbage. ONE
   * switch for both, with its own acknowledgement, independent of `autopilot` and of `shelve`.
   */
  docker: DockerAutonomyPrefs
  /**
   * "Pause autonomous cleanup" (design §5): while on, every autonomous action (the autopilot's
   * clean, shelving, Docker autonomy) acts on nothing. Manual cleaning is unaffected.
   */
  pauseAutonomous: boolean
}

export interface DockerAutonomyPrefs {
  /**
   * ON by default (design C1). A prefs file that never set it reads ON; one that explicitly set it
   * keeps its value. Even when on, the first cycle only reports until `firstReportAcknowledged`.
   */
  enabled: boolean
  /** Set by `gc:docker:ack`; until then a Docker cycle is report-only. Turning `enabled` on resets it. */
  firstReportAcknowledged: boolean
  /** Hours a stack must have shown no sign of life before it can be paused ("parked" in code). */
  idleHours: number
  /** Free bridge-network slots under which capacity pressure acts at once. */
  lowWaterSlots: number
  /** Stacks one hour may pause (hysteresis against thrash). */
  maxParksPerHour: number
  /** Minutes since a stack's last `up` before it can be paused. */
  minAgeMinutes: number
  /** Autonomous Docker actions one cycle may run; the rest wait for the next cycle. */
  maxPerCycle: number
  /** Failed actions in a row after which Docker autonomy switches itself off. */
  failureLimit: number
}

export const DEFAULT_DOCKER_IDLE_HOURS = 2
export const MAX_DOCKER_IDLE_HOURS = 720
export const DEFAULT_DOCKER_LOW_WATER_SLOTS = 3
export const MAX_DOCKER_LOW_WATER_SLOTS = 30
export const DEFAULT_DOCKER_PARKS_PER_HOUR = 6
export const MAX_DOCKER_PARKS_PER_HOUR = 60
export const DEFAULT_DOCKER_MIN_AGE_MINUTES = 30
export const MAX_DOCKER_MIN_AGE_MINUTES = 1440
export const DEFAULT_DOCKER_PER_CYCLE = 5
export const MAX_DOCKER_PER_CYCLE = 20
export const DEFAULT_DOCKER_FAILURE_LIMIT = 3
export const MAX_DOCKER_FAILURE_LIMIT = 10

export function defaultDockerPrefs(): DockerAutonomyPrefs {
  return {
    enabled: true,
    firstReportAcknowledged: false,
    idleHours: DEFAULT_DOCKER_IDLE_HOURS,
    lowWaterSlots: DEFAULT_DOCKER_LOW_WATER_SLOTS,
    maxParksPerHour: DEFAULT_DOCKER_PARKS_PER_HOUR,
    minAgeMinutes: DEFAULT_DOCKER_MIN_AGE_MINUTES,
    maxPerCycle: DEFAULT_DOCKER_PER_CYCLE,
    failureLimit: DEFAULT_DOCKER_FAILURE_LIMIT
  }
}

export interface ShelvePrefs {
  /**
   * ON by default (design C1; U2.3a, once every restore trigger exists). A prefs file that never set
   * it reads ON; one that explicitly set it keeps its value. Even when on, the first cycle only
   * reports until `firstReportAcknowledged`.
   */
  enabled: boolean
  /** Set by `gc:shelve:ack`; until then a shelving cycle is report-only. Turning `enabled` on resets it. */
  firstReportAcknowledged: boolean
  /** Days a worktree must have shown no sign of life before it is shelved. */
  thresholdDays: number
  /** Worktrees one cycle may shelve; the rest wait for the next cycle. */
  maxPerCycle: number
  /** Failed shelves in a row after which shelving switches itself off. */
  failureLimit: number
}

export const DEFAULT_SHELVE_THRESHOLD_DAYS = 3
export const MAX_SHELVE_THRESHOLD_DAYS = 365
export const DEFAULT_SHELVE_PER_CYCLE = 3
export const MAX_SHELVE_PER_CYCLE = 20
export const DEFAULT_SHELVE_FAILURE_LIMIT = 3
export const MAX_SHELVE_FAILURE_LIMIT = 10

export function defaultShelvePrefs(): ShelvePrefs {
  return {
    enabled: true,
    firstReportAcknowledged: false,
    thresholdDays: DEFAULT_SHELVE_THRESHOLD_DAYS,
    maxPerCycle: DEFAULT_SHELVE_PER_CYCLE,
    failureLimit: DEFAULT_SHELVE_FAILURE_LIMIT
  }
}

export interface ReleasedFrom {
  repoPath: string
  path: string
  /**
   * The branch tip the release was made at. A release applies only while the bundle's tip is
   * still this one, so new commits followed by a fresh merge do not inherit it. A mark with no
   * tip (legacy) never applies.
   */
  localTip?: string
}

export const PREFS_FILE = 'gc-prefs.json'

export const MIN_INTERVAL_MS = 1_800_000
export const MAX_INTERVAL_MS = 86_400_000
export const MAX_GRACE_DAYS = 30
export const MAX_ITEMS_PER_CYCLE = 200
export const MAX_CACHE_AGE_DAYS = 365
export const DEFAULT_ARCHIVE_KEEP_DAYS = 30
export const MAX_ARCHIVE_KEEP_DAYS = 3650

export function prefsFile(userDataDir: string): string {
  return path.join(userDataDir, PREFS_FILE)
}

export function defaultGcPrefs(): GcPrefs {
  return {
    version: 1,
    autopilot: false,
    firstReportAcknowledged: false,
    intervalMs: 3_600_000,
    graceDays: 2,
    maxItemsPerCycle: 20,
    categories: { worktrees: true, dockerCache: true },
    cacheMaxAgeDays: 7,
    archiveKeepDays: DEFAULT_ARCHIVE_KEEP_DAYS,
    archiveAutoExpire: false,
    neverClean: [],
    keep: {},
    released: {},
    releasedFrom: {},
    shelve: defaultShelvePrefs(),
    docker: defaultDockerPrefs(),
    pauseAutonomous: false
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clamped(v: unknown, min: number, max: number): number | null {
  const n = finite(v)
  return n === null ? null : Math.min(max, Math.max(min, Math.round(n)))
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

export interface LegacyPrefs {
  reaper?: unknown
  containers?: unknown
}

/**
 * Tolerates junk (wrong types, missing keys, out-of-range numbers) and always returns a fully
 * populated, clamped object. A stored value wins field by field; a missing one falls back to
 * the old Reaper / Containers prefs so nothing the operator configured is lost. Migration
 * never turns the autopilot on.
 */
export function normalizeGcPrefs(
  raw: unknown,
  legacy: LegacyPrefs = {},
  /** What a missing or invalid field falls back to; the defaults unless a merge passes the current prefs. */
  base: GcPrefs = defaultGcPrefs()
): GcPrefs {
  const d = base
  const r = isRecord(raw) ? raw : {}
  const reaper = isRecord(legacy.reaper) ? legacy.reaper : {}
  const containers = isRecord(legacy.containers) ? legacy.containers : {}

  const categories = isRecord(r.categories) ? r.categories : {}
  const neverClean = Array.isArray(r.neverClean)
    ? [
        ...new Set(
          r.neverClean.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        )
      ]
    : d.neverClean
  const keep: Record<string, string> = {}
  if (isRecord(r.keep)) {
    for (const [id, fate] of Object.entries(r.keep)) {
      if (id && typeof fate === 'string') keep[id] = fate
    }
  }

  const released: Record<string, number> = {}
  if (isRecord(r.released)) {
    for (const [id, at] of Object.entries(r.released)) {
      const t = finite(at)
      if (id && t !== null && t >= 0) released[id] = t
    }
  }

  const releasedFrom: Record<string, ReleasedFrom> = {}
  if (isRecord(r.releasedFrom)) {
    for (const [id, from] of Object.entries(r.releasedFrom)) {
      if (!id || !isRecord(from)) continue
      const { repoPath, path: where, localTip } = from
      if (typeof repoPath === 'string' && repoPath && typeof where === 'string' && where) {
        releasedFrom[id] = {
          repoPath,
          path: where,
          ...(typeof localTip === 'string' && localTip ? { localTip } : {})
        }
      }
    }
  }

  return {
    version: 1,
    autopilot: bool(r.autopilot) ?? d.autopilot,
    firstReportAcknowledged: bool(r.firstReportAcknowledged) ?? d.firstReportAcknowledged,
    intervalMs:
      clamped(r.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS) ??
      clamped(reaper.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS) ??
      clamped(containers.intervalMs, MIN_INTERVAL_MS, MAX_INTERVAL_MS) ??
      d.intervalMs,
    graceDays:
      clamped(r.graceDays, 0, MAX_GRACE_DAYS) ??
      clamped(containers.zombieAfterDays, 0, MAX_GRACE_DAYS) ??
      d.graceDays,
    maxItemsPerCycle: clamped(r.maxItemsPerCycle, 1, MAX_ITEMS_PER_CYCLE) ?? d.maxItemsPerCycle,
    categories: {
      worktrees: bool(categories.worktrees) ?? d.categories.worktrees,
      dockerCache: bool(categories.dockerCache) ?? d.categories.dockerCache
    },
    cacheMaxAgeDays: clamped(r.cacheMaxAgeDays, 1, MAX_CACHE_AGE_DAYS) ?? d.cacheMaxAgeDays,
    archiveKeepDays: clamped(r.archiveKeepDays, 1, MAX_ARCHIVE_KEEP_DAYS) ?? d.archiveKeepDays,
    archiveAutoExpire: bool(r.archiveAutoExpire) ?? d.archiveAutoExpire,
    neverClean,
    keep,
    released,
    releasedFrom,
    shelve: normalizeShelve(r.shelve, d.shelve),
    docker: normalizeDocker(r.docker, d.docker),
    pauseAutonomous: bool(r.pauseAutonomous) ?? d.pauseAutonomous
  }
}

function normalizeDocker(raw: unknown, d: DockerAutonomyPrefs): DockerAutonomyPrefs {
  const r = isRecord(raw) ? raw : {}
  return {
    enabled: bool(r.enabled) ?? d.enabled,
    firstReportAcknowledged: bool(r.firstReportAcknowledged) ?? d.firstReportAcknowledged,
    idleHours: clamped(r.idleHours, 1, MAX_DOCKER_IDLE_HOURS) ?? d.idleHours,
    lowWaterSlots: clamped(r.lowWaterSlots, 1, MAX_DOCKER_LOW_WATER_SLOTS) ?? d.lowWaterSlots,
    maxParksPerHour: clamped(r.maxParksPerHour, 1, MAX_DOCKER_PARKS_PER_HOUR) ?? d.maxParksPerHour,
    minAgeMinutes: clamped(r.minAgeMinutes, 1, MAX_DOCKER_MIN_AGE_MINUTES) ?? d.minAgeMinutes,
    maxPerCycle: clamped(r.maxPerCycle, 1, MAX_DOCKER_PER_CYCLE) ?? d.maxPerCycle,
    failureLimit: clamped(r.failureLimit, 1, MAX_DOCKER_FAILURE_LIMIT) ?? d.failureLimit
  }
}

function normalizeShelve(raw: unknown, d: ShelvePrefs): ShelvePrefs {
  const r = isRecord(raw) ? raw : {}
  return {
    enabled: bool(r.enabled) ?? d.enabled,
    firstReportAcknowledged: bool(r.firstReportAcknowledged) ?? d.firstReportAcknowledged,
    thresholdDays: clamped(r.thresholdDays, 1, MAX_SHELVE_THRESHOLD_DAYS) ?? d.thresholdDays,
    maxPerCycle: clamped(r.maxPerCycle, 1, MAX_SHELVE_PER_CYCLE) ?? d.maxPerCycle,
    failureLimit: clamped(r.failureLimit, 1, MAX_SHELVE_FAILURE_LIMIT) ?? d.failureLimit
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Reads the stored prefs. When no GC prefs file exists yet (or it is unreadable), the old
 * Reaper and Containers files seed the first values, one time: the result is written by the
 * next `writeGcPrefs`.
 */
export async function readGcPrefs(
  file: string,
  legacyFiles: { reaper: string; containers: string }
): Promise<GcPrefs> {
  const stored = await readJson(file)
  if (isRecord(stored)) return normalizeGcPrefs(stored)
  const [reaper, containers] = await Promise.all([
    readJson(legacyFiles.reaper),
    readJson(legacyFiles.containers)
  ])
  return normalizeGcPrefs(null, { reaper, containers })
}

/** Atomic: write `<file>.tmp`, then rename over the target. */
export async function writeGcPrefs(file: string, prefs: GcPrefs): Promise<void> {
  const tmp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, JSON.stringify(normalizeGcPrefs(prefs), null, 2) + '\n', 'utf8')
  await fs.rename(tmp, file)
}

// ---- reducers behind the IPC channels ------------------------------------------------------

/**
 * A write from the renderer, whole or partial: it changes only what it names. `keep`, `released`
 * and the acknowledgement have their own channels, so a stale settings form can neither wipe the
 * operator's Keep marks or an agent's releases nor acknowledge a report it never showed. Turning
 * the autopilot on (off to on) resets the acknowledgement.
 */
export function mergeIncomingPrefs(current: GcPrefs, raw: unknown): GcPrefs {
  const incoming =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const categories =
    incoming.categories &&
    typeof incoming.categories === 'object' &&
    !Array.isArray(incoming.categories)
      ? (incoming.categories as Record<string, unknown>)
      : {}
  // A partial write changes only what it names: everything else, and every invalid value it
  // brings, falls back to the CURRENT prefs rather than to the defaults.
  const next = normalizeGcPrefs(
    { ...current, ...incoming, categories: { ...current.categories, ...categories } },
    {},
    current
  )
  return {
    ...next,
    keep: current.keep,
    released: current.released,
    releasedFrom: current.releasedFrom,
    // Turning the autopilot ON starts a new promise: its first cycle only reports. A write
    // cannot acknowledge (see above), but it can take the acknowledgement away, so an operator
    // who dismissed the banner, or ran the autopilot before, is never cleaned for on a stale ack.
    firstReportAcknowledged:
      !current.autopilot && next.autopilot ? false : current.firstReportAcknowledged,
    // Shelving makes the same promise on its own: turning it ON starts a report-only cycle, and no
    // settings write can acknowledge it (its own channel does).
    shelve: {
      ...next.shelve,
      firstReportAcknowledged:
        !current.shelve.enabled && next.shelve.enabled
          ? false
          : current.shelve.firstReportAcknowledged
    },
    // Docker autonomy makes the same promise on its own switch and its own channel (`gc:docker:ack`).
    docker: {
      ...next.docker,
      firstReportAcknowledged:
        !current.docker.enabled && next.docker.enabled
          ? false
          : current.docker.firstReportAcknowledged
    }
  }
}

export function withKeep(prefs: GcPrefs, id: string, fate: string): GcPrefs {
  return { ...prefs, keep: { ...prefs.keep, [id]: fate } }
}

export function withoutKeep(prefs: GcPrefs, ids: readonly string[]): GcPrefs {
  const keep = { ...prefs.keep }
  for (const id of ids) delete keep[id]
  return { ...prefs, keep }
}

export function withReleased(prefs: GcPrefs, id: string, at: number, from?: ReleasedFrom): GcPrefs {
  return {
    ...prefs,
    released: { ...prefs.released, [id]: at },
    releasedFrom: from ? { ...prefs.releasedFrom, [id]: from } : prefs.releasedFrom
  }
}

export function withoutReleased(prefs: GcPrefs, ids: readonly string[]): GcPrefs {
  const released = { ...prefs.released }
  const releasedFrom = { ...prefs.releasedFrom }
  for (const id of ids) {
    delete released[id]
    delete releasedFrom[id]
  }
  return { ...prefs, released, releasedFrom }
}

export function withAcknowledged(prefs: GcPrefs): GcPrefs {
  return { ...prefs, firstReportAcknowledged: true }
}

export function withShelveAcknowledged(prefs: GcPrefs): GcPrefs {
  return { ...prefs, shelve: { ...prefs.shelve, firstReportAcknowledged: true } }
}

export function withDockerAcknowledged(prefs: GcPrefs): GcPrefs {
  return { ...prefs, docker: { ...prefs.docker, firstReportAcknowledged: true } }
}

/** The failure-streak kill switch of Docker autonomy: it switches itself off; everything else stays. */
export function withDockerDisabled(prefs: GcPrefs): GcPrefs {
  return { ...prefs, docker: { ...prefs.docker, enabled: false } }
}

/** The failure-streak kill switch: shelving switches itself off; everything else stays. */
export function withShelveDisabled(prefs: GcPrefs): GcPrefs {
  return { ...prefs, shelve: { ...prefs.shelve, enabled: false } }
}
