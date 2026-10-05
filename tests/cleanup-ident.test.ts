import { describe, it, expect } from 'vitest'
import { identText, identTitle, type ReapIdent } from '../src/renderer/src/components/cleanup-ident'

const REPO = '/home/user/Workspace/org/www'

function item(overrides: Partial<ReapIdent> = {}): ReapIdent {
  return { kind: 'worktree', repoPath: REPO, ...overrides }
}

describe('identText', () => {
  it('shows the branch for a worktree', () => {
    expect(identText(item({ branch: 'PROJ-231-panel', path: `${REPO}/../PROJ-231` }))).toBe(
      'PROJ-231-panel'
    )
  })

  it('shows the branch for branch-only rows', () => {
    expect(identText(item({ kind: 'local-branch', branch: 'feat/x' }))).toBe('feat/x')
    expect(identText(item({ kind: 'remote-branch', branch: 'origin/feat/x' }))).toBe(
      'origin/feat/x'
    )
  })

  it('shows a nested hidden folder relative to its repo', () => {
    expect(identText(item({ kind: 'hidden-folder', path: `${REPO}/.worktrees/proj-231` }))).toBe(
      '.worktrees/proj-231'
    )
  })

  it('falls back to the folder name for a hidden folder outside its repo', () => {
    // The common shape: a sibling worktree dir next to the repo. The absolute
    // path truncates to noise in the 240px identity column.
    expect(
      identText(item({ kind: 'hidden-folder', path: '/home/user/Workspace/org/proj-231-panel' }))
    ).toBe('proj-231-panel')
  })

  it('ignores a trailing slash when taking the folder name', () => {
    expect(
      identText(item({ kind: 'hidden-folder', path: '/home/user/Workspace/org/proj-231/' }))
    ).toBe('proj-231')
  })

  it('shows a detached worktree by folder name, not its absolute path', () => {
    // A detached worktree has no branch, so it would otherwise fall through to
    // the absolute path and truncate in the 240px column (BUG-95).
    expect(
      identText(
        item({ kind: 'detached-worktree', path: '/home/user/Workspace/org/proj-231-detached' })
      )
    ).toBe('proj-231-detached')
  })

  it('shows a nested detached worktree relative to its repo', () => {
    expect(identText(item({ kind: 'detached-worktree', path: `${REPO}/.worktrees/bisect` }))).toBe(
      '.worktrees/bisect'
    )
  })

  it('is empty when there is nothing to identify', () => {
    expect(identText(item())).toBe('')
  })
})

describe('identTitle', () => {
  it('carries the full absolute path for a truncated hidden folder', () => {
    const path = '/home/user/Workspace/org/proj-231-panel'
    expect(identTitle(item({ kind: 'hidden-folder', path }))).toBe(path)
  })

  it('reveals the on-disk path a worktree row hides behind its branch name', () => {
    const path = '/home/user/Workspace/org/proj-231'
    expect(identTitle(item({ branch: 'PROJ-231-panel', path }))).toBe(path)
  })

  it('carries the full absolute path for a truncated detached worktree', () => {
    const path = '/home/user/Workspace/org/proj-231-detached'
    expect(identTitle(item({ kind: 'detached-worktree', path }))).toBe(path)
  })

  it('is undefined when it would only repeat the visible text', () => {
    expect(identTitle(item({ kind: 'local-branch', branch: 'feat/x' }))).toBeUndefined()
    expect(identTitle(item())).toBeUndefined()
  })
})
