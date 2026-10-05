import { describe, it, expect } from 'vitest'
import { extractBottomLines, linesChanged } from '../src/main/detect/bottom-lines-core'

/**
 * T5 — `extractBottomLines` reduces a rendered grid to a small, STABLE bottom
 * slice. The invariants pinned here:
 *
 *   - takes the LAST n lines (never scrollback above the window);
 *   - drops the run of blank rows the emulator pads below the cursor;
 *   - is stable under redraw: trailing-space-only repaints and extra blank
 *     padding produce the SAME slice, so `linesChanged` stays quiet.
 */

describe('extractBottomLines — last n', () => {
  it('returns the last n content lines, top-to-bottom', () => {
    const grid = ['a', 'b', 'c', 'd', 'e']
    expect(extractBottomLines(grid, 2)).toEqual(['d', 'e'])
  })

  it('returns the whole grid when n exceeds its height', () => {
    expect(extractBottomLines(['a', 'b'], 10)).toEqual(['a', 'b'])
  })

  it('n <= 0 yields nothing', () => {
    expect(extractBottomLines(['a', 'b'], 0)).toEqual([])
    expect(extractBottomLines(['a', 'b'], -5)).toEqual([])
  })
})

describe('extractBottomLines — drops trailing blank padding', () => {
  it('ignores blank rows below the last content line', () => {
    const grid = ['› prompt', '', '   ', '']
    // Last 2 of the CONTENT (padding dropped) is just the prompt.
    expect(extractBottomLines(grid, 2)).toEqual(['› prompt'])
  })

  it('an all-blank grid has no bottom buffer', () => {
    expect(extractBottomLines(['', '  ', '\t', ''], 5)).toEqual([])
  })

  it('keeps interior blank lines within the window', () => {
    const grid = ['Allow this tool?', '', '  1. Yes', '  2. No', '', '']
    expect(extractBottomLines(grid, 4)).toEqual(['Allow this tool?', '', '  1. Yes', '  2. No'])
  })
})

describe('extractBottomLines — stable under redraw', () => {
  it('right-trims trailing whitespace so spinner repaints do not differ', () => {
    const frameA = extractBottomLines(['⠋ Thinking    '], 30)
    const frameB = extractBottomLines(['⠋ Thinking'], 30)
    expect(frameA).toEqual(frameB)
    expect(linesChanged(frameA, frameB)).toBe(false)
  })

  it('extra blank padding below content does not change the slice', () => {
    const tight = extractBottomLines(['line1', 'line2'], 30)
    const padded = extractBottomLines(['line1', 'line2', '', '', '   ', ''], 30)
    expect(padded).toEqual(tight)
    expect(linesChanged(tight, padded)).toBe(false)
  })
})

describe('linesChanged', () => {
  it('detects a real content change', () => {
    expect(linesChanged(['a', 'b'], ['a', 'c'])).toBe(true)
  })

  it('detects a length change', () => {
    expect(linesChanged(['a'], ['a', 'b'])).toBe(true)
  })

  it('reports no change for identical slices', () => {
    expect(linesChanged(['a', 'b'], ['a', 'b'])).toBe(false)
    expect(linesChanged([], [])).toBe(false)
  })
})
