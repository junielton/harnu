// Pure helpers that prepare what the Docker housekeeping planner needs and what the Needs review
// bucket shows for orphan volumes (design: workspace-gc §5, operator decision: the autopilot
// never removes a volume outside a ready bundle). No I/O: the shell reads the files and
// stats the paths, these functions interpret the results.

import { statProvesGone, type VolumeFact } from '../containers/containers-core'
import { normalizeComposeProjectName, type HousekeepingVolume } from './housekeeping-core'
import { projectNamesFromFiles, readValue, type ProjectFile } from './gc-project-files'

// ---- explicit compose project names -------------------------------------------------

const ENV_LINE = /^\s*(?:export\s+)?COMPOSE_PROJECT_NAME\s*=\s*(.*)$/
const NAME_LINE = /^name:\s*(.*)$/

/**
 * The project names a folder pins itself: `COMPOSE_PROJECT_NAME` in its `.env` and the
 * top-level `name:` of a compose file. Both are returned when both exist, since which one
 * wins depends on how compose is invoked and protecting too much is the safe direction. A
 * value that needs a variable we cannot read is skipped, never guessed. Names come back
 * normalized the way compose normalizes them.
 */
export function explicitProjectNames(sources: { env?: string; compose?: string }): string[] {
  const out = new Set<string>()
  const add = (raw: string | undefined): void => {
    if (raw === undefined) return
    const value = readValue(raw)
    const name = value === null ? '' : normalizeComposeProjectName(value)
    if (name) out.add(name)
  }
  for (const line of (sources.env ?? '').split(/\r?\n/)) add(ENV_LINE.exec(line)?.[1])
  for (const line of (sources.compose ?? '').split(/\r?\n/)) add(NAME_LINE.exec(line)?.[1])
  return [...out]
}

/** What is read from one known folder to learn the project names it pins. */
export interface ProjectSource {
  path: string
  /** The root `.env` and compose file, as one text each. */
  env?: string
  compose?: string
  /** Every `.env` and compose file down to depth 3, from {@link collectProjectFiles}. */
  files?: ProjectFile[]
}

/** The names a source pins, and whether one of them could not be resolved. */
export function sourceProjectNames(source: ProjectSource): {
  names: string[]
  unresolved: boolean
} {
  const fromFiles = projectNamesFromFiles(source.files ?? [])
  const names = new Set([...explicitProjectNames(source), ...fromFiles.names])
  return { names: [...names], unresolved: fromFiles.unresolved }
}

/**
 * Explicit project names of every folder that still exists. A folder that is gone protects
 * nothing: its own volumes are exactly what an operator-confirmed run may remove.
 */
export function protectedProjects(
  folders: ReadonlyArray<ProjectSource>,
  dirExists: (path: string) => boolean
): Set<string> {
  const out = new Set<string>()
  for (const f of folders) {
    if (!dirExists(f.path)) continue
    for (const name of sourceProjectNames(f).names) out.add(name)
  }
  return out
}

// ---- existence, failing closed --------------------------------------------------------

/**
 * Stats every distinct path. Only a missing entry (ENOENT, ENOTDIR) proves a folder gone;
 * any other outcome (EACCES, EIO, a timeout, an error with no code, a remote docker context
 * whose paths are not ours) leaves it counted as existing, so it protects what it may own.
 */
export async function statExistence(
  paths: Iterable<string>,
  stat: (path: string) => Promise<unknown>
): Promise<{ checked: Set<string>; existing: Set<string> }> {
  const checked = new Set<string>()
  const existing = new Set<string>()
  await Promise.all(
    [...new Set(paths)].map(async (p) => {
      checked.add(p)
      try {
        await stat(p)
        existing.add(p)
      } catch (err) {
        if (!statProvesGone(err)) existing.add(p)
      }
    })
  )
  return { checked, existing }
}

/** The synchronous predicate the planner takes. A path nobody checked is assumed to exist. */
export function makeDirExists(
  checked: ReadonlySet<string>,
  existing: ReadonlySet<string>
): (path: string) => boolean {
  return (p) => !checked.has(p) || existing.has(p)
}

// ---- volumes ----------------------------------------------------------------------------

/** `VolumeFact` carries no name; `docker volume rm` and the planner need one. */
export function toHousekeepingVolumes(df: ReadonlyMap<string, VolumeFact>): HousekeepingVolume[] {
  return [...df].map(([name, fact]) => ({ name, ...fact }))
}

/** A volume offered in Needs review: removed only by an explicit, confirmed operator action. */
export interface OrphanVolumeItem {
  id: string
  name: string
  sizeBytes: number | null
  project: string | null
  reason: { code: 'no-known-worktree'; detail: string }
}

export const volumeItemId = (name: string): string => `volume:${name}`

/** Review entries for the planner's orphan names, biggest first. Volumes are not restorable. */
export function orphanVolumeItems(
  names: readonly string[],
  df: ReadonlyMap<string, VolumeFact>
): OrphanVolumeItem[] {
  return names
    .map((name): OrphanVolumeItem => {
      const fact = df.get(name)
      const project = fact?.project ?? null
      return {
        id: volumeItemId(name),
        name,
        sizeBytes: fact?.sizeBytes ?? null,
        project,
        reason: {
          code: 'no-known-worktree',
          detail: project
            ? `No known worktree uses the compose project "${project}".`
            : 'No known worktree uses this volume.'
        }
      }
    })
    .sort((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1) || a.name.localeCompare(b.name))
}

// ---- what keeps a bundle from owning a volume ---------------------------------------------

/**
 * The two inputs `buildBundles` needs so that a worktree never owns a volume another folder
 * may still use (T441 delta 1, item 1): the folders that exist, and the compose project names
 * they pin. It is the orphan planner's own rule, read from the same files with the same
 * fail-closed existence, plus the trimmed default name of a folder whose name starts with `_`
 * or `-`, which the bundle builder's untrimmed default cannot see. Deliberately blunt: a name
 * pinned by the bundle's own folder protects its volume too, so such a worktree leaves the
 * volume behind, where it shows up as an orphan for the operator to decide on.
 */
export function volumeGuards(
  folders: ReadonlyArray<ProjectSource>,
  dirExists: (path: string) => boolean
): { knownFolders: string[]; protectedProjects: Set<string>; unresolved: boolean } {
  const existing = folders.filter((f) => dirExists(f.path))
  const names = protectedProjects(folders, dirExists)
  for (const f of existing) {
    const base =
      f.path
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() ?? ''
    if (/^[_-]/.test(base)) {
      const trimmed = normalizeComposeProjectName(base)
      if (trimmed) names.add(trimmed)
    }
  }
  // A name some folder writes but we cannot resolve could be any project's: nothing is then
  // provably foreign, and the orphan planner lists no volume at all until it is resolved.
  const unresolved = existing.some((f) => sourceProjectNames(f).unresolved)
  return { knownFolders: existing.map((f) => f.path), protectedProjects: names, unresolved }
}

/**
 * Every path whose existence the gather must really check: the folders Harnu knows, the
 * compose working dirs of the containers, and the folders cleaned worktrees ran from
 * (`gc-left-volumes.json`). One left out reads as "exists" through {@link makeDirExists}, so
 * a leftover volume would surface for review only by luck.
 */
export function existenceCandidates(sources: {
  known: readonly string[]
  workingDirs: readonly string[]
  remembered: ReadonlyMap<string, readonly string[]>
}): string[] {
  return [
    ...new Set([
      ...sources.known,
      ...sources.workingDirs,
      ...[...sources.remembered.values()].flat()
    ])
  ]
}

/** The existence predicate over those paths: missing is gone, any other stat outcome exists. */
export async function buildDirExists(
  paths: Iterable<string>,
  stat: (path: string) => Promise<unknown>
): Promise<(path: string) => boolean> {
  const { checked, existing } = await statExistence(paths, stat)
  return makeDirExists(checked, existing)
}
