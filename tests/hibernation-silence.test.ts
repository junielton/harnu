import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { shouldMarkExited } from '../src/renderer/src/components/TerminalPane.vue'
import { markHibernated, isHibernated, resetHibernation } from '../src/main/hibernation'
import { handleBridgeEvent } from '../src/main/hook-bridge'
import type { FolderEntry, Session as SessionEntry } from '../src/preload'

/**
 * T178 §3 — the audit table, in executable form. A parked session must be
 * silent: no OS notification, no in-app toast, no chime, no remote push, no
 * badge count, and a late hook event must not resurrect it. This file proves
 * the rows that needed a real new guard; the rows proven structural by the
 * spec (window attention #5, claude-watcher #12, team/roadmap watchers
 * #14-15, Sentinel #16, helper-pane #17) are not re-asserted here — a guard
 * that can never be false would be a lie about how the system works (spec §3
 * closing note), so this file does not add one.
 *
 * Coverage map:
 *  - #1-4, #18 (OS notify / toast / chime / push / "[session ended]" line):
 *    gated by `shouldMarkExited` (BUG-70 §3.3) — asserted directly below, and
 *    exercised at the call site in `tests/sessions-store.test.ts`.
 *  - #6 (dock/taskbar badge): `attentionCount` excludes a hibernated row —
 *    asserted below (`markHibernated` clears `taskState`).
 *  - #8 (late hook event): `tests/hook-bridge.test.ts` — re-asserted below via
 *    the same exported `handleBridgeEvent` for the "audit table" framing.
 *  - #13 (stale PID-registry dot): `tests/sessions-store.test.ts`.
 *  - regression bar (BUG-70 §5): a genuine completion still notifies, below.
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

describe('T178 §3 row #1-4, #18 — shouldMarkExited gates the whole notify chain', () => {
  it('a park never reaches markSessionExited / maybeNotify (gated at the source)', () => {
    expect(shouldMarkExited('park')).toBe(false)
  })

  it('a natural exit (or an absent reason, wire back-compat) still reaches it', () => {
    expect(shouldMarkExited('natural')).toBe(true)
    expect(shouldMarkExited(undefined)).toBe(true)
  })
})

describe('T178 §3 row #6 — a hibernated session cannot be counted needs-input (badge)', () => {
  let notify: ReturnType<typeof vi.fn>
  let pushSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    notify = vi.fn()
    pushSend = vi.fn()
    const disk = [diskFolder([session()])]
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
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

  it('parking a needs-input session drops it out of attentionCount', async () => {
    const store = useSessionsStore()
    await store.reloadModel()
    store.applyTaskState('s1', 'needs-input')
    expect(store.attentionCount).toBe(1)

    store.markHibernated('s1')

    expect(store.attentionCount).toBe(0)
    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBeUndefined()
  })

  it('the regression bar: a genuine completion (never parked) still notifies', async () => {
    const store = useSessionsStore()
    await store.reloadModel()

    store.markSessionExited('s1', 0)

    expect(store.allSessions.find((s) => s.sessionId === 's1')?.taskState).toBe('completed')
    expect(notify).toHaveBeenCalledTimes(1)
  })
})

describe('T178 §3 row #8 — a late hook event for a parked session is silent, in main', () => {
  afterEach(() => resetHibernation())

  it('drops the event entirely (no renderer send) once the ptyId is parked', () => {
    markHibernated('parked-2')
    expect(isHibernated('parked-2')).toBe(true)
    const send = vi.fn()
    handleBridgeEvent(
      { sessionId: 'parked-2', event: 'Stop', ts: Date.now() },
      () => ({ isDestroyed: () => false, webContents: { send } }) as never
    )
    expect(send).not.toHaveBeenCalled()
  })
})
