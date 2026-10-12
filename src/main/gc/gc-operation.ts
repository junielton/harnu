// Whether a detached worktree is in the middle of a rebase or a bisect. Both keep their state in the
// worktree's own git dir (the rebase todo list, the bisect log), which goes with the folder when it is
// removed: the commits are archived by sha, but the unfinished operation is not, and a detached HEAD
// is exactly where they run. So Cleanup refuses to remove one until it is finished or aborted.
// env-bound (git + fs); the decision to refuse is in bundle-core, gc-shell and gc-removability.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type GitOperation = 'rebase' | 'bisect'

/** The marker each operation leaves in the git dir, in the order they are reported. */
const MARKERS: ReadonlyArray<readonly [GitOperation, string]> = [
  ['rebase', 'rebase-merge'],
  ['rebase', 'rebase-apply'],
  ['bisect', 'BISECT_LOG']
]

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

/**
 * The operation in progress in `worktreePath`, or null. A folder git cannot read is null too: the
 * scan states what it saw, and the reprobe's other probes refuse an unreadable worktree.
 */
export async function gitOperationOf(worktreePath: string): Promise<GitOperation | null> {
  let paths: string[]
  try {
    const args = ['-C', worktreePath, 'rev-parse']
    for (const [, marker] of MARKERS) args.push('--git-path', marker)
    const { stdout } = await run('git', args, { windowsHide: true, timeout: 30_000 })
    paths = stdout.split('\n').filter(Boolean)
  } catch {
    return null
  }
  for (const [i, [op]] of MARKERS.entries()) {
    const p = paths[i]
    if (p && (await exists(path.resolve(worktreePath, p)))) return op
  }
  return null
}
