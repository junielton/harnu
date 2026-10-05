import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { watch } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import type { FolderEntry } from '../src/preload'
import { encodePathToSlug } from '../src/renderer/src/lib/folder-slug'
import type { AgentSession } from '../src/renderer/src/stores/agent-create-core'

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
      onFleetChanged: on('onFleetChanged')
    }
  }
}
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

describe('sidebar liveness — fleet:changed reloads (U1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'old', projectPath: '/repos/alpha', fullPath: '/x/old.jsonl' })
      ])
    ]
    installWindow()
  })
  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('AC-1: a session added outside Harnu appears ≤ 1 s after its fleet:changed', async () => {
    const store = useSessionsStore()
    await store.init()
    vi.useFakeTimers()
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'new1' }) // model still stale
    disk = [
      folder('/repos/alpha', [
        session({ sessionId: 'old', projectPath: '/repos/alpha', fullPath: '/x/old.jsonl' }),
        session({ sessionId: 'new1', projectPath: '/repos/alpha', fullPath: '/x/new1.jsonl' })
      ])
    ]
    await vi.advanceTimersByTimeAsync(250) // main's model window
    cb.onFleetChanged!({ version: 2, slugs: [encodePathToSlug('/repos/alpha')], full: false })
    await vi.advanceTimersByTimeAsync(750)
    expect(store.allSessions.some((s) => s.sessionId === 'new1')).toBe(true)
  })

  it('AC-2: a new folder and its first session appear ≤ 1 s after the push, no Rescan', async () => {
    const store = useSessionsStore()
    await store.init()
    vi.useFakeTimers()
    cb.onProjectAdded!({ slug: encodePathToSlug('/repos/gamma') })
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/gamma'), sessionId: 'g1' })
    disk = [
      ...disk,
      folder('/repos/gamma', [
        session({ sessionId: 'g1', projectPath: '/repos/gamma', fullPath: '/x/g1.jsonl' })
      ])
    ]
    await vi.advanceTimersByTimeAsync(250)
    cb.onFleetChanged!({ version: 2, slugs: [encodePathToSlug('/repos/gamma')], full: false })
    await vi.advanceTimersByTimeAsync(750)
    expect(
      store.folders.some(
        (f) => f.path === '/repos/gamma' && f.sessions.some((s) => s.sessionId === 'g1')
      )
    ).toBe(true)
  })

  it('AC-4: reconcileSessionAdded does not reload on its own; 10 pushes within 1 s cause ≤ 2 reloads', async () => {
    const store = useSessionsStore()
    await store.init()
    vi.useFakeTimers()
    foldersLoad.mockClear()
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/unknown'), sessionId: 'z' })
    await vi.advanceTimersByTimeAsync(10)
    expect(foldersLoad).not.toHaveBeenCalled()
    for (let i = 0; i < 10; i++) {
      cb.onFleetChanged!({ version: 10 + i, slugs: ['s'], full: false })
      await vi.advanceTimersByTimeAsync(100)
    }
    await vi.advanceTimersByTimeAsync(300)
    expect(foldersLoad.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('AC-5: a continuous trigger stream still reloads at least once per second', async () => {
    const store = useSessionsStore()
    await store.init()
    vi.useFakeTimers()
    foldersLoad.mockClear()
    for (let i = 0; i < 50; i++) {
      cb.onFleetChanged!({ version: 100 + i, slugs: ['s'], full: false })
      cb.onIndexUpdated!({ slug: 's' })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(foldersLoad.mock.calls.length).toBeGreaterThanOrEqual(5)
  })

  it('AC-5: the fleet:changed reload runs on the leading edge (no 250 ms wait)', async () => {
    const store = useSessionsStore()
    await store.init()
    vi.useFakeTimers()
    foldersLoad.mockClear()
    cb.onFleetChanged!({ version: 2, slugs: ['s'], full: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(foldersLoad).toHaveBeenCalledTimes(1)
  })

  it('AC-5: reloadModelDebounced alone still reloads at least once per second under a continuous stream', async () => {
    const store = useSessionsStore()
    await store.init()
    vi.useFakeTimers()
    foldersLoad.mockClear()
    // No fleet:changed at all: only the debounced trigger (onIndexUpdated), one
    // per 100 ms for 5 s — a pure sliding debounce would never fire.
    for (let i = 0; i < 50; i++) {
      cb.onIndexUpdated!({ slug: 's' })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(foldersLoad.mock.calls.length).toBeGreaterThanOrEqual(5)
  })

  it('AC-3: the synthetic→real collapse re-keys selection and the PTY exactly once', async () => {
    disk = [...disk, folder('/repos/beta', [])]
    const store = useSessionsStore()
    await store.init()
    const synthId = store.createNewSession('/repos/beta') as string
    store.selectedId = synthId
    // A migrate handler is how panes re-key their live PTY (TerminalPane's
    // liveTerminals map), so its call count is the PTY re-key count.
    const migrations: Array<[string, string]> = []
    store.registerMigrateHandler((from, to) => migrations.push([from, to]))
    const selections: Array<string | null> = []
    const stop = watch(
      () => store.selectedId,
      (id) => selections.push(id),
      { flush: 'sync' }
    )
    cb.onSessionAdded!({ slug: '-unresolvable-slug', sessionId: 'real-b' })
    await flush()
    disk = disk.map((f) =>
      f.path === '/repos/beta'
        ? folder('/repos/beta', [
            session({
              sessionId: 'real-b',
              projectPath: '/repos/beta',
              fullPath: '/x/real-b.jsonl'
            })
          ])
        : f
    )
    cb.onFleetChanged!({ version: 3, slugs: [encodePathToSlug('/repos/beta')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    // A second push for the same slug must not re-key anything again.
    cb.onFleetChanged!({ version: 4, slugs: [encodePathToSlug('/repos/beta')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    stop()
    expect(migrations).toEqual([[synthId, 'real-b']])
    expect(selections).toEqual(['real-b'])
    expect(store.selectedId).toBe('real-b')
  })

  it('AC-3: a synthetic and its real twin are never committed together', async () => {
    disk = [...disk, folder('/repos/beta', [])]
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/beta')
    const synthId = store.folders
      .find((f) => f.path === '/repos/beta')!
      .sessions.find((s) => s.synthetic)!.sessionId
    const violations: string[] = []
    const stop = watch(
      () =>
        store.folders.map((f) =>
          f.sessions.map((s) => `${s.sessionId}:${s.synthetic === true}`).join(',')
        ),
      () => {
        const beta = store.folders.find((f) => f.path === '/repos/beta')
        if (
          beta &&
          beta.sessions.some((s) => s.synthetic) &&
          beta.sessions.some((s) => s.sessionId === 'real-b')
        ) {
          violations.push('both rows committed')
        }
      },
      { flush: 'sync' }
    )
    // A slug that resolves to no folder (lossy slug decode, symlinked cwd) takes the
    // reconcileSessionAdded fallback — the path where the real row arrives one push later.
    cb.onSessionAdded!({ slug: '-unresolvable-slug', sessionId: 'real-b' })
    await flush()
    disk = disk.map((f) =>
      f.path === '/repos/beta'
        ? folder('/repos/beta', [
            session({
              sessionId: 'real-b',
              projectPath: '/repos/beta',
              fullPath: '/x/real-b.jsonl'
            })
          ])
        : f
    )
    cb.onFleetChanged!({ version: 3, slugs: [encodePathToSlug('/repos/beta')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    stop()
    expect(violations).toEqual([])
    const beta = store.folders.find((f) => f.path === '/repos/beta')!
    expect(beta.sessions.map((s) => s.sessionId)).toEqual(['real-b'])
    expect(store.allSessions.some((s) => s.sessionId === synthId)).toBe(false)
  })

  it('a push that arrived before session:added cannot drop the pending id (no duplicate later)', async () => {
    disk = [...disk, folder('/repos/beta', [])]
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/beta')
    const synthId = store.folders
      .find((f) => f.path === '/repos/beta')!
      .sessions.find((s) => s.synthetic)!.sessionId
    // P1 reloads on the leading edge; P2 (covering the watcher slug) lands in the
    // trailing window, so the reload that consumes it runs AFTER the add below.
    cb.onFleetChanged!({ version: 2, slugs: [encodePathToSlug('/repos/alpha')], full: false })
    cb.onFleetChanged!({ version: 3, slugs: ['-unresolvable-slug'], full: false })
    cb.onSessionAdded!({ slug: '-unresolvable-slug', sessionId: 'real-b' }) // pending
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    // P2 described a model older than real-b: the id must still be pending.
    expect(store.__pendingCollapseSizeForTests()).toBe(1)
    disk = disk.map((f) =>
      f.path === '/repos/beta'
        ? folder('/repos/beta', [
            session({
              sessionId: 'real-b',
              projectPath: '/repos/beta',
              fullPath: '/x/real-b.jsonl'
            })
          ])
        : f
    )
    cb.onFleetChanged!({ version: 4, slugs: [encodePathToSlug('/repos/beta')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    const beta = store.folders.find((f) => f.path === '/repos/beta')!
    expect(beta.sessions.map((s) => s.sessionId)).toEqual(['real-b'])
    expect(store.allSessions.some((s) => s.sessionId === synthId)).toBe(false)
  })

  it('Review focus 1: a session added then removed before its refresh leaves no ghost and no pending id', async () => {
    const store = useSessionsStore()
    await store.init()
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'flash' })
    cb.onSessionRemoved!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'flash' })
    cb.onFleetChanged!({ version: 4, slugs: [encodePathToSlug('/repos/alpha')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    expect(store.allSessions.some((s) => s.sessionId === 'flash')).toBe(false)
    expect(store.__pendingCollapseSizeForTests()).toBe(0)
  })
})

describe('sidebar liveness — migrated rows wait for model evidence (AC-31)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    disk = [
      folder('/repos/alpha', []),
      folder('/repos/beta', [
        session({ sessionId: 'b1', projectPath: '/repos/beta', fullPath: '/x/b1.jsonl' })
      ])
    ]
    installWindow()
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  async function migrateInAlpha() {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')
    const synth = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.synthetic)!
    store.selectedId = synth.sessionId
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'mig1' }) // in-place migrate
    await flush()
    return {
      store,
      row: store.folders
        .find((f) => f.path === '/repos/alpha')!
        .sessions.find((s) => s.sessionId === 'mig1')!
    }
  }

  it('survives a reload covering only another folder, same object, selection kept', async () => {
    const { store, row } = await migrateInAlpha()
    cb.onFleetChanged!({ version: 5, slugs: [encodePathToSlug('/repos/beta')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    const again = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'mig1')
    expect(again).toBe(row)
    expect(store.selectedId).toBe('mig1')
  })

  it('is dropped once a reload covering its own slug omits it', async () => {
    const { store } = await migrateInAlpha()
    cb.onFleetChanged!({ version: 6, slugs: [encodePathToSlug('/repos/alpha')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    expect(store.allSessions.some((s) => s.sessionId === 'mig1')).toBe(false)
    expect(store.__awaitingConfirmSizeForTests()).toBe(0)
  })

  it('moves out of alpha as soon as the model places it under another folder (no duplicate)', async () => {
    const { store } = await migrateInAlpha()
    disk = [
      folder('/repos/alpha', []),
      folder('/repos/beta', [
        session({ sessionId: 'b1', projectPath: '/repos/beta', fullPath: '/x/b1.jsonl' }),
        session({ sessionId: 'mig1', projectPath: '/repos/beta', fullPath: '/x/mig1.jsonl' })
      ])
    ]
    cb.onFleetChanged!({ version: 7, slugs: [encodePathToSlug('/repos/beta')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    const holders = store.folders
      .filter((f) => f.sessions.some((s) => s.sessionId === 'mig1'))
      .map((f) => f.path)
    expect(holders).toEqual(['/repos/beta'])
  })

  it('an agent synthetic bound in place (tryBindAgentMigration) waits for evidence too', async () => {
    const store = useSessionsStore()
    await store.init()
    const agent: AgentSession = {
      syntheticId: 'synthetic-agent-a',
      correlationId: 'corr-agent-a',
      folderPath: '/repos/alpha'
    }
    store.insertAgentSession(agent)
    store.armAgentCorrelationForBoot('synthetic-agent-a')
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'agent-real' })
    await flush()
    const row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'agent-real')
    expect(row).toBeDefined()
    cb.onFleetChanged!({ version: 9, slugs: [encodePathToSlug('/repos/beta')], full: false })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    expect(
      store.folders
        .find((f) => f.path === '/repos/alpha')!
        .sessions.find((s) => s.sessionId === 'agent-real')
    ).toBe(row)
    expect(store.__awaitingConfirmSizeForTests()).toBe(1)
  })

  it('a push that arrived before the migration does not judge the row (stale coverage)', async () => {
    const store = useSessionsStore()
    await store.init()
    store.createNewSession('/repos/alpha')
    // P1 reloads on the leading edge; P2 covers alpha but is consumed by a
    // trailing reload that runs AFTER the migration below.
    cb.onFleetChanged!({ version: 2, slugs: [encodePathToSlug('/repos/beta')], full: false })
    cb.onFleetChanged!({ version: 3, slugs: [encodePathToSlug('/repos/alpha')], full: false })
    cb.onSessionAdded!({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'mig1' })
    await flush()
    const row = store.folders
      .find((f) => f.path === '/repos/alpha')!
      .sessions.find((s) => s.sessionId === 'mig1')
    expect(row).toBeDefined()
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    expect(
      store.folders
        .find((f) => f.path === '/repos/alpha')!
        .sessions.find((s) => s.sessionId === 'mig1')
    ).toBe(row)
    expect(store.__awaitingConfirmSizeForTests()).toBe(1)
  })

  it('Review focus 3: a full rescan resolves a waiting row either way', async () => {
    const { store } = await migrateInAlpha()
    cb.onFleetChanged!({ version: 8, slugs: [], full: true })
    await new Promise((r) => setTimeout(r, 300))
    await flush()
    expect(store.__awaitingConfirmSizeForTests()).toBe(0)
  })
})
