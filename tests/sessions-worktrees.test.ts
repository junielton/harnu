import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'
import { encodePathToSlug } from '../src/renderer/src/lib/folder-slug'

// Same window-stub harness as tests/sessions-liveness.test.ts, plus the T388
// worktree channels (sidebar-liveness U4b).
type DiskSession = FolderEntry['sessions'][number]
function session(over: Partial<DiskSession> = {}): DiskSession {
  return {
    sessionId: 'unused',
    fullPath: '',
    fileMtime: 1,
    firstPrompt: '',
    summary: '',
    messageCount: 0,
    created: '2026-01-01T00:00:00.000Z',
    modified: new Date().toISOString(),
    gitBranch: '',
    projectPath: '',
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: true,
    bridged: false,
    ...over
  } as DiskSession
}
function folder(path: string, sessions: DiskSession[]): FolderEntry {
  return { path, alias: path.split('/').pop() ?? path, gitBranch: '', sessions }
}

let cb: Record<string, ((...a: unknown[]) => void) | undefined>
let disk: FolderEntry[]
let foldersLoad: ReturnType<typeof vi.fn>
function installWindow(): void {
  cb = {}
  const on =
    (name: string) =>
    (fn: (...a: unknown[]) => void): (() => void) => {
      cb[name] = fn
      return () => {}
    }
  foldersLoad = vi.fn(async () =>
    disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
  )
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      foldersLoad,
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      onProjectAdded: on('onProjectAdded'),
      onProjectRemoved: on('onProjectRemoved'),
      onSessionAdded: on('onSessionAdded'),
      onSessionRemoved: on('onSessionRemoved'),
      onSessionUpdated: on('onSessionUpdated'),
      onHook: on('onHook'),
      onScreenState: on('onScreenState'),
      onSessionRegistry: on('onSessionRegistry'),
      fleetReportShellSessions: vi.fn(),
      onApprovalPending: on('onApprovalPending'),
      onApprovalResolved: on('onApprovalResolved'),
      approvalsList: vi.fn(async () => []),
      onNotifyActivate: on('onNotifyActivate'),
      onIndexUpdated: on('onIndexUpdated'),
      onWatcherDegraded: on('onWatcherDegraded'),
      onSubagentUpdated: on('onSubagentUpdated'),
      onSubagentRemoved: on('onSubagentRemoved'),
      onFleetChanged: on('onFleetChanged'),
      worktreesTrack: vi.fn(async () => {}),
      onWorktreesChanged: on('onWorktreesChanged')
    }
  }
}
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}
const settle = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('sidebar — always-listed worktrees (U4b)', () => {
  const recent = (): string => new Date().toISOString()
  const old = '2026-01-01T00:00:00.000Z'
  const repoFolder = (modified: string, path = '/r', repoId = '/r/.git'): FolderEntry => ({
    ...folder(path, [
      session({ sessionId: `${path}-1`, projectPath: path, fullPath: `/x${path}.jsonl`, modified })
    ]),
    repoId,
    isMainWorktree: true
  })
  const trackCalls = (): Array<Array<{ repoId: string }>> =>
    (window.api.worktreesTrack as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
  const lastTrack = (): Array<{ repoId: string }> => {
    const calls = trackCalls()
    return calls.length ? calls[calls.length - 1] : []
  }
  const push = (paths: string[], repoId = '/r/.git'): void =>
    cb.onWorktreesChanged!({
      repoId,
      entries: paths.map((p, i) => ({
        path: p,
        branch: i === 0 ? 'main' : 'feat',
        isMainWorktree: i === 0,
        locked: false
      }))
    })
  const visibleJson = (store: ReturnType<typeof useSessionsStore>): string =>
    JSON.stringify(store.visibleFolders)

  beforeEach(() => {
    setActivePinia(createPinia())
    disk = [repoFolder(recent())]
    installWindow()
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('AC-7: a worktrees:changed push renders a sessionless row without a reload', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    expect(lastTrack()).toEqual([
      expect.objectContaining({ repoId: '/r/.git', probePath: '/r', memberPaths: ['/r'] })
    ])
    foldersLoad.mockClear()
    push(['/r', '/r/wt'])
    await flush()
    expect(foldersLoad).not.toHaveBeenCalled()
    expect(visibleJson(store)).toContain('/r/wt')
    const row = store.folders.find((f) => f.path === '/r/wt')
    expect(row).toMatchObject({ gitListed: true, repoId: '/r/.git', gitBranch: 'feat' })
    expect(row?.sessions).toEqual([])
  })

  it('AC-7: a placeholder survives an ordinary reload', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    push(['/r', '/r/wt'])
    await flush()
    cb.onFleetChanged!({ version: 2, slugs: [encodePathToSlug('/r')], full: false })
    await settle(300)
    expect(store.folders.filter((f) => f.path === '/r/wt')).toHaveLength(1)
    expect(visibleJson(store)).toContain('/r/wt')
  })

  it('AC-8: a later push without the worktree removes its sessionless row', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    push(['/r', '/r/wt'])
    await flush()
    push(['/r'])
    await flush()
    expect(store.folders.some((f) => f.path === '/r/wt')).toBe(false)
    // The main worktree keeps its row and its sessions.
    expect(store.folders.find((f) => f.path === '/r')?.sessions).toHaveLength(1)
  })

  it('AC-8: a removed worktree that has sessions loses its flag and follows the ordinary rules', async () => {
    disk = [repoFolder(recent()), { ...repoFolder(old, '/r/wt'), isMainWorktree: false }]
    const store = useSessionsStore()
    await store.init()
    await settle()
    push(['/r', '/r/wt'])
    await flush()
    expect(visibleJson(store)).toContain('/r/wt') // old sessions, but git-listed
    push(['/r'])
    await flush()
    expect(store.folders.find((f) => f.path === '/r/wt')?.gitListed).toBeFalsy()
    expect(visibleJson(store)).not.toContain('/r/wt') // aged out → stale again
  })

  it('AC-10: a hidden git-listed path never renders', async () => {
    ;(window.api.userProjectsList as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [],
      hiddenPaths: ['/r/wt']
    })
    const store = useSessionsStore()
    await store.init()
    await settle()
    push(['/r', '/r/wt'])
    await flush()
    expect(store.folders.some((f) => f.path === '/r/wt')).toBe(true)
    expect(visibleJson(store)).not.toContain('/r/wt')
    expect(store.manuallyHiddenPaths.has('/r/wt')).toBe(true)
  })

  it('AC-11: when the repo leaves the visible list it is no longer tracked, and its rows go', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    push(['/r', '/r/wt'])
    await flush()
    disk = [repoFolder(old)] // its only session ages out; nothing pinned
    cb.onFleetChanged!({ version: 9, slugs: [encodePathToSlug('/r')], full: false })
    await settle(900)
    expect(lastTrack()).toEqual([])
    expect(visibleJson(store)).not.toContain('/r/wt')
    // The git-listed rule never keeps the repo itself alive (D3).
    expect(visibleJson(store)).not.toContain('"/r"')
  })

  it('AC-11: a push for a repo that is no longer tracked is ignored', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    push(['/x', '/x/wt'], '/x/.git')
    await flush()
    expect(store.folders.some((f) => f.path === '/x/wt')).toBe(false)
  })

  it('AC-11: an unchanged known-repo set is not re-sent', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    const before = trackCalls().length
    cb.onFleetChanged!({ version: 3, slugs: [encodePathToSlug('/r')], full: false })
    await settle(900)
    expect(trackCalls().length).toBe(before)
  })

  it('AC-33: a pinned repo whose sessions aged out is still tracked and lists its worktrees', async () => {
    disk = [repoFolder(old)]
    ;(window.api.userProjectsList as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [{ path: '/r', alias: 'r' }],
      hiddenPaths: []
    })
    const store = useSessionsStore()
    await store.init()
    await settle()
    expect(lastTrack()).toEqual([expect.objectContaining({ repoId: '/r/.git' })])
    push(['/r', '/r/wt'])
    await flush()
    expect(visibleJson(store)).toContain('/r/wt')
  })

  it('B1 cap: the tracked set is ordered by priority — pinned repos first, then active', async () => {
    disk = [repoFolder(recent(), '/a', '/a/.git'), repoFolder(old, '/p', '/p/.git')]
    ;(window.api.userProjectsList as ReturnType<typeof vi.fn>).mockResolvedValue({
      projects: [{ path: '/p', alias: 'p' }],
      hiddenPaths: []
    })
    const store = useSessionsStore()
    await store.init()
    await settle()
    expect(lastTrack().map((r) => r.repoId)).toEqual(['/p/.git', '/a/.git'])
  })
})
