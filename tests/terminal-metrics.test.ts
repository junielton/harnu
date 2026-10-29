import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { measureCells, measureXtermCells } from '../src/renderer/src/lib/terminalMetrics'

/**
 * `measureCells` font-size parameterization (terminal-font-settings spec §3).
 * The cell geometry must be measured at the *current* font size, otherwise the
 * grid is computed for the wrong glyph size and clips. This test runs in the
 * `node` environment with a minimal stubbed DOM that captures the inline CSS
 * the measuring span is given, asserting the passed `fontSize` lands in it.
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubDom(captured: { css: string }, padX = '0'): HTMLElement {
  const span = {
    style: {
      set cssText(v: string) {
        captured.css = v
      }
    },
    textContent: '',
    getBoundingClientRect: () => ({ width: 80, height: 20 })
  }
  vi.stubGlobal('document', {
    documentElement: {},
    createElement: () => span
  })
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: () => 'monospace',
    paddingLeft: padX,
    paddingRight: padX,
    paddingTop: '0',
    paddingBottom: '0'
  }))
  // The host element measureCells reads dimensions + appends the span into.
  return {
    appendChild: () => {},
    removeChild: () => {},
    clientWidth: 800,
    clientHeight: 600
  } as unknown as HTMLElement
}

describe('measureCells fontSize parameter', () => {
  it('defaults to 13px when no fontSize is passed', () => {
    const captured = { css: '' }
    const el = stubDom(captured)
    measureCells(el)
    expect(captured.css).toContain('font-size:13px')
  })

  it('uses the passed fontSize in the measuring span', () => {
    const captured = { css: '' }
    const el = stubDom(captured)
    measureCells(el, undefined, 20)
    expect(captured.css).toContain('font-size:20px')
    expect(captured.css).not.toContain('font-size:13px')
  })

  it('still returns a valid grid (cols/rows >= minimums)', () => {
    const captured = { css: '' }
    const el = stubDom(captured)
    const dims = measureCells(el, undefined, 20)
    // charWidth = 80/10 = 8 → cols = floor((800 - 14 scrollbar)/8) = 98;
    // charHeight = 20 → rows = floor(600/20) = 30.
    expect(dims.cols).toBe(98)
    expect(dims.rows).toBe(30)
  })
})

/**
 * BUG-233: xterm 6 draws an overlay scrollbar over the right edge of the grid
 * (`verticalScrollbarSize = overviewRuler.width || 14`). We size manually (no
 * FitAddon, which would subtract it), so `measureCells` must leave that width
 * free or the last columns sit under the scrollbar.
 */
describe('measureCells scrollbar reservation', () => {
  it('excludes the 14px default xterm scrollbar from the usable width', () => {
    const el = stubDom({ css: '' })
    // 800px host, 8px cells: without the scrollbar 100 cols, with it (786px) 98.
    expect(measureCells(el).cols).toBe(98)
  })

  it('subtracts the host padding on top of the scrollbar', () => {
    const el = stubDom({ css: '' }, '8')
    // 800 - 16 padding - 14 scrollbar = 770px → floor(770/8) = 96.
    expect(measureCells(el).cols).toBe(96)
  })

  it('honours a custom scrollbar width (overviewRuler.width)', () => {
    const el = stubDom({ css: '' })
    // 800 - 20 = 780px → floor(780/8) = 97.
    expect(measureCells(el, undefined, 13, 20).cols).toBe(97)
  })

  it('leaves the width untouched when the scrollbar width is 0', () => {
    const el = stubDom({ css: '' })
    expect(measureCells(el, undefined, 13, 0).cols).toBe(100)
  })
})

/**
 * BUG-234: with the scrollbar reserved, the LAST column still rendered
 * half-clipped. Measured in the running app: xterm's DOM renderer sets
 * `letter-spacing` on `.xterm-rows` (`cell.width − measured "W" advance`), so a
 * glyph really advances `glyph + letter-spacing`, not the bare glyph width the
 * hidden 'M' span measures. The grid must be sized by that rendered advance or
 * `cols × advance` overruns the host and the last cell falls off the edge.
 */
describe('measureXtermCells rendered letter-spacing', () => {
  /** A host whose `.xterm-rows` first row is 20px tall and carries `letterSpacing`. */
  function stubXtermHost(letterSpacing: string, padX = '0'): HTMLElement {
    const host = stubDom({ css: '' }, padX)
    const rowsEl = { firstElementChild: { getBoundingClientRect: () => ({ height: 20 }) } }
    const base = (globalThis as unknown as { getComputedStyle: (el: unknown) => object })
      .getComputedStyle
    vi.stubGlobal('getComputedStyle', (el: unknown) =>
      el === rowsEl ? { letterSpacing } : base(el)
    )
    ;(host as unknown as { querySelector: (sel: string) => unknown }).querySelector = (
      sel: string
    ) => (sel === '.xterm-rows' ? rowsEl : null)
    return host
  }

  it('shrinks cols when xterm advances each glyph by extra letter-spacing', () => {
    const host = stubXtermHost('0.4px')
    // span cell 8px + 0.4px spacing = 8.4px rendered; usable 800 - 14 = 786px
    // → floor(786 / 8.4) = 93 (it was 98 sized by the bare 8px span).
    expect(measureXtermCells(host)?.cols).toBe(93)
  })

  it('never lets cols × rendered advance exceed the usable width', () => {
    const host = stubXtermHost('0.05px', '8')
    const dims = measureXtermCells(host)!
    expect(dims.cols * (8 + 0.05)).toBeLessThanOrEqual(800 - 16 - 14)
  })

  it('keeps the span-sized grid when letter-spacing is "normal" or negative', () => {
    expect(measureXtermCells(stubXtermHost('normal'))?.cols).toBe(98)
    // A negative spacing only tightens the glyphs; the grid stays as wide as the span says.
    expect(measureXtermCells(stubXtermHost('-0.0165px'))?.cols).toBe(98)
  })
})

/**
 * Root cause of the extra spacing: xterm 6's `WidthCache` appends its hidden
 * measuring element INSIDE `.xterm-rows`, so the element inherits the very
 * `letter-spacing` xterm just wrote there. It then measures an understated "W"
 * (7.735px vs the real 7.8016px at 13px) and sets
 * `letter-spacing = cell.width − W`, which grows on every re-measure (resize,
 * font-size change) until the row text overruns its own `overflow: hidden` box
 * and the last column is cut. Resetting the spacing on the measuring element
 * breaks that feedback loop.
 */
describe('xterm width-cache measuring element', () => {
  const css = readFileSync(
    fileURLToPath(new URL('../src/renderer/src/styles/main.css', import.meta.url)),
    'utf8'
  )

  it('does not inherit the row container letter-spacing', () => {
    expect(css).toMatch(
      /\.xterm-width-cache-measure-container\s*\{[^}]*letter-spacing:\s*0\s*!important/
    )
  })
})
