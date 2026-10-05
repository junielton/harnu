import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'
import { useUiStore } from '../src/renderer/src/stores/ui'

/**
 * Store-level wiring for the usage-reset notification (usage-reset-notify
 * spec). `checkUsageResetNotification` is called directly here — the same
 * lightweight pattern `session-notify-store.test.ts` uses for
 * `applyTaskState` — so this test doesn't need to mock the large `init()`
 * subscription surface.
 *
 * Because the detection is supersession-based (see usage-reset-notify.ts),
 * triggering a notification takes TWO calls: one to establish an
 * already-expired baseline, one with a distinct value to supersede it.
 */
describe('checkUsageResetNotification', () => {
  let notify: ReturnType<typeof vi.fn>
  const FIVE_HOURS_MS = 5 * 3600_000

  beforeEach(() => {
    setActivePinia(createPinia())
    notify = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = { api: { notify } }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('does nothing on the first observation (no baseline to compare against)', () => {
    const store = useSessionsStore()
    store.windowFocused = false
    store.setNotifyPref('usageReset', true)
    store.checkUsageResetNotification(Date.now() - 1000)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does nothing when resetsAtMs is null throughout', () => {
    const store = useSessionsStore()
    store.checkUsageResetNotification(null)
    store.checkUsageResetNotification(null)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does nothing when the pref is off (the default), even across a real rollover', () => {
    const store = useSessionsStore()
    expect(store.notifyPrefs.usageReset).toBe(false)
    store.windowFocused = false
    store.checkUsageResetNotification(Date.now() - 1000)
    store.checkUsageResetNotification(Date.now() + FIVE_HOURS_MS)
    expect(notify).not.toHaveBeenCalled()
  })

  it('fires a native OS notification when unfocused and a fresh window supersedes an expired one', () => {
    const store = useSessionsStore()
    store.windowFocused = false
    store.setNotifyPref('usageReset', true)

    store.checkUsageResetNotification(Date.now() - 1000)
    store.checkUsageResetNotification(Date.now() + FIVE_HOURS_MS)

    expect(notify).toHaveBeenCalledTimes(1)
    const arg = notify.mock.calls[0][0]
    expect(arg.sessionId).toBe('')
    expect(typeof arg.title).toBe('string')
    expect(arg.title.length).toBeGreaterThan(0)
  })

  it('fires an in-app toast when focused and a fresh window supersedes an expired one', () => {
    const store = useSessionsStore()
    const ui = useUiStore()
    store.windowFocused = true
    store.setNotifyPref('usageReset', true)

    store.checkUsageResetNotification(Date.now() - 1000)
    store.checkUsageResetNotification(Date.now() + FIVE_HOURS_MS)

    expect(notify).not.toHaveBeenCalled()
    expect(ui.toasts).toHaveLength(1)
  })

  it('does not fire when the value repeats (no supersession)', () => {
    const store = useSessionsStore()
    store.windowFocused = false
    store.setNotifyPref('usageReset', true)
    const t = Date.now() - 1000

    store.checkUsageResetNotification(t)
    store.checkUsageResetNotification(t)
    store.checkUsageResetNotification(t)

    expect(notify).not.toHaveBeenCalled()
  })

  it('does not re-notify for the same superseded window observed again after a fresh window', () => {
    const store = useSessionsStore()
    store.windowFocused = false
    store.setNotifyPref('usageReset', true)
    const expired = Date.now() - 1000
    const fresh = Date.now() + FIVE_HOURS_MS

    store.checkUsageResetNotification(expired) // baseline
    store.checkUsageResetNotification(fresh) // fires once; lastNotified = expired
    store.checkUsageResetNotification(expired) // reverts baseline (fresh hadn't expired, guarded)
    store.checkUsageResetNotification(fresh) // re-supersedes expired, but already notified -> deduped

    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the superseded window expired too long ago (stale)', () => {
    const store = useSessionsStore()
    store.windowFocused = false
    store.setNotifyPref('usageReset', true)

    store.checkUsageResetNotification(Date.now() - 30 * 60 * 1000)
    store.checkUsageResetNotification(Date.now() + FIVE_HOURS_MS)

    expect(notify).not.toHaveBeenCalled()
  })

  it('a throwing window.api.notify never escapes the call', () => {
    notify.mockImplementation(() => {
      throw new Error('ipc bridge gone')
    })
    const store = useSessionsStore()
    store.windowFocused = false
    store.setNotifyPref('usageReset', true)

    store.checkUsageResetNotification(Date.now() - 1000)
    expect(() => store.checkUsageResetNotification(Date.now() + FIVE_HOURS_MS)).not.toThrow()
  })
})
