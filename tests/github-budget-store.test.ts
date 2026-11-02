// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { BudgetPrefs, BudgetSnapshot } from '../src/main/github-budget-core'

const dispatch = vi.hoisted(() => vi.fn(() => true))
vi.mock('../src/renderer/src/stores/notify-dispatch', () => ({ dispatchNotification: dispatch }))

import { useGithubBudgetStore } from '../src/renderer/src/stores/github-budget'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { exhausted, healthy, low, prefs, unavailable } from './helpers/github-budget-snapshot'

let push: (s: BudgetSnapshot) => void = () => {}
const setPrefs = vi.fn(async (p: BudgetPrefs) => p)

function stubApi(initial: BudgetSnapshot): void {
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: {
        githubBudgetSnapshot: vi.fn(async () => initial),
        githubBudgetPrefs: vi.fn(async () => prefs()),
        githubBudgetSetPrefs: setPrefs,
        onGithubBudgetChanged: vi.fn((cb: (s: BudgetSnapshot) => void) => {
          push = cb
          return () => {}
        })
      }
    })
  )
}

beforeEach(() => {
  dispatch.mockClear()
  setPrefs.mockClear()
  setActivePinia(createPinia())
})

describe('github budget store', () => {
  it('reads the snapshot at init and follows the pushes', async () => {
    stubApi(healthy())
    const store = useGithubBudgetStore()
    expect(store.ready).toBeNull()

    await store.init()
    expect(store.ready?.tighter).toBe('rest')
    expect(store.state).toBe('normal')

    push(low())
    expect(store.state).toBe('low')
  })

  it('keeps the pill hidden while the budget is unavailable', async () => {
    stubApi(unavailable())
    const store = useGithubBudgetStore()
    await store.init()
    expect(store.ready).toBeNull()
  })

  it('is idempotent: a second init does not subscribe twice', async () => {
    stubApi(healthy())
    const store = useGithubBudgetStore()
    await store.init()
    await store.init()
    expect(window.api.onGithubBudgetChanged).toHaveBeenCalledTimes(1)
  })

  it('toasts once entering low, with an action that opens Settings → GitHub API', async () => {
    stubApi(healthy())
    const store = useGithubBudgetStore()
    await store.init()
    expect(dispatch).not.toHaveBeenCalled() // the first read only seeds

    push(low())
    expect(dispatch).toHaveBeenCalledTimes(1)
    const opts = (dispatch.mock.calls[0] as unknown[])[0] as {
      channel: string
      toastKind: string
      toastAction: { handler: () => void }
    }
    expect(opts.channel).toBe('toast')
    expect(opts.toastKind).toBe('warning')

    opts.toastAction.handler()
    expect(useUiStore().settingsTab).toBe('githubApi')

    // The same window again (a later poll, or a flap through normal): no second toast.
    push(low())
    push(healthy())
    push(low())
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('sends an OS notification at exhausted', async () => {
    stubApi(low())
    const store = useGithubBudgetStore()
    await store.init()
    push(exhausted())
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect((dispatch.mock.calls[0] as unknown[])[0]).toMatchObject({
      channel: 'os',
      notificationType: 'exhausted'
    })
    expect(store.state).toBe('exhausted')
  })

  it('is silent when "Tell me when it happens" is off', async () => {
    stubApi(healthy({ notify: false }))
    const store = useGithubBudgetStore()
    await store.init()
    push(low({ notify: false }))
    push(exhausted({ notify: false }))
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('writes prefs whole-object through the IPC and keeps what main echoes back', async () => {
    stubApi(healthy())
    const store = useGithubBudgetStore()
    await store.init()
    await store.savePrefs({ threshold: 25 })
    expect(setPrefs).toHaveBeenCalledWith(prefs({ threshold: 25 }))
    expect(store.prefs?.threshold).toBe(25)
  })

  it('reverts an optimistic write when the IPC rejects it', async () => {
    stubApi(healthy())
    const store = useGithubBudgetStore()
    await store.init()
    setPrefs.mockRejectedValueOnce(new Error('disk'))
    await store.savePrefs({ checkDelivered: true })
    expect(store.prefs?.checkDelivered).toBe(false)
  })
})
