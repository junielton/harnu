// What the sidebar's own Remove (`worktree:remove`) leaves in Docker (unit D, AC-D3). The cleanup
// engine remembers the compose projects of the stacks it removes so their leftovers can be offered
// later; a worktree removed from the sidebar leaves the very same containers and networks, so it is
// remembered the same way, detected from the folder before it goes: Docker's own labels (a
// container whose compose working dir or bind mount lies in the folder) and the project names the
// folder pins itself (`COMPOSE_PROJECT_NAME`, a compose `name:`). Best-effort: it never throws and
// never blocks a removal.

import { promises as fs } from 'node:fs'
import { isInside, COMPOSE_PROJECT_LABEL } from '../containers/containers-core'
import type { InspectedContainer } from '../containers/containers-core'
import { containerFolderPaths } from './bundle-core'
import { scanProjectFiles, projectNamesFromFiles, type FsProbe } from './gc-project-files'
import { rememberLeftovers } from './gc-leftover-registry'

/** The compose projects with a container running from `folder`, plus the names it pins, once each. */
export function projectsRunningFrom(
  folder: string,
  containers: readonly InspectedContainer[],
  pinnedNames: readonly string[]
): string[] {
  const out = new Set<string>()
  for (const c of containers) {
    const project = c.labels[COMPOSE_PROJECT_LABEL]
    if (!project) continue
    if (containerFolderPaths(c).some((d) => isInside(d, folder))) out.add(project)
  }
  for (const n of pinnedNames) out.add(n)
  return [...out]
}

export interface RemovedStackDeps {
  /** Containers Docker lists now; throws when Docker cannot answer. */
  containers?: () => Promise<InspectedContainer[]>
  /** The compose project names the folder pins. */
  pinnedNames?: (folder: string) => Promise<string[]>
}

const fsProbe: FsProbe = {
  readdir: async (dir) =>
    (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      name: e.name,
      isDir: e.isDirectory()
    })),
  readFile: async (file) => {
    try {
      const st = await fs.stat(file)
      return st.isFile() && st.size <= 256 * 1024 ? await fs.readFile(file, 'utf8') : undefined
    } catch {
      return undefined
    }
  }
}

async function realPinnedNames(folder: string): Promise<string[]> {
  return projectNamesFromFiles((await scanProjectFiles(folder, fsProbe)).files).names
}

async function realContainers(): Promise<InspectedContainer[]> {
  const { inspectAll } = await import('../containers/containers-shell')
  return inspectAll({ strict: true })
}

/** Remembers the compose projects of `folder` as left behind by its removal. Never throws. */
export async function rememberStacksOfFolder(
  folder: string,
  deps: RemovedStackDeps = {}
): Promise<void> {
  try {
    let containers: InspectedContainer[] = []
    try {
      containers = await (deps.containers ?? realContainers)()
    } catch {
      // Docker is down or absent: only the names the folder pins can be remembered.
    }
    const pinned = await (deps.pinnedNames ?? realPinnedNames)(folder).catch(() => [])
    rememberLeftovers(
      projectsRunningFrom(folder, containers, pinned).map((project) => ({ project, dir: folder }))
    )
  } catch (err) {
    console.warn('[gc] could not remember the stacks of a removed folder', err)
  }
}
