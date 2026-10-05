import { describe, it, expect } from 'vitest'
import { autoOrganizeLine } from '../src/main/auto-organize-line'

/**
 * T106 (D6) — the pure runtime-line builder for the auto-organize toggle
 * (mirrors `memory-language.ts`'s pattern for the T85 language line).
 */

describe('autoOrganizeLine', () => {
  it('states ON when the toggle is enabled', () => {
    const line = autoOrganizeLine(true)
    expect(line).toContain('**ON**')
    expect(line).not.toContain('**OFF**')
  })

  it('states OFF when the toggle is disabled', () => {
    const line = autoOrganizeLine(false)
    expect(line).toContain('**OFF**')
    expect(line).not.toContain('**ON**')
  })
})
