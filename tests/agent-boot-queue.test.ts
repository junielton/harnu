import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { AGENT_BOOT_TIMEOUT_MS } from '../src/renderer/src/stores/synthetic-reaper'
import type { AgentSession } from '../src/renderer/src/stores/agent-create-core'
import type { FolderEntry } from '../src/preload'

/**
 * BUG-23 — the synth→PTY boot pipeline. These store-level tests cover the pure /
 * deterministic half: the background boot queue (enqueue/dedup/take) and the
 * dead-synthetic reaper (timeout → FAILED, live → no-op, retry). The actual PTY
 * spawn + the serialized drain live in `TerminalPane.vue` (xterm + `ptyCreate`,
 * env-bound) → e2e.
 */

function diskFolders(): FolderEntry[] {
  return [{ path: '/repos/alpha', alias: 'alpha', gitBranch: 'main', sessions: [] }]
}

function installWindow(): void {
  // Each `on*` is `(cb) => unsubscribe`; the store pushes the unsubscribe onto its
  // cleanup registry. We never invoke the callbacks here.
  const on =
    () =>
    (_cb: (...a: unknown[]) => void): (() => void) =>
    () => {}
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      foldersLoad: vi.fn(async () => diskFolders()),
      userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
      orchestratorListArmed: vi.fn(async () => []),
      onProjectAdded: on(),
      onProjectRemoved: on(),
      onSessionAdded: on(),
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
      pushSend: vi.fn()
    }
  }
}

function agent(syntheticId: string, folderPath = '/repos/alpha'): AgentSession {
  return { syntheticId, correlationId: `corr-${syntheticId}`, folderPath }
}

function findSynth(store: ReturnType<typeof useSessionsStore>, id: string) {
  return store.folders.flatMap((f) => f.sessions).find((s) => s.sessionId === id)
}

describe('agent background boot queue (BUG-23)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('enqueueAgentBoot dedups and takeAgentBoots drains FIFO', () => {
    const store = useSessionsStore()
    store.enqueueAgentBoot('a')
    store.enqueueAgentBoot('b')
    store.enqueueAgentBoot('a') // dedup
    expect(store.agentBootQueue).toEqual(['a', 'b'])
    expect(store.takeAgentBoots()).toEqual(['a', 'b'])
    expect(store.agentBootQueue).toEqual([])
    expect(store.takeAgentBoots()).toEqual([]) // idempotent drain
  })

  it('insertAgentSession while idle selects the synthetic AND enqueues its boot', async () => {
    const store = useSessionsStore()
    await store.init()
    expect(store.selectedId).toBeNull()

    store.insertAgentSession(agent('synthetic-a'))

    expect(store.selectedId).toBe('synthetic-a') // idle → mount the pane
    expect(store.agentBootQueue).toEqual(['synthetic-a'])
    expect(findSynth(store, 'synthetic-a')?.synthetic).toBe(true)
  })

  it('insertAgentSession while busy does NOT steal selection but still enqueues', async () => {
    const store = useSessionsStore()
    await store.init()
    store.selectedId = 'user-session' // operator is looking at something

    store.insertAgentSession(agent('synthetic-a'))

    expect(store.selectedId).toBe('user-session') // never yanked
    expect(store.agentBootQueue).toEqual(['synthetic-a'])
  })

  it('a burst of creates enqueues EVERY boot (the core BUG-23 regression)', async () => {
    const store = useSessionsStore()
    await store.init()
    store.selectedId = 'user-session'

    store.insertAgentSession(agent('synthetic-a'))
    store.insertAgentSession(agent('synthetic-b'))
    store.insertAgentSession(agent('synthetic-c'))

    // Pre-fix, boot was selection-driven and the burst dropped all but one.
    // Now every dispatched boot is queued — none is lost to the single scalar.
    expect(store.agentBootQueue).toEqual(['synthetic-a', 'synthetic-b', 'synthetic-c'])
    expect(store.selectedId).toBe('user-session')
  })
})

describe('dead-synthetic reaper (BUG-23)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('marks a synthetic FAILED (boot_timeout) when no PTY came up within the deadline', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'))
    const s = findSynth(store, 'synthetic-a')!
    expect(s.taskState).toBeUndefined() // "working" until reaped

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    expect(s.taskState).toBe('failed')
    expect(s.failureReason).toBe('boot_timeout')
  })

  it('does NOT reap a synthetic whose boot produced a live PTY', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'))
    // Boot succeeded: a PTY registered (TerminalPane calls registerLiveSession).
    store.registerLiveSession('synthetic-a')

    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)

    const s = findSynth(store, 'synthetic-a')!
    expect(s.taskState).toBeUndefined() // still alive, never falsely failed
  })

  it('a dismissed (closed) synthetic never trips the reaper', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'))
    store.closeSession('synthetic-a') // dismiss before the deadline

    expect(() => vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)).not.toThrow()
    expect(findSynth(store, 'synthetic-a')).toBeUndefined()
    expect(store.agentBootQueue).toEqual([]) // dequeued on close
  })

  it('retrySyntheticBoot clears the FAILED state and re-enqueues + re-arms the reaper', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'))
    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)
    const s = findSynth(store, 'synthetic-a')!
    expect(s.taskState).toBe('failed')

    // Consume the initial queue entry (as TerminalPane would) so we can observe
    // the retry re-enqueue cleanly.
    store.takeAgentBoots()

    store.retrySyntheticBoot('synthetic-a')
    expect(s.taskState).toBeUndefined()
    expect(s.failureReason).toBeUndefined()
    expect(store.agentBootQueue).toEqual(['synthetic-a'])

    // Reaper re-armed: a second dead window fails it again.
    store.takeAgentBoots()
    vi.advanceTimersByTime(AGENT_BOOT_TIMEOUT_MS)
    expect(s.taskState).toBe('failed')
  })
})
