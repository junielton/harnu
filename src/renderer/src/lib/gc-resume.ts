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
}

/** The steps after which the local branch can still be there (prune and branch-delete). */
const BRANCH_MAY_REMAIN = new Set(['prune', 'branch-delete'])

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
  if (block.branch && BRANCH_MAY_REMAIN.has(step)) {
    commands.push(`git -C ${repo} branch -D ${shq(block.branch)}`)
  }
  return { step, commands }
}
