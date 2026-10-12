// "No dead ends" (unit B), main side. A refused Remove is only half an answer: this module reads what is
// true about the item right now (the lock reason, the sessions open in it, the stacks shared with other
// folders, the exact folder nobody could read, how to start Docker) so the dialog can say it, and runs the
// one preparatory step a guided "…and remove" starts with (unlock, park an idle session, stop a stack).
// The remove itself is never done here: it is the ordinary guarded pipeline, which re-probes everything.
//
// Every effect is injected; the real wiring is `defaultGuidedDeps` in gc-guided-shell.ts.

import { readFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import { findAdminDir } from '../reaper/worktree-admin-shell'
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
import type { PrepEntryInput } from './gc-prep-journal'

/** A Harnu-owned session running in, or under, a folder. */
export interface GuidedSession {
  key: string
  state: 'idle' | 'working' | 'needs-input'
  /** Who started it: the operator by hand, or an agent. Anything unknown reads as the operator. */
  origin?: 'operator' | 'agent'
}

/**
 * The hook state a session reports → what a guided action may do with it. Only an explicit resting state
 * (idle, completed, stopped) is idle; "no hook has arrived", a failed run and anything else are busy, and
 * so is the owner of a mission with a live child. Parking cannot be undone, so doubt means busy.
 */
export function sessionStateOf(
  hook: 'working' | 'needs-input' | 'idle' | 'completed' | 'failed' | 'stopped' | null | undefined,
  ownsLiveMission: boolean
): GuidedSession['state'] {
  if (ownsLiveMission) return 'working'
  if (hook === 'idle' || hook === 'completed' || hook === 'stopped') return 'idle'
  return hook === 'needs-input' ? 'needs-input' : 'working'
}

/**
 * Whether a session's folder is "in" a worktree: the worktree itself or a plain subfolder, never a
 * nested worktree (or anything under one), which is another worktree's session.
 */
export function sessionCountsHere(
  folder: string,
  root: string,
  nested: readonly string[],
  inside: (child: string, parent: string) => boolean
): boolean {
  return inside(folder, root) && !nested.some((n) => inside(folder, n))
}

export interface GuidedDeps {
  /** What git recorded with the lock: a string (possibly empty→null), or `undefined` when not locked. */
  lockReason(repoPath: string, path: string): Promise<string | null | undefined>
  unlock(repoPath: string, path: string): Promise<void>
  /** `git worktree lock [--reason <reason>]`: puts a lock back exactly as it was (the rollback of an unlock). */
  lock(repoPath: string, path: string, reason: string | null): Promise<void>
  /** Running Harnu sessions (live PTYs) whose folder is `path` or under it. Never a session Harnu does not own. */
  sessionsIn(path: string, nestedWorktrees: readonly string[]): Promise<GuidedSession[]>
  /** Parks (kills, keeps the conversation) one session. */
  park(key: string): void
  listStacks(): Promise<{ stacks: StackGroup[] }>
  /** Every path git lists as a worktree of this repo (the main checkout included). */
  worktreeRoots(repoPath: string): Promise<string[]>
  /** Every folder with a running Harnu session (`live`) or one parked on disk (`parked`). */
  sessionFolders(): Promise<Array<{ folder: string; state: 'live' | 'parked' }>>
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
  /** Written before a prep changes anything, cleared when the item ends (see gc-prep-journal.ts). */
  journal?: {
    begin(entry: PrepEntryInput): Promise<string>
    end(id: string): Promise<void>
  }
}

/**
 * `undo` puts back what the prep changed, for when the remove that follows still refuses. A prep that
 * cannot be undone (a parked session) has none, which is exactly why it runs last, after a dry run.
 */
export type PrepResult =
  | {
      ok: true
      undo?: () => Promise<void>
      /** The item ended without needing the undo: clears the journal entry. */
      settle?: () => Promise<void>
    }
  | { ok: false; error: string }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** `p` as one shell word: plain paths stay bare, anything else is single-quoted. */
function shellQuote(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
  '"': 34
}

/**
 * Undoes git's C-style quoting (`core.quotePath`): a value with a quote, a backslash, a control character
 * or a non-ASCII byte is printed as `"…"` with `\"`, `\\`, `\n`… and `\303\243` octal UTF-8 bytes. A value
 * that is not wrapped in quotes was printed as is.
 */
export function unquoteGitC(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value
  const inner = value.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'))
      continue
    }
    const next = inner[++i] ?? ''
    if (/[0-7]/.test(next)) {
      let octal = next
      while (octal.length < 3 && /[0-7]/.test(inner[i + 1] ?? '')) octal += inner[++i]
      bytes.push(parseInt(octal, 8) & 255)
    } else if (next in C_ESCAPES) {
      bytes.push(C_ESCAPES[next]!)
    } else {
      bytes.push(92, ...Buffer.from(next, 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * The reasons in `git worktree list --porcelain`: path → the text after `locked`, exactly as it was
 * recorded (git C-quotes it in this output, so it is unquoted here), or null when git recorded none.
 * A worktree that is not locked has no entry.
 */
export function parseLockReasons(porcelain: string): Map<string, string | null> {
  const out = new Map<string, string | null>()
  let current: string | null = null
  for (const raw of porcelain.split(/\r?\n/)) {
    if (raw.startsWith('worktree ')) current = unquoteGitC(raw.slice('worktree '.length))
    else if (current !== null && (raw === 'locked' || raw.startsWith('locked '))) {
      const reason = raw === 'locked' ? '' : unquoteGitC(raw.slice('locked '.length))
      out.set(current, reason === '' ? null : reason)
    }
  }
  return out
}

/** The paths of the `worktree <path>` lines of `git worktree list --porcelain`, unquoted. */
export function parseWorktreePaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => unquoteGitC(l.slice('worktree '.length)))
    .filter(Boolean)
}

/** The command that starts Docker on this platform; null where it is an app to open by hand. */
export function dockerStartHint(platform: string): string | null {
  if (platform === 'darwin') return 'open -a Docker'
  if (platform === 'linux') return 'sudo systemctl start docker'
  return null
}

/** A uid as a user name, from the text of /etc/passwd; the number itself when there is none to read. */
export function userNameOfUid(uid: number, passwd: string | null): string {
  for (const line of (passwd ?? '').split('\n')) {
    if (line.startsWith('#')) continue
    const [name, , id] = line.split(':')
    if (name && id === String(uid)) return name
  }
  return String(uid)
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
  const sessions = await deps.sessionFolders()
  const listed = await deps.worktreeRoots(b.item.repoPath).catch(() => [])
  const canonical = await deps.realPaths([
    path,
    b.item.repoPath,
    ...raw,
    ...listed,
    ...sessions.map((s) => s.folder)
  ])
  const root = canonicalPathKey(canonical(path).path, deps.platform)
  // A live or parked session outside this worktree HOLDS a mount of the stack when its folder lies inside
  // a mount source or contains one (a session at a worktree's root holds that worktree's `src`).
  const holders = sessions
    .map((s) => canonicalPathKey(canonical(s.folder).path, deps.platform))
    .filter((f) => !isInside(f, root))
  const main = canonicalPathKey(canonical(b.item.repoPath).path, deps.platform)
  // The main checkout is its OWN tree: Harnu keeps worktrees inside it (`.claude/worktrees/*`), and git
  // may list others, so a folder under any of those belongs to that worktree, not to main.
  const nestedRoots = [
    ...listed
      .map((p) => canonicalPathKey(canonical(p).path, deps.platform))
      .filter((p) => p !== main),
    `${main}/.claude/worktrees`
  ]
  const ownsMain = (d: string): boolean =>
    (d === main || isInside(d, main)) &&
    !nestedRoots.some((r) => d !== r && isInside(d, r)) &&
    d !== `${main}/.claude/worktrees`
  return Promise.all(
    wanted.map(async (stack): Promise<StackView> => {
      const dirs = [
        ...new Set(stack.containers.flatMap((c) => containerFolders(c, deps.platform, canonical)))
      ].filter((d) => d !== '')
      const others = dirs.filter((d) => !isInside(d, root))
      // The main checkout's own stack is never stopped from here (a conservative reading: any folder
      // of the repo that is not this worktree counts when it lies under the main checkout).
      let blocked: StackView['blocked'] = null
      if (others.some(ownsMain)) blocked = 'main-checkout'
      else if (holders.some((f) => others.some((d) => isInside(f, d) || isInside(d, f)))) {
        blocked = 'in-use-elsewhere'
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
    const open = await deps.sessionsIn(path, b.nestedWorktrees ?? [])
    out.sessions = {
      idle: open.filter((s) => s.state === 'idle').length,
      busy: open.filter((s) => s.state !== 'idle').length,
      userOpened: open.filter((s) => s.origin !== 'agent').length
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
    // Written BEFORE the unlock: if Harnu quits right after it, the next boot puts the lock back.
    const token = await deps.journal?.begin({
      kind: 'unlock',
      at: Date.now(),
      repoPath: b.item.repoPath,
      path,
      reason
    })
    const settle = async (): Promise<void> => {
      if (token !== undefined) await deps.journal?.end(token)
    }
    try {
      await deps.unlock(b.item.repoPath, path)
    } catch (err) {
      await settle()
      return { ok: false, error: `unlock-failed: ${messageOf(err)}` }
    }
    return {
      ok: true,
      // A failed re-lock throws before the entry is cleared, so the next boot retries it.
      undo: async () => {
        await deps.lock(b.item.repoPath, path, reason)
        await settle()
      },
      settle
    }
  }

  if (prep.kind === 'close-session') {
    if (b.session !== 'open-idle') return NOT_APPLICABLE
    const open = await deps.sessionsIn(path, b.nestedWorktrees ?? [])
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
  const nameOf = new Map(
    views.flatMap((v) => v.stack.containers.map((c) => [c.id, c.name] as const))
  )
  // Written BEFORE the stop: if Harnu quits right after it, the next boot starts these again.
  const token = await deps.journal?.begin({
    kind: 'stop-stack',
    at: Date.now(),
    path,
    containerIds: running,
    containerNames: running.map((id) => nameOf.get(id) ?? id),
    bindSources: [
      ...new Set(views.flatMap((v) => v.stack.containers.flatMap(containerFolderPaths)))
    ]
  })
  const settle = async (): Promise<void> => {
    if (token !== undefined) await deps.journal?.end(token)
  }
  /** Starts `ids` again; throws, naming by container name the ones that are still stopped. */
  const restart = async (ids: string[]): Promise<void> => {
    let left = ids
    try {
      const r = await deps.docker.start(ids)
      const started = new Set(r.done)
      left = ids.filter((id) => !started.has(id))
    } catch {
      // nothing is known to have started
    }
    if (left.length > 0) {
      throw new Error(`left stopped: ${left.map((id) => nameOf.get(id) ?? id).join(', ')}`)
    }
  }
  /** The refusal, with what could not be put back said out loud (never swallowed). */
  const failed = async (cause: string, toRestart: string[]): Promise<PrepResult> => {
    let rollback = ''
    if (toRestart.length > 0) {
      try {
        await restart(toRestart)
      } catch (err) {
        // The entry stays: the next boot retries what could not be started now.
        rollback = `; rollback-failed (${messageOf(err)})`
      }
    }
    if (rollback === '') await settle()
    return { ok: false, error: `stack-stop-failed: ${cause}${rollback}` }
  }
  let stopped: DockerBatchResult
  try {
    stopped = await deps.docker.stop(running)
  } catch (err) {
    // Which containers stopped before the throw is unknown; starting a running one is a no-op.
    return failed(messageOf(err), running)
  }
  if (stopped.error || stopped.done.length < running.length) {
    // A partial stop is put back before the refusal is reported: the stack runs as it did.
    return failed(stopped.error ?? 'not every container stopped', stopped.done)
  }
  return {
    ok: true,
    undo: async () => {
      await restart(running)
      await settle()
    },
    settle
  }
}

/** The two git-backed deps, over any `git -C <repo> …` runner (the executor's, or a test's real one). */
export function createGitGuided(
  git: (repo: string, args: string[]) => Promise<string>
): Pick<GuidedDeps, 'lockReason' | 'unlock' | 'lock'> {
  const key = (p: string): string => canonicalPathKey(p, process.platform)
  return {
    async lockReason(repoPath, path) {
      // The reason exactly as recorded: read from git's own `locked` file, because the porcelain output
      // trims it and quotes it. The file is the reason plus one newline; no reason is an empty file.
      const admin = await findAdminDir(repoPath, path, git, { assumeUnlocked: true }).catch(
        () => null
      )
      if (admin) {
        try {
          const raw = await readFile(joinPath(admin, 'locked'), 'utf8')
          const reason = raw.endsWith('\n') ? raw.slice(0, -1) : raw
          return reason === '' ? null : reason
        } catch {
          return undefined // no `locked` file: not locked
        }
      }
      // No unique admin directory to read: the porcelain listing is the best that is left.
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
