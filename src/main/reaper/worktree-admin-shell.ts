// Unregisters one worktree from git, and nothing else (T441 delta 3b, item 11; delta 4, N4). A
// plain `git worktree prune` also drops the registration of any unlocked worktree whose folder
// is temporarily missing; this removes only the admin directory whose `gitdir` file points at
// the worktree that is being cleaned, absolute or relative. No electron: node fs and an
// injected git runner.

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { matchAdminDir } from './executor-core'

/**
 * The admin directory of the worktree at `worktreePath`, or null: nothing is registered for it,
 * the match is ambiguous, or the worktree is locked (a lock is the user's way of saying "keep
 * this registered", as with `git worktree prune`).
 */
export async function findAdminDir(
  repoPath: string,
  worktreePath: string,
  git: (repo: string, args: string[]) => Promise<string>
): Promise<string | null> {
  const common = (
    await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim()
  const base = path.join(common, 'worktrees')
  let names: string[]
  try {
    names = await fs.readdir(base)
  } catch {
    return null // no worktree is registered at all
  }
  const entries: Array<{ dir: string; gitdir: string }> = []
  for (const name of names) {
    const dir = path.join(base, name)
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
  return matchAdminDir(entries, worktreePath)
}

export async function canUnregister(
  repoPath: string,
  worktreePath: string,
  git: (repo: string, args: string[]) => Promise<string>
): Promise<boolean> {
  return (await findAdminDir(repoPath, worktreePath, git)) !== null
}

/** Removes the worktree's own admin dir; false when there is none to remove. */
export async function removeWorktreeAdmin(
  repoPath: string,
  worktreePath: string,
  git: (repo: string, args: string[]) => Promise<string>
): Promise<boolean> {
  const mine = await findAdminDir(repoPath, worktreePath, git)
  if (!mine) return false
  await fs.rm(mine, { recursive: true, force: true })
  return true
}
