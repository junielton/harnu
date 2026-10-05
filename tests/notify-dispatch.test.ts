import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { dispatchNotification } from '../src/renderer/src/stores/notify-dispatch'

describe('dispatchNotification', () => {
  let notify: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    notify = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = { api: { notify } }
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('routes an "os" channel to window.api.notify with the given sessionId', () => {
    const result = dispatchNotification({
      title: 'T',
      body: 'B',
      channel: 'os',
      sound: false,
      sessionId: 's1',
      toastKind: 'info'
    })
    expect(notify).toHaveBeenCalledWith({ title: 'T', body: 'B', sessionId: 's1' })
    expect(result).toBe(true)
  })

  it('routes a "toast" channel to the ui store, never window.api.notify', () => {
    const result = dispatchNotification({
      title: 'T',
      body: 'B',
      channel: 'toast',
      sound: false,
      sessionId: 's1',
      toastKind: 'success'
    })
    expect(notify).not.toHaveBeenCalled()
    const ui = useUiStore()
    expect(ui.toasts).toHaveLength(1)
    expect(ui.toasts[0]).toMatchObject({ title: 'T', description: 'B', kind: 'success' })
    expect(result).toBe(true)
  })

  it('threads sessionId through to the toast (BUG-49 regression)', () => {
    dispatchNotification({
      title: 'T',
      body: 'B',
      channel: 'toast',
      sound: false,
      sessionId: 's1',
      toastKind: 'success'
    })
    const ui = useUiStore()
    expect(ui.toasts[0].sessionId).toBe('s1')
  })

  it('passes toastAction through to the toast', () => {
    const handler = vi.fn()
    dispatchNotification({
      title: 'T',
      body: 'B',
      channel: 'toast',
      sound: false,
      sessionId: '',
      toastKind: 'info',
      toastAction: { label: 'open', handler }
    })
    const ui = useUiStore()
    expect(ui.toasts[0].action?.label).toBe('open')
  })

  it('a throwing window.api.notify never escapes the call, and reports false', () => {
    notify.mockImplementation(() => {
      throw new Error('ipc bridge gone')
    })
    let result: boolean | undefined
    expect(() => {
      result = dispatchNotification({
        title: 'T',
        body: 'B',
        channel: 'os',
        sound: false,
        sessionId: 's1',
        toastKind: 'info'
      })
    }).not.toThrow()
    expect(result).toBe(false)
  })
})
