import { describe, it, expect } from 'vitest'
import { mergeFolders } from '../src/renderer/src/stores/merge-folders'
import type { FolderEntry } from '../src/preload'

const disk = (path: string, n = 1): FolderEntry => ({
  path,
  alias: path.split('/').pop()!,
  gitBranch: 'x',
  sessions: Array.from({ length: n }, (_, i) => ({
    sessionId: `${path}-${i}`,
    modified: '2026-01-01T00:00:00.000Z'
  })) as FolderEntry['sessions']
})

describe('mergeFolders — git-listed worktrees (AC-32, AC-33)', () => {
  const listed = [
    {
      repoId: '/r/.git',
      worktrees: [
        { path: '/r', branch: 'main', isMainWorktree: true, locked: false },
        { path: '/r/wt-old', branch: 'old', isMainWorktree: false, locked: false },
        { path: '/r/wt-new', branch: 'new', isMainWorktree: false, locked: false }
      ]
    }
  ]
  it('flags every listed folder, including ones with sessions, and injects one placeholder per missing path', () => {
    const out = mergeFolders([disk('/r'), disk('/r/wt-old')], [], [], undefined, listed)
    expect(out.map((f) => [f.path, f.gitListed === true, f.sessions.length])).toEqual(
      expect.arrayContaining([
        ['/r', true, 1],
        ['/r/wt-old', true, 1],
        ['/r/wt-new', true, 0]
      ])
    )
    expect(out.filter((f) => f.path === '/r/wt-new')).toHaveLength(1)
    expect(out.find((f) => f.path === '/r/wt-new')).toMatchObject({
      repoId: '/r/.git',
      gitBranch: 'new',
      isMainWorktree: false,
      pinned: false
    })
  })
  it('a pinned placeholder that is also listed is flagged, not duplicated', () => {
    const out = mergeFolders(
      [disk('/r')],
      [{ path: '/r/wt-new', alias: 'mine' }],
      [],
      undefined,
      listed
    )
    const rows = out.filter((f) => f.path === '/r/wt-new')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pinned: true, gitListed: true, alias: 'mine' })
  })
  it('a detached worktree (empty branch) carries no gitBranch', () => {
    const out = mergeFolders([], [], [], undefined, [
      {
        repoId: '/r/.git',
        worktrees: [{ path: '/r/det', branch: '', isMainWorktree: false, locked: false }]
      }
    ])
    expect('gitBranch' in out[0]).toBe(false)
  })
  it('without listings the output is unchanged (no gitListed key)', () => {
    const out = mergeFolders([disk('/r')], [], [])
    expect('gitListed' in out[0]).toBe(false)
  })
})
