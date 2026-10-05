// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useThemeStore } from '../src/renderer/src/stores/theme'
import type { ExtensionThemeWire } from '../src/preload'

/**
 * T137 — the theme store's extension-themes wiring. Regression coverage for a
 * real bug caught by local CI: a `window.api.extensionsListThemes` call that
 * resolves to something non-array (a stub/mock IPC in another test file's
 * jsdom environment, or a future wire-shape mistake) must never reach
 * `buildExtensionThemesCss`'s `for...of` and throw an unhandled rejection —
 * it must degrade to an empty extension-theme list instead.
 */

function wireTheme(id: string): ExtensionThemeWire {
  return {
    id,
    rawId: id.replace(/^ext-[^-]+-/, ''),
    extensionId: 'my-pack',
    extensionLabel: 'My pack',
    label: 'My Theme',
    dark: true,
    tokens: {
      bg: '#111',
      sidebar: '#111',
      surface: '#111',
      surface2: '#111',
      border: '#111',
      border2: '#111',
      text: '#eee',
      text2: '#eee',
      text3: '#eee',
      text4: '#eee',
      textDisabled: '#eee',
      accent: '#7aa2f7',
      accentSoft: 'rgba(0,0,0,.1)',
      accentLine: 'rgba(0,0,0,.3)',
      accentInk: '#000',
      green: '#0f0',
      greenSoft: 'rgba(0,255,0,.1)',
      red: '#f00',
      redSoft: 'rgba(255,0,0,.1)',
      warning: '#fa0',
      ansi: {
        black: '#000',
        red: '#f00',
        green: '#0f0',
        yellow: '#ff0',
        blue: '#00f',
        magenta: '#f0f',
        cyan: '#0ff',
        white: '#fff',
        brightBlack: '#111',
        brightRed: '#f11',
        brightGreen: '#1f1',
        brightYellow: '#ff1',
        brightBlue: '#11f',
        brightMagenta: '#f1f',
        brightCyan: '#1ff',
        brightWhite: '#fff'
      }
    }
  }
}

function mockApi(overrides: Record<string, unknown> = {}): void {
  const api = {
    extensionsListThemes: vi.fn(async () => []),
    onExtensionsThemesChanged: vi.fn(() => () => {}),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, p: string) {
      return p in t ? t[p] : () => () => {}
    }
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  document.getElementById('harnu-extension-themes')?.remove()
})

describe('useThemeStore — extension themes wiring', () => {
  it('degrades to an empty extension-theme list when the IPC resolves to something non-array, without throwing', async () => {
    mockApi({ extensionsListThemes: vi.fn(async () => 'not-an-array') })
    const theme = useThemeStore()
    await flush()
    expect(theme.themes).toHaveLength(13) // builtins only, no crash
    expect(document.getElementById('harnu-extension-themes')?.textContent).toBe('')
  })

  it('degrades to an empty list when the IPC rejects', async () => {
    mockApi({ extensionsListThemes: vi.fn(async () => Promise.reject(new Error('boom'))) })
    const theme = useThemeStore()
    await flush()
    expect(theme.themes).toHaveLength(13)
  })

  it('merges a valid extension theme into `themes`/`meta` and injects its CSS', async () => {
    mockApi({ extensionsListThemes: vi.fn(async () => [wireTheme('ext-my-pack-solarized')]) })
    const theme = useThemeStore()
    await flush()
    expect(theme.themes).toContain('ext-my-pack-solarized')
    const meta = theme.meta.find((m) => m.id === 'ext-my-pack-solarized')
    expect(meta).toMatchObject({
      origin: 'extension',
      label: 'My Theme',
      extensionLabel: 'My pack'
    })
    expect(document.getElementById('harnu-extension-themes')?.textContent).toContain(
      ":root[data-theme='ext-my-pack-solarized']"
    )
  })

  it('falls back to default-dark when the active extension theme is uninstalled', async () => {
    localStorage.setItem('om2tab.theme', 'ext-my-pack-solarized')
    mockApi({ extensionsListThemes: vi.fn(async () => []) }) // already uninstalled
    const theme = useThemeStore()
    expect(theme.current).toBe('ext-my-pack-solarized') // optimistically accepted at init
    await flush()
    expect(theme.current).toBe('default-dark') // corrected once the real list resolves
  })

  it('keeps a persisted extension theme selected when it IS still installed', async () => {
    localStorage.setItem('om2tab.theme', 'ext-my-pack-solarized')
    mockApi({ extensionsListThemes: vi.fn(async () => [wireTheme('ext-my-pack-solarized')]) })
    const theme = useThemeStore()
    await flush()
    expect(theme.current).toBe('ext-my-pack-solarized')
  })
})
