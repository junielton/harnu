import { describe, it, expect } from 'vitest'
import {
  gitSummary,
  isGitFolder,
  roadmapLine
} from '../src/renderer/src/components/folder-view-format'

/** The pure shaping behind the slim Folder View (design.md §6 "Folder View"). */

const counts = (over: Record<string, number> = {}): never =>
  ({
    counts: { backlog: 0, ready: 0, 'in-progress': 0, review: 0, done: 0, ...over },
    active: []
  }) as never

describe('isGitFolder', () => {
  it('is true for a repo id or a branch, false for a plain directory', () => {
    expect(isGitFolder({ repoId: 'r' })).toBe(true)
    expect(isGitFolder({ gitBranch: 'main' })).toBe(true)
    expect(isGitFolder({})).toBe(false)
    expect(isGitFolder(null)).toBe(false)
  })
})

describe('gitSummary', () => {
  it('lists changes, ahead and behind, and asks for attention when dirty', () => {
    expect(gitSummary({ dirtyCount: 2, ahead: 1, behind: 3 })).toEqual({
      parts: [
        { key: 'changes', n: 2 },
        { key: 'ahead', n: 1 },
        { key: 'behind', n: 3 }
      ],
      attention: true
    })
  })

  it('asks for attention when behind, not when only ahead', () => {
    expect(gitSummary({ dirtyCount: 0, ahead: 0, behind: 2 })?.attention).toBe(true)
    expect(gitSummary({ dirtyCount: 0, ahead: 2, behind: 0 })).toEqual({
      parts: [
        { key: 'clean', n: 0 },
        { key: 'ahead', n: 2 }
      ],
      attention: false
    })
  })

  it('leaves out what the probe could not read instead of printing zero', () => {
    expect(gitSummary({ dirtyCount: null, ahead: null, behind: null })).toBeNull()
    expect(gitSummary({ dirtyCount: null, ahead: 1, behind: null })?.parts).toEqual([
      { key: 'ahead', n: 1 }
    ])
    expect(gitSummary(null)).toBeNull()
  })
})

describe('roadmapLine', () => {
  it('is null with no board', () => {
    expect(roadmapLine(null)).toBeNull()
    expect(roadmapLine(counts())).toBeNull()
  })

  it('shows a board that holds only backlog or done cards', () => {
    expect(roadmapLine(counts({ done: 3 }))).toEqual({
      inProgress: 0,
      ready: 0,
      review: 0,
      inProgressPct: 0,
      readyPct: 0
    })
  })

  it('sizes the two segments against in progress + ready + review', () => {
    expect(roadmapLine(counts({ 'in-progress': 1, ready: 3, backlog: 50 }))).toMatchObject({
      inProgressPct: 25,
      readyPct: 75
    })
  })
})
