// What a removed worktree's Docker stack leaves behind (unit D, AC-D3). The cleanup stops and
// removes the stack's containers, but `docker rm` leaves the compose network, and a container that
// could not be removed (or one created after the clean) stays too. Without this they sit in
// Docker forever, and the only way to get rid of them is a terminal.
//
// Only a compose project the cleanup itself remembered (gc-leftovers.ts) is ever offered, and only
// while none of its folders exists any more and nothing of it runs. Containers and networks are
// removed one at a time, never with force, and never a volume: volumes cannot be restored, so they
// are listed beside this and removed only by their own confirm (rule D1, the orphan-volume path).
// Pure over an injected `docker` runner; the real one is bound in gc-ipc.

import { COMPOSE_PROJECT_LABEL, COMPOSE_WORKING_DIR_LABEL } from '../containers/containers-core'
import type { InspectedContainer } from '../containers/containers-core'
import type { OrphanVolumeItem } from './gc-housekeeping-input'
import type { GcExpected } from './gc-wire'

export interface StackLeftoverItem {
  /** `stack-leftover:<project>` */
  id: string
  /** The compose project the removed worktree's stack ran as. */
  project: string
  /** The folders the cleanup remembers it ran from, all gone. */
  dirs: string[]
  /** Containers that are not running. */
  containers: Array<{ id: string; name: string; state: string }>
  networks: Array<{ id: string; name: string }>
  /** Volumes of the project nothing mounts: listed apart, removed only by their own confirm. */
  volumes: Array<{ id: string; name: string; sizeBytes: number | null }>
}

export const STACK_LEFTOVER_PREFIX = 'stack-leftover:'
export const stackLeftoverId = (project: string): string => `${STACK_LEFTOVER_PREFIX}${project}`

export interface NetworkFact {
  id: string
  name: string
  project: string
}

/** Docker names and ids: a plain word that can never be read as a flag. */
const SAFE_DOCKER_REF = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** Container states that mean something may still be using the stack. */
const ACTIVE_STATES = new Set(['running', 'restarting', 'paused'])

export interface StackLeftoverInput {
  /** Compose project → the folders it ran from, as the cleanup remembered them. */
  remembered: ReadonlyMap<string, readonly string[]>
  /** Whether a folder exists. Fails closed: a folder nobody could stat must answer true. */
  dirExists: (path: string) => boolean
  containers: readonly InspectedContainer[]
  networks: readonly NetworkFact[]
  /** The orphan volumes the housekeeping rules cleared (their own list, their own confirm). */
  orphanVolumes: readonly OrphanVolumeItem[]
  /**
   * Compose project names a live folder owns: the names the main checkout and every existing
   * worktree pin, and the default name each runs as. A remembered project with one of these names
   * is somebody's stack (`myapp` pinned by the main checkout), not a leftover: none of its
   * containers or networks is ever offered.
   */
  protectedProjects?: ReadonlySet<string>
}

/**
 * The leftovers of every remembered project whose folders are all gone and that nothing runs.
 * A project with a running, restarting or paused container, or a container a still-existing
 * folder labels, is left alone entirely: it is not a leftover, it is somebody's stack.
 */
export function planStackLeftovers(input: StackLeftoverInput): StackLeftoverItem[] {
  const items: StackLeftoverItem[] = []
  for (const [project, dirs] of input.remembered) {
    if (!SAFE_DOCKER_REF.test(project) || dirs.length === 0) continue
    if (input.protectedProjects?.has(project)) continue
    if (dirs.some((d) => input.dirExists(d))) continue
    const mine = input.containers.filter((c) => c.labels[COMPOSE_PROJECT_LABEL] === project)
    if (mine.some((c) => ACTIVE_STATES.has(c.state))) continue
    if (
      mine.some((c) => {
        const dir = c.labels[COMPOSE_WORKING_DIR_LABEL]
        return !!dir && input.dirExists(dir)
      })
    ) {
      continue
    }
    const item: StackLeftoverItem = {
      id: stackLeftoverId(project),
      project,
      dirs: [...dirs],
      containers: mine.map((c) => ({ id: c.id, name: c.name, state: c.state })),
      networks: input.networks
        .filter((n) => n.project === project)
        .map((n) => ({ id: n.id, name: n.name })),
      volumes: input.orphanVolumes
        .filter((v) => v.project === project)
        .map((v) => ({ id: v.id, name: v.name, sizeBytes: v.sizeBytes }))
    }
    if (item.containers.length + item.networks.length + item.volumes.length > 0) items.push(item)
  }
  return items.sort((a, b) => (a.project < b.project ? -1 : 1))
}

// ---- docker -------------------------------------------------------------------------------------

export type DockerRun = (argv: readonly string[]) => Promise<{ stdout: string }>

/** `docker network ls` rows: `<id>\t<name>\t<compose project>`. Rows with no project are not ours. */
export function parseNetworkList(stdout: string): NetworkFact[] {
  const out: NetworkFact[] = []
  for (const line of stdout.split('\n')) {
    const [id, name, project] = line.split('\t').map((x) => x.trim())
    if (!id || !name || !project) continue
    if (
      !SAFE_DOCKER_REF.test(id) ||
      !SAFE_DOCKER_REF.test(name) ||
      !SAFE_DOCKER_REF.test(project)
    ) {
      continue
    }
    out.push({ id, name, project })
  }
  return out
}

/** Every compose-labelled network. Throws when docker cannot answer: that is "unknown", not "none". */
export async function listComposeNetworks(run: DockerRun): Promise<NetworkFact[]> {
  const { stdout } = await run([
    'network',
    'ls',
    '--filter',
    `label=${COMPOSE_PROJECT_LABEL}`,
    '--format',
    `{{.ID}}\t{{.Name}}\t{{.Label "${COMPOSE_PROJECT_LABEL}"}}`
  ])
  return parseNetworkList(stdout)
}

export interface StackCleanupResult {
  removedContainers: number
  removedNetworks: number
  errors: string[]
}

const firstLine = (err: unknown): string => {
  const e = err as { stderr?: unknown; message?: unknown }
  const text =
    typeof e?.stderr === 'string' && e.stderr.trim() ? e.stderr : String(e?.message ?? err)
  return text.trim().split('\n')[0]!.slice(0, 300)
}

/**
 * Removes the item's containers, then its networks, one id per docker call: never `-f`, never `-v`,
 * never a volume. A refusal (a container that is running after all, a network with active
 * endpoints) is reported and the rest still go.
 */
export async function runStackLeftoverCleanup(
  item: Pick<StackLeftoverItem, 'containers' | 'networks'>,
  run: DockerRun
): Promise<StackCleanupResult> {
  const result: StackCleanupResult = { removedContainers: 0, removedNetworks: 0, errors: [] }
  for (const c of item.containers) {
    if (!SAFE_DOCKER_REF.test(c.id)) {
      result.errors.push(`docker rm ${c.id}: not a container id`)
      continue
    }
    try {
      await run(['rm', c.id])
      result.removedContainers++
    } catch (err) {
      result.errors.push(`docker rm ${c.name}: ${firstLine(err)}`)
    }
  }
  for (const n of item.networks) {
    if (!SAFE_DOCKER_REF.test(n.id)) {
      result.errors.push(`docker network rm ${n.id}: not a network id`)
      continue
    }
    try {
      await run(['network', 'rm', n.id])
      result.removedNetworks++
    } catch (err) {
      result.errors.push(`docker network rm ${n.name}: ${firstLine(err)}`)
    }
  }
  return result
}

// ---- the confirm ----------------------------------------------------------------------------------

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

/** The facts a Cleanup row shows for a stack leftover. Volumes are not part of it (their own confirm). */
export function stackLeftoverExpectedOf(item: StackLeftoverItem): GcExpected {
  return {
    bucket: 'stack-leftover',
    reasonCode: null,
    headSha: null,
    stackIds: sorted(item.containers.map((c) => c.id)),
    ownedVolumes: [],
    networkIds: sorted(item.networks.map((n) => n.id)),
    bytes: null,
    path: null,
    project: item.project
  }
}

const addedTo = (fresh: readonly string[], seen: readonly string[]): boolean => {
  const known = new Set(seen)
  return fresh.some((x) => !known.has(x))
}

/**
 * What differs from what the operator was shown. Fewer containers or networks are fine (part of it
 * is already gone); any new one was never looked at.
 */
export function stackLeftoversChangedSince(
  item: StackLeftoverItem,
  seen: GcExpected
): 'bucket' | 'project' | 'container' | 'network' | null {
  if (seen.bucket !== 'stack-leftover') return 'bucket'
  if (item.project !== (seen.project ?? null)) return 'project'
  if (
    addedTo(
      item.containers.map((c) => c.id),
      seen.stackIds
    )
  )
    return 'container'
  if (
    addedTo(
      item.networks.map((n) => n.id),
      seen.networkIds ?? []
    )
  )
    return 'network'
  return null
}
