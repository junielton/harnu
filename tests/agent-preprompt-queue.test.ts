import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useSessionsStore,
  AGENT_PREPROMPT_ARGV_MAX_CHARS
} from '../src/renderer/src/stores/sessions'
import type { AgentSession } from '../src/renderer/src/stores/agent-create-core'
import type { FolderEntry } from '../src/preload'

/**
 * The agent pre-prompt queue (T25/T62/T80): a session created with a `prePrompt`
 * queues it for the last-mile injection `TerminalPane` performs once the REPL is
 * up. These store-level tests cover the queue half — enqueue on
 * `insertAgentSession` / `dispatchCardSession`, the non-consuming `hasAgentPrompt`
 * peek, and the one-shot `takeAgentPrompt` consume — the pure/deterministic seam
 * the drop-fix (`acquireInjectionTarget`) reads to decide whether it may consume.
 */

function diskFolders(): FolderEntry[] {
  return [{ path: '/repos/alpha', alias: 'alpha', gitBranch: 'main', sessions: [] }]
}

function installWindow(): void {
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
      pushSend: vi.fn(),
      reportPromptUndelivered: vi.fn(),
      clearPromptUndelivered: vi.fn()
    }
  }
}

function agent(syntheticId: string, folderPath = '/repos/alpha'): AgentSession {
  return { syntheticId, correlationId: `corr-${syntheticId}`, folderPath }
}

describe('agent pre-prompt queue (insertAgentSession / dispatchCardSession)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('insertAgentSession with a short prePrompt attaches it to bootOverride, not the queue', async () => {
    const store = useSessionsStore()
    await store.init()

    store.insertAgentSession(agent('synthetic-a'), 'boot me up')

    const s = store.findSessionById('synthetic-a')!
    expect(s.bootOverride?.prePrompt).toBe('boot me up')
    expect(store.hasAgentPrompt('synthetic-a')).toBe(false)
    expect(store.takeAgentPrompt('synthetic-a')).toBeUndefined()
  })

  it('insertAgentSession with a prePrompt over the argv threshold falls back to the queue', async () => {
    const store = useSessionsStore()
    await store.init()

    const huge = 'y'.repeat(AGENT_PREPROMPT_ARGV_MAX_CHARS + 1)
    store.insertAgentSession(agent('synthetic-huge'), huge)

    const s = store.findSessionById('synthetic-huge')!
    expect(s.bootOverride?.prePrompt).toBeUndefined()
    expect(store.hasAgentPrompt('synthetic-huge')).toBe(true)
    expect(store.takeAgentPrompt('synthetic-huge')).toBe(huge)
  })

  it('insertAgentSession with a prePrompt at exactly the argv threshold still attaches to bootOverride', async () => {
    const store = useSessionsStore()
    await store.init()

    const atMax = 'z'.repeat(AGENT_PREPROMPT_ARGV_MAX_CHARS)
    store.insertAgentSession(agent('synthetic-at-max'), atMax)

    const s = store.findSessionById('synthetic-at-max')!
    expect(s.bootOverride?.prePrompt).toBe(atMax)
    expect(store.hasAgentPrompt('synthetic-at-max')).toBe(false)
  })

  it('insertAgentSession preserves an allowlisted model/effort bootOverride alongside an argv prePrompt', async () => {
    const store = useSessionsStore()
    await store.init()

    store.insertAgentSession(agent('synthetic-both'), 'go', { model: 'haiku', effort: 'low' })

    const s = store.findSessionById('synthetic-both')!
    expect(s.bootOverride?.prePrompt).toBe('go')
    expect(s.bootOverride?.model).toBe('haiku')
    expect(s.bootOverride?.effort).toBe('low')
  })

  it('insertAgentSession without a prePrompt queues nothing', async () => {
    const store = useSessionsStore()
    await store.init()

    store.insertAgentSession(agent('synthetic-b'))

    expect(store.hasAgentPrompt('synthetic-b')).toBe(false)
    expect(store.takeAgentPrompt('synthetic-b')).toBeUndefined()
  })

  it('a whitespace-only prePrompt is treated as none (matches the .trim() guard)', async () => {
    const store = useSessionsStore()
    await store.init()

    store.insertAgentSession(agent('synthetic-c'), '   \n  ')

    expect(store.hasAgentPrompt('synthetic-c')).toBe(false)
  })

  it('dispatchCardSession with a short prePrompt attaches it to bootOverride, not the queue', async () => {
    const store = useSessionsStore()
    await store.init()

    const result = store.dispatchCardSession('/repos/alpha', 'read the card and go')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const s = store.findSessionById(result.sessionId)!
    expect(s.bootOverride?.prePrompt).toBe('read the card and go')
    expect(store.hasAgentPrompt(result.sessionId)).toBe(false)
    expect(store.takeAgentPrompt(result.sessionId)).toBeUndefined()
  })

  it('dispatchCardSession with a prePrompt over the argv threshold falls back to the queue', async () => {
    const store = useSessionsStore()
    await store.init()

    const huge = 'x'.repeat(AGENT_PREPROMPT_ARGV_MAX_CHARS + 1)
    const result = store.dispatchCardSession('/repos/alpha', huge)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const s = store.findSessionById(result.sessionId)!
    expect(s.bootOverride?.prePrompt).toBeUndefined()
    expect(store.hasAgentPrompt(result.sessionId)).toBe(true)
    expect(store.takeAgentPrompt(result.sessionId)).toBe(huge)
  })

  it('dispatchCardSession with a prePrompt at exactly the argv threshold still attaches to bootOverride', async () => {
    const store = useSessionsStore()
    await store.init()

    const atMax = 'w'.repeat(AGENT_PREPROMPT_ARGV_MAX_CHARS)
    const result = store.dispatchCardSession('/repos/alpha', atMax)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const s = store.findSessionById(result.sessionId)!
    expect(s.bootOverride?.prePrompt).toBe(atMax)
    expect(store.hasAgentPrompt(result.sessionId)).toBe(false)
  })

  it('hasAgentPrompt is false for an unknown session id', async () => {
    const store = useSessionsStore()
    await store.init()

    expect(store.hasAgentPrompt('nope-never-queued')).toBe(false)
  })
})

/**
 * The injection watchdog's visible-failure escalation (§5.4/§5.5 of the spec) and
 * its retry path. `prompt_undelivered` is a DISTINCT failure from the boot
 * reaper's `boot_timeout`: the PTY is genuinely alive here, so
 * `retrySyntheticBoot` — which only usefully re-boots a DEAD synthetic
 * (`drainBgBoot` no-ops on an id whose `liveTerminals` entry already exists and
 * isn't `dead`) — must NOT be the retry path. `retryPromptInjection` is the
 * dedicated one, mirroring the existing close/migrate/reload handler-registry
 * pattern so `TerminalPane` (which owns the actual PTY/inject plumbing) can react.
 */
describe('markPromptUndelivered / retryPromptInjection (injection watchdog escalation)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    installWindow()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('markPromptUndelivered sets a visible failed row with the dedicated reason', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'), 'boot me up')
    const s = store.findSessionById('synthetic-a')!

    store.markPromptUndelivered('synthetic-a')

    expect(s.taskState).toBe('failed')
    expect(s.failureReason).toBe('prompt_undelivered')
  })

  it('BUG-64 C: markPromptUndelivered pushes the verdict to main so get_session/get_fleet can see it', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'), 'boot me up')

    store.markPromptUndelivered('synthetic-a')

    const api = (
      globalThis as unknown as {
        window: { api: { reportPromptUndelivered: ReturnType<typeof vi.fn> } }
      }
    ).window.api
    expect(api.reportPromptUndelivered).toHaveBeenCalledTimes(1)
    expect(api.reportPromptUndelivered).toHaveBeenCalledWith('synthetic-a')
  })

  it('retryPromptInjection clears the failed state when the reason is prompt_undelivered', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'), 'boot me up')
    store.markPromptUndelivered('synthetic-a')
    const s = store.findSessionById('synthetic-a')!
    expect(s.taskState).toBe('failed')

    store.retryPromptInjection('synthetic-a')

    expect(s.taskState).toBeUndefined()
    expect(s.failureReason).toBeUndefined()
  })

  it('BUG-64 C: retryPromptInjection clears the main-side push (undoes reportPromptUndelivered)', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'), 'boot me up')
    store.markPromptUndelivered('synthetic-a')

    store.retryPromptInjection('synthetic-a')

    const api = (
      globalThis as unknown as {
        window: { api: { clearPromptUndelivered: ReturnType<typeof vi.fn> } }
      }
    ).window.api
    expect(api.clearPromptUndelivered).toHaveBeenCalledTimes(1)
    expect(api.clearPromptUndelivered).toHaveBeenCalledWith('synthetic-a')
  })

  it('BUG-64 C: retryPromptInjection on an unrelated failure reason does NOT push a clear', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'))
    store.markSyntheticBootFailed('synthetic-a')

    store.retryPromptInjection('synthetic-a')

    const api = (
      globalThis as unknown as {
        window: { api: { clearPromptUndelivered: ReturnType<typeof vi.fn> } }
      }
    ).window.api
    expect(api.clearPromptUndelivered).not.toHaveBeenCalled()
  })

  it('retryPromptInjection dispatches to every registered handler with the session id', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'), 'boot me up')
    store.markPromptUndelivered('synthetic-a')

    const seen: string[] = []
    const unregister = store.registerPromptRetryHandler((id) => seen.push(id))

    store.retryPromptInjection('synthetic-a')
    expect(seen).toEqual(['synthetic-a'])

    unregister()
    store.markPromptUndelivered('synthetic-a')
    store.retryPromptInjection('synthetic-a')
    expect(seen).toEqual(['synthetic-a']) // no further dispatch after unregister
  })

  it('retryPromptInjection is a no-op (does not clear) on an unrelated failure reason', async () => {
    const store = useSessionsStore()
    await store.init()
    store.insertAgentSession(agent('synthetic-a'))
    store.markSyntheticBootFailed('synthetic-a') // failureReason: 'boot_timeout'
    const s = store.findSessionById('synthetic-a')!
    expect(s.failureReason).toBe('boot_timeout')

    store.retryPromptInjection('synthetic-a')

    expect(s.taskState).toBe('failed') // untouched — not our failure to clear
    expect(s.failureReason).toBe('boot_timeout')
  })

  it('retryPromptInjection on an unknown session id does not throw', async () => {
    const store = useSessionsStore()
    await store.init()

    expect(() => store.retryPromptInjection('never-existed')).not.toThrow()
  })
})
