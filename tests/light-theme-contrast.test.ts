import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * design.md §9 "Light themes: sidebar contrast". In the four light themes the group rail, the
 * selected bar and the small labels have to read apart: measured here from the token values, with
 * the WCAG contrast ratio and, for "is this a different colour", the OKLab distance.
 */
const read = (file: string): string =>
  readFileSync(join(__dirname, '../src/renderer/src/styles', file), 'utf8')
const THEMES_CSS = read('themes.css')
const MAIN_CSS = read('main.css')

const LIGHT = ['light', 'catppuccin-latte', 'github-light', 'gruvbox-light']
const DERIVED = {
  '--color-rail-working': 'color-mix(in oklab, var(--color-green) 40%, transparent)',
  '--color-bar-selected': 'var(--color-accent)'
}

const code = THEMES_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of every block opened by `selector {`, later ones winning. */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {}
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const [, body] of code.matchAll(new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'gm'))) {
    for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
      out[name] = value.replace(/\s+/g, ' ').trim()
    }
  }
  return out
}

const base = { ...declarations('@theme'), ...declarations(':root') }
const themeNames = [...code.matchAll(/^:root\[data-theme='([^']+)'\]/gm)].map((m) => m[1])

/** What a theme resolves a token to: its own value, else the base one, following one `var()`. */
function resolve(theme: string, name: string): string {
  const own = declarations(`:root[data-theme='${theme}']`)
  const value = own[name] ?? base[name]
  const ref = value?.match(/^var\((--[\w-]+)\)$/)?.[1]
  return ref ? resolve(theme, ref) : value
}

type Rgb = [number, number, number]

function rgb(value: string): Rgb {
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1]
  if (!hex) throw new Error(`not a hex colour: ${value}`)
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb
}

const linear = (channel: number): number => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(color: Rgb): number {
  const [r, g, b] = color.map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(theme: string, a: string, b: string): number {
  const [hi, lo] = [a, b].map((t) => luminance(rgb(resolve(theme, t)))).sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function oklab(color: Rgb): Rgb {
  const [r, g, b] = color.map(linear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

function distance(theme: string, a: string, b: string): number {
  const [x, y] = [a, b].map((t) => oklab(rgb(resolve(theme, t))))
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

/** The OKLab distance with lightness left out: how far apart two colours are in hue and chroma. */
function hueDistance(theme: string, a: string, b: string): number {
  const [x, y] = [a, b].map((t) => oklab(rgb(resolve(theme, t))))
  return Math.hypot(x[1] - y[1], x[2] - y[2])
}

describe('the derived rail and bar tokens', () => {
  it.each(Object.entries(DERIVED))('%s is today’s expression in the base', (name, value) => {
    expect(base[name]).toBe(value)
  })

  it('no dark theme overrides them, so dark paints what it painted', () => {
    const dark = themeNames.filter((theme) => !LIGHT.includes(theme))
    expect(dark.length).toBeGreaterThan(5)
    for (const theme of dark) {
      const own = declarations(`:root[data-theme='${theme}']`)
      for (const name of Object.keys(DERIVED)) expect(own[name], theme).toBeUndefined()
    }
  })

  it('the group rail and the row bars read them', () => {
    expect(MAIN_CSS).toMatch(/--rail-color:\s*var\(--color-rail-working\)/)
    // Session selected, current header, and either of them with keyboard focus.
    expect(MAIN_CSS.match(/background-color:\s*var\(--color-bar-selected\)/g)).toHaveLength(3)
  })
})

describe.each(LIGHT)('%s', (theme) => {
  const SIDEBAR = '--color-sidebar'

  it('draws the dim working rail apart from the sidebar and from the tree guide', () => {
    expect(contrast(theme, '--color-rail-working', SIDEBAR)).toBeGreaterThanOrEqual(3)
    expect(contrast(theme, '--color-rail-working', '--color-border-2')).toBeGreaterThanOrEqual(1.7)
  })

  // Rail and guide are only 1.76:1 to 2.18:1 apart in lightness: hue carries the difference, so a
  // grey rail that met the ratios above would still read as one more guide line.
  it('keeps the working rail a different hue from the tree guide', () => {
    expect(hueDistance(theme, '--color-rail-working', '--color-border-2')).toBeGreaterThanOrEqual(
      0.07
    )
  })

  it('draws a selected bar that is not the colour of failed or of needs-you', () => {
    expect(contrast(theme, '--color-bar-selected', SIDEBAR)).toBeGreaterThanOrEqual(3)
    expect(distance(theme, '--color-bar-selected', '--color-red')).toBeGreaterThanOrEqual(0.15)
    expect(distance(theme, '--color-bar-selected', '--color-warning')).toBeGreaterThanOrEqual(0.15)
  })

  it.each([
    // The quietest labels keep a margin over the 4.5:1 line.
    ['--color-text-4', 4.6],
    ['--color-warning', 4.5]
  ])('reads %s as text on the sidebar', (token, floor) => {
    expect(contrast(theme, token, SIDEBAR)).toBeGreaterThanOrEqual(floor)
    // Hover rows and cards sit on the other surfaces: never under the 3:1 floor.
    for (const surface of ['--color-bg', '--color-surface', '--color-surface-2']) {
      expect(contrast(theme, token, surface), surface).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps the order of the text scale', () => {
    const scale = ['text', 'text-2', 'text-3', 'text-4', 'text-disabled'].map((step) =>
      contrast(theme, `--color-${step}`, SIDEBAR)
    )
    expect(scale).toEqual([...scale].sort((a, b) => b - a))
    expect(new Set(scale).size).toBe(scale.length)
  })

  it('keeps needs-you apart from failed and working, and its tints on the same hue', () => {
    expect(distance(theme, '--color-warning', '--color-red')).toBeGreaterThanOrEqual(0.13)
    expect(distance(theme, '--color-warning', '--color-green')).toBeGreaterThanOrEqual(0.08)
    const channels = rgb(resolve(theme, '--color-warning')).join(', ')
    expect(resolve(theme, '--color-warning-soft')).toBe(`rgba(${channels}, 0.1)`)
    expect(resolve(theme, '--color-warning-line')).toBe(`rgba(${channels}, 0.3)`)
  })
})
