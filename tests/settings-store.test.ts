import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  useSettingsStore,
  DEFAULT_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  DEFAULT_UI_ZOOM,
  MIN_UI_ZOOM,
  MAX_UI_ZOOM
} from '../src/renderer/src/stores/settings'

/**
 * Settings store unit tests (terminal-font-settings spec §11). Runs in the
 * default `node` vitest environment, so `window`/`localStorage` are stubbed
 * with `vi.stubGlobal`. The store talks to the main process only through
 * `window.api`, which we replace with spies.
 */

type ChangedCb = (p: {
  data?: { terminalFontSize: number; uiZoom?: number }
  error?: boolean
}) => void

let changedCb: ChangedCb | null = null
let savedCalls: Array<{ path: string; data: { terminalFontSize?: number; uiZoom?: number } }> = []
let zoomApplyCalls: number[] = []

function makeApi(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settingsDefaultPath: vi.fn(async () => '/default/settings.json'),
    settingsLoad: vi.fn(async (path: string) => ({
      path,
      data: { terminalFontSize: 13, uiZoom: 1 }
    })),
    settingsSave: vi.fn(
      async (path: string, data: { terminalFontSize?: number; uiZoom?: number }) => {
        savedCalls.push({ path, data })
      }
    ),
    uiZoomApply: vi.fn((factor: number) => {
      zoomApplyCalls.push(factor)
    }),
    settingsChangeLocation: vi.fn(async () => null),
    settingsReveal: vi.fn(),
    settingsOpenExternal: vi.fn(),
    onSettingsChanged: vi.fn((cb: ChangedCb) => {
      changedCb = cb
      return () => {}
    }),
    ...overrides
  }
}

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

describe('useSettingsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    changedCb = null
    savedCalls = []
    zoomApplyCalls = []
    vi.stubGlobal('localStorage', makeLocalStorage())
    vi.stubGlobal('window', { api: makeApi() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('exposes the documented constants', () => {
    expect(DEFAULT_TERMINAL_FONT_SIZE).toBe(13)
    expect(MIN_TERMINAL_FONT_SIZE).toBe(8)
    expect(MAX_TERMINAL_FONT_SIZE).toBe(32)
    expect(DEFAULT_UI_ZOOM).toBe(1)
    expect(MIN_UI_ZOOM).toBe(0.5)
    expect(MAX_UI_ZOOM).toBe(2)
  })

  it('clamps below MIN and above MAX', () => {
    vi.useFakeTimers()
    const store = useSettingsStore()
    store.setFontSize(2)
    expect(store.terminalFontSize).toBe(MIN_TERMINAL_FONT_SIZE)
    store.setFontSize(99)
    expect(store.terminalFontSize).toBe(MAX_TERMINAL_FONT_SIZE)
  })

  it('setFontSize debounce-saves to the active path', async () => {
    vi.useFakeTimers()
    const store = useSettingsStore()
    await store.init()
    store.setFontSize(18)
    expect(savedCalls).toHaveLength(0) // debounced, not yet flushed
    vi.advanceTimersByTime(200)
    expect(savedCalls).toEqual([{ path: '/default/settings.json', data: { terminalFontSize: 18 } }])
  })

  it('init reads the localStorage path pointer when present', async () => {
    vi.stubGlobal(
      'localStorage',
      makeLocalStorage({ 'om2tab.settingsPath': '/custom/settings.json' })
    )
    const api = makeApi({
      settingsLoad: vi.fn(async (path: string) => ({ path, data: { terminalFontSize: 20 } }))
    })
    vi.stubGlobal('window', { api })
    const store = useSettingsStore()
    await store.init()
    expect(api.settingsLoad).toHaveBeenCalledWith('/custom/settings.json')
    expect(store.path).toBe('/custom/settings.json')
    expect(store.terminalFontSize).toBe(20)
  })

  it('init falls back to the OS default path when no pointer is stored', async () => {
    const store = useSettingsStore()
    await store.init()
    expect(window.api.settingsDefaultPath).toHaveBeenCalled()
    expect(store.path).toBe('/default/settings.json')
    expect(localStorage.getItem('om2tab.settingsPath')).toBe('/default/settings.json')
  })

  it('echo suppression: an external change with the same value is a no-op, a different value updates', async () => {
    const store = useSettingsStore()
    await store.init()
    expect(store.terminalFontSize).toBe(13)
    expect(changedCb).toBeTypeOf('function')

    // Same value — no-op (this is the write→watch echo of our own save).
    changedCb!({ data: { terminalFontSize: 13 } })
    expect(store.terminalFontSize).toBe(13)

    // Different value (a genuine external edit) — applied + clamped.
    changedCb!({ data: { terminalFontSize: 22 } })
    expect(store.terminalFontSize).toBe(22)

    changedCb!({ data: { terminalFontSize: 999 } })
    expect(store.terminalFontSize).toBe(MAX_TERMINAL_FONT_SIZE)
  })

  it('changeLocation persists the new pointer and re-establishes the watch', async () => {
    const api = makeApi({
      settingsChangeLocation: vi.fn(async () => ({ path: '/moved/settings.json' }))
    })
    vi.stubGlobal('window', { api })
    const store = useSettingsStore()
    await store.init()
    const loadCallsBefore = (api.settingsLoad as ReturnType<typeof vi.fn>).mock.calls.length
    await store.changeLocation()
    expect(store.path).toBe('/moved/settings.json')
    expect(localStorage.getItem('om2tab.settingsPath')).toBe('/moved/settings.json')
    // settingsLoad called again on the new path to re-establish the watch.
    expect((api.settingsLoad as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      loadCallsBefore + 1
    )
    expect(api.settingsLoad).toHaveBeenLastCalledWith('/moved/settings.json')
  })

  it('reveal / openInEditor forward the active path', async () => {
    const store = useSettingsStore()
    await store.init()
    store.reveal()
    store.openInEditor()
    expect(window.api.settingsReveal).toHaveBeenCalledWith('/default/settings.json')
    expect(window.api.settingsOpenExternal).toHaveBeenCalledWith('/default/settings.json')
  })

  // --- UI zoom (T54) --------------------------------------------------------

  it('init adopts + applies the loaded uiZoom to the frame', async () => {
    const api = makeApi({
      settingsLoad: vi.fn(async (path: string) => ({
        path,
        data: { terminalFontSize: 13, uiZoom: 1.25 }
      }))
    })
    vi.stubGlobal('window', { api })
    const store = useSettingsStore()
    await store.init()
    expect(store.uiZoom).toBe(1.25)
    expect(zoomApplyCalls).toContain(1.25)
  })

  it('init defaults uiZoom to 1 when the file predates the setting', async () => {
    const api = makeApi({
      settingsLoad: vi.fn(async (path: string) => ({
        path,
        data: { terminalFontSize: 13 } // no uiZoom on disk
      }))
    })
    vi.stubGlobal('window', { api })
    const store = useSettingsStore()
    await store.init()
    expect(store.uiZoom).toBe(DEFAULT_UI_ZOOM)
    expect(zoomApplyCalls).toContain(DEFAULT_UI_ZOOM)
  })

  it('setUiZoom clamps, applies to the frame, and debounce-persists { uiZoom }', async () => {
    vi.useFakeTimers()
    const store = useSettingsStore()
    await store.init()
    zoomApplyCalls = []

    store.setUiZoom(5) // above MAX → clamps to 2
    expect(store.uiZoom).toBe(MAX_UI_ZOOM)
    expect(zoomApplyCalls).toEqual([MAX_UI_ZOOM]) // applied immediately, not debounced
    expect(savedCalls).toHaveLength(0) // save is debounced

    vi.advanceTimersByTime(200)
    expect(savedCalls).toEqual([{ path: '/default/settings.json', data: { uiZoom: MAX_UI_ZOOM } }])

    store.setUiZoom(0.1) // below MIN → clamps to 0.5
    expect(store.uiZoom).toBe(MIN_UI_ZOOM)
  })

  it('setUiZoom persists independently of setFontSize (no cross-cancel)', async () => {
    vi.useFakeTimers()
    const store = useSettingsStore()
    await store.init()
    store.setFontSize(18)
    store.setUiZoom(1.1) // must not cancel the pending font save
    vi.advanceTimersByTime(200)
    expect(savedCalls).toContainEqual({
      path: '/default/settings.json',
      data: { terminalFontSize: 18 }
    })
    expect(savedCalls).toContainEqual({ path: '/default/settings.json', data: { uiZoom: 1.1 } })
  })

  it('external uiZoom edit re-applies to the frame; echo of same value is a no-op', async () => {
    const store = useSettingsStore()
    await store.init()
    expect(store.uiZoom).toBe(1)
    zoomApplyCalls = []

    // Echo of our own value — no re-apply.
    changedCb!({ data: { terminalFontSize: 13, uiZoom: 1 } })
    expect(zoomApplyCalls).toEqual([])

    // A genuine external edit — adopted + re-applied.
    changedCb!({ data: { terminalFontSize: 13, uiZoom: 1.5 } })
    expect(store.uiZoom).toBe(1.5)
    expect(zoomApplyCalls).toEqual([1.5])
  })
})
