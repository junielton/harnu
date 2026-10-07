import { describe, expect, it } from 'vitest'
import { parseClaudeVersion } from '../../src/main/claude-cli-version'
import {
  COMPANION_MIN_CLI,
  cliGate,
  gateAllowsInjection
} from '../../src/main/companion/version-gate'

const CEILING = '2.1.289'
const gateOf = (s: string | null) => cliGate(s === null ? null : parseClaudeVersion(s), CEILING)

describe('cliGate', () => {
  it('minimum is 2.1.287', () => {
    expect(COMPANION_MIN_CLI).toBe('2.1.287')
  })

  it('gate table', () => {
    expect(gateOf(null)).toBe('unknown')
    expect(gateOf('2.1.286')).toBe('below')
    expect(gateOf('2.1.287')).toBe('ok')
    expect(gateOf('2.1.289')).toBe('ok')
    expect(gateOf('2.1.290')).toBe('above')
    expect(gateOf('2.2.0')).toBe('above')
  })

  it('allows injection for ok and above only', () => {
    expect(gateAllowsInjection('unknown')).toBe(false)
    expect(gateAllowsInjection('below')).toBe(false)
    expect(gateAllowsInjection('ok')).toBe(true)
    expect(gateAllowsInjection('above')).toBe(true)
  })

  it('a prerelease of the minimum is below it', () => {
    expect(gateOf('2.1.287-beta.1')).toBe('below')
  })
})
