import { describe, it, expect, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import {
  useNotificationsStore,
  NOTIFICATIONS_MAX_COUNT,
  NOTIFICATIONS_MAX_AGE_MS,
  type NotificationItem,
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

describe('notify() group upsert (BUG-173 S2, spec §3.3)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  const item = (id: string, over: Partial<NotificationItem> = {}): NotificationItem => ({
    id,
    title: `Mission ${id}`,
    ...over
  })

  it('without a group, two identical notifies append two records (unchanged behavior)', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ title: 'same' }))
    s.notify(baseEntry({ title: 'same' }))

    expect(s.list).toHaveLength(2)
  })

  it('a group with no existing record appends and stores group + items', () => {
    const s = useNotificationsStore()
    const rec = s.notify(baseEntry({ group: 'mission-cue', items: [item('m1')] }))

    expect(s.list).toHaveLength(1)
    expect(rec.group).toBe('mission-cue')
    expect(s.list[0].items).toEqual([item('m1')])
  })

  it('a group with an existing record replaces its content in place and keeps the id', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    const first = s.notify(
      baseEntry({
        ts: now - 5000,
        kind: 'info',
        title: 'one mission',
        description: 'old description',
        sessionId: 'sess-1',
        target: { view: 'cleanup' },
        group: 'mission-cue',
        items: [item('m1')]
      })
    )

    const second = s.notify(
      baseEntry({
        ts: now,
        kind: 'warning',
        title: '2 missions',
        group: 'mission-cue',
        items: [item('m1'), item('m2', { sessionId: 'sess-2' })]
      })
    )

    expect(s.list).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(s.list[0]).toMatchObject({
      id: first.id,
      ts: now,
      kind: 'warning',
      title: '2 missions'
    })
    expect(s.list[0].items).toHaveLength(2)
    // Fields the new entry does not carry are replaced, not merged: no stale
    // description / sessionId / target from the previous snapshot.
    expect(s.list[0].description).toBeUndefined()
    expect(s.list[0].sessionId).toBeUndefined()
    expect(s.list[0].target).toBeUndefined()
  })

  it('an upsert does not grow the badge count (list length)', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ group: 'mission-cue', title: 'a' }))
    s.notify(baseEntry({ title: 'unrelated' }))
    const before = s.list.length

    s.notify(baseEntry({ group: 'mission-cue', title: 'b' }))
    s.notify(baseEntry({ group: 'mission-cue', title: 'c' }))

    expect(s.list).toHaveLength(before)
    expect(s.list.filter((r) => r.group === 'mission-cue')).toHaveLength(1)
  })

  it('different groups keep separate records', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ group: 'g1', title: 'a' }))
    s.notify(baseEntry({ group: 'g2', title: 'b' }))

    expect(s.list).toHaveLength(2)
  })

  it('an upsert after the entry was dismissed appends a fresh record', () => {
    const s = useNotificationsStore()
    const first = s.notify(baseEntry({ group: 'mission-cue', title: 'a' }))
    s.dismiss(first.id)

    const again = s.notify(baseEntry({ group: 'mission-cue', title: 'b' }))

    expect(s.list).toHaveLength(1)
    expect(again.id).not.toBe(first.id)
  })

  it('the upserted record persists with its group and items', async () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ group: 'mission-cue', items: [item('m1')] }))
    s.notify(baseEntry({ group: 'mission-cue', items: [item('m1'), item('m2')] }))
    await nextTick() // persistedRef flushes through a watcher

    setActivePinia(createPinia())
    const reloaded = useNotificationsStore()

    expect(reloaded.list).toHaveLength(1)
    expect(reloaded.list[0].group).toBe('mission-cue')
    expect(reloaded.list[0].items?.map((i) => i.id)).toEqual(['m1', 'm2'])
  })
})

describe('updateGroup() / removeGroup() — quiet sync helpers (BUG-173 S2 delta, spec §3.3)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  it('updateGroup rewrites the grouped record in place and keeps its id and ts', () => {
    const s = useNotificationsStore()
    const ts = Date.now() - 60_000
    const rec = s.notify(
      baseEntry({
        ts,
        kind: 'warning',
        title: '3 missions need you',
        group: 'mission-cue',
        items: [
          { id: 'm1', title: 'A' },
          { id: 'm2', title: 'B' },
          { id: 'm3', title: 'C' }
        ]
      })
    )

    const updated = s.updateGroup('mission-cue', {
      title: '1 mission needs you',
      items: [{ id: 'm1', title: 'A' }]
    })

    expect(updated).not.toBeNull()
    expect(updated!.id).toBe(rec.id)
    expect(updated!.ts).toBe(ts)
    expect(s.list).toHaveLength(1)
    expect(s.list[0]).toMatchObject({
      id: rec.id,
      ts,
      title: '1 mission needs you',
      kind: 'warning',
      group: 'mission-cue'
    })
    expect(s.list[0].items).toEqual([{ id: 'm1', title: 'A' }])
  })

  it('updateGroup leaves fields the patch does not name untouched', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ group: 'g', title: 't', description: 'd', sessionId: 'sess-1' }))

    s.updateGroup('g', { title: 'new' })

    expect(s.list[0]).toMatchObject({ title: 'new', description: 'd', sessionId: 'sess-1' })
  })

  it('updateGroup on an absent group returns null and leaves the list unchanged', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ title: 'plain' }))
    s.notify(baseEntry({ group: 'other', title: 'other' }))
    const before = JSON.stringify(s.records)

    expect(s.updateGroup('mission-cue', { title: 'x' })).toBeNull()

    expect(JSON.stringify(s.records)).toBe(before)
  })

  it('updateGroup never resurrects a dismissed grouped entry', () => {
    const s = useNotificationsStore()
    const rec = s.notify(baseEntry({ group: 'mission-cue', title: 'a' }))
    s.dismiss(rec.id)

    expect(s.updateGroup('mission-cue', { title: 'b' })).toBeNull()

    expect(s.list).toHaveLength(0)
  })

  it('removeGroup removes only the record holding that group and reports it', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ title: 'plain' }))
    s.notify(baseEntry({ group: 'other', title: 'other' }))
    s.notify(baseEntry({ group: 'mission-cue', title: 'mc' }))

    expect(s.removeGroup('mission-cue')).toBe(true)

    expect(s.list.map((r) => r.title).sort()).toEqual(['other', 'plain'])
  })

  it('removeGroup on an absent group returns false and changes nothing', () => {
    const s = useNotificationsStore()
    s.notify(baseEntry({ title: 'plain' }))

    expect(s.removeGroup('mission-cue')).toBe(false)

    expect(s.list).toHaveLength(1)
  })
})

describe('legacy persisted records (BUG-173 S2, spec §3.4 back-compat / I-7)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
  })

  it('records written before group/items load unchanged and keep appending', () => {
    const ts = Date.now()
    localStorage.setItem(
      'om2tab.notifications',
      JSON.stringify([
        {
          id: 'legacy-1',
          ts,
          source: 'app',
          kind: 'warning',
          title: '3 missions need you',
          description: 'A · B · C'
        },
        { id: 'legacy-2', ts: ts - 1, source: 'session', kind: 'info', title: 's', sessionId: 'x' }
      ])
    )
    setActivePinia(createPinia())
    const s = useNotificationsStore()

    expect(s.list.map((r) => r.id)).toEqual(['legacy-1', 'legacy-2'])
    expect(s.list[0].group).toBeUndefined()
    expect(s.list[0].items).toBeUndefined()
    expect(s.list[0].description).toBe('A · B · C')

    // A grouped notify next to legacy rows never matches them (they have no group).
    s.notify(baseEntry({ group: 'mission-cue', title: 'new' }))
    s.notify(baseEntry({ title: 'plain' }))
    expect(s.list).toHaveLength(4)
    expect(s.list.map((r) => r.id)).toEqual(expect.arrayContaining(['legacy-1', 'legacy-2']))
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
