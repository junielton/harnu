/**
 * Shared terminal cell-measurement + font-loading helpers.
 *
 * `TerminalPane.vue` (main pane) and `HelperPane.vue` (split cells) both embed
 * an xterm grid and must size their PTY to the host element. They previously
 * carried byte-identical copies of this logic; this module is the single
 * source of truth so a fix to the measurement strategy (e.g. the cell-width
 * correction in `ed90503`) lands in both panes at once.
 */

/** Family of the bundled Nerd Font; matches the `@font-face` in `fonts.css`. */
const TERMINAL_FONT_FAMILY = 'JetBrainsMono Nerd Font Mono'

export interface CellDims {
  cols: number
  rows: number
}

/**
 * Resolve once the bundled terminal font is loaded so `measureCells` reads its
 * metrics, not the fallback's. Memoized — the load only needs to happen once
 * per renderer; later session switches reuse the resolved promise. Failures
 * (font missing, `document.fonts` unavailable) resolve rather than reject: we
 * fall back to whatever the system provides and proceed with mounting.
 */
let terminalFontReady: Promise<void> | null = null
export function ensureTerminalFontLoaded(): Promise<void> {
  if (terminalFontReady) return terminalFontReady
  terminalFontReady = (async () => {
    if (!('fonts' in document)) return
    try {
      const family = `"${TERMINAL_FONT_FAMILY}"`
      await Promise.all([
        document.fonts.load(`13px ${family}`),
        document.fonts.load(`bold 13px ${family}`)
      ])
    } catch {
      // Ignore — proceed with the system-resolved font.
    }
  })()
  return terminalFontReady
}

/**
 * Span-based cell measurement. Always reliable for cellW (immune to xterm's
 * DOM-renderer coalescing), but cellH from this method can over-estimate
 * row count vs xterm's real rendered row height. See `measureXtermCells`
 * for the hybrid that fixes row clipping.
 *
 * When `cellHOverride` is provided, that height is used in place of the
 * span-measured height — the call from `measureXtermCells` passes xterm's
 * actual `.xterm-rows > div` height there.
 */
export function measureCells(el: HTMLElement, cellHOverride?: number, fontSize = 13): CellDims {
  const cs = getComputedStyle(document.documentElement)
  const fontFamily = cs.getPropertyValue('--font-mono').trim() || 'monospace'
  const lineHeight = 1.55

  const measureSpan = document.createElement('span')
  measureSpan.style.cssText =
    `position:absolute;visibility:hidden;left:-9999px;top:-9999px;` +
    `font-family:${fontFamily};font-size:${fontSize}px;line-height:${lineHeight};` +
    `white-space:pre;letter-spacing:0;`
  measureSpan.textContent = 'M'.repeat(10)
  el.appendChild(measureSpan)
  const rect = measureSpan.getBoundingClientRect()
  const charWidth = rect.width / 10
  const charHeight = cellHOverride ?? rect.height
  el.removeChild(measureSpan)

  const elCs = getComputedStyle(el)
  const padX = parseFloat(elCs.paddingLeft) + parseFloat(elCs.paddingRight)
  const padY = parseFloat(elCs.paddingTop) + parseFloat(elCs.paddingBottom)

  const innerW = Math.max(0, el.clientWidth - padX)
  const innerH = Math.max(0, el.clientHeight - padY)

  const cols = Math.max(2, Math.floor(innerW / Math.max(1, charWidth)))
  const rows = Math.max(1, Math.floor(innerH / Math.max(1, charHeight)))
  return { cols, rows }
}

/**
 * Hybrid measurement: span-based cellW + xterm-DOM cellH.
 *
 * Called after `term.open()` and the first `term.resize`, when xterm has
 * materialized its grid. Returns null when xterm hasn't rendered yet (use
 * the span-based `measureCells` for the initial estimate in that case).
 *
 * Why hybrid:
 *   - **Row HEIGHT** must come from xterm's actual rendered row, not the
 *     span. xterm applies extra glyph-baseline padding beyond
 *     `fontSize * lineHeight`, so the span underestimates row height,
 *     producing too many rows and clipping Claude's status line off-screen.
 *   - **Cell WIDTH** must NOT come from xterm DOM. xterm's DOM renderer
 *     coalesces adjacent cells sharing the same style into a single `<span>`,
 *     so its rect can span anywhere from 1 to `cols` characters. The reliable
 *     source is the span method (`measureCells`), which renders 10 known 'M's
 *     in the current `--font-mono` and divides. See CDP investigation
 *     2026-05-28.
 */
export function measureXtermCells(host: HTMLElement, fontSize = 13): CellDims | null {
  const xtermRow = host.querySelector('.xterm-rows')?.firstElementChild as HTMLElement | null
  if (!xtermRow) return null
  const actualCharH = xtermRow.getBoundingClientRect().height
  if (!actualCharH) return null
  return measureCells(host, actualCharH, fontSize)
}
