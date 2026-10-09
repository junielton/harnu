import { describe, it, expect } from 'vitest'
import { resumeHint } from '../src/renderer/src/lib/gc-resume'
import { blockOf, reviewReason, wt } from './helpers/cleanup-gc-fixtures'
import type { GcBlock } from '../src/renderer/src/lib/gc-model'

/**
 * F0 delta 2 — Retry cannot finish a clean that stopped after the folder was trashed (the
 * engine refuses a folder that is gone), so the screen stops offering it and says what to run.
 */

const halted = (detail: string, over: { folderGone?: boolean; branch?: string | null } = {}) => {
  const b = wt(
    'x',
    'review',
    1000,
    { branch: over.branch === undefined ? 'feat/x' : over.branch },
    {
      reason: reviewReason('cleanup-failed', detail)
    }
  )
  if (over.folderGone !== false) (b as unknown as { folderGone: boolean }).folderGone = true
  return blockOf(b)
}

describe('resumeHint', () => {
  it('a halt at branch-delete after the trash: the step, the prune and the branch command', () => {
    const hint = resumeHint(
      halted('Cleanup stopped at branch-delete in /w/repo/.claude/worktrees/x.')
    )!
    expect(hint.step).toBe('branch-delete')
    expect(hint.commands).toEqual([
      'git -C /w/repo worktree prune',
      'git -C /w/repo branch -D feat/x'
    ])
  })

  it('a halt at prune gives both commands too', () => {
    expect(resumeHint(halted('Cleanup stopped at prune in /w/x.'))!.commands).toHaveLength(2)
  })

  it('leaves the branch command out when there is no branch', () => {
    const hint = resumeHint(halted('Cleanup stopped at prune in /w/x.', { branch: null }))!
    expect(hint.commands).toEqual(['git -C /w/repo worktree prune'])
  })

  it('leaves the branch command out for a step after the branch is gone', () => {
    const hint = resumeHint(halted('Cleanup stopped at detach in /w/x.'))!
    expect(hint.commands).toEqual(['git -C /w/repo worktree prune'])
  })

  it('quotes a repo path or branch that a shell would split', () => {
    const b = halted('Cleanup stopped at prune in /w/x.', { branch: "feat/it's here" })
    const withSpace: GcBlock = { ...b, repoPath: '/w/my repo' }
    expect(resumeHint(withSpace)!.commands).toEqual([
      "git -C '/w/my repo' worktree prune",
      "git -C '/w/my repo' branch -D 'feat/it'\\''s here'"
    ])
  })

  it('is null while the folder is still there, and for any other reason', () => {
    expect(resumeHint(halted('Cleanup stopped at prune.', { folderGone: false }))).toBeNull()
    const dirty = blockOf(wt('y', 'review', 1, {}, { reason: reviewReason('dirty') }))
    expect(resumeHint(dirty)).toBeNull()
  })
})
