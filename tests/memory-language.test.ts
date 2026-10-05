import { describe, it, expect } from 'vitest'
import { memoryLanguageLine, localeDisplayName } from '../src/main/memory-language'

/**
 * T85 — the project-memory LANGUAGE rule. The Settings locale is the single source
 * of truth for what gets WRITTEN to `.harnu/memory/`; `harnu-features.ts` appends
 * this pure line to the self-awareness preamble at spawn. These pin the contract:
 * the effective locale is named (tag + friendly name), the scope is unambiguous
 * (persisted memory only, not chat), and it is a single line (one preamble entry).
 */

describe('localeDisplayName', () => {
  it('maps known locale tags to a friendly name', () => {
    expect(localeDisplayName('en')).toBe('English')
    expect(localeDisplayName('pt-BR')).toBe('Portuguese (Brazil)')
  })

  it('falls back to the raw tag for an unknown locale', () => {
    expect(localeDisplayName('fr-CA')).toBe('fr-CA')
  })
})

describe('memoryLanguageLine', () => {
  it('names the effective locale (friendly name + raw tag)', () => {
    const line = memoryLanguageLine('pt-BR')
    expect(line).toContain('Portuguese (Brazil)')
    expect(line).toContain('`pt-BR`')
  })

  it('scopes the rule to persisted memory, not the chat language', () => {
    const line = memoryLanguageLine('en')
    expect(line).toContain('.harnu/memory/')
    expect(line).toMatch(/chat/i)
  })

  it('is a single preamble line (no embedded newlines)', () => {
    expect(memoryLanguageLine('en')).not.toContain('\n')
  })
})
