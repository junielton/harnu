// View helpers of the Shelved card (autonomous cleanup U2.3a): pure, so they are tested without a DOM.

import type { ShelvedEntry } from '../../../main/gc/shelve-store'
import type { ShelvedRestoreFailure } from '../../../main/gc/shelve-restore-shell'

/** A value that is already one safe shell word stays bare; anything else is single-quoted. */
const SHELL_SAFE = /^[A-Za-z0-9,._+:@%/-]+$/
const quote = (v: string): string => (SHELL_SAFE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`)

/**
 * The command that makes a fresh worktree where the shelved one stood, for when Restore cannot
 * (the archive record is gone): on the kept branch, or detached at the recorded commit.
 */
export function freshWorktreeCommand(e: ShelvedEntry): string {
  const repo = quote(e.repoPath)
  const at = quote(e.worktreePath)
  return e.branch
    ? `git -C ${repo} worktree add ${at} ${quote(e.branch)}`
    : `git -C ${repo} worktree add --detach ${at} ${e.headSha}`
}

/** The i18n key (under `cleanup.gc.shelved.failure.`) for a failed restore's reason. */
export function failureKey(reason: ShelvedRestoreFailure | string | undefined): string {
  switch (reason) {
    case 'repo-busy':
      return 'repoBusy'
    case 'in-use':
      return 'inUse'
    case 'record-missing':
      return 'recordMissing'
    case 'archive-unverified':
      return 'archiveUnverified'
    case 'move-aside-failed':
      return 'moveAsideFailed'
    case 'path-exists':
      return 'pathExists'
    default:
      return 'other'
  }
}

/** Failures where the command above is the way out; the others are "try again" or "move the folder". */
export function offersFreshWorktree(reason: ShelvedRestoreFailure | string | undefined): boolean {
  return !['repo-busy', 'in-use', 'move-aside-failed', 'path-exists'].includes(reason ?? '')
}
