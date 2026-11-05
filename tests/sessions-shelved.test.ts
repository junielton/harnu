import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useGcStore } from '../src/renderer/src/stores/gc'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { isFolderGroup, type FolderGroup } from '../src/renderer/src/stores/folder-zones'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import type { FolderEntry } from '../src/preload'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'

// U2.3b — shelved worktrees through the sessions store: they never list as folders, they join their repo
// group, and a session click restores first and resumes after. Neutral vocabulary only.

type DiskSession = FolderEntry['sessions'][number]
const DAY = 86_400_000
const REPO = '/home/u/org/api-gateway'
const REPO_ID = `${REPO}/.git`
const WT = `${REPO}/.claude/worktrees/PROJ-231-auth-refresh`

function session(id: string, path: string): DiskSession {
  return {
    sessionId: id,
    fullPath: `/x/${id}.jsonl`,
    fileMtime: 1,
    firstPrompt: `prompt ${id}`,
    summary: `Summary ${id}`,
    messageCount: 1,
    created: '2026-01-01T00:00:00.000Z',
    modified: new Date().toISOString(),
    gitBranch: '',
    projectPath: path,
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: true,
    bridged: false
  } as DiskSession
}
const entry = (
  path: string,
  sessions: DiskSession[],
  over: Partial<FolderEntry> = {}
): FolderEntry =>
  ({
    path,
    alias: path.split('/').pop() ?? path,
    gitBranch: '',
    sessions,
    repoId: REPO_ID,
    ...over
  }) as FolderEntry

const shelvedEntry = (over: Record<string, unknown> = {}): GcSnapshot['shelved'][number] =>
  ({
    id: `${REPO}::branch::PROJ-231-auth-refresh`,
    repoPath: REPO,
    worktreePath: WT,
    branch: 'PROJ-231-auth-refresh',
    headSha: 'abc123',
    namespace: 'refs/archive/x',
    shelvedAt: Date.now() - 9 * DAY,
    idleDays: 11,
    reason: 'Shelved',
    freedBytes: null,
    ...over
  }) as GcSnapshot['shelved'][number]

/** A snapshot the GC store can build its model from: only `shelved` varies. */
const snapshotWith = (shelved: GcSnapshot['shelved']): GcSnapshot =>
  ({
    scannedAt: Date.now(),
    bundles: [],
    orphanVolumes: [],
    orphanTranscripts: [],
    stackLeftovers: [],
    docker: { buildCacheReclaimableBytes: null, danglingImages: null, orphanVolumesHidden: null },
    prefs: defaultGcPrefs(),
    lastCycle: null,
    nextCycleAt: null,
    nextClean: null,
    backgroundScan: false,
    archives: { repos: [], retentionDays: 30, total: { count: 0, bytes: 0 } },
    trash: { entries: [], totalBytes: 0 },
    shelved
  }) as unknown as GcSnapshot

let disk: FolderEntry[]
let gcRestoreShelved: ReturnType<typeof vi.fn>
let gcSnapshot: ReturnType<typeof vi.fn>

function installWindow(): void {
  const noop = (): (() => void) => () => {}
  gcRestoreShelved = vi.fn(async () => ({ ok: true, status: 'restored', attached: true }))
  gcSnapshot = vi.fn(async () => snapshotWith([]))
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      foldersLoad: vi.fn(async () => disk.map((f) => ({ ...f, sessions: [...f.sessions] }))),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      onProjectAdded: noop,
      onProjectRemoved: noop,
      onSessionAdded: noop,
      onSessionRemoved: noop,
      onSessionUpdated: noop,
      onHook: noop,
      onScreenState: noop,
      onSessionRegistry: noop,
      fleetReportShellSessions: vi.fn(),
      onApprovalPending: noop,
      onApprovalResolved: noop,
      approvalsList: vi.fn(async () => []),
      onNotifyActivate: noop,
      onIndexUpdated: noop,
      onWatcherDegraded: noop,
      onSubagentUpdated: noop,
      onSubagentRemoved: noop,
      onFleetChanged: noop,
      worktreesTrack: vi.fn(async () => {}),
      onWorktreesChanged: noop,
      gcRestoreShelved,
      gcSnapshot
    }
  }
}

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function boot(entries = [shelvedEntry()]): Promise<ReturnType<typeof useSessionsStore>> {
  const store = useSessionsStore()
  await store.init()
  await settle()
  useGcStore().snapshot = snapshotWith(entries)
  return store
}

const groups = (store: ReturnType<typeof useSessionsStore>): FolderGroup[] =>
  store.visibleFolders.filter((n): n is FolderGroup => isFolderGroup(n))
const listedPaths = (store: ReturnType<typeof useSessionsStore>): string[] =>
  store.visibleFolders.flatMap((n) => (isFolderGroup(n) ? n.folders.map((f) => f.path) : [n.path]))

describe('sessions store — shelved worktrees in the sidebar (U2.3b)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    disk = [
      entry(REPO, [session('m1', REPO)], { isMainWorktree: true }),
      entry(WT, [session('a1', WT), session('a2', WT)], { diskExists: false })
    ]
    installWindow()
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('AC-2: a shelved worktree is never a normal or ghost row — only a member of the group', async () => {
    const store = await boot()
    expect(listedPaths(store)).toEqual([REPO])
    expect(listedPaths(store)).not.toContain(WT)
    const g = groups(store)
    expect(g).toHaveLength(1)
    expect(g[0].shelved?.map((m) => m.label)).toEqual(['PROJ-231-auth-refresh'])
    expect(g[0].shelved?.[0].sessions.map((s) => s.sessionId)).toEqual(['a1', 'a2'])
  })

  it('AC-4: ONE live folder plus a shelved worktree still forms a group', async () => {
    const store = await boot()
    const g = groups(store)
    expect(g).toHaveLength(1)
    expect(g[0].folders).toHaveLength(1)
  })

  it('with nothing shelved the single folder stays a bare row and the ghost keeps its old rules', async () => {
    const store = await boot([])
    expect(groups(store)).toHaveLength(0)
  })

  it('the Shelved section is closed by default, opens on toggle, and a filter forces it open', async () => {
    const store = await boot()
    const key = groups(store)[0].key
    expect(store.shelvedSectionOpen(key)).toBe(false)
    store.toggleShelvedSection(key)
    expect(store.shelvedSectionOpen(key)).toBe(true)
    store.toggleShelvedSection(key)
    expect(store.shelvedSectionOpen(key)).toBe(false)
    store.filterQuery = 'auth-refresh'
    expect(store.shelvedSectionOpen(key)).toBe(true)
    expect(groups(store)[0].shelved).toHaveLength(1)
  })

  it('a filter that matches nothing in the shelved list leaves the section out', async () => {
    const store = await boot()
    store.filterQuery = 'summary m1'
    expect(groups(store).every((g) => !g.shelved?.length)).toBe(true)
  })

  it('collapse all closes the Shelved sections, expand all opens them', async () => {
    const store = await boot()
    const key = groups(store)[0].key
    store.expandAll()
    expect(store.shelvedSectionOpen(key)).toBe(true)
    store.collapseAll()
    expect(store.shelvedSectionOpen(key)).toBe(false)
  })

  describe('AC-3: restore, then resume', () => {
    it('shows the restoring state, selects the session only AFTER the folder is back, and lands the row live', async () => {
      const store = await boot()
      const member = groups(store)[0].shelved![0] as never
      let release: (v: unknown) => void = () => {}
      gcRestoreShelved.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      gcSnapshot.mockResolvedValueOnce(snapshotWith([]))
      const before = store.selectedId

      const run = store.restoreShelvedWorktree(member, 'a2')
      await settle(0)
      // Restoring: the row and the clicked session read it; nothing was selected yet, nothing started.
      expect(store.shelvedRestoring.get(shelvedEntry().id)).toBe('a2')
      // The main pane says what it waits for (a plain Restore resumes nothing, so it says nothing).
      expect(store.shelvedRestoringLabel).toBe('PROJ-231-auth-refresh')
      expect(store.selectedId).toBe(before)

      release({ ok: true, status: 'restored', attached: true })
      expect(await run).toBe(true)

      expect(gcRestoreShelved).toHaveBeenCalledWith(shelvedEntry().id)
      expect(store.shelvedRestoring.size).toBe(0)
      expect(store.shelvedRestoringLabel).toBeNull()
      expect(store.selectedId).toBe('a2')
      // The worktree is a normal folder row again, expanded, and no longer in the Shelved list.
      expect(listedPaths(store)).toContain(WT)
      expect(store.folders.find((f) => f.path === WT)).toMatchObject({
        diskExists: true,
        expanded: true
      })
      expect(groups(store).every((g) => !g.shelved?.length)).toBe(true)
      expect(store.jumpFlash?.token).toBe(`folder:${WT}`)
    })

    it('a plain Restore worktree selects nothing', async () => {
      const store = await boot()
      const member = groups(store)[0].shelved![0] as never
      const before = store.selectedId
      expect(await store.restoreShelvedWorktree(member, null)).toBe(true)
      expect(store.selectedId).toBe(before)
      expect(listedPaths(store)).toContain(WT)
    })

    it('a second click while restoring does not start a second restore', async () => {
      const store = await boot()
      const member = groups(store)[0].shelved![0] as never
      let release: (v: unknown) => void = () => {}
      gcRestoreShelved.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      const first = store.restoreShelvedWorktree(member, 'a1')
      await settle(0)
      expect(await store.restoreShelvedWorktree(member, 'a2')).toBe(false)
      release({ ok: true, status: 'restored' })
      await first
      expect(gcRestoreShelved).toHaveBeenCalledTimes(1)
    })

    it('a failed restore leaves the selection and the row alone and says how to get out', async () => {
      const store = await boot()
      const member = groups(store)[0].shelved![0] as never
      gcRestoreShelved.mockResolvedValueOnce({
        ok: false,
        status: 'failed',
        message: 'the archive record is missing'
      })
      const before = store.selectedId
      expect(await store.restoreShelvedWorktree(member, 'a1')).toBe(false)

      expect(store.selectedId).toBe(before)
      expect(store.shelvedRestoring.size).toBe(0)
      expect(groups(store)[0].shelved).toHaveLength(1)
      expect(listedPaths(store)).not.toContain(WT)

      const toast = useUiStore().toasts.at(-1)
      expect(toast).toMatchObject({ kind: 'danger' })
      expect(toast?.title).toContain('PROJ-231-auth-refresh')
      expect(toast?.description).toBe('the archive record is missing')
      // "Open in Cleanup" is the way out of a failure.
      const openCleanup = vi.spyOn(useUiStore(), 'openCleanup')
      await toast?.action?.handler()
      expect(openCleanup).toHaveBeenCalledWith(REPO)
    })

    it('an IPC error is a failure too, never an unhandled rejection', async () => {
      const store = await boot()
      const member = groups(store)[0].shelved![0] as never
      gcRestoreShelved.mockRejectedValueOnce(new Error('ipc down'))
      expect(await store.restoreShelvedWorktree(member, 'a1')).toBe(false)
      expect(store.shelvedRestoring.size).toBe(0)
    })

    it('a worktree restored elsewhere (a resume, a terminal) lists again when its entry leaves the snapshot', async () => {
      const store = await boot()
      expect(listedPaths(store)).not.toContain(WT)
      useGcStore().snapshot = snapshotWith([])
      await settle(0)
      expect(listedPaths(store)).toContain(WT)
    })
  })
})
