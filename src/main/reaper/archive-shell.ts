/**
 * Imperative shell for the Reaper's preserve-before-sweeping step: writes the
 * archive refs planned by `archive-core.ts` into the repository.
 *
 * env-bound (`child_process` + `node:fs` + `node:os`) ⇒ e2e-only per ADR-0001;
 * the *decision* of what to archive lives in the pure planner. The one thing
 * covered by a real-git integration test is {@link archiveWip}, because its
 * correctness (untracked files in, ignored files out, byte-identical restore)
 * cannot be asserted against a mock.
 *
 * `git stash push` appears nowhere in this file, and must not: the stash stack
 * is repo-wide, not worktree-scoped, so a push here would mutate state shared
 * with every other worktree and could collide with a concurrent session's
 * stash. `git commit-tree` over a throwaway index touches nothing but the
 * object store.
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const runFile = promisify(execFile)

/** Shared `execFile` options for `git` (no shell, hard bounds). */
const GIT_OPTS = { windowsHide: true, timeout: 60_000, maxBuffer: 8 << 20 } as const

/**
 * A fixed identity for the archive commit. `commit-tree` refuses to run when it
 * cannot auto-detect an author, which would turn "preserve the work" into
 * "refuse to sweep" on a machine with no global git identity.
 */
const ARCHIVE_IDENTITY = {
  GIT_AUTHOR_NAME: 'Harnu Reaper',
  GIT_AUTHOR_EMAIL: 'reaper@harnu.dev',
  GIT_COMMITTER_NAME: 'Harnu Reaper',
  GIT_COMMITTER_EMAIL: 'reaper@harnu.dev'
} as const

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const opts = env ? { ...GIT_OPTS, env: { ...process.env, ...env } } : GIT_OPTS
  return (await runFile('git', ['-C', cwd, ...args], opts)).stdout
}

/** Points `ref` at an already-resolved commit sha. Throws on any git failure. */
export async function archiveTip(repoPath: string, ref: string, sha: string): Promise<string> {
  await git(repoPath, ['update-ref', ref, sha])
  return sha
}

/** Resolves HEAD in `worktreePath`, or null when the branch is unborn. */
async function headSha(worktreePath: string): Promise<string | null> {
  try {
    return (await git(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
  } catch {
    return null
  }
}

/** The commit `ref` points at in `repoPath`, or null when it does not exist. */
async function resolveRef(repoPath: string, ref: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
  } catch {
    return null
  }
}

/** The tree of a commit, or null when it cannot be read. */
async function treeOf(repoPath: string, commit: string): Promise<string | null> {
  try {
    return (await git(repoPath, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`])).trim()
  } catch {
    return null
  }
}

/** `yyyymmddhhmmss` (UTC): the suffix of the sibling ref an earlier working state moves to. */
function siblingStamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[-:T]/g, '')
}

/**
 * Captures the worktree's *working state* — tracked modifications, staged or
 * not, plus untracked files — as a dangling commit, and points `ref` at it so
 * `git gc` can never reclaim it.
 *
 * Built over a throwaway index file (`GIT_INDEX_FILE`) so the worktree's real
 * index is never touched:
 *
 *   1. `read-tree HEAD` seeds the temp index. Seeding matters: with an empty
 *      index, `add -A` would treat a tracked-but-gitignored path as ignored and
 *      silently drop it from the archive.
 *   2. `add -A` stages everything on disk that git would ever track — including
 *      untracked files, excluding `.gitignore`d ones. That exclusion is the
 *      point: the objects are ~78 MiB against ~19.71 GiB of checkouts precisely
 *      because build output stays out.
 *   3. `write-tree` + `commit-tree -p HEAD` mints the commit. The HEAD parent is
 *      what makes `git show <ref>` read as a diff against the tip.
 *
 * Returns the commit sha. Throws (aborting the item) if any step fails.
 */
export async function archiveWip(
  repoPath: string,
  ref: string,
  worktreePath: string
): Promise<string> {
  const tmpIndex = path.join(
    os.tmpdir(),
    `harnu-archive-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  try {
    const indexEnv = { GIT_INDEX_FILE: tmpIndex }
    const parent = await headSha(worktreePath)
    if (parent) await git(worktreePath, ['read-tree', parent], indexEnv)
    await git(worktreePath, ['add', '-A'], indexEnv)
    const tree = (await git(worktreePath, ['write-tree'], indexEnv)).trim()

    const args = ['commit-tree', tree]
    if (parent) args.push('-p', parent)
    args.push('-m', `harnu-archive: working state of ${worktreePath}`)
    const commit = (await git(worktreePath, args, ARCHIVE_IDENTITY)).trim()

    // A ref that already exists is an earlier working state under the same name — a detached
    // worktree's refs are keyed by folder and commit, not by sweep, so removing the same folder at
    // the same commit twice lands here. One with the same files is the same work (the reprobe and the
    // executor both write the ref in one run) and is simply replaced. One with different files is
    // kept under a timestamped sibling, so overwriting the name never drops the only copy of it, and
    // the new ref stays a plain one-parent diff against the tip.
    const earlier = await resolveRef(repoPath, ref)
    if (earlier && (await treeOf(repoPath, earlier)) !== tree) {
      await git(repoPath, ['update-ref', `${ref}-${siblingStamp()}`, earlier])
    }
    await git(repoPath, ['update-ref', ref, commit])
    return commit
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined)
  }
}

/** The most chain tips one removal will archive for a worktree's HEAD reflog; more is refused, never truncated. */
export const REFLOG_REF_LIMIT = 500

/** The git calls the reflog archiver makes, injectable so a test can count them. */
export interface ReflogIo {
  run(cwd: string, args: string[]): Promise<string>
  /** Runs git with `input` on stdin (a long list of revisions never goes through argv). */
  runIn(cwd: string, args: string[], input: string): Promise<string>
}

export const defaultReflogIo: ReflogIo = {
  run: (cwd, args) => git(cwd, args),
  runIn: (cwd, args, input) =>
    new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true })
      let out = ''
      let err = ''
      const timer = setTimeout(() => child.kill(), GIT_OPTS.timeout)
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(out)
        else reject(new Error(`git ${args[0]} failed (${code}): ${err.trim()}`))
      })
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
    })
}

/**
 * Points a ref under `refPrefix` at every commit in the HEAD reflog of `worktreePath` that no ref
 * reaches, and returns the ref names written.
 *
 * A detached HEAD has no branch, so a commit made while detached and then left behind (check out
 * another commit, a rebase or bisect that moved on) is held by nothing but that worktree's own
 * reflog, which goes with the folder. Three bulk git calls to decide, whatever the history: which
 * entries still exist, which of them no ref reaches (with their parents), and one
 * `update-ref --stdin` for all the refs. One ref per chain TIP, not per commit: archiving a tip makes
 * its ancestors reachable. The ref is named by the tip's own short sha, so a second removal can never
 * overwrite a different commit's ref.
 *
 * Never silent: more than the limit ({@link REFLOG_REF_LIMIT} tips) is refused with `reflog-limit`
 * BEFORE any ref is written, so the item stops at the archive step and nothing is trashed. The same
 * goes for a reflog that cannot be read or a ref that cannot be written (the update is one
 * transaction).
 *
 * Nothing is remembered between calls. What no ref reaches changes the moment a tag or a branch is
 * deleted, and a removal asks twice (the forced reprobe, then the executor): each pass asks git again.
 *
 * "Reaches" is `git rev-list --all`, which also counts the HEAD each worktree stands on now: that
 * commit and its ancestry are the tip ref's, written right after this runs.
 */
export function createReflogArchiver(opts: { io?: ReflogIo; limit?: number } = {}): {
  archive(repoPath: string, refPrefix: string, worktreePath: string): Promise<string[]>
} {
  const io = opts.io ?? defaultReflogIo
  const limit = opts.limit ?? REFLOG_REF_LIMIT

  const unreachableTips = async (repoPath: string, entries: string[]): Promise<string[]> => {
    // Entries whose object was pruned cannot be preserved, and are not a commit we could lose.
    const checked = await io.runIn(
      repoPath,
      ['cat-file', '--batch-check'],
      `${entries.join('\n')}\n`
    )
    const commits = checked
      .split('\n')
      .map((l) => l.split(' '))
      .filter((f) => f[1] === 'commit')
      .map((f) => f[0]!)
    if (commits.length === 0) return []
    // What the entries reach that no ref does, with each commit's parents.
    const listed = await io.runIn(
      repoPath,
      ['rev-list', '--parents', '--stdin', '--not', '--all'],
      `${commits.join('\n')}\n`
    )
    const parents = new Map<string, string[]>()
    for (const line of listed.split('\n')) {
      const [sha, ...ps] = line.trim().split(' ')
      if (sha) parents.set(sha, ps)
    }
    const unreachable = commits.filter((sha) => parents.has(sha))
    // A commit that another unreachable entry descends from is kept by that entry's ref.
    const covered = new Set<string>()
    for (const start of unreachable) {
      const stack = [...(parents.get(start) ?? [])]
      while (stack.length > 0) {
        const sha = stack.pop()!
        if (covered.has(sha) || !parents.has(sha)) continue
        covered.add(sha)
        stack.push(...parents.get(sha)!)
      }
    }
    return unreachable.filter((sha) => !covered.has(sha))
  }

  return {
    async archive(repoPath, refPrefix, worktreePath) {
      const log = await io.run(worktreePath, ['reflog', 'show', '--format=%H', 'HEAD'])
      const entries = [
        ...new Set(
          log
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        )
      ]
      if (entries.length === 0) return []

      const tips = await unreachableTips(repoPath, entries)
      if (tips.length > limit) {
        throw new Error(
          `reflog-limit: this worktree's history holds ${tips.length} separate lines of commits that no branch, tag or ref reaches (one tip each), more than the ${limit} tips Harnu keeps for one removal. Nothing was removed. Keep the ones you want with git branch <name> <sha>, or remove the folder yourself.`
        )
      }
      if (tips.length === 0) return []
      const refs = tips.map((sha) => `${refPrefix}/${sha.slice(0, 12)}`)
      await io.runIn(
        repoPath,
        ['update-ref', '--stdin'],
        `${tips.map((sha, i) => `update ${refs[i]} ${sha}`).join('\n')}\n`
      )
      return refs
    }
  }
}

const reflogArchiver = createReflogArchiver()

/** See {@link createReflogArchiver}. */
export const archiveReflog = (
  repoPath: string,
  refPrefix: string,
  worktreePath: string
): Promise<string[]> => reflogArchiver.archive(repoPath, refPrefix, worktreePath)
