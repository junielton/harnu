// What a cleaned worktree leaves in Docker (D1, 2026-10-08: worktree cleanup never removes a
// volume). Once the stack's containers are gone, nothing on the machine says which folder its
// compose project ran from, so the orphan planner could never call its volumes orphans. The
// cleanup therefore remembers `project → folders` for what it leaves behind, and the planner
// reads that. A forgotten entry only ever means "no longer offered for review", never a
// removal. Pure helpers, plus a tiny synchronous file shell that takes the path.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import type { WorktreeBundle } from './bundle-core'
import type { HousekeepingVolume } from './housekeeping-core'

export interface LeftoverFile {
  version: 1
  /** Compose project name → the folders it ran from. */
  projects: Record<string, string[]>
}

export interface Leftover {
  project: string
  dir: string
}

export const LEFTOVERS_FILE = 'gc-left-volumes.json'

export const emptyLeftovers = (): LeftoverFile => ({ version: 1, projects: {} })

/**
 * The compose projects whose volumes a cleaned bundle leaves, with the folder they ran from.
 * Only a volume that carries a project label can be tied to anything, so only those count.
 */
export function leftBehind(b: WorktreeBundle, volumes: readonly HousekeepingVolume[]): Leftover[] {
  const dir = b.item.path
  if (!dir) return []
  const byName = new Map(volumes.map((v) => [v.name, v]))
  const projects = new Set<string>()
  for (const name of b.ownedVolumes) {
    const project = byName.get(name)?.project
    if (project) projects.add(project)
  }
  return [...projects].map((project) => ({ project, dir }))
}

export function withLeftovers(file: LeftoverFile, entries: readonly Leftover[]): LeftoverFile {
  const projects: Record<string, string[]> = {}
  for (const [p, dirs] of Object.entries(file.projects)) projects[p] = [...dirs]
  for (const { project, dir } of entries) {
    const dirs = projects[project] ?? []
    if (!dirs.includes(dir)) dirs.push(dir)
    projects[project] = dirs
  }
  return { version: 1, projects }
}

/** Forgets a project once Docker has no volume of it: there is nothing left to review. */
export function pruneLeftovers(
  file: LeftoverFile,
  volumes: readonly HousekeepingVolume[]
): LeftoverFile {
  const alive = new Set(volumes.flatMap((v) => (v.project ? [v.project] : [])))
  return {
    version: 1,
    projects: Object.fromEntries(Object.entries(file.projects).filter(([p]) => alive.has(p)))
  }
}

export function toDirMap(file: LeftoverFile): Map<string, string[]> {
  return new Map(Object.entries(file.projects))
}

/** Never throws: a missing or damaged file just means nothing is remembered. */
export function readLeftovers(file: string): LeftoverFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown }
    if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) {
      return emptyLeftovers()
    }
    const projects: Record<string, string[]> = {}
    for (const [p, dirs] of Object.entries(raw.projects)) {
      if (!Array.isArray(dirs)) continue
      const clean = dirs.filter((d): d is string => typeof d === 'string' && d.length > 0)
      if (clean.length > 0) projects[p] = clean
    }
    return { version: 1, projects }
  } catch {
    return emptyLeftovers()
  }
}

/** Atomic: write `<file>.tmp`, then rename over the target. */
export function writeLeftovers(file: string, data: LeftoverFile): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}
