import { describe, it, expect } from 'vitest'
import { attentionStrategy } from '../src/main/window-attention'

/**
 * T44 S4 — pure per-OS attention strategy (the decidable part of the window-flash
 * primitive). Mirrors tests/badge.test.ts; the electron glue is e2e-only.
 */
describe('attentionStrategy', () => {
  it('flashes the taskbar on Windows + Linux', () => {
    expect(attentionStrategy('win32')).toBe('flash')
    expect(attentionStrategy('linux')).toBe('flash')
  })

  it('bounces the dock on macOS', () => {
    expect(attentionStrategy('darwin')).toBe('bounce')
  })

  it('no-ops on unsupported platforms', () => {
    expect(attentionStrategy('aix' as NodeJS.Platform)).toBe('none')
    expect(attentionStrategy('sunos' as NodeJS.Platform)).toBe('none')
  })
})
