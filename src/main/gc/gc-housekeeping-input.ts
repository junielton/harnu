// Pure helpers that prepare what the Docker housekeeping planner needs and what the Decide
// bucket shows for orphan volumes (design: workspace-gc §5, operator decision: the autopilot
// never removes a volume outside a corpse bundle). No I/O: the shell reads the files and
// stats the paths, these functions interpret the results.

import { statProvesGone, type VolumeFact } from '../containers/containers-core'
import { normalizeComposeProjectName, type HousekeepingVolume } from './housekeeping-core'

// ---- explicit compose project names -------------------------------------------------

const ENV_LINE = /^\s*(?:export\s+)?COMPOSE_PROJECT_NAME\s*=\s*(.*)$/
const NAME_LINE = /^name:\s*(.*)$/
const INTERPOLATED_DEFAULT = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}]*)\}$/

/** Strips a trailing comment and surrounding quotes; null when the value cannot be resolved. */
function readValue(raw: string): string | null {
  let v = raw.trim()
  const quote = v[0] === '"' || v[0] === "'" ? v[0] : null
  if (quote) {
    const end = v.indexOf(quote, 1)
    v = end > 0 ? v.slice(1, end) : v.slice(1)
  } else {
    const hash = v.search(/\s#/)
    if (hash >= 0) v = v.slice(0, hash)
    v = v.trim()
  }
  if (v.includes('$')) {
    const fallback = INTERPOLATED_DEFAULT.exec(v)?.[1]
    return fallback ? fallback.trim() : null
  }
  return v
}

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

/**
 * Explicit project names of every folder that still exists. A folder that is gone protects
 * nothing: its own volumes are exactly what an operator-confirmed run may remove.
 */
export function protectedProjects(
  folders: ReadonlyArray<{ path: string; env?: string; compose?: string }>,
  dirExists: (path: string) => boolean
): Set<string> {
  const out = new Set<string>()
  for (const f of folders) {
    if (!dirExists(f.path)) continue
    for (const name of explicitProjectNames(f)) out.add(name)
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

/** A volume offered in Decide: removed only by an explicit, confirmed operator action. */
export interface OrphanVolumeItem {
  id: string
  name: string
  sizeBytes: number | null
  project: string | null
  reason: { code: 'no-known-worktree'; detail: string }
}

export const volumeItemId = (name: string): string => `volume:${name}`

/** Decide entries for the planner's orphan names, biggest first. Volumes are not restorable. */
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
