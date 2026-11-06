import { describe, expect, it } from 'vitest'
import { leftoverPathFor, shelvedEntryFor } from '../src/main/gc/shelve-restore-core'
import type { ShelvedEntry, ShelvedFile } from '../src/main/gc/shelve-store'

const entry = (over: Partial<ShelvedEntry> = {}): ShelvedEntry => ({
  id: '/ws/org/proj/www::worktree::/t/feat-x',
  repoPath: '/ws/org/proj/www',
  worktreePath: '/t/feat-x',
  branch: 'feat/x',
  headSha: 'a'.repeat(40),
  namespace: 'refs/archive/feat/x/20261105T100000Z',
  shelvedAt: 1_000,
  idleDays: 9,
  reason: 'Shelved feat/x — idle 9 d, branch kept',
  freedBytes: 1,
  ...over
})

const file = (...entries: ShelvedEntry[]): ShelvedFile => ({ version: 1, entries })

describe('shelvedEntryFor', () => {
  it('finds the entry whose folder is the requested folder', () => {
    const e = entry()
    expect(shelvedEntryFor(file(e), '/t/feat-x')).toEqual(e)
  })

  it('finds the entry for a subfolder of the shelved worktree', () => {
    const e = entry()
    expect(shelvedEntryFor(file(e), '/t/feat-x/api')).toEqual(e)
  })

  it('does not treat a shared name prefix as containment', () => {
    expect(shelvedEntryFor(file(entry()), '/t/feat-xy')).toBeNull()
  })

  it('answers null for an empty store and for an empty folder', () => {
    expect(shelvedEntryFor(file(), '/t/feat-x')).toBeNull()
    expect(shelvedEntryFor(file(entry()), '')).toBeNull()
  })

  it('compares case-insensitively on Windows only', () => {
    const e = entry({ worktreePath: 'C:\\Trees\\Feat-X' })
    expect(shelvedEntryFor(file(e), 'c:\\trees\\feat-x\\api', 'win32')).toEqual(e)
    expect(shelvedEntryFor(file(entry()), '/T/FEAT-X', 'linux')).toBeNull()
  })

  it('picks the most specific entry when worktrees nest', () => {
    const outer = entry({ id: 'outer', worktreePath: '/t' })
    const inner = entry({ id: 'inner', worktreePath: '/t/feat-x' })
    expect(shelvedEntryFor(file(outer, inner), '/t/feat-x/api')?.id).toBe('inner')
  })
})

describe('leftoverPathFor', () => {
  it('appends a UTC stamp to the worktree path', () => {
    expect(leftoverPathFor('/t/feat-x', Date.UTC(2026, 10, 5, 9, 8, 7))).toBe(
      '/t/feat-x.leftover-20261105T090807'
    )
  })
})
