// Real ops for the worktree cleanup pipeline (design: workspace-gc §4). `createGcOps` is a
// thin factory over injected dependencies, so the reprobe and the failure mapping are
// unit-tested in tests/gc-shell.test.ts with fakes. Only `defaultGcShellDeps` touches the
// real modules, and it loads them lazily so importing this file never pulls in electron.

import type { BrowserWindow } from 'electron'
import { GcStepError, isMainCheckoutByPath, type GcOps, type GcStep } from './pipeline-core'
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
  /**
   * Fresh listing for resolving stack ids to container ids and for the reprobe. Resolves
   * `{ stacks: [] }` only when nothing can be running (the docker CLI is not installed).
   * Rejects with {@link DockerUnavailableError} when the daemon is down or unreachable, and
   * with any other error when the listing failed: neither may read as "no stacks".
   */
  listStacks(): Promise<{ stacks: StackGroup[] }>
  /** Presence of a session in a folder, from the same sets the Reaper reads. */
  presenceOf(path: string): Promise<SessionPresence>
  /** The commit checked out in a folder now, or null when there is none. */
  headOf(path: string): Promise<string | null>
  /**
   * Whether the bundle is keep, neverClean or the main checkout NOW, not at the scan: a
   * worktree marked Keep after the scan must not be cleaned. The reprobe asks it first.
   */
  isProtectedNow(b: WorktreeBundle): boolean | Promise<boolean>
}

/**
 * The Reaper's two folder sets decide presence: `live` is a working or waiting session with
 * a running PTY, `inUse` is any running PTY. `live` cannot tell `working` from `needs-input`,
 * and the bucket treats both as alive, so one answer covers both. History-only and
 * hibernated sessions have no PTY, so they read `none`.
 *
 * A session in a folder under `path` counts as one in `path` itself: the worktree is live
 * whichever subfolder the session was started from. Containment is by path segment, so a
 * sibling `WT-other` never counts, and neither does a parent folder.
 */
export function presenceFromSets(
  path: string,
  sets: { live: Set<string>; inUse: Set<string> }
): SessionPresence {
  const platform = process.platform
  const root = normalizePath(path, platform)
  const touches = (folders: Set<string>): boolean =>
    [...folders].some((f) => isInside(normalizePath(f, platform), root))
  if (touches(sets.live)) return 'working'
  if (touches(sets.inUse)) return 'open-idle'
  return 'none'
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const DAEMON_DOWN =
  /cannot connect to the docker daemon|is the docker daemon running|error during connect|failed to connect to the docker API/i

/**
 * The docker daemon is down or unreachable. Its containers may come back with it, so this
 * says nothing about what runs from a worktree, and the reprobe refuses on it.
 */
export class DockerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DockerUnavailableError'
  }
}

type ExecError = {
  code?: unknown
  killed?: unknown
  signal?: unknown
  stderr?: unknown
  message?: unknown
} | null

/** The docker CLI is not installed (ENOENT), so nothing can be running on this machine. */
export function dockerCliAbsent(err: unknown): boolean {
  const e = err as ExecError
  return !!e && typeof e === 'object' && e.code === 'ENOENT'
}

/**
 * The CLI ran but could not reach the daemon. A killed call (execFile's timeout) can carry
 * partial output that reads the same way; it never counts.
 */
export function dockerDaemonDown(err: unknown): boolean {
  const e = err as ExecError
  if (!e || typeof e !== 'object') return false
  if (e.killed === true || (typeof e.signal === 'string' && e.signal)) return false
  return [e.stderr, e.message].some((t) => typeof t === 'string' && DAEMON_DOWN.test(t))
}

/**
 * Either of the two above. Anything else, a timeout above all, says nothing about what
 * runs, so the listing must fail and the reprobe refuse.
 */
export function dockerIsUnavailable(err: unknown): boolean {
  return dockerCliAbsent(err) || dockerDaemonDown(err)
}

/** `working` and `needs-input` are one state to the fresh probe, so neither is a change from the other. */
const sameState = (p: SessionPresence): 'busy' | SessionPresence =>
  p === 'working' || p === 'needs-input' ? 'busy' : p

/**
 * True when every folder the container touches (working dir and bind mount sources) lies
 * inside `root`; false when it has none.
 */
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

/**
 * Which pipeline step a failed executor step belongs to. `remote-delete` cannot run here.
 * cleanItem's guard runs at the start of the archive phase, after the docker steps and
 * drop-deps already ran, so it maps to `archive`: `reprobe` would claim nothing was touched.
 */
const STEP_OF: Record<CleanStepId, GcStep> = {
  guard: 'archive',
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
      // Protection first, before any probe or docker call. A read that fails is no answer.
      try {
        // The path decides too, so a bundle whose flag says otherwise is still refused.
        if (b.isMainCheckout || isMainCheckoutByPath(b) || (await deps.isProtectedNow(b))) {
          return { ok: false, reason: 'protected-now' }
        }
      } catch (err) {
        return { ok: false, reason: `probe-failed: ${messageOf(err)}` }
      }
      const item = b.item
      // cleanItem refuses a non-harvestable item at its first guard, after the docker steps
      // would already have run, so refuse here before anything destructive.
      if (item.verdict !== 'harvestable') return { ok: false, reason: 'not-harvestable' }
      // A strong merge proof covers the scanned tip only. With no tip recorded there is
      // nothing to hold HEAD against, so the clean cannot be shown to match the proof.
      if (typeof b.localTip !== 'string') return { ok: false, reason: 'tip-unknown' }
      // Re-check the grace against the clock now, not the one the bucket was decided on: a
      // bundle bucketed long ago, or built by hand, must not clean on a stale decision. No
      // sign of life, or no recorded grace window, cannot show the window elapsed either,
      // and neither can a NaN, infinite or negative one (each makes the comparison false).
      const known = (n: number | null | undefined): n is number =>
        Number.isFinite(n) && (n as number) >= 0
      if (
        !known(b.lastSignOfLifeAt) ||
        !known(b.graceDays) ||
        deps.executor.now() - b.lastSignOfLifeAt < b.graceDays * 86_400_000
      ) {
        return { ok: false, reason: 'grace-not-elapsed' }
      }
      const path = item.path
      if (!path) return { ok: false, reason: 'changed-since-scan' }
      const root = normalizePath(path, platform)
      try {
        // Pre-flight everything cleanItem's guard would refuse: that guard runs only after
        // the docker steps and drop-deps, so refusing there is too late. Dirty or unknown
        // now refuses even when the scan already saw it dirty.
        const status = await deps.executor.probeStatus(path)
        const scanDirty = item.blockers.includes('dirty')
        if (status.trackedDirty !== false || scanDirty) {
          const same = status.trackedDirty === scanDirty
          return { ok: false, reason: same ? 'dirty' : 'changed-since-scan' }
        }
        // Same rule as cleanItem: only a merge signal waives the unpushed re-probe.
        if (item.justifiedBy === null && (await deps.executor.hasUnpushed(path))) {
          return { ok: false, reason: 'unpushed' }
        }
        // Any running session refuses, even one the scan already saw idle: dehydrateItem
        // refuses a live worktree, which would halt the run after the docker steps.
        const presence = await deps.presenceOf(path)
        if (presence !== 'none') {
          const changed = sameState(presence) !== sameState(b.session)
          return { ok: false, reason: changed ? 'changed-since-scan' : 'session-open' }
        }
        // New commits since the scan, or a HEAD we cannot read, mean the merge proof no
        // longer describes what we would archive.
        const head = await deps.headOf(path).catch(() => null)
        if (head !== b.localTip) return { ok: false, reason: 'changed-since-scan' }
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
        if (err instanceof DockerUnavailableError)
          return { ok: false, reason: 'docker-unavailable' }
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
      // The owned list is from the scan. By now the bundle's own containers are removed, so
      // any container still mounting a volume (running or stopped, which docker would not
      // refuse) is someone else's: skip it. A listing that fails throws, so nothing goes.
      const { stacks } = await deps.listStacks()
      const mounted = new Set<string>()
      for (const s of stacks) {
        for (const c of s.containers) for (const m of c.mounts) if (m.name) mounted.add(m.name)
      }
      const skipped = names
        .filter((name) => mounted.has(name))
        .map((name) => ({ name, reason: 'volume-in-use' as const }))
      const free = names.filter((name) => !mounted.has(name))
      if (free.length > 0) {
        // Docker refuses a volume a container still mounts, which is the last safety net.
        assertBatch('docker volume rm', await deps.docker.removeVolumes(free), free.length)
      }
      return skipped.length > 0 ? { skipped } : undefined
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

    async recheck(b) {
      const path = b.item.path
      if (!path) return { ok: false, reason: 'changed-mid-run' }
      try {
        // Fail closed: a probe that cannot answer is not a green light either.
        if ((await deps.presenceOf(path)) !== 'none') return { ok: false, reason: 'session-open' }
        if ((await deps.headOf(path)) !== b.localTip) return { ok: false, reason: 'head-moved' }
        // By now the exclusive stacks were removed and a shared one was refused at the
        // reprobe, so any stack still touching the worktree would run from a folder about to
        // be trashed, whatever its id: a `compose up` during drop-deps brings the same project
        // id back. Same attribution as the scan and the reprobe.
        const { stacks } = await deps.listStacks()
        const root = normalizePath(path, platform)
        if (stackIdsInside(stacks, root, platform).length > 0) {
          return { ok: false, reason: 'stack-present' }
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: `probe-failed: ${messageOf(err)}` }
      }
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
        return { stacks: groupStacks(await shell.inspectAll({ strict: true })) }
      } catch (err) {
        // No docker CLI means no stacks to stop: a bundle that had stacks then fails the
        // reprobe's stack comparison, one that had none still cleans. A stopped daemon is
        // not "none" (its containers come back with it), so the reprobe refuses it. Any
        // other failure rethrows, so the reprobe reports probe-failed.
        if (dockerCliAbsent(err)) return { stacks: [] }
        if (dockerDaemonDown(err)) throw new DockerUnavailableError(messageOf(err))
        throw err
      }
    },
    presenceOf: async (path) => presenceFromSets(path, await computeFolderSets()),
    headOf: async (path) => (await executor.git(path, ['rev-parse', 'HEAD'])).trim() || null,
    // The scan-time flags for now; S3 replaces this with a live read of the prefs.
    isProtectedNow: (b) => b.keep || b.neverClean || b.isMainCheckout || isMainCheckoutByPath(b)
  }
}
