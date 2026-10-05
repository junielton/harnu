import { defineStore } from 'pinia'
import { ref } from 'vue'
import { i18n } from '../i18n'
import { useUiStore } from './ui'
import type { SettingsData } from '../../../preload'

/**
 * Terminal-font-size settings store (terminal-font-settings spec §6).
 *
 * Single source of truth for the terminal font size. Unlike the pure
 * localStorage `theme` store, the *value* lives in a real `settings.json` on
 * disk (read-modify-write via IPC); only the *location pointer* lives in
 * localStorage (`om2tab.settingsPath`) — the file can be relocated, so the
 * pointer must live somewhere other than the file itself.
 */

export const DEFAULT_TERMINAL_FONT_SIZE = 13
export const MIN_TERMINAL_FONT_SIZE = 8
export const MAX_TERMINAL_FONT_SIZE = 32

// UI zoom (T54) — a whole-frame scale factor applied via
// `webFrame.setZoomFactor`, scaling typography *and* icons together. `MIN`/`MAX`
// are the clamp bounds (defense-in-depth + what a hand-edited settings.json may
// hold); `UI_ZOOM_STEPS` are the discrete stops the Settings stepper walks
// (80–150%), deliberately narrower than the clamp so the UI can't reach a
// layout-breaking extreme while an external edit still resolves to a sane value.
export const DEFAULT_UI_ZOOM = 1
export const MIN_UI_ZOOM = 0.5
export const MAX_UI_ZOOM = 2
export const UI_ZOOM_STEPS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.5] as const

const PATH_KEY = 'om2tab.settingsPath'
const SAVE_DEBOUNCE_MS = 150

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_FONT_SIZE
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(n)))
}

/** Clamp the UI zoom into bounds and snap to 2 decimals (mirrors main-side). */
function clampZoom(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_UI_ZOOM
  const clamped = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, n))
  return Math.round(clamped * 100) / 100
}

export const useSettingsStore = defineStore('settings', () => {
  const terminalFontSize = ref<number>(DEFAULT_TERMINAL_FONT_SIZE)
  const uiZoom = ref<number>(DEFAULT_UI_ZOOM)
  const path = ref<string>('')

  let saveTimer: ReturnType<typeof setTimeout> | null = null
  // Separate debounce for the zoom save so a rapid font-then-zoom (or vice
  // versa) never cancels the other's pending write. Both persist through the
  // main-side read-modify-write merge, so independent patches are safe.
  let zoomSaveTimer: ReturnType<typeof setTimeout> | null = null

  // Guard against a double `init()` (e.g. an HMR re-run) so we never stack two
  // `onSettingsChanged` subscriptions. The unsubscribe is retained rather than
  // discarded; the store is an app-lifetime singleton, but keeping the handle
  // documents intent and leaves the door open for an explicit dispose later.
  let started = false
  let unsubscribe: (() => void) | null = null

  /**
   * Resolve the active settings path (localStorage pointer or OS default),
   * load+watch the file, adopt its font size, and subscribe to external edits.
   * Fire-and-forget from `main.ts`; terminals are created lazily on the first
   * session selection, well after this resolves.
   */
  async function init(): Promise<void> {
    if (started) return
    started = true
    const stored = localStorage.getItem(PATH_KEY)
    const p = stored ?? (await window.api.settingsDefaultPath())
    const { path: resolved, data } = await window.api.settingsLoad(p)
    path.value = resolved
    localStorage.setItem(PATH_KEY, resolved)
    terminalFontSize.value = clamp(data.terminalFontSize)
    // Adopt + apply the persisted UI zoom on boot so the frame comes up scaled.
    uiZoom.value = clampZoom(data.uiZoom)
    window.api.uiZoomApply(uiZoom.value)

    unsubscribe = window.api.onSettingsChanged(({ data: incoming, error }) => {
      if (error) {
        // Invalid JSON from an external edit — keep last-good, warn the user.
        useUiStore().pushToast({
          kind: 'danger',
          title: i18n.global.t('settings.invalidJson.title'),
          description: i18n.global.t('settings.invalidJson.description')
        })
        return
      }
      if (!incoming) return
      // Echo suppression: our own saves produce a value equal to the in-memory
      // one, so they're ignored here. Only a genuinely different value (an
      // external edit) re-applies.
      const next = clamp(incoming.terminalFontSize)
      if (next !== terminalFontSize.value) terminalFontSize.value = next
      const nextZoom = clampZoom(incoming.uiZoom)
      if (nextZoom !== uiZoom.value) {
        uiZoom.value = nextZoom
        window.api.uiZoomApply(nextZoom)
      }
    })
  }

  /** Set the font size (clamped) and debounced-persist to disk. */
  function setFontSize(n: number): void {
    terminalFontSize.value = clamp(n)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (!path.value) return
      void window.api.settingsSave(path.value, { terminalFontSize: terminalFontSize.value })
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * Set the UI zoom (clamped/snapped), apply it to the live frame immediately,
   * and debounced-persist to disk. Live terminals re-fit on their own: the zoom
   * reflows the layout, shrinking/growing each xterm host in CSS px, which fires
   * its `ResizeObserver` → re-measure → grid resize (no manual re-fit needed).
   */
  function setUiZoom(n: number): void {
    uiZoom.value = clampZoom(n)
    window.api.uiZoomApply(uiZoom.value)
    if (zoomSaveTimer) clearTimeout(zoomSaveTimer)
    zoomSaveTimer = setTimeout(() => {
      zoomSaveTimer = null
      if (!path.value) return
      void window.api.settingsSave(path.value, { uiZoom: uiZoom.value })
    }, SAVE_DEBOUNCE_MS)
  }

  /** Relocate settings.json via the native folder picker. */
  async function changeLocation(): Promise<void> {
    const data: SettingsData = { terminalFontSize: terminalFontSize.value, uiZoom: uiZoom.value }
    const res = await window.api.settingsChangeLocation(data)
    if (!res) return
    path.value = res.path
    localStorage.setItem(PATH_KEY, res.path)
    // Re-establish the watch on the new location.
    await window.api.settingsLoad(res.path)
  }

  function reveal(): void {
    if (path.value) void window.api.settingsReveal(path.value)
  }

  function openInEditor(): void {
    if (path.value) void window.api.settingsOpenExternal(path.value)
  }

  /**
   * Tear down the external-edit subscription and any pending debounced save.
   * Not needed during normal app life (the store is a singleton), but lets a
   * test or an HMR teardown re-run `init()` cleanly.
   */
  function dispose(): void {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    if (zoomSaveTimer) {
      clearTimeout(zoomSaveTimer)
      zoomSaveTimer = null
    }
    unsubscribe?.()
    unsubscribe = null
    started = false
  }

  return {
    terminalFontSize,
    uiZoom,
    path,
    init,
    setFontSize,
    setUiZoom,
    changeLocation,
    reveal,
    openInEditor,
    dispose
  }
})
