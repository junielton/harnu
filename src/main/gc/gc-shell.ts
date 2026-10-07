// Real ops for the worktree cleanup pipeline (design: workspace-gc §4). `createGcOps` is a
// thin factory over injected dependencies, so the reprobe and the failure mapping are
// unit-tested in tests/gc-shell.test.ts with fakes. Only `defaultGcShellDeps` touches the
// real modules, and it loads them lazily so importing this file never pulls in electron.

import type { BrowserWindow } from 'electron'
import { GcStepError, type GcOps, type GcStep } from './pipeline-core'
import { containerFolders, type SessionPresence, type WorktreeBundle } from './bundle-core'
import { cleanItem, type CleanStepId, type ExecutorDeps } from '../reaper/executor-core'
import { dehydrateItem, type DehydrateDeps } from '../reaper/dehydrate-core'
import {
  groupStacks,
  isInside,
  normalizePath,
  type InspectedContainer,
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
  /** The commit checked out in a folder now, or null when there is none. */
  headOf(path: string): Promise<string | null>
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

const DAEMON_DOWN =
  /cannot connect to the docker daemon|is the docker daemon running|error during connect/i

/**
 * Whether a failed docker call means docker is genuinely absent, so nothing can be running:
 * the CLI is not installed (ENOENT) or the daemon is down. Anything else, a timeout above
 * all, says nothing about what runs, so the listing must fail and the reprobe refuse.
 */
export function dockerIsUnavailable(err: unknown): boolean {
  const e = err as {
    code?: unknown
    killed?: unknown
    signal?: unknown
    stderr?: unknown
    message?: unknown
  } | null
  if (!e || typeof e !== 'object') return false
  if (e.code === 'ENOENT') return true
  // A killed call (execFile's timeout) can carry partial output; it never proves absence.
  if (e.killed === true || (typeof e.signal === 'string' && e.signal)) return false
  return [e.stderr, e.message].some((t) => typeof t === 'string' && DAEMON_DOWN.test(t))
}

/** `working` and `needs-input` are one state to the fresh probe, so the scan's either matches. */
const sameState = (p: SessionPresence): 'busy' | SessionPresence =>
  p === 'working' || p === 'needs-input' ? 'busy' : p

/** True when every folder the container runs from lies inside `root`; false when it has none. */
function containedIn(c: InspectedContainer, root: string, platform: string): boolean {
  const dirs = containerFolders(c, platform)
  return dirs.length > 0 && dirs.every((d) => isInside(d, root))
}

/**
 * Stacks with any container folder inside `root`, as a sorted id list. Same attribution as
 * the builder (`containerFolders`), so a stack the scan saw is seen here by the same rule.
 */
function stackIdsInside(stacks: readonly StackGroup[], root: string, platform: string): string[] {
  return stacks
    .filter((s) =>
      s.containers.some((c) => containerFolders(c, platform).some((d) => isInside(d, root)))
    )
    .map((s) => s.id)
    .sort()
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x))

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
  const platform = process.platform
  /**
   * What the last passing reprobe saw for each exclusive stack: the worktree it runs from
   * and its container ids. Ops receive only stack ids, so this is how stop and rm know the
   * containers they are about to touch are the ones the reprobe vetted.
   */
  const vetted = new Map<string, { root: string; ids: Set<string> }>()

  /**
   * Container ids of the named stacks, from a listing taken now rather than at scan time.
   * Throws before any docker call unless each stack passed a reprobe and still has exactly
   * the containers that reprobe saw, all inside its worktree: a container that started in
   * between, perhaps from another worktree with the same compose project, is never touched.
   */
  const containersOf = async (stackIds: string[]): Promise<string[]> => {
    if (stackIds.length === 0) return []
    const { stacks } = await deps.listStacks()
    const out: string[] = []
    for (const id of stackIds) {
      const seen = vetted.get(id)
      if (!seen) throw new Error(`stack was not reprobed: ${id}`)
      const containers = stacks.find((s) => s.id === id)?.containers ?? []
      const fresh = new Set(containers.map((c) => c.id))
      if (
        !sameSet(fresh, seen.ids) ||
        !containers.every((c) => containedIn(c, seen.root, platform))
      ) {
        throw new Error(`stack ${id} changed since the reprobe`)
      }
      out.push(...fresh)
    }
    return [...new Set(out)]
  }

  return {
    async reprobe(b: WorktreeBundle) {
      // Whatever an earlier pass vetted for these stacks no longer stands once we re-ask.
      for (const id of b.stackIds) vetted.delete(id)
      const item = b.item
      // cleanItem refuses a non-harvestable item at its first guard, after the docker steps
      // would already have run, so refuse here before anything destructive.
      if (item.verdict !== 'harvestable') return { ok: false, reason: 'not-harvestable' }
      const path = item.path
      if (!path) return { ok: false, reason: 'changed-since-scan' }
      const root = normalizePath(path, platform)
      try {
        const status = await deps.executor.probeStatus(path)
        if (status.trackedDirty !== item.blockers.includes('dirty')) {
          return { ok: false, reason: 'changed-since-scan' }
        }
        // Any running session refuses, even one the scan already saw idle: dehydrateItem
        // refuses a live worktree, which would halt the run after the docker steps.
        const presence = await deps.presenceOf(path)
        if (presence !== 'none') {
          const changed = sameState(presence) !== sameState(b.session)
          return { ok: false, reason: changed ? 'changed-since-scan' : 'session-open' }
        }
        // A strong merge proof covers the scanned tip only. New commits since then, or a
        // HEAD we cannot read, mean the proof no longer describes what we would archive.
        if (typeof b.localTip === 'string') {
          const head = await deps.headOf(path).catch(() => null)
          if (head !== b.localTip) return { ok: false, reason: 'changed-since-scan' }
        }
        const { stacks } = await deps.listStacks()
        // Exclusivity is recomputed, not trusted: every container of every stack we are
        // about to remove must still run from inside this worktree and nowhere else.
        const pass = new Map<string, { root: string; ids: Set<string> }>()
        for (const id of b.stackIds) {
          const s = stacks.find((x) => x.id === id)
          if (!s || !s.containers.every((c) => containedIn(c, root, platform))) {
            return { ok: false, reason: 'changed-since-scan' }
          }
          pass.set(id, { root, ids: new Set(s.containers.map((c) => c.id)) })
        }
        const fresh = stackIdsInside(stacks, root, platform)
        const scanned = [...b.stackIds, ...b.sharedStackIds].sort()
        if (fresh.length !== scanned.length || fresh.some((id, i) => id !== scanned[i])) {
          return { ok: false, reason: 'changed-since-scan' }
        }
        for (const [id, seen] of pass) vetted.set(id, seen)
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
  const executor = buildDeps(getWindow)
  return {
    executor,
    dehydrate: buildHydrationDeps().dehydrate,
    docker: shell.dockerActions,
    listStacks: async () => {
      try {
        return { stacks: groupStacks(await shell.inspectAll()) }
      } catch (err) {
        // No docker means no stacks to stop. A bundle that had stacks then fails the
        // reprobe's stack comparison and is skipped; one that had none still cleans. Any
        // other failure rethrows, so the reprobe reports probe-failed instead of "none".
        if (dockerIsUnavailable(err)) return { stacks: [] }
        throw err
      }
    },
    presenceOf: async (path) => presenceFromSets(path, await computeFolderSets()),
    headOf: async (path) => (await executor.git(path, ['rev-parse', 'HEAD'])).trim() || null
  }
}
