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

import { execFile } from 'node:child_process'
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

    await git(repoPath, ['update-ref', ref, commit])
    return commit
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined)
  }
}
