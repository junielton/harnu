import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

/**
 * BUG-262 AC-3 (second half) — `shelvedPartition` re-ran on every 30 s `closureNow` tick, on every
 * GC snapshot replacement and on any deep change of `folders`, costing 325-408 ms each time on a
 * large fleet. It now re-runs only when the folder membership/shape or the shelved list changes.
 */

const calls = vi.hoisted(() => ({ n: 0 }))
vi.mock('../src/renderer/src/lib/shelved-sidebar', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/src/lib/shelved-sidebar')>()
  return {
    ...real,
    partitionShelved: ((...a: Parameters<typeof real.partitionShelved>) => {
      calls.n++
      return real.partitionShelved(...a)
    }) as typeof real.partitionShelved
  }
})

import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useGcStore } from '../src/renderer/src/stores/gc'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import type { FolderEntry } from '../src/preload'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'

type DiskSession = FolderEntry['sessions'][number]
const DAY = 86_400_000
const REPO = '/home/u/org/api-gateway'
const REPO_ID = `${REPO}/.git`
const WT = `${REPO}/.claude/worktrees/PROJ-231-auth-refresh`

const session = (id: string, path: string): DiskSession =>
  ({
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
  }) as DiskSession
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
    shelvedAt: Date.now() - 9.5 * DAY, // mid-day: a 30 s tick must not flip the whole-day count
    idleDays: 11,
    reason: 'Shelved',
    freedBytes: null,
    ...over
  }) as GcSnapshot['shelved'][number]

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
function installWindow(): void {
  const noop = (): (() => void) => () => {}
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
      gcRestoreShelved: vi.fn(),
      gcSnapshot: vi.fn(async () => snapshotWith([]))
    }
  }
}
const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('shelvedPartition recompute (BUG-262 AC-3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    disk = [
      entry(REPO, [session('m1', REPO)], { isMainWorktree: true }),
      entry(WT, [session('a1', WT)], { diskExists: false })
    ]
    installWindow()
    calls.n = 0
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('does not re-partition for a clock tick, an equal snapshot, or a session change in a live folder', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    useGcStore().snapshot = snapshotWith([shelvedEntry()])
    void store.visibleFolders
    const base = calls.n
    expect(base).toBeGreaterThan(0)

    // 1. The 30 s clock tick (same whole-day count for the shelved row).
    store.nowTick = Date.now() + 30_000
    void store.visibleFolders
    expect(calls.n).toBe(base)

    // 2. A new snapshot object carrying an identical shelved list.
    useGcStore().snapshot = snapshotWith([
      shelvedEntry({ shelvedAt: useGcStore().snapshot!.shelved[0].shelvedAt })
    ])
    void store.visibleFolders
    expect(calls.n).toBe(base)

    // 3. A deep change inside a LIVE folder's session.
    const live = store.folders.find((f) => f.path === REPO)!
    live.sessions[0].title = 'renamed'
    void store.visibleFolders
    expect(calls.n).toBe(base)
  })

  it('re-partitions when the shelved list changes', async () => {
    const store = useSessionsStore()
    await store.init()
    await settle()
    useGcStore().snapshot = snapshotWith([shelvedEntry()])
    void store.visibleFolders
    const base = calls.n
    useGcStore().snapshot = snapshotWith([
      shelvedEntry(),
      shelvedEntry({ id: 'other', worktreePath: `${WT}-2` })
    ])
    void store.visibleFolders
    expect(calls.n).toBeGreaterThan(base)
  })
})
