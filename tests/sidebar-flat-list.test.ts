import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore, type Folder, type Session } from '../src/renderer/src/stores/sessions'
import type { FolderGroup } from '../src/renderer/src/stores/folder-zones'
import type { FolderEntry, UserProject } from '../src/preload'

/**
 * BUG-39 — the classic sidebar's FOLDERS/ACTIVE ELSEWHERE zone split is gone,
 * replaced by a single `sessions.visibleFolders` computed (one classify → sort
 * → groupByRepo → nestByPath pass). Covers the two regressions the split
 * caused:
 *   (a) a repo with members split across the old two zones used to produce
 *       TWO group headers (each zone ran its own `groupByRepo`) — now one.
 *   (b) `dismissFolder` (Hide) used to also unpin, so a pin → hide → unhide
 *       round-trip lost the pinned flag — now hide/unhide never touches pin.
 *   (c) a hidden folder must never render, pinned or not (`hidden` always wins
 *       — `classifyFolder`'s branch order).
 */

type VisibleNode = Folder | FolderGroup<Folder>

function flattenPaths(nodes: VisibleNode[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if ('kind' in n && n.kind === 'folder-group') {
      out.push(...n.folders.map((f) => f.path))
    } else {
      out.push((n as Folder).path)
    }
  }
  return out
}

function diskSession(sessionId: string, folderPath: string, modified: string): Session {
  return {
    sessionId,
    fullPath: `${folderPath}/${sessionId}.jsonl`,
    fileMtime: 1,
    firstPrompt: 'first prompt',
    summary: '',
    messageCount: 1,
    created: modified,
    modified,
    gitBranch: 'main',
    projectPath: folderPath,
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false
  }
}

function diskFolder(
  path: string,
  sessions: Session[],
  over: Partial<FolderEntry> = {}
): FolderEntry {
  return {
    path,
    alias: path.split('/').pop() ?? path,
    sessions: sessions as unknown as FolderEntry['sessions'],
    ...over
  }
}

describe('sessions.visibleFolders — single-pass repo grouping (BUG-39)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('one pinned worktree + one active-unpinned sibling worktree group into exactly one FolderGroup', async () => {
    const now = new Date().toISOString()
    const disk: FolderEntry[] = [
      diskFolder('/repos/app', [], {
        repoId: '/repos/app/.git',
        gitBranch: 'main',
        isMainWorktree: true
      }),
      // Active because it has a session modified "now" (well within the
      // default 48h active window) — but never pinned.
      diskFolder('/repos/app-wt/feature', [diskSession('s1', '/repos/app-wt/feature', now)], {
        repoId: '/repos/app/.git',
        gitBranch: 'feature',
        isMainWorktree: false
      })
    ]
    const projects: UserProject[] = [
      { path: '/repos/app', alias: 'app', addedAt: now, worktrees: [] }
    ]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => disk),
        userProjectsList: vi.fn(async () => ({ projects, hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => [])
      }
    }
    const store = useSessionsStore()
    await store.reloadModel()

    // Sanity: both folders are actually visible (one pinned, one active).
    expect(flattenPaths(store.visibleFolders).sort()).toEqual([
      '/repos/app',
      '/repos/app-wt/feature'
    ])

    const groups = store.visibleFolders.filter(
      (n): n is FolderGroup<Folder> => 'kind' in n && n.kind === 'folder-group'
    )
    const appGroups = groups.filter((g) => g.id === '/repos/app/.git')
    // The old two-zone split ran `groupByRepo` once per zone, so this repo
    // rendered TWO headers (one under FOLDERS, one under ACTIVE ELSEWHERE).
    // The single combined pass yields exactly one, with both worktrees inside.
    expect(appGroups).toHaveLength(1)
    expect(appGroups[0].folders.map((f) => f.path).sort()).toEqual([
      '/repos/app',
      '/repos/app-wt/feature'
    ])
  })
})

describe('pin / hide / unhide interplay (BUG-39)', () => {
  const PATH = '/repos/alpha'
  let hidden: string[]
  let projects: UserProject[]

  beforeEach(() => {
    setActivePinia(createPinia())
    hidden = []
    projects = []
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () => []),
        userProjectsList: vi.fn(async () => ({
          projects: [...projects],
          hiddenPaths: [...hidden]
        })),
        orchestratorListArmed: vi.fn(async () => []),
        userProjectsAdd: vi.fn(async (entry: UserProject) => {
          projects = [...projects.filter((p) => p.path !== entry.path), entry]
          return { projects: [...projects], hiddenPaths: [...hidden] }
        }),
        userProjectsHide: vi.fn(async (path: string) => {
          if (!hidden.includes(path)) hidden.push(path)
          return { projects: [...projects], hiddenPaths: [...hidden] }
        }),
        userProjectsUnhide: vi.fn(async (path: string) => {
          hidden = hidden.filter((p) => p !== path)
          return { projects: [...projects], hiddenPaths: [...hidden] }
        })
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('pin -> hide -> unhide round-trips back to pinned: true', async () => {
    const store = useSessionsStore()

    await store.pinFolder(PATH)
    expect(store.folders.find((f) => f.path === PATH)?.pinned).toBe(true)

    // Hide (dismissFolder) must NOT unpin (BUG-39 fix) — the pin survives
    // underneath the hidden state.
    await store.dismissFolder(PATH)
    expect(store.manuallyHiddenPaths.has(PATH)).toBe(true)
    expect(store.folders.find((f) => f.path === PATH)?.pinned).toBe(true)

    await store.unhideFolder(PATH)
    expect(store.manuallyHiddenPaths.has(PATH)).toBe(false)
    // The regression: before the fix, `dismissFolder` also unpinned, so the
    // folder came back merely "active" (or vanished if it had gone stale) —
    // never restored as pinned.
    expect(store.folders.find((f) => f.path === PATH)?.pinned).toBe(true)
  })

  it('a hidden-and-pinned folder does not render, even though pinned stays true underneath', async () => {
    const store = useSessionsStore()

    await store.pinFolder(PATH)
    await store.dismissFolder(PATH)

    expect(store.folders.find((f) => f.path === PATH)?.pinned).toBe(true)
    expect(store.manuallyHiddenPaths.has(PATH)).toBe(true)

    // `hidden` always wins at render time regardless of `pinned` —
    // classifyFolder's branch order (hidden > pinned > active > stale).
    expect(flattenPaths(store.visibleFolders)).not.toContain(PATH)
  })
})
