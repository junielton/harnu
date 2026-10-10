// What to tell the operator when a clean stopped AFTER the folder was trashed. The engine's
// pre-flight check refuses a folder that is gone, so Retry (and Remove) cannot finish the git
// steps; until a resume path exists the screen says which step stopped and the exact commands.
// Pure: the panel and the list both read it.

import type { GcBlock } from './gc-model'

export interface ResumeHint {
  /** The pipeline step the clean stopped at ("prune", "branch-delete", …). */
  step: string
  /** Shell commands to run, in order, each safe to copy as one line. */
  commands: string[]
  /** True once the archive step had run, so the archive refs hold the commit. */
  archived: boolean
  /** True when no archive exists and the branch is still there: it may hold the only copy of commits. */
  unarchivedWarning: boolean
}

/**
 * The steps from which the archive refs exist: the archive runs before the trash. A halt at
 * `archive` itself may have written none.
 */
const ARCHIVED = new Set(['trash', 'prune', 'branch-delete', 'detach'])

/** The one step that runs after the branch is deleted; before it the branch is still there. */
const BRANCH_GONE_AFTER = 'detach'

/** Quotes a word for a POSIX shell only when it needs it, so the common case reads plainly. */
function shq(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

export function resumeHint(
  block: Pick<GcBlock, 'bundle' | 'reasonCode' | 'reasonDetail' | 'repoPath' | 'branch'>
): ResumeHint | null {
  if (block.reasonCode !== 'cleanup-failed' || block.bundle?.folderGone !== true) return null
  if (!block.repoPath) return null
  const step = /^Cleanup stopped at ([a-z][a-z-]*)/.exec(block.reasonDetail ?? '')?.[1]
  if (!step) return null
  const repo = shq(block.repoPath)
  const commands = [`git -C ${repo} worktree prune`]
  // A halt before the trash with the folder deleted by hand leaves the branch alone, too.
  const archived = ARCHIVED.has(step)
  const branchStays = !!block.branch && step !== BRANCH_GONE_AFTER
  if (block.branch && branchStays) {
    // `-D` only when the archive refs hold the commit. Without them the branch may carry the
    // only copy of unmerged work: `-d` refuses that, and the screen says what a refusal means.
    commands.push(`git -C ${repo} branch ${archived ? '-D' : '-d'} ${shq(block.branch)}`)
  }
  return { step, commands, archived, unarchivedWarning: branchStays && !archived }
}
