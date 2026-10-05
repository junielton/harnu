import { describe, it, expect, vi } from 'vitest'
import {
  buildExtensionThemesCss,
  toExtensionThemeMeta,
  deriveOptionalTokens
} from '../src/renderer/src/lib/extension-themes'
import type { ExtensionThemeWire } from '../src/preload'

/**
 * T137 — renderer-side pure helpers that fold `contributes.themes` into the
 * injectable stylesheet + picker metadata. Kept separate from `stores/theme.ts`
 * so the CSS-building/merge logic is testable without an IPC mock.
 */

function wireTheme(overrides: Partial<ExtensionThemeWire> = {}): ExtensionThemeWire {
  return {
    id: 'ext-my-pack-solarized',
    rawId: 'solarized',
    extensionId: 'my-pack',
    extensionLabel: 'My pack',
    label: 'Solarized Harnu',
    dark: true,
    tokens: {
      bg: '#111111',
      sidebar: '#121212',
      surface: '#131313',
      surface2: '#141414',
      border: '#151515',
      border2: '#161616',
      text: '#eeeeee',
      text2: '#dddddd',
      text3: '#cccccc',
      text4: '#bbbbbb',
      textDisabled: '#aaaaaa',
      accent: '#7aa2f7',
      accentSoft: 'rgba(1,2,3,0.1)',
      accentLine: 'rgba(1,2,3,0.3)',
      accentInk: '#000000',
      green: '#00ff00',
      greenSoft: 'rgba(0,255,0,0.1)',
      red: '#ff0000',
      redSoft: 'rgba(255,0,0,0.1)',
      warning: '#ffaa00',
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
    },
    ...overrides
  }
}

describe('buildExtensionThemesCss', () => {
  it('builds one :root[data-theme=...] block per theme, with every CSS var name present', () => {
    const css = buildExtensionThemesCss([wireTheme()])
    expect(css).toContain(":root[data-theme='ext-my-pack-solarized'] {")
    expect(css).toContain('--color-bg: #111111;')
    expect(css).toContain('--color-surface-2: #141414;')
    expect(css).toContain('--color-text-disabled: #aaaaaa;')
    expect(css).toContain('--term-ansi-bright-white: #fff;')
  })

  it('joins multiple themes with a blank line between blocks', () => {
    const css = buildExtensionThemesCss([
      wireTheme({ id: 'ext-a-x', rawId: 'x', extensionId: 'a' }),
      wireTheme({ id: 'ext-b-y', rawId: 'y', extensionId: 'b' })
    ])
    expect(css.split('\n\n')).toHaveLength(2)
  })

  it('returns an empty string for no themes', () => {
    expect(buildExtensionThemesCss([])).toBe('')
  })

  it('drops a theme with a CSS-breaking token value, logging it, without touching a sibling theme', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const evil = wireTheme({
      id: 'ext-evil-x',
      tokens: { ...wireTheme().tokens, bg: '#fff; } body { display:none' }
    })
    const good = wireTheme({ id: 'ext-good-y', rawId: 'y' })
    const css = buildExtensionThemesCss([evil, good])
    expect(css).not.toContain('ext-evil-x')
    expect(css).toContain('ext-good-y')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})

describe('deriveOptionalTokens — T291 badge tokens', () => {
  it('derives all four from the declared base hues', () => {
    const out = deriveOptionalTokens({ green: '#7a9455', red: '#c6675a', warning: '#c08a3e' })
    expect(out.greenLine).toBe('rgba(122, 148, 85, 0.35)')
    expect(out.redLine).toBe('rgba(198, 103, 90, 0.3)')
    expect(out.warningSoft).toBe('rgba(192, 138, 62, 0.1)')
    expect(out.warningLine).toBe('rgba(192, 138, 62, 0.3)')
  })

  it('never overwrites a value the manifest declared', () => {
    const out = deriveOptionalTokens({ warning: '#c08a3e', warningSoft: 'rgba(1,2,3,0.5)' })
    expect(out.warningSoft).toBe('rgba(1,2,3,0.5)')
  })

  it('leaves a key absent when its base is unparseable', () => {
    expect(deriveOptionalTokens({ green: 'notacolor' }).greenLine).toBeUndefined()
  })
})

describe('buildExtensionThemesCss — derives badge tokens for an older manifest', () => {
  it('reaches the injected stylesheet for a theme declaring none of the four tokens', () => {
    // wireTheme() omits greenLine/redLine/warningSoft/warningLine entirely —
    // the shape of a manifest written before T291.
    const css = buildExtensionThemesCss([wireTheme()])
    expect(css).toContain('--color-green-line: rgba(0, 255, 0, 0.35);')
    expect(css).toContain('--color-red-line: rgba(255, 0, 0, 0.3);')
    expect(css).toContain('--color-warning-soft: rgba(255, 170, 0, 0.1);')
    expect(css).toContain('--color-warning-line: rgba(255, 170, 0, 0.3);')
  })
})

describe('toExtensionThemeMeta', () => {
  it('derives picker metadata with a plain label (not an i18n key) and origin=extension', () => {
    const meta = toExtensionThemeMeta(wireTheme())
    expect(meta).toEqual({
      id: 'ext-my-pack-solarized',
      label: 'Solarized Harnu',
      dark: true,
      origin: 'extension',
      extensionId: 'my-pack',
      extensionLabel: 'My pack',
      swatch: { bg: '#111111', surface: '#131313', text: '#eeeeee', accent: '#7aa2f7' }
    })
  })
})
