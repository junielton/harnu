import { describe, it, expect } from 'vitest'
import { countNeedsInput, formatWindowTitle } from '../src/renderer/src/stores/attention'
import type { TaskState } from '../src/preload'

describe('countNeedsInput', () => {
  it('counts only needs-input across the fleet', () => {
    expect(countNeedsInput([])).toBe(0)
    expect(countNeedsInput([{ taskState: 'needs-input' }, { taskState: 'needs-input' }])).toBe(2)
  })
  it('ignores every other state (and an unset taskState)', () => {
    for (const st of ['working', 'idle', 'completed', 'failed', 'stopped'] as TaskState[]) {
      expect(countNeedsInput([{ taskState: st }])).toBe(0)
    }
    expect(countNeedsInput([{ taskState: undefined }])).toBe(0)
  })
  it('counts a realistic mix', () => {
    expect(
      countNeedsInput([
        { taskState: 'needs-input' },
        { taskState: 'working' },
        { taskState: 'needs-input' },
        { taskState: 'failed' }
      ])
    ).toBe(2)
  })
})

describe('formatWindowTitle', () => {
  it('count 0 → bare base name (no prefix, no period)', () => {
    expect(formatWindowTitle(0, 'Harnu', '(0)')).toBe('Harnu')
  })
  it('count > 0 → prefix + base name', () => {
    expect(formatWindowTitle(3, 'Harnu', '(3)')).toBe('(3) Harnu')
  })
})
