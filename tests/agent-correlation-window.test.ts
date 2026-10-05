import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore, AGENT_MIGRATE_WINDOW_MS } from '../src/renderer/src/stores/sessions'
import { encodePathToSlug } from '../src/renderer/src/lib/folder-slug'
import type { AgentSession } from '../src/renderer/src/stores/agent-create-core'
import type { FolderEntry } from '../src/preload'

/**
 * BUG-59 — the correlation window must be armed at BOOT, not at
 * `insertAgentSession` (enqueue), because `agentBootQueue` drains serially
 * and a fixed enqueue-armed window routinely expired before a queued boot
 * even started under fan-out (post-mortem: `docs/reports/2026-07-20-orphan-
 * spawn-postmortem.md`, defect D4). These tests cover the store-level half of
 * the fix: `armAgentCorrelationForBoot` (called by `TerminalPane` right
 * before the PTY spawn — see `TerminalPane.vue`'s `createLiveTerminal`) and
 * the fallback recency path (`collapseSyntheticInto`) also reporting
 * materialization when the correlation window itself has lapsed.
 */

type SessionAddedCb = (p: { slug: string; sessionId: string }) => void

function diskFolders(...paths: string[]): FolderEntry[] {
  return paths.map((path, i) => ({ path, alias: `f${i}`, gitBranch: 'main', sessions: [] }))
}

let sessionAddedCb: SessionAddedCb | null = null
let notifyMaterializedSpy: ReturnType<typeof vi.fn>

function installWindow(folders: FolderEntry[]): void {
  const on =
    () =>
    (_cb: (...a: unknown[]) => void): (() => void) =>
    () => {}
  sessionAddedCb = null
  notifyMaterializedSpy = vi.fn()
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      foldersLoad: vi.fn(async () => folders),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      onProjectAdded: on(),
      onProjectRemoved: on(),
      onSessionAdded: (cb: SessionAddedCb): (() => void) => {
        sessionAddedCb = cb
        return () => {
          sessionAddedCb = null
        }
      },
      onSessionRemoved: on(),
      onSessionUpdated: on(),
      onSessionRegistry: on(),
      onHook: on(),
      onScreenState: on(),
      fleetReportShellSessions: vi.fn(),
      onApprovalPending: on(),
      onApprovalResolved: on(),
      approvalsList: vi.fn(async () => []),
      onNotifyActivate: on(),
      onIndexUpdated: on(),
      onWatcherDegraded: on(),
      onSubagentUpdated: on(),
      onSubagentRemoved: on(),
      notify: vi.fn(),
      pushSend: vi.fn(),
      notifySessionMaterialized: notifyMaterializedSpy
    }
  }
}

function agent(syntheticId: string, folderPath: string): AgentSession {
  return { syntheticId, correlationId: `corr-${syntheticId}`, folderPath }
}

function rowById(store: ReturnType<typeof useSessionsStore>, id: string) {
  return store.folders.flatMap((f) => f.sessions).find((s) => s.sessionId === id)
}

describe('agent correlation window armed at boot (BUG-59)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('binds by correlation after a serial-queue delay far exceeding the fixed window, leaving a coexisting user synthetic untouched', async () => {
    installWindow(diskFolders('/repos/alpha'))
    const store = useSessionsStore()
    await store.init()

    // A user "+ New session" synthetic already lives in the folder.
    const userSyntheticId = store.createNewSession('/repos/alpha')!
    expect(rowById(store, userSyntheticId)?.synthetic).toBe(true)

    // The agent's create enqueues at t=0.
    store.insertAgentSession(agent('synthetic-a', '/repos/alpha'))

    // Serial drain: this synthetic's boot doesn't actually start until 20s
    // later — comfortably past what a fixed 10s window armed at enqueue would
    // have allowed (exactly the BUG-59 queue-depth erosion).
    vi.advanceTimersByTime(20_000)
    expect(20_000).toBeGreaterThan(AGENT_MIGRATE_WINDOW_MS)
    store.armAgentCorrelationForBoot('synthetic-a') // TerminalPane starts the real spawn now

    // Transcript lands a few seconds after the boot actually started — well
    // within the FRESH window armed above.
    vi.advanceTimersByTime(3_000)
    sessionAddedCb?.({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real-agent-a' })
    await Promise.resolve()

    const agentRow = rowById(store, 'real-agent-a')
    expect(agentRow).toBeDefined()
    expect(agentRow?.synthetic).toBe(false)

    // T16/T25: the coexisting user synthetic is never touched by the agent's
    // correlation.
    const userRow = rowById(store, userSyntheticId)
    expect(userRow).toBeDefined()
    expect(userRow?.synthetic).toBe(true)

    expect(notifyMaterializedSpy).toHaveBeenCalledWith({
      syntheticId: 'synthetic-a',
      sessionId: 'real-agent-a',
      folder: '/repos/alpha'
    })
  })

  it('a burst of N creates: later members still materialize + report despite growing serial-drain delay', async () => {
    const paths = ['/repos/alpha', '/repos/beta', '/repos/gamma']
    installWindow(diskFolders(...paths))
    const store = useSessionsStore()
    await store.init()

    // Burst: all three agent creates enqueue back-to-back at ~t=0 (fan-out).
    store.insertAgentSession(agent('synthetic-alpha', '/repos/alpha'))
    store.insertAgentSession(agent('synthetic-beta', '/repos/beta'))
    store.insertAgentSession(agent('synthetic-gamma', '/repos/gamma'))

    // Member 1: boots almost immediately.
    store.armAgentCorrelationForBoot('synthetic-alpha')
    vi.advanceTimersByTime(2_000)
    sessionAddedCb?.({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real-alpha' })
    await Promise.resolve()

    // Member 2: the serial queue doesn't reach it until t=15s total — already
    // past the fixed 10s window if it had been armed back at enqueue (t=0).
    vi.advanceTimersByTime(13_000)
    store.armAgentCorrelationForBoot('synthetic-beta')
    vi.advanceTimersByTime(2_000)
    sessionAddedCb?.({ slug: encodePathToSlug('/repos/beta'), sessionId: 'real-beta' })
    await Promise.resolve()

    // Member 3: reached at t=40s total — far past the fixed window.
    vi.advanceTimersByTime(23_000)
    store.armAgentCorrelationForBoot('synthetic-gamma')
    vi.advanceTimersByTime(2_000)
    sessionAddedCb?.({ slug: encodePathToSlug('/repos/gamma'), sessionId: 'real-gamma' })
    await Promise.resolve()

    for (const id of ['real-alpha', 'real-beta', 'real-gamma']) {
      const row = rowById(store, id)
      expect(row).toBeDefined()
      expect(row?.synthetic).toBe(false)
    }
    expect(notifyMaterializedSpy).toHaveBeenCalledTimes(3)
    expect(notifyMaterializedSpy).toHaveBeenNthCalledWith(1, {
      syntheticId: 'synthetic-alpha',
      sessionId: 'real-alpha',
      folder: '/repos/alpha'
    })
    expect(notifyMaterializedSpy).toHaveBeenNthCalledWith(2, {
      syntheticId: 'synthetic-beta',
      sessionId: 'real-beta',
      folder: '/repos/beta'
    })
    expect(notifyMaterializedSpy).toHaveBeenNthCalledWith(3, {
      syntheticId: 'synthetic-gamma',
      sessionId: 'real-gamma',
      folder: '/repos/gamma'
    })
  })

  it('armAgentCorrelationForBoot is a safe no-op for a user synthetic / unknown id', async () => {
    installWindow(diskFolders('/repos/alpha'))
    const store = useSessionsStore()
    await store.init()
    const userSyntheticId = store.createNewSession('/repos/alpha')!

    expect(() => store.armAgentCorrelationForBoot(userSyntheticId)).not.toThrow()
    expect(() => store.armAgentCorrelationForBoot('nonexistent-id')).not.toThrow()
  })
})

describe('fallback recency migrate also reports materialization (BUG-59)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('reports materialization through collapseSyntheticInto when no correlation is armed at all', async () => {
    installWindow(diskFolders('/repos/alpha'))
    const store = useSessionsStore()
    await store.init()

    // Enqueued but never armed for boot (simulating a window that lapsed
    // long before the transcript landed) — tryBindAgentMigration must fail
    // and fall through to the recency collapse.
    store.insertAgentSession(agent('synthetic-a', '/repos/alpha'))

    sessionAddedCb?.({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real-a' })
    await Promise.resolve()

    const row = rowById(store, 'real-a')
    expect(row).toBeDefined()
    expect(row?.synthetic).toBe(false)
    expect(notifyMaterializedSpy).toHaveBeenCalledWith({
      syntheticId: 'synthetic-a',
      sessionId: 'real-a',
      folder: '/repos/alpha'
    })
  })

  it('does NOT report materialization for an ordinary user synthetic collapsing via recency', async () => {
    installWindow(diskFolders('/repos/alpha'))
    const store = useSessionsStore()
    await store.init()

    store.createNewSession('/repos/alpha')

    sessionAddedCb?.({ slug: encodePathToSlug('/repos/alpha'), sessionId: 'real-user' })
    await Promise.resolve()

    const row = rowById(store, 'real-user')
    expect(row).toBeDefined()
    expect(row?.synthetic).toBe(false)
    expect(notifyMaterializedSpy).not.toHaveBeenCalled()
  })
})
