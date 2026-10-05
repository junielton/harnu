import { describe, it, expect, beforeEach } from 'vitest'
import {
  addInheritOnce,
  snapshotInheritOnce,
  hasInheritOnce,
  closeInheritOnce,
  _resetInheritOnce
} from '../src/main/mcp/inherit-once-registry'

/**
 * T72 — the in-memory "inherit-once" registry. Holds the worktree paths allowed
 * "Only this" (just this app session). It stores NORMALIZED paths (so the snapshot
 * compares bit-for-bit with the gate), dedupes, is process-lifetime, and NEVER
 * persists — `closeInheritOnce` wipes it on teardown (a capability that survives a
 * restart is a smell). The security math (only consulted on deny+FOLDER_NOT_ALLOWED)
 * lives in `plan-tool-call`; this pins the registry's own add/snapshot/close.
 */

const HOME = '/home/u'

beforeEach(() => _resetInheritOnce())

describe('inherit-once registry — add + snapshot', () => {
  it('adds a worktree and it appears in the snapshot (normalized)', () => {
    addInheritOnce('/home/u/repo/.claude/worktrees/wt', HOME)
    expect(snapshotInheritOnce()).toEqual(['/home/u/repo/.claude/worktrees/wt'])
    expect(hasInheritOnce('/home/u/repo/.claude/worktrees/wt', HOME)).toBe(true)
  })

  it('normalizes on add (trailing slash / . segments collapse)', () => {
    addInheritOnce('/home/u/repo/.claude/worktrees/wt/', HOME)
    expect(snapshotInheritOnce()).toEqual(['/home/u/repo/.claude/worktrees/wt'])
    // A differently-spelled twin resolves to the same entry — no duplicate.
    addInheritOnce('/home/u/repo/./.claude/worktrees/wt', HOME)
    expect(snapshotInheritOnce()).toEqual(['/home/u/repo/.claude/worktrees/wt'])
  })

  it('dedupes a repeat add', () => {
    addInheritOnce('/home/u/repo/.claude/worktrees/wt', HOME)
    addInheritOnce('/home/u/repo/.claude/worktrees/wt', HOME)
    expect(snapshotInheritOnce()).toHaveLength(1)
  })

  it('holds multiple distinct worktrees', () => {
    addInheritOnce('/home/u/repo/.claude/worktrees/a', HOME)
    addInheritOnce('/home/u/repo/.claude/worktrees/b', HOME)
    expect(new Set(snapshotInheritOnce())).toEqual(
      new Set(['/home/u/repo/.claude/worktrees/a', '/home/u/repo/.claude/worktrees/b'])
    )
  })

  it('a path not added is not present', () => {
    expect(hasInheritOnce('/home/u/repo/.claude/worktrees/nope', HOME)).toBe(false)
  })
})

describe('inherit-once registry — teardown never persists', () => {
  it('closeInheritOnce wipes every once-allow (dies with the server)', () => {
    addInheritOnce('/home/u/repo/.claude/worktrees/a', HOME)
    addInheritOnce('/home/u/repo/.claude/worktrees/b', HOME)
    expect(snapshotInheritOnce()).toHaveLength(2)
    closeInheritOnce()
    expect(snapshotInheritOnce()).toEqual([])
  })
})
