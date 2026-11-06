// Pure core of Docker garbage removal (autonomous cleanup U3.3, design §4 U3 "Garbage", C3, C8).
//
// No I/O. U3.2's facts (which compose networks are empty and not external) and the Containers
// scan's stack verdicts go in; out comes what Cleanup may remove on its own:
//   - every empty compose network the facts call `garbage`, and
//   - every stack whose verdict is `orphan` (its attributed folder is gone),
// minus any stack that belongs to a SHELVED worktree (its folder is gone on purpose, so its stack
// is not an orphan: the C3 analogue) and minus everything when the shelved list is unreadable.
//
// Nothing here ever names a volume to remove. An orphan's volumes are listed only so the journal
// can say they were kept.

import { canonicalPathKey } from './bundle-core'
import { isInside } from '../containers/containers-core'
import type { StackRow } from '../containers/containers-wire'
import type {
  DockerNetworkFact,
  EmptyNetworkPlan,
  HeldReason
} from '../containers/docker-networks-core'
import type { DockerAction } from './docker-cycle'

export interface GarbageNetwork {
  id: string
  name: string
  project: string | null
}

export interface GarbageStack {
  /** `StackRow.id`: the compose project name, or the container name. */
  stack: string
  name: string
  project: string | null
  kind: 'compose' | 'container'
  /** Every container the stack had when it was decided on, running or not. */
  containerIds: string[]
  /** True when any of them was running: the executor stops them first. */
  running: boolean
  /** The folder the stack was attributed to (gone). */
  worktreePath: string | null
  /** Named and anonymous volumes the stack mounts. They are kept, never removed. */
  volumes: string[]
}

export interface GarbagePlan {
  networks: GarbageNetwork[]
  stacks: GarbageStack[]
  /** Empty networks that stay, and why (reported, never removed). */
  held: { network: DockerNetworkFact; reason: HeldReason }[]
  /** Orphans left alone, and why. */
  excluded: { stack: string; why: 'shelved' | 'store-unreadable' }[]
}

export interface GarbagePlanInput {
  networks: EmptyNetworkPlan
  stacks: readonly StackRow[]
  /** Folders of shelved worktrees, or null when the store could not be read (fail closed). */
  shelvedPaths: readonly string[] | null
  platform?: string
}

/** The folders a stack is attributed to: the compose working dir and the Harnu folder around it. */
function anchorsOf(s: Pick<StackRow, 'attribution'>): string[] {
  return [s.attribution.path, s.attribution.folderPath].filter((p): p is string => !!p)
}

function inShelved(
  s: Pick<StackRow, 'attribution'>,
  shelvedPaths: readonly string[],
  platform: string
): boolean {
  const shelved = shelvedPaths.map((p) => canonicalPathKey(p, platform))
  return anchorsOf(s).some((a) => {
    const key = canonicalPathKey(a, platform)
    return shelved.some((w) => isInside(key, w))
  })
}

export function planDockerGarbage(input: GarbagePlanInput): GarbagePlan {
  const platform = input.platform ?? process.platform
  const plan: GarbagePlan = {
    networks: input.networks.garbage.map((n) => ({ id: n.id, name: n.name, project: n.project })),
    stacks: [],
    held: [...input.networks.held],
    excluded: []
  }
  for (const s of input.stacks) {
    if (s.verdict !== 'orphan') continue
    if (input.shelvedPaths === null) {
      plan.excluded.push({ stack: s.id, why: 'store-unreadable' })
      continue
    }
    if (inShelved(s, input.shelvedPaths, platform)) {
      plan.excluded.push({ stack: s.id, why: 'shelved' })
      continue
    }
    plan.stacks.push({
      stack: s.id,
      name: s.name,
      project: s.project,
      kind: s.kind,
      containerIds: s.containers.map((c) => c.id),
      running: s.running,
      worktreePath: s.attribution.path,
      volumes: s.volumes.map((v) => v.name)
    })
  }
  return plan
}

// ---- sentences (the Activity line the digest reads) -----------------------------------------------

export const networkReasonLine = (name: string): string =>
  `Removed empty network \`${name}\` — no containers`

export const orphanReasonLine = (project: string, volumes: readonly string[]): string =>
  `Removed orphan stack \`${project}\` — worktree gone, volumes kept: ${
    volumes.length > 0 ? volumes.join(', ') : 'none'
  }`

export const NETWORK_ACTION_PREFIX = 'net:'
export const STACK_ACTION_PREFIX = 'stack:'

/** What the Docker cycle slot is handed: networks first (cheap, regenerable), then orphan stacks. */
export function garbageActions(plan: GarbagePlan): DockerAction[] {
  return [
    ...plan.networks.map((n): DockerAction => ({
      kind: 'prune-network',
      id: `${NETWORK_ACTION_PREFIX}${n.id}`,
      reason: networkReasonLine(n.name)
    })),
    ...plan.stacks.map((s): DockerAction => ({
      kind: 'remove-orphan',
      id: `${STACK_ACTION_PREFIX}${s.stack}`,
      reason: orphanReasonLine(s.project ?? s.name, s.volumes)
    }))
  ]
}

// ---- the re-probe (AC-2) ------------------------------------------------------------------------

const CHANGED = 'changed since decided'

/**
 * Whether a stack decided on earlier may still be removed. Null when it may; otherwise the sentence
 * for "changed since decided". Fewer containers than planned is fine (part of it is already gone);
 * a container nobody looked at is not.
 */
export function orphanChangedSince(
  target: GarbageStack,
  fresh: StackRow,
  shelvedPaths: readonly string[] | null,
  platform: string = process.platform
): string | null {
  if (fresh.verdict !== 'orphan') return `${CHANGED}: its verdict is now ${fresh.verdict}`
  const known = new Set(target.containerIds)
  if (fresh.containers.some((c) => !known.has(c.id))) {
    return `${CHANGED}: a container appeared that the plan never listed`
  }
  if (shelvedPaths === null) {
    return `${CHANGED}: the list of shelved worktrees cannot be read, so the stack is left alone`
  }
  if (inShelved(fresh, shelvedPaths, platform)) {
    return `${CHANGED}: its worktree is shelved, not removed`
  }
  return null
}
