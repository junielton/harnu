import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { persistedRef } from './persisted'
import { buildExtensionThemesCss, toExtensionThemeMeta } from '../lib/extension-themes'
import type { ExtensionThemeWire } from '../../../preload'

const STORAGE_KEY = 'om2tab.theme'
/** `<style>` tag id the runtime-injected extension theme CSS lives under (T137). */
const EXTENSION_STYLE_ID = 'harnu-extension-themes'

export const THEMES = [
  'default-dark',
  'light',
  'tokyo-night',
  'dracula',
  'catppuccin-mocha',
  'catppuccin-latte',
  'one-dark',
  'github-dark',
  'github-light',
  'gruvbox-dark',
  'gruvbox-light',
  'nord',
  'monospace'
] as const
export type Theme = (typeof THEMES)[number]

/**
 * Picker metadata (SettingsDialog → Appearance). `swatch` mirrors the four most
 * representative tokens from each theme's token set so the picker can render a
 * mini-preview of every theme simultaneously — `data-theme` only applies the
 * active theme's vars, so an inactive theme's swatch can't be read from CSS at
 * render time. A builtin entry carries `labelKey` (i18n); an extension entry
 * (T137) carries a plain `label` string instead — extension content
 * self-localizes (ADR-0002 study §2), it never gets an i18n key. `origin`
 * drives the picker's provenance badge. Keep builtin entries in sync with
 * `themes.css` and the i18n `theme.*` labels.
 */
export interface ThemeMeta {
  id: string
  labelKey?: string
  label?: string
  dark: boolean
  origin: 'builtin' | 'extension'
  /** Which extension installed this theme + its own label, for the origin badge. Builtins leave both unset. */
  extensionId?: string
  extensionLabel?: string
  swatch: { bg: string; surface: string; text: string; accent: string }
}

const BUILTIN_THEME_META: readonly ThemeMeta[] = [
  {
    id: 'default-dark',
    labelKey: 'theme.defaultDark',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#17120e', surface: '#251f1b', text: '#faf8f6', accent: '#8090b4' }
  },
  {
    id: 'tokyo-night',
    labelKey: 'theme.tokyoNight',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#1a1b26', surface: '#1f2335', text: '#c0caf5', accent: '#7aa2f7' }
  },
  {
    id: 'dracula',
    labelKey: 'theme.dracula',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#282a36', surface: '#343746', text: '#f8f8f2', accent: '#ff79c6' }
  },
  {
    id: 'catppuccin-mocha',
    labelKey: 'theme.catppuccinMocha',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#1e1e2e', surface: '#313244', text: '#cdd6f4', accent: '#fab387' }
  },
  {
    id: 'one-dark',
    labelKey: 'theme.oneDark',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#282c34', surface: '#2c313a', text: '#abb2bf', accent: '#d19a66' }
  },
  {
    id: 'github-dark',
    labelKey: 'theme.githubDark',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#0d1117', surface: '#161b22', text: '#e6edf3', accent: '#58a6ff' }
  },
  {
    id: 'gruvbox-dark',
    labelKey: 'theme.gruvboxDark',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#282828', surface: '#32302f', text: '#ebdbb2', accent: '#fe8019' }
  },
  {
    id: 'nord',
    labelKey: 'theme.nord',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#2e3440', surface: '#3b4252', text: '#eceff4', accent: '#88c0d0' }
  },
  {
    id: 'monospace',
    labelKey: 'theme.monospace',
    dark: true,
    origin: 'builtin',
    swatch: { bg: '#0c0c0c', surface: '#1a1a1a', text: '#e8e8e8', accent: '#cfcfcf' }
  },
  {
    id: 'light',
    labelKey: 'theme.light',
    dark: false,
    origin: 'builtin',
    swatch: { bg: '#fafafa', surface: '#f4f4f5', text: '#18181b', accent: '#c2410c' }
  },
  {
    id: 'catppuccin-latte',
    labelKey: 'theme.catppuccinLatte',
    dark: false,
    origin: 'builtin',
    swatch: { bg: '#eff1f5', surface: '#e6e9ef', text: '#4c4f69', accent: '#fe640b' }
  },
  {
    id: 'github-light',
    labelKey: 'theme.githubLight',
    dark: false,
    origin: 'builtin',
    swatch: { bg: '#ffffff', surface: '#f6f8fa', text: '#1f2328', accent: '#0969da' }
  },
  {
    id: 'gruvbox-light',
    labelKey: 'theme.gruvboxLight',
    dark: false,
    origin: 'builtin',
    swatch: { bg: '#fbf1c7', surface: '#f2e5bc', text: '#3c3836', accent: '#d65d0e' }
  }
]

function isBuiltinTheme(v: string): v is Theme {
  return (THEMES as readonly string[]).includes(v)
}

/**
 * Accepted at `persistedRef` init time — BEFORE the async extension-themes
 * fetch resolves. A builtin id is always accepted; an `ext-`-shaped id is
 * accepted OPTIMISTICALLY (format only) so a persisted extension theme
 * survives a restart instead of being evicted before its extension has even
 * had a chance to load. `refreshExtensionThemes` below applies the REAL
 * guard once the installed set is known — falling back to `default-dark`
 * only if the extension turns out to be gone.
 */
function isPlausibleTheme(v: string): boolean {
  return isBuiltinTheme(v) || v.startsWith('ext-')
}

export const useThemeStore = defineStore('theme', () => {
  // persistedRef owns the localStorage mirror (key + format unchanged); this
  // store only applies the theme to the DOM on init and on every change.
  const current = persistedRef<string>(STORAGE_KEY, 'default-dark', { validate: isPlausibleTheme })

  // `contributes.themes` from installed extensions (T137) — fetched once at
  // store init, refreshed on every `onExtensionsThemesChanged` push (install/
  // edit/uninstall, hot, no app restart).
  const extensionThemes = ref<ExtensionThemeWire[]>([])

  const themes = computed<readonly string[]>(() => [
    ...THEMES,
    ...extensionThemes.value.map((t) => t.id)
  ])
  const meta = computed<readonly ThemeMeta[]>(() => [
    ...BUILTIN_THEME_META,
    ...extensionThemes.value.map(toExtensionThemeMeta)
  ])

  let styleEl: HTMLStyleElement | null = null
  function injectExtensionCss(): void {
    if (typeof document === 'undefined') return
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = EXTENSION_STYLE_ID
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = buildExtensionThemesCss(extensionThemes.value)
  }

  async function refreshExtensionThemes(): Promise<void> {
    try {
      const result = await window.api?.extensionsListThemes?.()
      // A defensive `Array.isArray` guard, not just `?? []` — a stub/mock IPC
      // (or a future wire-shape mistake) that resolves to something non-array
      // must never reach `buildExtensionThemesCss`'s `for...of` and throw.
      extensionThemes.value = Array.isArray(result) ? result : []
    } catch {
      extensionThemes.value = []
    }
    injectExtensionCss()
    // Persistence guard (T137 scope): an uninstalled extension's theme id
    // falls back to `default-dark` rather than leaving `data-theme` pointed at
    // a stylesheet block that no longer exists.
    if (current.value.startsWith('ext-') && !themes.value.includes(current.value)) {
      current.value = 'default-dark'
    }
  }

  function applyDom(t: string): void {
    document.documentElement.dataset.theme = t
  }
  applyDom(current.value)

  watch(current, applyDom)

  void refreshExtensionThemes()
  window.api?.onExtensionsThemesChanged?.(() => void refreshExtensionThemes())

  function set(t: string): void {
    current.value = t
  }

  function cycle(): void {
    const list = themes.value
    const idx = list.indexOf(current.value)
    current.value = list[(idx + 1) % list.length]
  }

  return { current, themes, meta, set, cycle }
})
