import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useNotificationsStore,
  NOTICE_COALESCE_WINDOW_MS,
  type NewNotification
} from '../src/renderer/src/stores/notifications'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { dispatchNotification } from '../src/renderer/src/stores/notify-dispatch'
import { noticeUnitFor } from '../src/renderer/src/lib/notice-unit'

/**
 * Chapter 1b — notice coalescing per unit (T599). Duplicate idle / task-finished
 * notices for the SAME unit (one mission step, or one card) inside a window
 * collapse into ONE Activity row that counts the repeats.
 */

function makeLocalStorage(): Storage {
  const store = new Map<string, string>()
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

const MIN = 60_000

function notice(over: Partial<NewNotification> = {}): NewNotification {
  return {
    ts: Date.now(),
    source: 'app',
    kind: 'success',
    title: 'Session completed',
    description: 'proj · builder',
    sessionId: 's1',
    notificationType: 'completed',
    unit: 'step:mnt-1/stp-3',
    ...over
  }
}

describe('notification coalescing per unit', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
  })

  it('AC-1: two idle notices for the same unit within 10 minutes make one row', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    const first = s.notify(notice({ ts: now - 6 * MIN }))
    const second = s.notify(notice({ ts: now }))

    expect(s.list).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(s.list[0].count).toBe(2)
    expect(s.list[0].ts).toBe(now)
  })

  it('AC-1: a third repeat keeps counting on the same row', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    s.notify(notice({ ts: now - 8 * MIN }))
    s.notify(notice({ ts: now - 4 * MIN }))
    s.notify(notice({ ts: now }))

    expect(s.list).toHaveLength(1)
    expect(s.list[0].count).toBe(3)
  })

  it('AC-1: the window slides — each repeat is measured from the latest one', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    s.notify(notice({ ts: now - 16 * MIN }))
    s.notify(notice({ ts: now - 9 * MIN }))
    s.notify(notice({ ts: now - 2 * MIN }))

    expect(s.list).toHaveLength(1)
    expect(s.list[0].count).toBe(3)
  })

  it('AC-1: the same unit outside the window starts a fresh row', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    s.notify(notice({ ts: now - NOTICE_COALESCE_WINDOW_MS - MIN }))
    s.notify(notice({ ts: now }))

    expect(s.list).toHaveLength(2)
    expect(s.list.every((r) => (r.count ?? 1) === 1)).toBe(true)
  })

  it('AC-2: a notice for a different unit in the same window is never collapsed', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    s.notify(notice({ ts: now - MIN, unit: 'step:mnt-1/stp-3' }))
    s.notify(notice({ ts: now, unit: 'step:mnt-1/stp-4' }))
    s.notify(notice({ ts: now, unit: 'card:T599' }))

    expect(s.list).toHaveLength(3)
  })

  it('AC-2: a different notice kind for the same unit is never collapsed', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    s.notify(notice({ ts: now - MIN, notificationType: 'completed' }))
    s.notify(notice({ ts: now, notificationType: 'needs-input', kind: 'warning' }))

    expect(s.list).toHaveLength(2)
  })

  it('AC-2: notices with no unit are never collapsed', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    s.notify(notice({ ts: now - MIN, unit: undefined }))
    s.notify(notice({ ts: now, unit: undefined }))

    expect(s.list).toHaveLength(2)
  })

  it('a dismissed collapsed row is gone — the next notice starts fresh', () => {
    const s = useNotificationsStore()
    const now = Date.now()
    const first = s.notify(notice({ ts: now - 2 * MIN }))
    s.notify(notice({ ts: now - MIN }))
    s.dismiss(first.id)
    s.notify(notice({ ts: now }))

    expect(s.list).toHaveLength(1)
    expect(s.list[0].count ?? 1).toBe(1)
  })
})

describe('dispatchNotification carries the unit into the Activity history', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
    setActivePinia(createPinia())
    ;(globalThis as unknown as { window: unknown }).window = { api: { notify: vi.fn() } }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('two toast-channel completions for one unit leave one counted row', () => {
    useUiStore()
    const base = {
      title: 'Session completed',
      body: 'proj · builder',
      channel: 'toast' as const,
      sound: false,
      sessionId: 's1',
      toastKind: 'success' as const,
      unit: 'step:mnt-1/stp-3',
      notificationType: 'completed'
    }
    dispatchNotification(base)
    dispatchNotification(base)

    const rows = useNotificationsStore().list
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(2)
  })
})

describe('noticeUnitFor', () => {
  const views = [
    {
      mission: {
        id: 'mnt-1',
        steps: [
          { id: 'stp-1', links: [{ kind: 'session', ref: 'other' }] },
          {
            id: 'stp-3',
            links: [
              { kind: 'card', ref: 'T599' },
              { kind: 'session', ref: 's1' }
            ]
          }
        ]
      }
    }
  ]
  const cards = [{ slug: 'T600', session: 's2' }]

  it('resolves a session linked to a mission step to that step', () => {
    expect(noticeUnitFor('s1', { views, cards })).toBe('step:mnt-1/stp-3')
  })

  it('falls back to the card the session is bound to', () => {
    expect(noticeUnitFor('s2', { views, cards })).toBe('card:T600')
  })

  it('prefers the mission step when both match', () => {
    expect(noticeUnitFor('s1', { views, cards: [{ slug: 'T599', session: 's1' }] })).toBe(
      'step:mnt-1/stp-3'
    )
  })

  it('returns undefined for a session that belongs to no unit', () => {
    expect(noticeUnitFor('nobody', { views, cards })).toBeUndefined()
  })
})
