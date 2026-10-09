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
  if (block.branch && step !== BRANCH_GONE_AFTER) {
    commands.push(`git -C ${repo} branch -D ${shq(block.branch)}`)
  }
  return { step, commands, archived: ARCHIVED.has(step) }
}
