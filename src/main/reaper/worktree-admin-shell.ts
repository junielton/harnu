// Unregisters one worktree from git, and nothing else (T441 delta 3b, item 11). A plain
// `git worktree prune` also drops the registration of any unlocked worktree whose folder is
// temporarily missing; this removes only the admin directory whose `gitdir` file points at
// the worktree that was just trashed. No electron: node fs and an injected git runner.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { matchAdminDir } from './executor-core'

export async function removeWorktreeAdmin(
  repoPath: string,
  worktreePath: string,
  git: (repo: string, args: string[]) => Promise<string>
): Promise<void> {
  const common = (
    await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim()
  const base = path.join(common, 'worktrees')
  let names: string[]
  try {
    names = await fs.readdir(base)
  } catch {
    return // no worktree is registered at all
  }
  const entries: Array<{ dir: string; gitdir: string }> = []
  for (const name of names) {
    const dir = path.join(base, name)
    // A locked worktree is the user's way of saying "keep this registered": leave it, as
    // `git worktree prune` does.
    if (
      await fs.stat(path.join(dir, 'locked')).then(
        () => true,
        () => false
      )
    )
      continue
    try {
      entries.push({ dir, gitdir: await fs.readFile(path.join(dir, 'gitdir'), 'utf8') })
    } catch {
      // Not an admin dir we can read: it is not ours to remove.
    }
  }
  const mine = matchAdminDir(entries, worktreePath)
  if (mine) await fs.rm(mine, { recursive: true, force: true })
}
