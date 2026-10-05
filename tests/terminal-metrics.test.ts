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

function stubDom(captured: { css: string }): HTMLElement {
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
    paddingLeft: '0',
    paddingRight: '0',
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
    // charWidth = 80/10 = 8 → cols = floor(800/8) = 100; charHeight = 20 →
    // rows = floor(600/20) = 30.
    expect(dims.cols).toBe(100)
    expect(dims.rows).toBe(30)
  })
})
