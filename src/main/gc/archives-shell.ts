// The git side of the Cleanup "Archives" category (unit C): list `refs/archive/**`, estimate what
// only they keep alive, delete expired refs, and run `git gc` when the operator asks for it.
// Every decision (grouping, expiry, restore commands) is in archives-core.ts; this file only
// asks and tells git. The git runner is injected so the real-git tests and the app share it.
//
// Two rules hold across the file. Deleting a ref NEVER runs `git gc`: the objects are reclaimed
// on git's own next gc, or by the separate, confirmed "Run git gc now". And a ref is deleted
// only together with the sha the operator was shown (`update-ref -d <ref> <sha>`), so a ref that
// moved since the confirm is left alone.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  ARCHIVE_PREFIX,
  groupArchiveRefs,
  type ArchiveEntry,
  type ArchiveRefInfo
} from './archives-core'

const runFile = promisify(execFile)
const GIT_OPTS = { windowsHide: true, timeout: 60_000, maxBuffer: 16 << 20 } as const
/** `git gc` can legitimately run long on a big repo. */
const GC_OPTS = { windowsHide: true, timeout: 600_000, maxBuffer: 16 << 20 } as const

/** Runs `git -C <repo> <args>` and resolves to stdout; rejects when git fails. */
export type GitRunner = (repo: string, args: string[]) => Promise<string>

export const execGit: GitRunner = async (repo, args) =>
  (await runFile('git', ['-C', repo, ...args], GIT_OPTS)).stdout

/** Objects younger than this are kept by `git gc`: a concurrent writer's objects are safe. */
export const GC_PRUNE_WINDOW = '1.hour.ago'

/** Every ref under `refs/archive/`, with its sha and commit date. Empty when there are none. */
export async function listArchiveRefs(git: GitRunner, repo: string): Promise<ArchiveRefInfo[]> {
  const out = await git(repo, [
    'for-each-ref',
    '--format=%(refname)%09%(objectname)%09%(creatordate:unix)',
    ARCHIVE_PREFIX
  ])
  const refs: ArchiveRefInfo[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const [ref, sha, unix] = line.split('\t')
    if (!ref || !sha || !/^[0-9a-f]{40,64}$/.test(sha)) continue
    const secs = Number(unix)
    refs.push({ ref, sha, at: Number.isFinite(secs) && secs > 0 ? secs * 1000 : Number.NaN })
  }
  return refs
}

export async function listRepoArchives(git: GitRunner, repo: string): Promise<ArchiveEntry[]> {
  return groupArchiveRefs(repo, await listArchiveRefs(git, repo))
}

/**
 * Bytes on disk of the objects reachable ONLY from `refs/archive/*`: what deleting every archive
 * would let git's gc reclaim. An estimate (a worktree's detached HEAD is not a ref, so an object
 * only it reaches still counts), shown with a leading "≈". Null when git cannot say: before git
 * 2.31 there is no `--disk-usage`, and a figure that is not known is never invented.
 */
export async function archiveBytes(git: GitRunner, repo: string): Promise<number | null> {
  try {
    const out = await git(repo, [
      'rev-list',
      '--objects',
      '--disk-usage',
      `--glob=${ARCHIVE_PREFIX}*`,
      '--not',
      `--exclude=${ARCHIVE_PREFIX}*`,
      '--all',
      // Reflogs and the index keep objects alive too: what they reach is not freed by deleting an archive.
      '--reflog',
      '--indexed-objects'
    ])
    const n = Number(out.trim())
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export interface DeleteArchivesResult {
  /** The refs that were deleted. */
  deleted: string[]
  /** How many ARCHIVES that is: an entry counts once, when every ref it holds was deleted. */
  archives: number
  /** The refs that were not, with git's own reason. */
  failed: Array<{ ref: string; error: string }>
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Deletes the refs of the given entries, each against the sha the entry carries. Only a ref under
 * `refs/archive/` is ever touched; anything else is reported as failed and left alone. Never
 * runs `git gc`: the objects go on git's next gc.
 */
export async function deleteArchiveEntries(
  git: GitRunner,
  repo: string,
  entries: readonly ArchiveEntry[]
): Promise<DeleteArchivesResult> {
  const result: DeleteArchivesResult = { deleted: [], archives: 0, failed: [] }
  for (const entry of entries) {
    const targets: Array<{ ref: string | null; sha: string | null }> = [
      { ref: entry.tipRef, sha: entry.tipSha },
      { ref: entry.wipRef, sha: entry.wipSha }
    ]
    const failedBefore = result.failed.length
    for (const { ref, sha } of targets) {
      if (!ref) continue
      if (!ref.startsWith(ARCHIVE_PREFIX) || !sha) {
        result.failed.push({ ref, error: 'not an archive ref, or its sha is unknown' })
        continue
      }
      try {
        await git(repo, ['update-ref', '-d', ref, sha])
        result.deleted.push(ref)
      } catch (err) {
        result.failed.push({ ref, error: messageOf(err) })
      }
    }
    if (result.failed.length === failedBefore && entry.refs.length > 0) result.archives++
  }
  return result
}

/**
 * `git gc` with a one-hour prune window: unreachable objects older than that go, a concurrent
 * writer's fresh ones stay. The operator confirms it separately from deleting refs.
 */
export async function runGitGc(git: GitRunner, repo: string): Promise<void> {
  // The runner has fixed options; gc is the one call that needs the long timeout.
  if (git === execGit) {
    await runFile('git', ['-C', repo, 'gc', '--quiet', `--prune=${GC_PRUNE_WINDOW}`], GC_OPTS)
    return
  }
  await git(repo, ['gc', '--quiet', `--prune=${GC_PRUNE_WINDOW}`])
}
