import { describe, it, expect } from 'vitest'
import {
  mergeFolders,
  userProjectToFolder,
  type PersistedUserProject
} from '../src/renderer/src/stores/merge-folders'
import { groupByRepo, type FolderGroup } from '../src/renderer/src/stores/folder-zones'
import type { FolderEntry, GitMeta } from '../src/preload'

/** Build a user-project record with sane defaults; `partial` overrides + git. */
function up(
  partial: Partial<PersistedUserProject> & { path: string; alias: string }
): PersistedUserProject {
  return { addedAt: '2026-01-01T00:00:00.000Z', worktrees: [], ...partial }
}

/** Narrow a grouped sidebar entry to the synthetic group header. */
function repoGroupsOf(grouped: Array<unknown>): FolderGroup[] {
  return grouped.filter((g): g is FolderGroup => typeof g === 'object' && g !== null && 'kind' in g)
}

describe('userProjectToFolder — adoption via the volatile gitByPath map', () => {
  it('enriches a placeholder from gitByPath and groups it under its repo', () => {
    const wtPath = '/repos/app/.claude/worktrees/feature'
    const gitByPath = new Map<string, GitMeta>([
      [wtPath, { repoId: '/repos/app/.git', gitBranch: 'feature', isMainWorktree: false }]
    ])
    const disk: FolderEntry[] = [
      {
        path: '/repos/app',
        alias: 'app',
        repoId: '/repos/app/.git',
        gitBranch: 'main',
        isMainWorktree: true,
        sessions: []
      }
    ]
    const userList: PersistedUserProject[] = [up({ path: wtPath, alias: 'feature' })]

    const merged = mergeFolders(disk, userList, [], gitByPath)
    const placeholder = merged.find((f) => f.path === wtPath)!
    expect(placeholder.repoId).toBe('/repos/app/.git')
    expect(placeholder.gitBranch).toBe('feature')
    expect(placeholder.isMainWorktree).toBe(false)
    expect(placeholder.pinned).toBe(true)
    expect(placeholder.sessions).toEqual([])

    // Same repoId as the disk main worktree → one collapsed repo group.
    const groups = repoGroupsOf(groupByRepo(merged))
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('/repos/app/.git')
    expect(groups[0].folders.map((f) => f.path).sort()).toEqual(['/repos/app', wtPath])
  })
})

describe('userProjectToFolder — persisted git on the record (survives reload)', () => {
  it('reads repoId/gitBranch/isMainWorktree from the record WITHOUT a gitByPath map', () => {
    const rec = up({
      path: '/repos/app/.claude/worktrees/feature',
      alias: 'feature',
      repoId: '/repos/app/.git',
      gitBranch: 'feature',
      isMainWorktree: false
    })
    // No gitByPath argument — the volatile map is gone after a reload.
    const folder = userProjectToFolder(rec)
    expect(folder.repoId).toBe('/repos/app/.git')
    expect(folder.gitBranch).toBe('feature')
    expect(folder.isMainWorktree).toBe(false)
    expect(folder.pinned).toBe(true)
  })

  it('still groups under its repo through mergeFolders with NO gitByPath', () => {
    const wtPath = '/repos/app/.claude/worktrees/feature'
    const disk: FolderEntry[] = [
      {
        path: '/repos/app',
        alias: 'app',
        repoId: '/repos/app/.git',
        gitBranch: 'main',
        isMainWorktree: true,
        sessions: []
      }
    ]
    const userList: PersistedUserProject[] = [
      up({
        path: wtPath,
        alias: 'feature',
        repoId: '/repos/app/.git',
        gitBranch: 'feature',
        isMainWorktree: false
      })
    ]

    const merged = mergeFolders(disk, userList, [])
    expect(merged.find((f) => f.path === wtPath)!.repoId).toBe('/repos/app/.git')
    expect(repoGroupsOf(groupByRepo(merged))).toHaveLength(1)
  })
})

describe('userProjectToFolder — the gap: no git → ungrouped standalone', () => {
  it('omits the git keys entirely and never forms a repo group', () => {
    const rec = up({ path: '/code/loose', alias: 'loose' })

    const folder = userProjectToFolder(rec)
    // Absent fields must not land as explicit `undefined` keys.
    expect('repoId' in folder).toBe(false)
    expect('gitBranch' in folder).toBe(false)
    expect('isMainWorktree' in folder).toBe(false)
    expect(folder.repoId).toBeUndefined()

    const grouped = groupByRepo(mergeFolders([], [rec], []))
    expect(repoGroupsOf(grouped)).toHaveLength(0)
    expect(grouped).toHaveLength(1)
  })
})

describe('mergeFolders — existing disk-folder behavior unchanged', () => {
  it('a disk entry: not pinned, basename alias, git fields preserved, collapsed', () => {
    const disk: FolderEntry[] = [
      { path: '/repos/alpha', alias: 'alpha', gitBranch: 'main', sessions: [] }
    ]
    const merged = mergeFolders(disk, [], [])
    expect(merged).toHaveLength(1)
    const f = merged[0]
    expect(f.path).toBe('/repos/alpha')
    expect(f.alias).toBe('alpha')
    expect(f.gitBranch).toBe('main')
    expect(f.pinned).toBe(false)
    expect(f.expanded).toBe(false)
  })

  it('a user alias overrides the disk basename alias and marks the folder pinned', () => {
    const disk: FolderEntry[] = [{ path: '/repos/alpha', alias: 'alpha', sessions: [] }]
    const merged = mergeFolders(disk, [up({ path: '/repos/alpha', alias: 'My Alpha' })], [])
    expect(merged).toHaveLength(1)
    expect(merged[0].alias).toBe('My Alpha')
    expect(merged[0].pinned).toBe(true)
  })

  it('a user-only path (no disk counterpart) comes first as an empty pinned placeholder', () => {
    const disk: FolderEntry[] = [{ path: '/repos/alpha', alias: 'alpha', sessions: [] }]
    const merged = mergeFolders(disk, [up({ path: '/other/thing', alias: 'thing' })], [])
    expect(merged.map((f) => f.path)).toEqual(['/other/thing', '/repos/alpha'])
    expect(merged[0].pinned).toBe(true)
    expect(merged[0].sessions).toEqual([])
  })
})
