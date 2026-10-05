/**
 * Canvas palette — the §9 tokens the X6 graph draws with (T218 U2, spec §6.4).
 *
 * X6 paints into an SVG document whose `fill`/`stroke` attributes are set from
 * JavaScript, so a CSS class cannot carry the colour the way it does everywhere
 * else in the app. The token values are therefore RESOLVED from the live CSS
 * custom properties at mount and re-resolved on every theme switch — the same
 * contract `TerminalPane` honours when it reapplies its palette to every live
 * terminal. That is what makes "switching theme recolours the canvas without a
 * reload" true (U2-4) instead of a reload in disguise.
 *
 * This module is the ONLY place a token name appears as a string. Nothing else
 * in the pane knows a CSS variable exists, and no component carries a raw hex
 * (U2-3) — a swapped or extension-provided theme flows through here unchanged.
 */

/** The resolved token values one render of the canvas draws with. */
export interface CanvasPalette {
  /** `--color-bg` — the board itself. */
  bg: string
  /** `--color-surface` — a node body, and the ground under a transparent image. */
  surface: string
  /** `--color-border` — hairlines. */
  border: string
  /** `--color-border-2` — node outlines and the dot grid. */
  border2: string
  /** `--color-text` — a node label. */
  text: string
  /** `--color-text-2` — a bare `text` node (no frame to carry the emphasis). */
  text2: string
  /** `--color-text-3` — an edge label. */
  text3: string
  /** `--color-accent` — edges, and the selection halo the plugins draw. */
  accent: string
  /** `--font-sans` — labels match the app's own type, not the browser default. */
  fontSans: string
}

/**
 * The token → palette-field map. Kept as data rather than as a hand-written
 * object literal so the fallback loop below cannot drift from the read loop.
 */
const TOKENS: ReadonlyArray<readonly [keyof CanvasPalette, string]> = [
  ['bg', '--color-bg'],
  ['surface', '--color-surface'],
  ['border', '--color-border'],
  ['border2', '--color-border-2'],
  ['text', '--color-text'],
  ['text2', '--color-text-2'],
  ['text3', '--color-text-3'],
  ['accent', '--color-accent'],
  ['fontSans', '--font-sans']
]

/**
 * Last-resort values, used only when a token resolves to an empty string —
 * which in practice means a test environment with no stylesheet attached, not a
 * real theme. They are `currentColor`-ish neutrals rather than copies of the
 * default theme's hexes ON PURPOSE: a silent fallback that LOOKS right is how a
 * missing token ships unnoticed, and these are visibly plain.
 */
const FALLBACK: CanvasPalette = {
  bg: 'transparent',
  surface: 'transparent',
  border: 'currentColor',
  border2: 'currentColor',
  text: 'currentColor',
  text2: 'currentColor',
  text3: 'currentColor',
  accent: 'currentColor',
  fontSans: 'inherit'
}

/**
 * Resolve the canvas palette from the live CSS variables.
 *
 * Reads from `document.documentElement` by default — that is where `data-theme`
 * lands, so a theme switch is reflected the moment the attribute is applied
 * (call this AFTER `nextTick`, exactly as the terminal's theme watch does).
 * An explicit element is accepted so a test can scope the read.
 */
export function readCanvasPalette(el?: Element | null): CanvasPalette {
  const target = el ?? (typeof document === 'undefined' ? null : document.documentElement)
  if (!target || typeof getComputedStyle !== 'function') return { ...FALLBACK }
  const style = getComputedStyle(target)
  const out = { ...FALLBACK }
  for (const [field, token] of TOKENS) {
    const value = style.getPropertyValue(token).trim()
    if (value) out[field] = value
  }
  return out
}
