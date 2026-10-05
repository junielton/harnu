// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'

/**
 * T289 — the drill-in stack survives a restart.
 *
 * `drillStack` is a `persistedRef` under the `om2tab.*` prefix, exactly like
 * `drillDepth`. Restoring it is deliberately two-phase: the ref validates the
 * stored SHAPE at construction time, and `reconcileDrillStack()` runs the
 * RESOLUTION check once the folder model has loaded — a node naming a folder
 * or group that is gone empties the whole stack, so a stale entry can never
 * strand the sidebar on a screen that renders nothing.
 */

const DRILL_STACK_KEY = 'om2tab.sidebarDrillStack'
const DRILL_DEPTH_KEY = 'om2tab.sidebarDrillDepth'

function installWindow(disk: FolderEntry[], hiddenPaths: string[] = []): void {
  ;(window as unknown as { api: unknown }).api = {
    foldersLoad: vi.fn(async () => disk),
    userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths })),
    orchestratorListArmed: vi.fn(async () => [])
  }
}

function session(id: string): FolderEntry['sessions'][number] {
  const now = new Date().toISOString()
  return {
    sessionId: id,
    fullPath: `/repos/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: '',
    summary: id,
    messageCount: 1,
    created: now,
    modified: now,
    gitBranch: '',
    projectPath: '/repos/alpha',
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as FolderEntry['sessions'][number]
}

const REPO: FolderEntry[] = [
  {
    path: '/repos/alpha/main',
    alias: 'main',
    gitBranch: 'main',
    repoId: 'repo-x',
    isMainWorktree: true,
    sessions: [session('s1')]
  },
  {
    path: '/repos/alpha/wt-b',
    alias: 'wt-b',
    gitBranch: 'wt-b',
    repoId: 'repo-x',
    sessions: [session('s2')]
  }
] as FolderEntry[]

describe('drill stack persistence (T289)', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem(DRILL_DEPTH_KEY, '2')
    setActivePinia(createPinia())
  })
  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
    localStorage.clear()
  })

  it('persists the stack to localStorage under the om2tab prefix as drilling happens', async () => {
    installWindow(REPO)
    const store = useSessionsStore()
    await store.reloadModel()

    store.drillIntoGroup('repo:repo-x')
    store.drillIntoFolder('/repos/alpha/wt-b')
    // The persist watcher is a plain (pre-flush) `watch` — let it run.
    await Promise.resolve()

    expect(JSON.parse(localStorage.getItem(DRILL_STACK_KEY) ?? 'null')).toEqual([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/wt-b' }
    ])

    store.drillBack()
    await Promise.resolve()
    expect(JSON.parse(localStorage.getItem(DRILL_STACK_KEY) ?? 'null')).toEqual([
      { kind: 'group', key: 'repo:repo-x' }
    ])
  })

  it('restores a stack whose every node still resolves', async () => {
    localStorage.setItem(
      DRILL_STACK_KEY,
      JSON.stringify([
        { kind: 'group', key: 'repo:repo-x' },
        { kind: 'folder', path: '/repos/alpha/wt-b' }
      ])
    )
    installWindow(REPO)
    const store = useSessionsStore()
    expect(store.drillStack).toHaveLength(2)

    await store.reloadModel()
    store.reconcileDrillStack()

    expect(store.drillStack).toEqual([
      { kind: 'group', key: 'repo:repo-x' },
      { kind: 'folder', path: '/repos/alpha/wt-b' }
    ])
  })

  it('empties the stack when a folder in it no longer exists', async () => {
    localStorage.setItem(
      DRILL_STACK_KEY,
      JSON.stringify([
        { kind: 'group', key: 'repo:repo-x' },
        { kind: 'folder', path: '/repos/alpha/deleted-worktree' }
      ])
    )
    installWindow(REPO)
    const store = useSessionsStore()

    await store.reloadModel()
    store.reconcileDrillStack()

    expect(store.drillStack).toEqual([])
  })

  it('empties the stack when a folder in it was dismissed by the user', async () => {
    // A dismissed folder stays in `folders.value` (only `visibleFolders` drops
    // it), so an existence check alone would restore straight onto the screen
    // of a folder the operator explicitly hid. A STANDALONE folder on purpose:
    // hiding a member of a repo group would also change whether the group
    // still groups, and the stack would then empty for the wrong reason.
    const SOLO = [
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s9')] }
    ] as FolderEntry[]
    localStorage.setItem(DRILL_STACK_KEY, JSON.stringify([{ kind: 'folder', path: '/repos/solo' }]))
    installWindow(SOLO, ['/repos/solo'])
    const store = useSessionsStore()

    await store.reloadModel()
    // Precondition: the folder is still KNOWN — the stack is dropped for being
    // hidden, not for being gone.
    expect(store.findFolderByPath('/repos/solo')).not.toBeNull()

    store.reconcileDrillStack()

    expect(store.drillStack).toEqual([])
  })

  it('keeps the stack for a standalone folder that is merely not hidden', async () => {
    // The negative control for the case above: same fixture, nothing dismissed.
    // Proves the previous test empties the stack for the HIDDEN axis and not
    // because a standalone folder cannot be restored at all.
    const SOLO = [
      { path: '/repos/solo', alias: 'solo', gitBranch: '', sessions: [session('s9')] }
    ] as FolderEntry[]
    localStorage.setItem(DRILL_STACK_KEY, JSON.stringify([{ kind: 'folder', path: '/repos/solo' }]))
    installWindow(SOLO)
    const store = useSessionsStore()

    await store.reloadModel()
    store.reconcileDrillStack()

    expect(store.drillStack).toEqual([{ kind: 'folder', path: '/repos/solo' }])
  })

  it('empties the stack when the group in it no longer exists', async () => {
    localStorage.setItem(
      DRILL_STACK_KEY,
      JSON.stringify([{ kind: 'group', key: 'repo:repo-gone' }])
    )
    installWindow(REPO)
    const store = useSessionsStore()

    await store.reloadModel()
    store.reconcileDrillStack()

    expect(store.drillStack).toEqual([])
  })

  it('falls back to an empty stack when the stored value is corrupt', async () => {
    localStorage.setItem(DRILL_STACK_KEY, '{"not":"an array"}')
    installWindow(REPO)
    expect(useSessionsStore().drillStack).toEqual([])

    setActivePinia(createPinia())
    localStorage.setItem(DRILL_STACK_KEY, JSON.stringify([{ kind: 'nonsense' }]))
    expect(useSessionsStore().drillStack).toEqual([])

    setActivePinia(createPinia())
    localStorage.setItem(DRILL_STACK_KEY, 'not json at all')
    expect(useSessionsStore().drillStack).toEqual([])
  })

  it('clamps a restored stack to the current drill depth', async () => {
    localStorage.setItem(DRILL_DEPTH_KEY, '1')
    localStorage.setItem(
      DRILL_STACK_KEY,
      JSON.stringify([
        { kind: 'group', key: 'repo:repo-x' },
        { kind: 'folder', path: '/repos/alpha/wt-b' }
      ])
    )
    installWindow(REPO)
    const store = useSessionsStore()

    await store.reloadModel()
    store.reconcileDrillStack()

    expect(store.drillStack).toEqual([{ kind: 'group', key: 'repo:repo-x' }])
  })
})
