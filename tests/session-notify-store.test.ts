import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'
import type { FolderEntry, Session as SessionEntry } from '../src/preload'

/**
 * Store-level wiring for OS notifications (os-notifications spec §7). Proves that
 * BOTH task-state write paths — the hook stream and the pty-exit overlay — route
 * through `applyTaskState`, which runs the pure `decideNotification` and calls
 * `window.api.notify` with a resolved title + "<folder> · <session>" body. The
 * decision truth table itself is covered in `session-notify.test.ts`; here we
 * cover the glue (label resolution, selection/focus suppression, exit overlay).
 */

function session(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: 's1',
    summary: 'My session',
    status: 'idle',
    modified: '2026-06-11T12:00:00.000Z',
    ...over
  } as SessionEntry
}

function diskFolder(sessions: SessionEntry[]): FolderEntry {
  return { path: '/repos/alpha', alias: 'alpha', sessions }
}

describe('applyTaskState → notification wiring', () => {
  let notify: ReturnType<typeof vi.fn>
  let pushSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    notify = vi.fn()
    pushSend = vi.fn()
    const disk = [diskFolder([session()])]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        // Return FRESH objects each call — like the real IPC, which
        // deserializes a new payload every time (so runtime fields such as
        // `taskState` are NOT shared across reloads unless the store preserves
        // them explicitly).
        foldersLoad: vi.fn(async () =>
          disk.map((f) => ({ ...f, sessions: f.sessions.map((s) => ({ ...s })) }))
        ),
        userProjectsList: vi.fn(async () => ({ projects: [], hiddenPaths: [] })),
        orchestratorListArmed: vi.fn(async () => []),
        notify,
        pushSend
      }
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('notifies on the edge into needs-input for a non-selected session', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    store.applyTaskState('s1', 'needs-input')

    expect(notify).toHaveBeenCalledTimes(1)
    const arg = notify.mock.calls[0][0]
    expect(arg.sessionId).toBe('s1')
    expect(arg.body).toBe('alpha · My session')
    expect(typeof arg.title).toBe('string')
    expect(arg.title.length).toBeGreaterThan(0)
    // and the transition is applied to the model
    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBe('needs-input')
  })

  it('reloadModel preserves runtime taskState for a real session (no reset, no re-notify)', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    store.applyTaskState('s1', 'needs-input')
    expect(notify).toHaveBeenCalledTimes(1)
    notify.mockClear()

    // An onIndexUpdated-style rescan must not lose the live state nor re-notify
    // for a block the user already saw.
    await store.reloadModel()

    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBe('needs-input')
    expect(notify).not.toHaveBeenCalled()
  })

  it('a throwing window.api.notify never escapes applyTaskState (state still updates)', async () => {
    notify.mockImplementation(() => {
      throw new Error('ipc bridge gone')
    })
    const store = useSessionsStore()
    await store.reloadModel()

    expect(() => store.applyTaskState('s1', 'failed')).not.toThrow()
    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBe('failed')
  })

  it('a throwing window.api.notify on the OS channel also skips pushSend (regression: both must fail together, as before the dispatchNotification extraction)', async () => {
    notify.mockImplementation(() => {
      throw new Error('ipc bridge gone')
    })
    const store = useSessionsStore()
    await store.reloadModel()
    store.windowFocused = false // forces the 'os' channel

    store.applyTaskState('s1', 'needs-input')

    expect(notify).toHaveBeenCalledTimes(1)
    expect(pushSend).not.toHaveBeenCalled()
  })

  it('does not fire on a non-notify target (working)', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    store.applyTaskState('s1', 'working')

    expect(notify).not.toHaveBeenCalled()
  })

  it('focused + selected: routes to an in-app toast, not the OS notification', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    await store.reloadModel()
    store.select('s1')
    store.windowFocused = true

    store.applyTaskState('s1', 'needs-input')

    // No native OS notification while focused — it becomes an in-app toast.
    expect(notify).not.toHaveBeenCalled()
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].description).toBe('alpha · My session')
    // state still updates
    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBe('needs-input')
  })

  it('focused + a different session selected: still an in-app toast (not OS)', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    await store.reloadModel()
    store.select('other-session')
    store.windowFocused = true

    store.applyTaskState('s1', 'failed')

    expect(notify).not.toHaveBeenCalled()
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0].kind).toBe('danger')
  })

  it('NOT focused: routes to the native OS notification', async () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    await store.reloadModel()
    store.windowFocused = false

    store.applyTaskState('s1', 'needs-input')

    expect(notify).toHaveBeenCalledTimes(1)
    expect(ui.toasts).toHaveLength(0)
  })

  it('NOT focused, notify succeeds: also fires pushSend (the OS channel is where remote push rides)', async () => {
    const store = useSessionsStore()
    await store.reloadModel()
    store.windowFocused = false

    store.applyTaskState('s1', 'needs-input')

    expect(notify).toHaveBeenCalledTimes(1)
    expect(pushSend).toHaveBeenCalledTimes(1)
  })

  it('respects a per-state pref toggle (failed off)', async () => {
    const store = useSessionsStore()
    await store.reloadModel()
    store.setNotifyPref('failed', false)

    store.applyTaskState('s1', 'failed')

    expect(notify).not.toHaveBeenCalled()
  })

  it('respects the master pref switch', async () => {
    const store = useSessionsStore()
    await store.reloadModel()
    store.setNotifyPref('enabled', false)

    store.applyTaskState('s1', 'needs-input')

    expect(notify).not.toHaveBeenCalled()
  })

  it('markSessionExited routes through applyTaskState: clean exit → completed + notifies', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    store.markSessionExited('s1', 0)

    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBe('completed')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0].title.length).toBeGreaterThan(0)
  })

  it('markSessionExited non-zero → failed + notifies', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    store.markSessionExited('s1', 1)

    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBe('failed')
    expect(notify).toHaveBeenCalledTimes(1)
  })
})
