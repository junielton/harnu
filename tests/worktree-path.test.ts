import { describe, it, expect } from 'vitest'
import {
  slugifyBranch,
  deriveWorktreePath,
  canonicalWorktreeParentRepo,
  decideWorktreeInheritance
} from '../src/main/worktree-core'

describe('slugifyBranch', () => {
  it('replaces the path separator with a dash', () => {
    expect(slugifyBranch('feat/login')).toBe('feat-login')
  })

  it('keeps dots and underscores so versioned branches stay readable', () => {
    expect(slugifyBranch('release/1.2.0')).toBe('release-1.2.0')
    expect(slugifyBranch('chore/my_thing')).toBe('chore-my_thing')
  })

  it('collapses runs of unsafe characters into a single dash', () => {
    expect(slugifyBranch('feat//deep///nest')).toBe('feat-deep-nest')
    expect(slugifyBranch('hot fix now')).toBe('hot-fix-now')
  })

  it('trims leading and trailing separators/dashes', () => {
    expect(slugifyBranch('/feat/login/')).toBe('feat-login')
    expect(slugifyBranch('  spaced  ')).toBe('spaced')
  })
})

describe('deriveWorktreePath', () => {
  it('places the worktree under <root>/.claude/worktrees/<slug> by default', () => {
    expect(deriveWorktreePath('/home/u/repo', 'feat/login')).toBe(
      '/home/u/repo/.claude/worktrees/feat-login'
    )
  })

  it('resolves a relative explicit path against the worktrees root', () => {
    expect(deriveWorktreePath('/home/u/repo', 'feat/login', 'custom-dir')).toBe(
      '/home/u/repo/.claude/worktrees/custom-dir'
    )
  })

  it('normalizes an absolute explicit path verbatim', () => {
    expect(deriveWorktreePath('/home/u/repo', 'feat/login', '/abs/custom/')).toBe('/abs/custom')
  })
})

// ── T61: canonical worktree layout recognition ──────────────────────────────
describe('canonicalWorktreeParentRepo', () => {
  it('returns the repo root for the canonical `<repo>/.claude/worktrees/<slug>` layout', () => {
    expect(canonicalWorktreeParentRepo('/home/u/repo/.claude/worktrees/feat-login')).toBe(
      '/home/u/repo'
    )
  })

  it('matches the path deriveWorktreePath produces', () => {
    const target = deriveWorktreePath('/home/u/repo', 'feat/login')
    expect(canonicalWorktreeParentRepo(target)).toBe('/home/u/repo')
  })

  it('tolerates a trailing separator', () => {
    expect(canonicalWorktreeParentRepo('/home/u/repo/.claude/worktrees/wt/')).toBe('/home/u/repo')
  })

  it('returns null for a worktree NESTED below the worktrees root (not a direct child)', () => {
    expect(canonicalWorktreeParentRepo('/home/u/repo/.claude/worktrees/a/b')).toBeNull()
  })

  it('returns null for a custom-path worktree outside `.claude/worktrees`', () => {
    expect(canonicalWorktreeParentRepo('/tmp/custom-wt')).toBeNull()
    expect(canonicalWorktreeParentRepo('/home/u/repo/.git/worktrees/x')).toBeNull()
  })

  it('returns null for a plain repo folder (not a worktree)', () => {
    expect(canonicalWorktreeParentRepo('/home/u/repo')).toBeNull()
  })
})

describe('decideWorktreeInheritance', () => {
  it('inherits only when setting ON, parent allowed, and not opted out', () => {
    expect(
      decideWorktreeInheritance({ settingEnabled: true, baseRepoAllowed: true, optedOut: false })
    ).toBe(true)
  })

  it('does not inherit when the global setting is off (fail-closed default)', () => {
    expect(
      decideWorktreeInheritance({ settingEnabled: false, baseRepoAllowed: true, optedOut: false })
    ).toBe(false)
  })

  it('does not inherit when the parent repo is not agent-allowed', () => {
    expect(
      decideWorktreeInheritance({ settingEnabled: true, baseRepoAllowed: false, optedOut: false })
    ).toBe(false)
  })

  it('does not inherit when the human opted out', () => {
    expect(
      decideWorktreeInheritance({ settingEnabled: true, baseRepoAllowed: true, optedOut: true })
    ).toBe(false)
  })
})
