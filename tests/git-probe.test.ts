import { describe, it, expect } from 'vitest'
import { parseRevParse, buildGitMeta, slugFallbackRepoId } from '../src/main/git-probe'

/**
 * Pure parsing/derivation for the per-folder git probe (folder-first model,
 * spec §4.2). The IO wrapper (execFile + realpath + cache) is thin and not
 * unit-tested here; these cover the logic that turns `git rev-parse` output
 * into a `GitMeta` and the slug-based fallback used when the probe fails.
 */
describe('parseRevParse', () => {
  it('splits the two output lines into branch + commonDir', () => {
    expect(parseRevParse('main\n/home/u/repo/.git\n')).toEqual({
      branch: 'main',
      commonDir: '/home/u/repo/.git'
    })
  })

  it('tolerates CRLF and missing trailing newline', () => {
    expect(parseRevParse('feat/x\r\n.git')).toEqual({ branch: 'feat/x', commonDir: '.git' })
  })

  it('returns empty strings for absent lines', () => {
    expect(parseRevParse('')).toEqual({ branch: '', commonDir: '' })
    expect(parseRevParse('HEAD\n')).toEqual({ branch: 'HEAD', commonDir: '' })
  })
})

describe('buildGitMeta', () => {
  it('main worktree: dirname(repoId) === folder ⇒ isMainWorktree true', () => {
    expect(buildGitMeta('main', '/home/u/repo/.git', '/home/u/repo')).toEqual({
      gitBranch: 'main',
      repoId: '/home/u/repo/.git',
      isMainWorktree: true
    })
  })

  it('linked worktree: dirname(repoId) !== folder ⇒ isMainWorktree false, repoId shared', () => {
    expect(
      buildGitMeta('feat/login', '/home/u/repo/.git', '/home/u/repo/.claude/worktrees/login')
    ).toEqual({
      gitBranch: 'feat/login',
      repoId: '/home/u/repo/.git',
      isMainWorktree: false
    })
  })

  it('detached HEAD ⇒ gitBranch omitted (not present as a key)', () => {
    const meta = buildGitMeta('HEAD', '/home/u/repo/.git', '/home/u/repo')
    expect('gitBranch' in meta).toBe(false)
    expect(meta).toEqual({ repoId: '/home/u/repo/.git', isMainWorktree: true })
  })

  it('empty branch ⇒ gitBranch omitted', () => {
    const meta = buildGitMeta('', '/home/u/repo/.git', '/home/u/repo')
    expect('gitBranch' in meta).toBe(false)
  })
})

describe('slugFallbackRepoId', () => {
  it('derives the parent repo .git from a .claude/worktrees path', () => {
    expect(slugFallbackRepoId('/home/u/repo/.claude/worktrees/login')).toBe('/home/u/repo/.git')
  })

  it('returns undefined for a plain (non-worktree) path', () => {
    expect(slugFallbackRepoId('/home/u/gym-photos')).toBeUndefined()
    expect(slugFallbackRepoId('/home/u/repo')).toBeUndefined()
  })

  it('handles Windows native (backslash) worktree paths', () => {
    expect(slugFallbackRepoId('C:\\Users\\u\\repo\\.claude\\worktrees\\login')).toBe(
      'C:\\Users\\u\\repo/.git'
    )
  })
})
