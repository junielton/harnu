// The planner and executor behind the Docker slot's garbage removal (autonomous cleanup U3.3).
//
// `plan()` gathers U3.2's facts, the Containers scan and the shelved-worktree list, hands them to
// the pure core, and remembers what it decided. `execute()` re-probes the one thing it is about to
// touch and refuses with "changed since decided" if the world moved, then acts. Every docker
// mutation goes through three injected mutators: `docker stop`, `docker rm` (never forced, never
// `-v`) and `docker network rm`. Nothing here can remove a volume: there is no mutator for it, and
// an orphan stack's volumes are only listed in the journal as kept, with who they belonged to.
//
// Orphan stacks are removed through the existing `runContainersAction` (`stop`, then `remove` with
// `removeVolumes: false`) under the actor `autopilot`, so the Containers tier table is enforced a
// second time and the journal is the one the Containers view already reads. The scan it is given
// re-applies this unit's own checks on every call.
//
// Every effect is an injected dep: tests/docker-garbage-shell.test.ts runs it with fakes.

import {
  runContainersAction,
  type ActionDeps,
  type DockerBatchResult
} from '../containers/containers-actions'
import type { ActErrorCode, ContainersSnapshot, Tombstone } from '../containers/containers-wire'
import type { DockerFactsResult } from '../containers/docker-facts-shell'
import type { EmptyNetworkPlan } from '../containers/docker-networks-core'
import type { RemoveNetworkResult } from '../containers/containers-shell'
import type { DockerAction, DockerOutcome } from './docker-cycle'
import {
  NETWORK_ACTION_PREFIX,
  STACK_ACTION_PREFIX,
  garbageActions,
  networkReasonLine,
  orphanChangedSince,
  orphanReasonLine,
  planDockerGarbage,
  type GarbageNetwork,
  type GarbageStack
} from './docker-garbage-core'

/** The only docker mutations garbage removal can make. Volumes are not among them. */
export interface GarbageMutators {
  /** `docker stop <ids>`: graceful, never a kill. */
  stop(ids: string[]): Promise<DockerBatchResult>
  /** `docker rm <ids>`: never `--force`, never `-v`. */
  removeContainers(ids: string[]): Promise<DockerBatchResult>
  /** `docker network rm <id>`. */
  removeNetwork(id: string): Promise<RemoveNetworkResult>
}

export interface GarbageDeps {
  /** U3.2's `readEmptyComposeNetworks`, bound to the real runner. */
  emptyNetworks(): Promise<DockerFactsResult<EmptyNetworkPlan>>
  /** A Containers scan that starts now. */
  scan(): Promise<ContainersSnapshot>
  /** Folders of shelved worktrees. Throws when the store cannot be read: that excludes every orphan. */
  shelvedPaths(): Promise<readonly string[]>
  mutators: GarbageMutators
  /** The Containers journal. */
  appendTombstone(t: Tombstone): Promise<void>
  now(): number
}

export interface DockerGarbage {
  plan(): Promise<DockerAction[]>
  execute(a: DockerAction): Promise<DockerOutcome>
}

const CHANGED = 'changed since decided'
const NO_VOLUMES = 'Docker autonomy never removes volumes'

/** Codes that mean "the world moved, or this is not ours to touch": a refusal, not a fault. */
const REFUSAL_CODES: ReadonlySet<ActErrorCode> = new Set([
  'STACK_NOT_FOUND',
  'STACK_NOT_ATTRIBUTABLE',
  'STACK_IN_USE',
  'STACK_PROTECTED',
  'STACK_PENDING',
  'STACK_RUNNING',
  'WORKTREE_GONE',
  'DOCKER_UNAVAILABLE'
])

const refusal = (reason: string): DockerOutcome => ({ ok: false, reason, refusal: true })
const failure = (reason: string): DockerOutcome => ({ ok: false, reason })
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type Target = { kind: 'network'; network: GarbageNetwork } | { kind: 'stack'; stack: GarbageStack }

export function createDockerGarbage(deps: GarbageDeps): DockerGarbage {
  /** What the last `plan()` decided, by action id. An action runs once, then is forgotten. */
  let targets = new Map<string, Target>()

  const shelvedOrNull = async (): Promise<readonly string[] | null> => {
    try {
      return await deps.shelvedPaths()
    } catch (err) {
      console.warn('[gc] docker garbage: shelved worktrees unreadable', messageOf(err))
      return null
    }
  }

  async function plan(): Promise<DockerAction[]> {
    let networks: EmptyNetworkPlan = { garbage: [], held: [] }
    const facts = await deps.emptyNetworks().catch((err: unknown) => ({
      ok: false as const,
      error: { kind: 'failed' as const, message: messageOf(err) }
    }))
    if (facts.ok) networks = facts.value
    else if (facts.error.kind === 'failed') {
      console.warn('[gc] docker garbage: network facts unreadable', facts.error.message)
    }

    let snap: ContainersSnapshot | null = null
    try {
      snap = await deps.scan()
    } catch (err) {
      console.warn('[gc] docker garbage: scan failed', messageOf(err))
    }
    const stacks = snap && snap.dockerAvailable ? snap.stacks : []

    const garbage = planDockerGarbage({ networks, stacks, shelvedPaths: await shelvedOrNull() })
    targets = new Map<string, Target>([
      ...garbage.networks.map((n): [string, Target] => [
        `${NETWORK_ACTION_PREFIX}${n.id}`,
        { kind: 'network', network: n }
      ]),
      ...garbage.stacks.map((s): [string, Target] => [
        `${STACK_ACTION_PREFIX}${s.stack}`,
        { kind: 'stack', stack: s }
      ])
    ])
    return garbageActions(garbage)
  }

  async function executeNetwork(n: GarbageNetwork): Promise<DockerOutcome> {
    const fresh = await deps.emptyNetworks().catch((err: unknown) => ({
      ok: false as const,
      error: { kind: 'failed' as const, message: messageOf(err) }
    }))
    if (!fresh.ok) {
      return fresh.error.kind === 'docker-unavailable'
        ? refusal('docker is unavailable')
        : failure(`could not re-check network ${n.name}: ${fresh.error.message}`)
    }
    if (!fresh.value.garbage.some((g) => g.id === n.id)) {
      const held = fresh.value.held.find((h) => h.network.id === n.id)
      return refusal(
        held
          ? `${CHANGED}: network ${n.name} is now kept (${held.reason})`
          : `${CHANGED}: network ${n.name} has a container attached or is gone`
      )
    }

    const removed = await deps.mutators.removeNetwork(n.id)
    if (!removed.ok) {
      return removed.active
        ? refusal(`${CHANGED}: network ${n.name} has active endpoints`)
        : failure(`docker network rm ${n.name}: ${removed.error}`)
    }
    try {
      await deps.appendTombstone({
        at: deps.now(),
        actor: 'autopilot',
        verb: 'remove',
        stacks: [],
        restoreHint: null,
        reason: networkReasonLine(n.name)
      })
    } catch (err) {
      return failure(
        `network ${n.name} was removed but the journal write failed: ${messageOf(err)}`
      )
    }
    return { ok: true }
  }

  async function executeOrphan(t: GarbageStack): Promise<DockerOutcome> {
    const label = t.project ?? t.name
    let changed: string | null = null

    // Every scan this action sees re-applies the plan's own checks: a stack that no longer
    // qualifies is dropped from the snapshot, so the Containers tier table finds nothing to touch.
    const guarded = async (): Promise<ContainersSnapshot> => {
      const snap = await deps.scan()
      if (!snap.dockerAvailable) return snap
      const fresh = snap.stacks.find((s) => s.id === t.stack)
      if (!fresh) {
        changed = `${CHANGED}: stack ${label} is already gone`
        return snap
      }
      const why = orphanChangedSince(t, fresh, await shelvedOrNull())
      if (why !== null) {
        changed = why
        return { ...snap, stacks: snap.stacks.filter((s) => s.id !== t.stack) }
      }
      return snap
    }

    const actionDeps = (annotate: (tb: Tombstone) => Tombstone): ActionDeps => ({
      scan: guarded,
      stop: deps.mutators.stop,
      removeContainers: deps.mutators.removeContainers,
      // Not reachable: the only request made is `remove` with `removeVolumes: false`. If it ever
      // were, the answer is an error, never a removal.
      start: async () => ({ done: [], error: NO_VOLUMES }),
      removeVolumes: async () => ({ done: [], error: NO_VOLUMES }),
      appendTombstone: (tb) => deps.appendTombstone(annotate(tb)),
      now: deps.now
    })

    const first = await guarded()
    if (!first.dockerAvailable) return refusal('docker is unavailable')
    if (changed !== null) return refusal(changed)
    const running = first.stacks.find((s) => s.id === t.stack)?.running === true

    if (running) {
      const stopped = await runContainersAction(
        { verb: 'stop', stacks: [t.stack] },
        'autopilot',
        actionDeps((tb) => ({
          ...tb,
          reason: `Stopped orphan stack \`${label}\` before removing it`,
          // The containers are removed right after, so `docker start <id>` could never work.
          restoreHint: null
        }))
      )
      if (!stopped.ok)
        return stopOutcome(
          stopped.results[0]?.error,
          stopped.results[0]?.message ?? stopped.message,
          changed
        )
    }

    const removed = await runContainersAction(
      { verb: 'remove', stack: t.stack, removeVolumes: false },
      'autopilot',
      actionDeps((tb) => annotateRemoval(tb, t, label))
    )
    if (removed.ok) return { ok: true }
    return stopOutcome(
      removed.error ?? removed.results[0]?.error,
      removed.results[0]?.message ?? removed.message,
      changed
    )
  }

  /** A refusal when the world moved, a failure when docker or the journal did not do what was asked. */
  function stopOutcome(
    code: ActErrorCode | undefined,
    message: string | undefined,
    changed: string | null
  ): DockerOutcome {
    if (changed !== null) return refusal(changed)
    if (code !== undefined && REFUSAL_CODES.has(code)) return refusal(message ?? code)
    return failure(message ?? code ?? 'docker did not finish the removal')
  }

  async function execute(a: DockerAction): Promise<DockerOutcome> {
    const target = targets.get(a.id)
    if (!target) return refusal(`${CHANGED}: ${a.id} is not part of the current plan`)
    targets.delete(a.id)
    try {
      return target.kind === 'network'
        ? await executeNetwork(target.network)
        : await executeOrphan(target.stack)
    } catch (err) {
      return failure(messageOf(err))
    }
  }

  return { plan, execute }
}

/** The removal line: why it happened, and who the kept volumes belonged to. */
function annotateRemoval(tb: Tombstone, t: GarbageStack, label: string): Tombstone {
  const kept = tb.stacks.flatMap((s) => s.keptVolumes ?? [])
  return {
    ...tb,
    reason: orphanReasonLine(label, kept),
    stacks: tb.stacks.map((s) =>
      (s.keptVolumes?.length ?? 0) > 0
        ? {
            ...s,
            keptVolumeOwner: {
              reason: 'worktree-removed' as const,
              project: t.project,
              worktreePath: t.worktreePath
            }
          }
        : s
    )
  }
}
