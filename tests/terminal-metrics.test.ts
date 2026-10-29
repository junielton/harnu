import { describe, it, expect, afterEach, vi } from 'vitest'
import { measureCells } from '../src/renderer/src/lib/terminalMetrics'

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
