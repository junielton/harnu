import { describe, expect, it } from 'vitest'
import {
  compareClaudeVersions,
  isAtLeast,
  parseClaudeVersion
} from '../src/main/claude-cli-version'

const v = (s: string) => {
  const parsed = parseClaudeVersion(s)
  if (!parsed) throw new Error(`fixture did not parse: ${s}`)
  return parsed
}

describe('parseClaudeVersion', () => {
  it('parses the observed stdout verbatim', () => {
    expect(parseClaudeVersion('2.1.222 (Claude Code)\n')).toEqual({
      raw: '2.1.222 (Claude Code)',
      major: 2,
      minor: 1,
      patch: 222,
      prerelease: null
    })
  })

  it('parses a bare version, a prerelease and leading shim noise', () => {
    expect(parseClaudeVersion('1.0.6\n')).toMatchObject({ major: 1, minor: 0, patch: 6 })
    expect(parseClaudeVersion('2.1.193-beta.1 (Claude Code)')).toMatchObject({
      patch: 193,
      prerelease: 'beta.1'
    })
    expect(parseClaudeVersion('claude 2.1.287 (Claude Code)')).toMatchObject({ patch: 287 })
  })

  it('reads only the first non-empty line', () => {
    expect(parseClaudeVersion('\n\n2.1.5 (Claude Code)\nsee 9.9.9 for more')).toMatchObject({
      patch: 5
    })
  })

  it('returns null for empty, error and HTML output', () => {
    expect(parseClaudeVersion('')).toBeNull()
    expect(parseClaudeVersion('\n\n')).toBeNull()
    expect(parseClaudeVersion('command not found')).toBeNull()
    expect(parseClaudeVersion('<!doctype html><html><body>404</body></html>')).toBeNull()
  })
})

describe('compareClaudeVersions', () => {
  it('orders numerically, not lexicographically', () => {
    expect(compareClaudeVersions(v('2.1.9'), v('2.1.72'))).toBe(-1)
    expect(compareClaudeVersions(v('2.1.72'), v('2.1.222'))).toBe(-1)
    expect(compareClaudeVersions(v('2.1.222'), v('2.1.9'))).toBe(1)
    expect(compareClaudeVersions(v('2.10.0'), v('2.9.0'))).toBe(1)
    expect(compareClaudeVersions(v('3.0.0'), v('2.99.99'))).toBe(1)
  })

  it('sorts a prerelease below its release and treats equal as 0', () => {
    expect(compareClaudeVersions(v('2.1.193-beta.1'), v('2.1.193'))).toBe(-1)
    expect(compareClaudeVersions(v('2.1.193'), v('2.1.193-beta.1'))).toBe(1)
    expect(compareClaudeVersions(v('2.1.193'), v('2.1.193 (Claude Code)'))).toBe(0)
  })
})

describe('isAtLeast', () => {
  it('is false for an unknown version', () => {
    expect(isAtLeast(null, '2.1.80')).toBe(false)
  })

  it('is true at and above the target, false below', () => {
    expect(isAtLeast(v('2.1.222'), '2.1.80')).toBe(true)
    expect(isAtLeast(v('2.1.80'), '2.1.80')).toBe(true)
    expect(isAtLeast(v('2.1.79'), '2.1.80')).toBe(false)
  })
})
