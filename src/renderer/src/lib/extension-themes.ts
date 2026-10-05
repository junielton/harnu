import type { ExtensionThemeWire } from '../../../preload'

/**
 * Pure helpers for folding `contributes.themes` extension themes (T137) into
 * the renderer's theme picker + runtime stylesheet — the merge/CSS-building
 * logic kept separate from `stores/theme.ts` so it's testable without an IPC
 * mock, mirroring the pure-core/impure-shell split the main process uses
 * throughout (`detect/manifest-registry.ts` + `detect/screen-detect.ts`).
 */

/** UI token key → its `--color-*` CSS custom property name (mirrors `themes.css`). */
const UI_TOKEN_CSS_VAR: Record<string, string> = {
  bg: '--color-bg',
  sidebar: '--color-sidebar',
  surface: '--color-surface',
  surface2: '--color-surface-2',
  border: '--color-border',
  border2: '--color-border-2',
  text: '--color-text',
  text2: '--color-text-2',
  text3: '--color-text-3',
  text4: '--color-text-4',
  textDisabled: '--color-text-disabled',
  accent: '--color-accent',
  accentSoft: '--color-accent-soft',
  accentLine: '--color-accent-line',
  accentInk: '--color-accent-ink',
  green: '--color-green',
  greenSoft: '--color-green-soft',
  red: '--color-red',
  redSoft: '--color-red-soft',
  warning: '--color-warning',
  greenLine: '--color-green-line',
  redLine: '--color-red-line',
  warningSoft: '--color-warning-soft',
  warningLine: '--color-warning-line'
}

/** ANSI token key → its `--term-ansi-*` CSS custom property name, in xterm order. */
const ANSI_TOKEN_CSS_VAR: Record<string, string> = {
  black: '--term-ansi-black',
  red: '--term-ansi-red',
  green: '--term-ansi-green',
  yellow: '--term-ansi-yellow',
  blue: '--term-ansi-blue',
  magenta: '--term-ansi-magenta',
  cyan: '--term-ansi-cyan',
  white: '--term-ansi-white',
  brightBlack: '--term-ansi-bright-black',
  brightRed: '--term-ansi-bright-red',
  brightGreen: '--term-ansi-bright-green',
  brightYellow: '--term-ansi-bright-yellow',
  brightBlue: '--term-ansi-bright-blue',
  brightMagenta: '--term-ansi-bright-magenta',
  brightCyan: '--term-ansi-bright-cyan',
  brightWhite: '--term-ansi-bright-white'
}

/**
 * Escape a value before it's interpolated into a `<style>` text node. Manifest
 * tokens are validated as non-empty strings by the main-process core, but
 * nothing there guarantees they're VALID CSS color syntax — this only needs
 * to stop the string from breaking out of its declaration (no `;`/`{`/`}` or
 * comment-close), not validate color grammar. A stray unsafe token drops the
 * whole theme rather than emitting a broken/escaping rule.
 */
const UNSAFE_CSS_VALUE = /[;{}]|\*\//

/**
 * Alpha-blend a declared base hue into the soft/line variant an extension theme
 * omitted. An extension manifest predates these four tokens, so absence is the
 * norm, not an error — deriving keeps its badges readable instead of transparent.
 * Returns the input untouched for a value it cannot parse (the CSS escape hatch
 * below already drops anything unsafe).
 */
export function deriveOptionalTokens(tokens: Record<string, unknown>): Record<string, unknown> {
  const rgba = (hex: unknown, alpha: number): string | undefined => {
    if (typeof hex !== 'string') return undefined
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
    if (!m) return undefined
    const n = parseInt(m[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  const out = { ...tokens }
  out.greenLine ??= rgba(tokens.green, 0.35)
  out.redLine ??= rgba(tokens.red, 0.3)
  out.warningSoft ??= rgba(tokens.warning, 0.1)
  out.warningLine ??= rgba(tokens.warning, 0.3)
  return out
}

/** Build one `:root[data-theme='ext-...']{ … }` block. Returns `null` if any token value is unsafe to inline. */
function cssBlockFor(theme: ExtensionThemeWire): string | null {
  const lines: string[] = []
  const tokens = deriveOptionalTokens(theme.tokens as unknown as Record<string, unknown>)
  for (const [key, cssVar] of Object.entries(UI_TOKEN_CSS_VAR)) {
    const value = tokens[key]
    // A key that stayed absent (manifest omitted it AND its base was
    // unparseable) is left out of the block rather than emitting `undefined`.
    if (value === undefined) continue
    if (typeof value !== 'string' || UNSAFE_CSS_VALUE.test(value)) return null
    lines.push(`  ${cssVar}: ${value};`)
  }
  for (const [key, cssVar] of Object.entries(ANSI_TOKEN_CSS_VAR)) {
    const value = theme.tokens.ansi[key as keyof typeof theme.tokens.ansi]
    if (UNSAFE_CSS_VALUE.test(value)) return null
    lines.push(`  ${cssVar}: ${value};`)
  }
  return `:root[data-theme='${theme.id}'] {\n${lines.join('\n')}\n}`
}

/**
 * Build the full injectable stylesheet text for every currently-installed
 * extension theme. A theme with an unsafe token value is dropped (logged),
 * never allowed to break out of the `<style>` tag or take down its siblings.
 */
export function buildExtensionThemesCss(themes: readonly ExtensionThemeWire[]): string {
  const blocks: string[] = []
  for (const theme of themes) {
    const block = cssBlockFor(theme)
    if (block) blocks.push(block)
    else console.error(`[theme] extension theme "${theme.id}" has an unsafe token value — dropped`)
  }
  return blocks.join('\n\n')
}

/** The picker-facing metadata for one extension theme (mirrors builtin `ThemeMeta` shape). */
export interface ExtensionThemeMeta {
  id: string
  /** Plain string label (extension content self-localizes — ADR-0002 study §2). */
  label: string
  dark: boolean
  origin: 'extension'
  extensionId: string
  extensionLabel: string
  swatch: { bg: string; surface: string; text: string; accent: string }
}

/** Derive picker metadata from a validated extension theme — swatch computed from ITS OWN tokens, never hand-copied. */
export function toExtensionThemeMeta(theme: ExtensionThemeWire): ExtensionThemeMeta {
  return {
    id: theme.id,
    label: theme.label,
    dark: theme.dark,
    origin: 'extension',
    extensionId: theme.extensionId,
    extensionLabel: theme.extensionLabel,
    swatch: {
      bg: theme.tokens.bg,
      surface: theme.tokens.surface,
      text: theme.tokens.text,
      accent: theme.tokens.accent
    }
  }
}
