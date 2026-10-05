import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useNotificationsStore,
  NOTIFICATIONS_MAX_COUNT,
  NOTIFICATIONS_MAX_AGE_MS,
  type NotificationRecord
} from '../src/renderer/src/stores/notifications'
import { useUiStore } from '../src/renderer/src/stores/ui'

/**
 * Notification history store (T83 S1). `localStorage` is stubbed with the same
 * in-memory harness as `layout-store.test.ts` / `persisted.test.ts`.
 */

function makeLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}

function baseEntry(over: Partial<NotificationRecord> = {}): Omit<NotificationRecord, 'id'> {
  return {
    ts: Date.now(),
    source: 'app',
    kind: 'info',
    title: 'A title',
    ...over
  }
}

describe('useNotificationsStore', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  it('starts empty', () => {
    const s = useNotificationsStore()
    expect(s.list).toHaveLength(0)
  })

  it('notify() appends a record with a generated id', () => {
    const s = useNotificationsStore()
    const rec = s.notify(baseEntry({ title: 'Hello' }))
    expect(rec.id).toBeTruthy()
    expect(s.list).toHaveLength(1)
    expect(s.list[0].title).toBe('Hello')
  })

  it('list is most-recent-first regardless of insertion order', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    s.notify(baseEntry({ ts: now - 3000, title: 'oldest' }))
    s.notify(baseEntry({ ts: now - 1000, title: 'newest' }))
    s.notify(baseEntry({ ts: now - 2000, title: 'middle' }))

    expect(s.list.map((r) => r.title)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('caps the buffer at NOTIFICATIONS_MAX_COUNT, dropping the oldest', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    for (let i = 0; i < NOTIFICATIONS_MAX_COUNT + 10; i++) {
      s.notify(baseEntry({ ts: now + i, title: `n${i}` }))
    }

    expect(s.list).toHaveLength(NOTIFICATIONS_MAX_COUNT)
    // The 10 oldest (n0..n9) must have been evicted; the newest survives.
    expect(s.list.map((r) => r.title)).not.toContain('n0')
    expect(s.list[0].title).toBe(`n${NOTIFICATIONS_MAX_COUNT + 9}`)
  })

  it('drops an entry past the age cap immediately, even a brand-new notify() call', () => {
    const s = useNotificationsStore()
    const stale = Date.now() - NOTIFICATIONS_MAX_AGE_MS - 1000
    s.notify(baseEntry({ ts: stale, title: 'too old' }))

    expect(s.list).toHaveLength(0)
  })

  it('a fresh record survives while an older one already in the buffer ages out', () => {
    const s = useNotificationsStore()
    // Just inside the cap when added — still present after the next notify().
    const borderline = Date.now() - NOTIFICATIONS_MAX_AGE_MS + 5000
    s.notify(baseEntry({ ts: borderline, title: 'borderline' }))
    expect(s.list.map((r) => r.title)).toEqual(['borderline'])

    s.notify(baseEntry({ ts: Date.now(), title: 'fresh' }))

    expect(s.list.map((r) => r.title)).toEqual(['fresh', 'borderline'])
  })

  it('dismiss() removes only the matching record (T152)', () => {
    const s = useNotificationsStore()
    const a = s.notify(baseEntry({ title: 'a' }))
    const b = s.notify(baseEntry({ title: 'b' }))

    s.dismiss(a.id)

    expect(s.list.map((r) => r.id)).toEqual([b.id])
  })

  it('dismiss() is a no-op for an unknown id', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ title: 'a' }))

    s.dismiss('does-not-exist')

    expect(s.list).toHaveLength(1)
  })

  it('clearAll() empties the list (T152)', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ title: 'a' }))
    s.notify(baseEntry({ title: 'b' }))

    s.clearAll()

    expect(s.list).toHaveLength(0)
  })

  it('a persisted record from before T152 (with a stale `read` field) loads fine — the field is just ignored', () => {
    localStorage.setItem(
      'om2tab.notifications',
      JSON.stringify([
        { id: 'a', ts: Date.now(), source: 'app', kind: 'info', title: 'legacy', read: true }
      ])
    )
    setActivePinia(createPinia())
    const s = useNotificationsStore()

    expect(s.list.map((r) => r.title)).toEqual(['legacy'])
  })

  it('prunes a stale persisted buffer on load', () => {
    // Simulate a prior window that persisted an old buffer directly to storage.
    const stale = Date.now() - NOTIFICATIONS_MAX_AGE_MS - 1000
    localStorage.setItem(
      'om2tab.notifications',
      JSON.stringify([
        { id: 'a', ts: stale, source: 'app', kind: 'info', title: 'old', read: false }
      ])
    )
    setActivePinia(createPinia())
    const s = useNotificationsStore()

    expect(s.list).toHaveLength(0)
  })
})

describe('pushToast → notifications funnel', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  it('a toast is captured as a history record by default', () => {
    const ui = useUiStore()
    const notifications = useNotificationsStore()

    ui.pushToast({ kind: 'success', title: 'Saved' })

    expect(notifications.list).toHaveLength(1)
    expect(notifications.list[0]).toMatchObject({ title: 'Saved', kind: 'success', source: 'app' })
  })

  it('persist: false opts a trivial toast out of the history', () => {
    const ui = useUiStore()
    const notifications = useNotificationsStore()

    ui.pushToast({ kind: 'success', title: 'Copied to clipboard', persist: false })

    expect(notifications.list).toHaveLength(0)
    expect(ui.toasts).toHaveLength(1) // still shows as a toast — only history capture is skipped
  })

  it('carries the toast sessionId into the record (BUG-49 regression — the Activity bell needs this to navigate on click)', () => {
    const ui = useUiStore()
    const notifications = useNotificationsStore()

    ui.pushToast({ kind: 'success', title: 'Session completed', sessionId: 'sess-1' })

    expect(notifications.list[0].sessionId).toBe('sess-1')
  })

  it('carries the toast action label (no handler) into the record', () => {
    const ui = useUiStore()
    const notifications = useNotificationsStore()

    ui.pushToast({
      kind: 'info',
      title: 'Update ready',
      timeoutMs: 0,
      action: { label: 'Restart now', handler: () => {} }
    })

    expect(notifications.list[0].action).toEqual({ label: 'Restart now' })
  })
})
