// "No dead ends" (unit B), main side. A refused Remove is only half an answer: this module reads what is
// true about the item right now (the lock reason, the sessions open in it, the stacks shared with other
// folders, the exact folder nobody could read, how to start Docker) so the dialog can say it, and runs the
// one preparatory step a guided "…and remove" starts with (unlock, park an idle session, stop a stack).
// The remove itself is never done here: it is the ordinary guarded pipeline, which re-probes everything.
//
// Every effect is injected; the real wiring is `defaultGuidedDeps` in gc-guided-shell.ts.

import {
  canonicalPathKey,
  containerFolderPaths,
  containerFolders,
  type CanonicalPath,
  type WorktreeBundle
} from './bundle-core'
import { isHolding, isInside, type StackGroup } from '../containers/containers-core'
import type { DockerBatchResult } from '../containers/containers-actions'
import type { GcGuidance, GcGuidedStack, GcPrep } from './gc-wire'

/** A Harnu-owned session running in, or under, a folder. */
export interface GuidedSession {
  key: string
  state: 'idle' | 'working' | 'needs-input'
}

export interface GuidedDeps {
  /** What git recorded with the lock: a string (possibly empty→null), or `undefined` when not locked. */
  lockReason(repoPath: string, path: string): Promise<string | null | undefined>
  unlock(repoPath: string, path: string): Promise<void>
  /** `git worktree lock [--reason <reason>]`: puts a lock back exactly as it was (the rollback of an unlock). */
  lock(repoPath: string, path: string, reason: string | null): Promise<void>
  /** Running Harnu sessions (live PTYs) whose folder is `path` or under it. Never a session Harnu does not own. */
  sessionsIn(path: string): Promise<GuidedSession[]>
  /** Parks (kills, keeps the conversation) one session. */
  park(key: string): void
  listStacks(): Promise<{ stacks: StackGroup[] }>
  /** Whether a folder has a running Harnu session (`live`) or one parked on disk (`parked`). */
  folderHasSession(folder: string): Promise<'none' | 'live' | 'parked'>
  realPaths(paths: string[]): Promise<CanonicalPath>
  docker: {
    start(ids: string[]): Promise<DockerBatchResult>
    stop(ids: string[]): Promise<DockerBatchResult>
    removeContainers(ids: string[]): Promise<DockerBatchResult>
    removeVolumes(names: string[]): Promise<DockerBatchResult>
  }
  /** The scan's own foreign-checkout walk: it rejects, naming the path, on a folder it cannot read. */
  walkForeign(root: string): Promise<string[]>
  ownerOf(path: string): Promise<string | null>
  currentUser(): string
  platform: string
}

/**
 * `undo` puts back what the prep changed, for when the remove that follows still refuses. A prep that
 * cannot be undone (a parked session) has none, which is exactly why it runs last, after a dry run.
 */
export type PrepResult = { ok: true; undo?: () => Promise<void> } | { ok: false; error: string }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** `p` as one shell word: plain paths stay bare, anything else is single-quoted. */
function shellQuote(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * The reasons in `git worktree list --porcelain`: path → the text after `locked` (null when git
 * recorded none). A worktree that is not locked has no entry.
 */
export function parseLockReasons(porcelain: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  let current: string | null = null
  for (const raw of porcelain.split(/\r?\n/)) {
    if (raw.startsWith('worktree ')) current = raw.slice('worktree '.length)
    else if (current !== null && (raw === 'locked' || raw.startsWith('locked '))) {
      const reason = raw.slice('locked'.length).trim()
      out.set(current, reason === '' ? null : reason)
    }
  }
  return out
}

/** The command that starts Docker on this platform; null where it is an app to open by hand. */
export function dockerStartHint(platform: string): string | null {
  if (platform === 'darwin') return 'open -a Docker'
  if (platform === 'linux') return 'sudo systemctl start docker'
  return null
}

/** The fix for a folder nobody can read: a chmod when it is ours, a chown when it is not. */
function fixFor(path: string, owner: string | null, me: string): string {
  const q = shellQuote(path)
  return owner !== null && owner === me ? `chmod -R u+rwX ${q}` : `sudo chown -R $USER ${q}`
}

interface StackView {
  stack: StackGroup
  dirs: string[]
  inside: boolean
  /** Why stopping it is off the table, or null. */
  blocked: 'main-checkout' | 'in-use-elsewhere' | null
}

/** Each listed stack read against this worktree's real folder. */
async function stackViews(
  b: WorktreeBundle,
  ids: readonly string[],
  deps: GuidedDeps
): Promise<StackView[]> {
  const path = b.item.path
  if (!path || ids.length === 0) return []
  const { stacks } = await deps.listStacks()
  const wanted = stacks.filter((s) => ids.includes(s.id))
  const raw = wanted.flatMap((s) => s.containers.flatMap(containerFolderPaths))
  const canonical = await deps.realPaths([path, b.item.repoPath, ...raw])
  const root = canonicalPathKey(canonical(path).path, deps.platform)
  const main = canonicalPathKey(canonical(b.item.repoPath).path, deps.platform)
  return Promise.all(
    wanted.map(async (stack): Promise<StackView> => {
      const dirs = [
        ...new Set(stack.containers.flatMap((c) => containerFolders(c, deps.platform, canonical)))
      ].filter((d) => d !== '')
      const others = dirs.filter((d) => !isInside(d, root))
      // The main checkout's own stack is never stopped from here (a conservative reading: any folder
      // of the repo that is not this worktree counts when it lies under the main checkout).
      let blocked: StackView['blocked'] = null
      if (others.some((d) => d === main || isInside(d, main))) blocked = 'main-checkout'
      else {
        for (const d of others) {
          if ((await deps.folderHasSession(d)) !== 'none') blocked = 'in-use-elsewhere'
        }
      }
      return { stack, dirs, inside: dirs.some((d) => isInside(d, root)), blocked }
    })
  )
}

/** What main sees about a refused item right now. Read-only; each part is null where it does not apply. */
export async function guidanceFor(b: WorktreeBundle, deps: GuidedDeps): Promise<GcGuidance> {
  const path = b.item.path
  const out: GcGuidance = {
    id: b.item.id,
    lock: null,
    sessions: null,
    stacks: [],
    unreadable: null,
    docker: null
  }
  if (!path) return out

  if (b.locked === true || b.reason?.code === 'locked') {
    const r = await deps.lockReason(b.item.repoPath, path)
    out.lock = r === undefined ? null : { reason: r }
  }

  if (b.session !== 'none') {
    const open = await deps.sessionsIn(path)
    out.sessions = {
      idle: open.filter((s) => s.state === 'idle').length,
      busy: open.filter((s) => s.state !== 'idle').length
    }
  }

  if (b.sharedStackIds.length > 0) {
    const root = canonicalPathKey(path, deps.platform)
    out.stacks = (await stackViews(b, b.sharedStackIds, deps)).map((v): GcGuidedStack => ({
      id: v.stack.id,
      name: v.stack.name,
      otherFolders: v.dirs.filter((d) => !isInside(d, root)).sort(),
      bindsThisFolder: v.inside,
      containers: v.stack.containers.length,
      containerNames: v.stack.containers.map((c) => c.name),
      stopBlocked: v.blocked
    }))
  }

  const unchecked =
    b.reason?.code === 'check-failed' ||
    !Array.isArray(b.nestedWorktrees) ||
    !Array.isArray(b.foreignCheckouts)
  if (unchecked) {
    try {
      await deps.walkForeign(path)
    } catch (err) {
      const where = (err as NodeJS.ErrnoException).path ?? path
      const owner = await deps.ownerOf(where).catch(() => null)
      out.unreadable = { path: where, owner, fixCommand: fixFor(where, owner, deps.currentUser()) }
    }
  }

  if (b.dockerBlind === true) out.docker = { hint: dockerStartHint(deps.platform) }
  return out
}

const NOT_APPLICABLE: PrepResult = { ok: false, error: 'prep-not-applicable' }

/**
 * Runs a guided action's one preparatory step against the bundle as main finds it now. Refuses
 * (`prep-not-applicable`) a step the facts no longer call for, so a stale confirm never unlocks, parks or
 * stops anything it was not shown.
 */
export async function prepareClean(
  prep: GcPrep,
  b: WorktreeBundle,
  deps: GuidedDeps,
  /** `dry`: validate everything the prep needs and change nothing. */
  opts: { dry?: boolean } = {}
): Promise<PrepResult> {
  const path = b.item.path
  if (!path) return NOT_APPLICABLE

  if (prep.kind === 'unlock') {
    if (b.locked !== true && b.reason?.code !== 'locked') return NOT_APPLICABLE
    // What git recorded with the lock, read BEFORE the unlock: it is what a rollback puts back.
    let reason: string | null
    try {
      const r = await deps.lockReason(b.item.repoPath, path)
      if (r === undefined) return NOT_APPLICABLE
      reason = r
    } catch (err) {
      return { ok: false, error: `unlock-failed: ${messageOf(err)}` }
    }
    if (opts.dry) return { ok: true }
    try {
      await deps.unlock(b.item.repoPath, path)
    } catch (err) {
      return { ok: false, error: `unlock-failed: ${messageOf(err)}` }
    }
    return { ok: true, undo: () => deps.lock(b.item.repoPath, path, reason) }
  }

  if (prep.kind === 'close-session') {
    if (b.session !== 'open-idle') return NOT_APPLICABLE
    const open = await deps.sessionsIn(path)
    // A session Harnu does not own never shows up here: it is not Harnu's to close.
    if (open.length === 0) return { ok: false, error: 'session-not-closable' }
    // One that is working or waiting for the operator is never closed, and then none is.
    if (open.some((s) => s.state !== 'idle')) return { ok: false, error: 'session-busy' }
    if (opts.dry) return { ok: true }
    for (const s of open) deps.park(s.key)
    return { ok: true }
  }

  // The two stack steps name stacks the bundle lists as shared, and nothing else.
  const ids = [...new Set(prep.stackIds)]
  if (ids.length === 0 || !ids.every((id) => b.sharedStackIds.includes(id))) return NOT_APPLICABLE
  let views: StackView[]
  try {
    views = await stackViews(b, ids, deps)
  } catch (err) {
    return { ok: false, error: `stack-stop-failed: ${messageOf(err)}` }
  }

  if (prep.kind === 'leave-stack') {
    return views.some((v) => v.inside) ? { ok: false, error: 'stack-binds-folder' } : { ok: true }
  }
  // stop-stack. Never the main checkout's own stack, and never one another folder is using with a live
  // or parked session: those are somebody's running work.
  for (const v of views) {
    if (v.blocked === 'main-checkout') return { ok: false, error: 'stack-is-main-checkout' }
    if (v.blocked === 'in-use-elsewhere') return { ok: false, error: 'stack-used-elsewhere' }
  }
  if (opts.dry) return { ok: true }

  // It only STOPS. The stopped containers stay (Cleanup's leftovers flow removes them, behind its own
  // confirm) and so do the stack's volumes. What this stops, `undo` starts again.
  const running = [
    ...new Set(
      views.flatMap((v) => v.stack.containers.filter((c) => isHolding(c.state)).map((c) => c.id))
    )
  ]
  if (running.length === 0) return { ok: true }
  const restart = (ids: string[]): Promise<void> =>
    deps.docker.start(ids).then((r) => {
      if (r.error || r.done.length < ids.length) {
        throw new Error(r.error ?? 'not every container started again')
      }
    })
  let stopped: Awaited<ReturnType<GuidedDeps['docker']['stop']>>
  try {
    stopped = await deps.docker.stop(running)
  } catch (err) {
    return { ok: false, error: `stack-stop-failed: ${messageOf(err)}` }
  }
  if (stopped.error || stopped.done.length < running.length) {
    // A partial stop is put back before the refusal is reported: the stack runs as it did.
    if (stopped.done.length > 0) await restart(stopped.done).catch(() => undefined)
    return {
      ok: false,
      error: `stack-stop-failed: ${stopped.error ?? 'not every container stopped'}`
    }
  }
  return { ok: true, undo: () => restart(running) }
}

/** The two git-backed deps, over any `git -C <repo> …` runner (the executor's, or a test's real one). */
export function createGitGuided(
  git: (repo: string, args: string[]) => Promise<string>
): Pick<GuidedDeps, 'lockReason' | 'unlock' | 'lock'> {
  const key = (p: string): string => canonicalPathKey(p, process.platform)
  return {
    async lockReason(repoPath, path) {
      const reasons = parseLockReasons(await git(repoPath, ['worktree', 'list', '--porcelain']))
      const want = key(path)
      for (const [p, reason] of reasons) if (key(p) === want) return reason
      return undefined
    },
    async unlock(repoPath, path) {
      await git(repoPath, ['worktree', 'unlock', path])
    },
    async lock(repoPath, path, reason) {
      await git(repoPath, ['worktree', 'lock', ...(reason ? ['--reason', reason] : []), path])
    }
  }
}
