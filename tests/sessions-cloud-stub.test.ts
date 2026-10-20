import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { encodePathToSlug } from '../src/renderer/src/lib/folder-slug'
import { isCloudStub } from '../src/renderer/src/lib/cloud-session'
import type { FolderEntry } from '../src/preload'

/**
 * BUG-198 — a fresh session's JSONL exists seconds before its first `user`
 * line, so the reader briefly reports it `resumable:false`. `reconcileSessions`
 * (disk wins on every key) used to copy that onto the live row, which flipped
 * the cloud predicate and locked the user out of their own terminal.
 *
 * G2: reconcile never DOWNGRADES `resumable` on a row born synthetic in this
 * app run; disk may still upgrade it. G5: a row classified cloud heals as soon
 * as disk carries `resumable:true`.
 */
describe('useSessionsStore resumable reconcile (BUG-198)', () => {
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
      modified: '2026-01-01T00:00:00.000Z',
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

  function installWindow(): void {
    cb = {}
    const on =
      (name: string) =>
      (fn: (...a: unknown[]) => void): (() => void) => {
        cb[name] = fn
        return () => {}
      }
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        foldersLoad: vi.fn(async () =>
          disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
        ),
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
        onFleetChanged: on('onFleetChanged')
      }
    }
  }

  const flush = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }
  // Past the ~250 ms reload debounce (perf spec §5.1b), then drain.
  const flushDebounce = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 300))
    await flush()
  }

  const rowOf = (store: ReturnType<typeof useSessionsStore>, id: string) =>
    store.folders.find((f) => f.path === '/repos/alpha')!.sessions.find((s) => s.sessionId === id)

  beforeEach(() => {
    setActivePinia(createPinia())
    disk = [folder('/repos/alpha', [])]
    installWindow()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('AC-5: the race — synthetic → zero-turn disk row → reload — keeps the row resumable and out of the cloud panel', async () => {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')
    const synth = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.synthetic === true)!
    expect(synth.resumable).toBe(true)
    store.registerLiveSession(synth.sessionId)

    // Claude created the JSONL (metadata lines only) before the first prompt.
    disk = [
      folder('/repos/alpha', [
        session({
          sessionId: 'real1',
          fullPath: '/repos/alpha/real1.jsonl',
          projectPath: '/repos/alpha',
          resumable: false
        })
      ])
    ]
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real1' })
    await flush()
    // The watcher's follow-up index update reconciles the row against disk.
    cb.onIndexUpdated!({ slug: encodePathToSlug('/repos/alpha') })
    await flushDebounce()

    const row = rowOf(store, 'real1')!
    expect(row).toBe(synth) // migrated in place
    expect(row.resumable).toBe(true)
    expect(isCloudStub(row, store.isSessionLive('real1'))).toBe(false)
  })

  it('AC-5: the race holds even when the terminal is not registered live (G2 alone)', async () => {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')

    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'real1', projectPath: '/repos/alpha', resumable: false })
      ])
    ]
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real1' })
    await flush()
    cb.onIndexUpdated!({ slug: encodePathToSlug('/repos/alpha') })
    await flushDebounce()

    expect(rowOf(store, 'real1')!.resumable).toBe(true)
  })

  it('AC-2: a disk row resumable:false never downgrades a row born synthetic in this run', async () => {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')

    // Already resumable on disk when the watcher fires, so the migration lands…
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'real1', projectPath: '/repos/alpha', resumable: true })
      ])
    ]
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real1' })
    await flush()
    expect(rowOf(store, 'real1')!.resumable).toBe(true)

    // …and a later scan sees the file as zero-turn again (e.g. a rewrite).
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'real1', projectPath: '/repos/alpha', resumable: false })
      ])
    ]
    cb.onIndexUpdated!({ slug: encodePathToSlug('/repos/alpha') })
    await flushDebounce()
    expect(rowOf(store, 'real1')!.resumable).toBe(true)
  })

  it('AC-2: a disk row resumable:true still upgrades a resumable:false row', async () => {
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'cloud1', projectPath: '/repos/alpha', resumable: false })
      ])
    ]
    const store = useSessionsStore()
    await store.init()
    expect(rowOf(store, 'cloud1')!.resumable).toBe(false)

    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'cloud1', projectPath: '/repos/alpha', resumable: true })
      ])
    ]
    cb.onIndexUpdated!({ slug: encodePathToSlug('/repos/alpha') })
    await flushDebounce()
    expect(rowOf(store, 'cloud1')!.resumable).toBe(true)
  })

  it('a session NOT born synthetic still takes disk truth when it goes back to resumable:false', async () => {
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'old1', projectPath: '/repos/alpha', resumable: true })
      ])
    ]
    const store = useSessionsStore()
    await store.init()

    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'old1', projectPath: '/repos/alpha', resumable: false })
      ])
    ]
    cb.onIndexUpdated!({ slug: encodePathToSlug('/repos/alpha') })
    await flushDebounce()
    expect(rowOf(store, 'old1')!.resumable).toBe(false)
  })

  it('AC-6: a row classified cloud heals when the next reconcile carries resumable:true', async () => {
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'cloud1', projectPath: '/repos/alpha', resumable: false })
      ])
    ]
    const store = useSessionsStore()
    await store.init()
    expect(isCloudStub(rowOf(store, 'cloud1'), store.isSessionLive('cloud1'))).toBe(true)

    // The transcript gained its first turn.
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'cloud1', projectPath: '/repos/alpha', resumable: true })
      ])
    ]
    cb.onIndexUpdated!({ slug: encodePathToSlug('/repos/alpha') })
    await flushDebounce()
    expect(isCloudStub(rowOf(store, 'cloud1'), store.isSessionLive('cloud1'))).toBe(false)
  })

  it('AC-4: "Resume anyway" survives a disk reconcile (renderer-only flag)', async () => {
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'cloud1', projectPath: '/repos/alpha', resumable: false })
      ])
    ]
    const store = useSessionsStore()
    await store.init()

    store.resumeAnyway('cloud1')
    expect(isCloudStub(rowOf(store, 'cloud1'), false)).toBe(false)

    cb.onIndexUpdated!({ slug: encodePathToSlug('/repos/alpha') })
    await flushDebounce()
    const row = rowOf(store, 'cloud1')!
    expect(row.resumable).toBe(false) // disk truth untouched
    expect(row.resumeAnyway).toBe(true) // operator override preserved
    expect(isCloudStub(row, false)).toBe(false)
  })
})
