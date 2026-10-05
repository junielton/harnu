import { describe, it, expect } from 'vitest'
import {
  displayAlias,
  basename,
  type AliasFolder
} from '../src/renderer/src/components/folder-alias'

/**
 * T52 label derivation — the precedence custom > branch (when auto-alias on) >
 * basename must be inequivocal, or the auto-alias toggle would silently "eat" a
 * user's custom rename. Each assertion pins an independent, hand-written label —
 * never a value derived from the function under test.
 */

const WT = '/repos/app/.claude/worktrees/feat-x' // basename = 'feat-x'
function f(over: Partial<AliasFolder>): AliasFolder {
  return { path: WT, alias: 'feat-x', ...over }
}

describe('displayAlias', () => {
  it('a custom alias always wins, with or without preferBranch', () => {
    expect(displayAlias(f({ alias: 'My Feature', gitBranch: 'feature/foo' }), false)).toBe(
      'My Feature'
    )
    expect(displayAlias(f({ alias: 'My Feature', gitBranch: 'feature/foo' }), true)).toBe(
      'My Feature'
    )
  })

  it('falls back to the branch when preferBranch is on and the basename differs', () => {
    expect(displayAlias(f({ alias: 'feat-x', gitBranch: 'feature/foo' }), true)).toBe('feature/foo')
  })

  it('keeps the basename when preferBranch is on but the branch equals the basename', () => {
    expect(displayAlias({ path: '/repos/app', alias: 'app', gitBranch: 'app' }, true)).toBe('app')
  })

  it('keeps the basename when preferBranch is off', () => {
    expect(displayAlias(f({ alias: 'feat-x', gitBranch: 'feature/foo' }), false)).toBe('feat-x')
  })

  it('keeps the basename when there is no branch', () => {
    expect(displayAlias(f({ alias: 'feat-x' }), true)).toBe('feat-x')
  })

  it('treats alias === basename as "no custom override" (so reset re-enables auto-alias)', () => {
    // After a reset, the persisted alias is the basename; auto-alias should apply.
    expect(displayAlias(f({ alias: 'feat-x', gitBranch: 'topic/bar' }), true)).toBe('topic/bar')
  })
})

describe('basename', () => {
  it('takes the last segment, trailing slashes stripped, cross-platform', () => {
    expect(basename('/a/b/c')).toBe('c')
    expect(basename('/a/b/')).toBe('b')
    expect(basename('C:\\repos\\app')).toBe('app')
    expect(basename('')).toBe('')
  })
})
