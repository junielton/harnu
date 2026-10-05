import type { Terminal } from '@xterm/xterm'

/**
 * Build an xterm `ITheme` from the live CSS variables on `<html>`.
 *
 * Reads the active theme's tokens (set by `stores/theme.ts` via `data-theme`)
 * straight from `getComputedStyle`, so it always reflects the current theme.
 * Beyond the core surfaces it maps the full 16-colour ANSI palette
 * (`--term-ansi-*`, defined per theme in `styles/themes.css`) — without this,
 * Claude/bash output keeps xterm's built-in palette regardless of theme.
 *
 * Shared by `TerminalPane.vue` and `HelperPane.vue`. Both call it on terminal
 * construction, again from a per-instance `theme.current` watch (TerminalPane's
 * T-3.5; HelperPane's mirror added in T60/BUG-7) to recolour every live terminal
 * — attached or detached — on theme switch, AND once more from each pane's
 * re-attach path (`attachLiveTerminal` / `attachLiveHelper`) so a terminal that
 * was detached and unmounted during a theme switch self-heals when it returns.
 */
export function themeFromCss(): NonNullable<Terminal['options']['theme']> {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string): string => css.getPropertyValue(name).trim() || '#000'
  return {
    background: v('--color-bg'),
    foreground: v('--color-text'),
    cursor: v('--color-accent'),
    cursorAccent: v('--color-bg'),
    selectionBackground: v('--color-accent-soft'),

    black: v('--term-ansi-black'),
    red: v('--term-ansi-red'),
    green: v('--term-ansi-green'),
    yellow: v('--term-ansi-yellow'),
    blue: v('--term-ansi-blue'),
    magenta: v('--term-ansi-magenta'),
    cyan: v('--term-ansi-cyan'),
    white: v('--term-ansi-white'),
    brightBlack: v('--term-ansi-bright-black'),
    brightRed: v('--term-ansi-bright-red'),
    brightGreen: v('--term-ansi-bright-green'),
    brightYellow: v('--term-ansi-bright-yellow'),
    brightBlue: v('--term-ansi-bright-blue'),
    brightMagenta: v('--term-ansi-bright-magenta'),
    brightCyan: v('--term-ansi-bright-cyan'),
    brightWhite: v('--term-ansi-bright-white')
  }
}
