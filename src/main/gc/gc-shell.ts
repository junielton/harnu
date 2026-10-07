// Real ops for the worktree cleanup pipeline (design: workspace-gc §4). `createGcOps` is a
// thin factory over injected dependencies, so the reprobe and the failure mapping are
// unit-tested in tests/gc-shell.test.ts with fakes. Only `defaultGcShellDeps` touches the
// real modules, and it loads them lazily so importing this file never pulls in electron.

import type { BrowserWindow } from 'electron'
import { GcStepError, type GcOps, type GcStep } from './pipeline-core'
import type { SessionPresence, WorktreeBundle } from './bundle-core'
import { cleanItem, type CleanStepId, type ExecutorDeps } from '../reaper/executor-core'
import { dehydrateItem, type DehydrateDeps } from '../reaper/dehydrate-core'
import {
  COMPOSE_WORKING_DIR_LABEL,
  groupStacks,
  isInside,
  normalizePath,
  type StackGroup
} from '../containers/containers-core'
import type { DockerBatchResult } from '../containers/containers-actions'

export interface GcShellDeps {
  executor: ExecutorDeps
  dehydrate: DehydrateDeps
  docker: {
    stop(ids: string[]): Promise<DockerBatchResult>
    removeContainers(ids: string[]): Promise<DockerBatchResult>
    removeVolumes(names: string[]): Promise<DockerBatchResult>
  }
  /** Fresh listing for resolving stack ids to container ids and for the reprobe. */
  listStacks(): Promise<{ stacks: StackGroup[] }>
  /** Presence of a session in a folder, from the same sets the Reaper reads. */
  presenceOf(path: string): Promise<SessionPresence>
}

/**
 * The Reaper's two folder sets decide presence: `live` is a working or waiting session with
 * a running PTY, `inUse` is any running PTY. `live` cannot tell `working` from `needs-input`,
 * and the bucket treats both as alive, so one answer covers both. History-only and
 * hibernated sessions have no PTY, so they read `none`.
 */
export function presenceFromSets(
  path: string,
  sets: { live: Set<string>; inUse: Set<string> }
): SessionPresence {
  if (sets.live.has(path)) return 'working'
  if (sets.inUse.has(path)) return 'open-idle'
  return 'none'
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** `working` and `needs-input` are one state to the fresh probe, so the scan's either matches. */
const sameState = (p: SessionPresence): 'busy' | SessionPresence =>
  p === 'working' || p === 'needs-input' ? 'busy' : p

/** Stacks with any container whose compose working dir lies inside `folder`, as a sorted id list. */
function stackIdsInside(stacks: readonly StackGroup[], folder: string): string[] {
  const platform = process.platform
  const root = normalizePath(folder, platform)
  return stacks
    .filter((s) =>
      s.containers.some((c) => {
        const dir = c.labels[COMPOSE_WORKING_DIR_LABEL]
        return !!dir && isInside(normalizePath(dir, platform), root)
      })
    )
    .map((s) => s.id)
    .sort()
}

/** A batch that errored, or finished fewer targets than asked, is a failed step. */
function assertBatch(what: string, result: DockerBatchResult, wanted: number): void {
  if (result.error) throw new Error(`${what}: ${result.error}`)
  if (result.done.length < wanted) {
    throw new Error(`${what}: only ${result.done.length} of ${wanted} completed`)
  }
}

/** Which pipeline step a failed executor step belongs to. `remote-delete` cannot run here. */
const STEP_OF: Record<CleanStepId, GcStep> = {
  guard: 'reprobe',
  archive: 'archive',
  'trash-folder': 'trash',
  'worktree-prune': 'prune',
  'branch-delete': 'branch-delete',
  'remote-delete': 'branch-delete',
  'sidebar-detach': 'detach',
  journal: 'detach'
}

export function createGcOps(deps: GcShellDeps): GcOps {
  /** Container ids of the named stacks, from a listing taken now rather than at scan time. */
  const containersOf = async (stackIds: string[]): Promise<string[]> => {
    if (stackIds.length === 0) return []
    const wanted = new Set(stackIds)
    const { stacks } = await deps.listStacks()
    const ids = stacks.filter((s) => wanted.has(s.id)).flatMap((s) => s.containers.map((c) => c.id))
    return [...new Set(ids)]
  }

  return {
    async reprobe(b: WorktreeBundle) {
      const item = b.item
      // cleanItem refuses a non-harvestable item at its first guard, after the docker steps
      // would already have run, so refuse here before anything destructive.
      if (item.verdict !== 'harvestable') return { ok: false, reason: 'not-harvestable' }
      const path = item.path
      if (!path) return { ok: false, reason: 'changed-since-scan' }
      try {
        const status = await deps.executor.probeStatus(path)
        if (status.trackedDirty !== item.blockers.includes('dirty')) {
          return { ok: false, reason: 'changed-since-scan' }
        }
        if (sameState(await deps.presenceOf(path)) !== sameState(b.session)) {
          return { ok: false, reason: 'changed-since-scan' }
        }
        const fresh = stackIdsInside((await deps.listStacks()).stacks, path)
        const scanned = [...b.stackIds, ...b.sharedStackIds].sort()
        if (fresh.length !== scanned.length || fresh.some((id, i) => id !== scanned[i])) {
          return { ok: false, reason: 'changed-since-scan' }
        }
        return { ok: true }
      } catch (err) {
        // Fail closed: a probe that cannot answer is not a green light.
        return { ok: false, reason: `probe-failed: ${messageOf(err)}` }
      }
    },

    async stopStacks(ids) {
      const containers = await containersOf(ids)
      if (containers.length === 0) return
      assertBatch('docker stop', await deps.docker.stop(containers), containers.length)
    },

    async removeContainers(ids) {
      const containers = await containersOf(ids)
      if (containers.length === 0) return
      assertBatch('docker rm', await deps.docker.removeContainers(containers), containers.length)
    },

    async removeVolumes(names) {
      if (names.length === 0) return
      // Docker refuses a volume a container still mounts, which is the last safety net.
      assertBatch('docker volume rm', await deps.docker.removeVolumes(names), names.length)
    },

    async dropDeps(b) {
      const r = await dehydrateItem(b.item, deps.dehydrate)
      if (r.ok) return b.depsBytes ?? 0
      // A worktree with no installed deps is already as light as it gets.
      if (r.error === 'nothing removable' && r.removed.length === 0 && r.failed.length === 0) {
        return 0
      }
      const parts = [
        ...(r.error ? [r.error] : []),
        ...r.failed.map((f) => `${f.path}: ${f.error}`),
        ...(r.trackedChanged.length > 0
          ? [`tracked files changed: ${r.trackedChanged.join(', ')}`]
          : [])
      ]
      throw new Error(`drop deps: ${parts.join('; ') || 'failed'}`)
    },

    async cleanGit(b) {
      // Remote branch deletion never happens through the cleanup pipeline, so the flag is a
      // literal rather than anything read from settings or from the item.
      const result = await cleanItem(b.item, { deleteRemote: false }, deps.executor)
      if (result.ok) return
      const failed = result.steps.find((s) => !s.ok)
      throw new GcStepError(
        failed ? STEP_OF[failed.id] : 'archive',
        `${failed?.id ?? 'clean'}: ${failed?.error ?? 'failed'}`
      )
    }
  }
}

/**
 * Wires the real modules. env-bound (electron, docker, git) and so not unit-tested
 * (ADR-0001). The imports are dynamic so that loading this file for its pure parts never
 * loads electron.
 */
export async function defaultGcShellDeps(
  getWindow: () => BrowserWindow | null
): Promise<GcShellDeps> {
  const [{ computeFolderSets }, { buildDeps, buildHydrationDeps }, shell] = await Promise.all([
    import('../reaper/scanner-shell'),
    import('../reaper/reaper-ipc'),
    import('../containers/containers-shell')
  ])
  return {
    executor: buildDeps(getWindow),
    dehydrate: buildHydrationDeps().dehydrate,
    docker: shell.dockerActions,
    listStacks: async () => {
      try {
        return { stacks: groupStacks(await shell.inspectAll()) }
      } catch {
        // No docker means no stacks to stop. A bundle that had stacks then fails the
        // reprobe's stack comparison and is skipped; one that had none still cleans.
        return { stacks: [] }
      }
    },
    presenceOf: async (path) => presenceFromSets(path, await computeFolderSets())
  }
}
