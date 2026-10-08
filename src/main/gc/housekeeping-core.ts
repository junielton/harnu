import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type VolumeFact
} from '../containers/containers-core'

export interface HousekeepingParams {
  /** Build cache older than this is pruned. Zero or negative disables the prune. */
  cacheMaxAgeDays: number
  danglingImages: boolean
  /**
   * Plan orphan-volume removal. Volumes cannot be restored, so this means "this
   * is a manual, operator-confirmed run": the autopilot never sets it, and
   * orphan volumes reach the Needs review bucket for a human click instead.
   */
  orphanVolumes: boolean
}
export interface HousekeepingPlan {
  builderPruneUntilHours: number | null
  danglingImages: boolean
  orphanVolumes: string[]
}
export interface HousekeepingResult {
  buildCacheBytes: number
  imageBytes: number
  volumeBytes: number
  errors: string[]
}
/** `VolumeFact` carries no name; `docker volume rm` needs one. */
export interface HousekeepingVolume extends VolumeFact {
  name: string
}

/** Docker's own volume-name grammar; anything else could be read as a flag. */
const SAFE_VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

function untilHours(days: number): number | null {
  if (!Number.isFinite(days) || days <= 0) return null
  return Math.max(1, Math.ceil(days * 24))
}

/**
 * Decide what housekeeping to run: the build-cache age cutoff (null when
 * disabled), whether to prune dangling images, and the orphan volume names.
 *
 * Orphan volumes are only planned when `p.orphanVolumes` is set, which means a
 * manual, operator-confirmed run. The autopilot never removes volumes.
 *
 * `knownFolders` is every folder Harnu knows; a volume whose compose project
 * name matches the default project name of one that still exists is never
 * planned (see {@link composeProjectName}).
 */
export function planHousekeeping(
  p: HousekeepingParams,
  volumes: readonly HousekeepingVolume[],
  containers: readonly InspectedContainer[],
  dirExists: (path: string) => boolean,
  knownFolders: readonly string[],
  protectedProjects: ReadonlySet<string> = new Set(),
  rememberedDirs: ReadonlyMap<string, readonly string[]> = new Map(),
  /** A compose name somewhere could not be resolved: no volume is provably foreign, so none is planned. */
  protectAllProjects = false
): HousekeepingPlan {
  return {
    builderPruneUntilHours: untilHours(p.cacheMaxAgeDays),
    danglingImages: p.danglingImages,
    orphanVolumes:
      p.orphanVolumes && !protectAllProjects
        ? orphanVolumeNames(
            volumes,
            containers,
            dirExists,
            knownFolders,
            protectedProjects,
            rememberedDirs
          )
        : []
  }
}

/**
 * A compose project name the way compose normalizes it: lowercased, every character outside
 * `[a-z0-9_-]` removed, and any leading `_` or `-` trimmed (a project name must start with a
 * letter or a digit). Applied to a folder's basename and to an explicit name alike.
 */
export function normalizeComposeProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '')
}

/**
 * The default compose project name of a folder: its basename, normalized. Two checkouts that
 * share a basename therefore share a project, and so share volume names.
 */
function composeProjectName(folder: string): string {
  const base =
    folder
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? ''
  return normalizeComposeProjectName(base)
}

/**
 * Orphan = labeled with a compose project, referenced by no container (running
 * or stopped), and every working dir known for that project is gone. Kept, never
 * planned, when:
 * - the project's dir cannot be learned: no container carries it, or any
 *   container of the project lacks the working-dir label (unprovable);
 * - an existing known folder has the same default project name, because that
 *   checkout may own the volume even though it has no containers right now;
 * - `protectedProjects` names it: a live folder pins that project name explicitly
 *   (`COMPOSE_PROJECT_NAME` or a compose `name:`), which no basename comparison can see.
 */
function orphanVolumeNames(
  volumes: readonly HousekeepingVolume[],
  containers: readonly InspectedContainer[],
  dirExists: (path: string) => boolean,
  knownFolders: readonly string[],
  protectedProjects: ReadonlySet<string>,
  rememberedDirs: ReadonlyMap<string, readonly string[]>
): string[] {
  const referenced = new Set<string>()
  const dirsByProject = new Map<string, Set<string>>()
  const unknownDirProjects = new Set<string>()
  for (const c of containers) {
    for (const m of c.mounts) if (m.name) referenced.add(m.name)
    const project = c.labels[COMPOSE_PROJECT_LABEL]
    if (!project) continue
    const dir = c.labels[COMPOSE_WORKING_DIR_LABEL]
    if (!dir) {
      unknownDirProjects.add(project)
      continue
    }
    const dirs = dirsByProject.get(project) ?? new Set<string>()
    dirs.add(dir)
    dirsByProject.set(project, dirs)
  }
  // Folders a cleaned worktree ran from. Once its containers are gone, nothing else says where
  // the project lived; every remembered folder must be gone too, like every labelled one.
  for (const [project, dirs] of rememberedDirs) {
    const known = dirsByProject.get(project) ?? new Set<string>()
    for (const d of dirs) known.add(d)
    if (known.size > 0) dirsByProject.set(project, known)
  }
  const liveProjects = new Set(knownFolders.filter(dirExists).map(composeProjectName))
  return volumes
    .filter((v) => {
      if (!SAFE_VOLUME_NAME.test(v.name) || referenced.has(v.name) || !v.project) return false
      if (
        unknownDirProjects.has(v.project) ||
        liveProjects.has(v.project) ||
        protectedProjects.has(v.project)
      ) {
        return false
      }
      const dirs = dirsByProject.get(v.project)
      return !!dirs && dirs.size > 0 && [...dirs].every((d) => !dirExists(d))
    })
    .map((v) => v.name)
}

/** One argv per docker invocation, without the leading `docker`. Never `-a`, never `system prune`. */
export function housekeepingArgv(plan: HousekeepingPlan): string[][] {
  const argv: string[][] = []
  const h = plan.builderPruneUntilHours
  if (h !== null && Number.isInteger(h) && h >= 1) {
    argv.push(['builder', 'prune', '-f', '--filter', `until=${h}h`])
  }
  if (plan.danglingImages) argv.push(['image', 'prune', '-f'])
  for (const name of plan.orphanVolumes) {
    if (SAFE_VOLUME_NAME.test(name)) argv.push(['volume', 'rm', name])
  }
  return argv
}

const UNIT_BYTES: Record<string, number> = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, p: 1e15 }
const SIZE = /^(\d+(?:\.\d+)?)\s*([kmgtp]?)(i?)b$/i
const TOTAL_LINE = /^total(?: reclaimed space)?:/i

/**
 * Bytes from docker's `Total reclaimed space: 1.2GB` (image/volume prune) or
 * `Total:\t1.2GB` (builder prune); a bare size also parses. Anything else is 0.
 */
export function parseReclaimed(stdout: string): number {
  const lines = stdout.split('\n').map((l) => l.trim())
  const total = lines.find((l) => TOTAL_LINE.test(l))
  const text = total ? total.slice(total.indexOf(':') + 1).trim() : stdout.trim()
  const m = SIZE.exec(text)
  if (!m) return 0
  const unit = m[2].toLowerCase()
  if (m[3] && !unit) return 0
  const base = m[3] ? 1024 : 1000
  const mult = unit ? (m[3] ? base ** ('kmgtp'.indexOf(unit) + 1) : UNIT_BYTES[unit]) : 1
  const bytes = Math.round(Number(m[1]) * mult)
  return Number.isFinite(bytes) ? bytes : 0
}
