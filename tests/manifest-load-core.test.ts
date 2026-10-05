import { describe, it, expect } from 'vitest'
import {
  parseManifest,
  resolveManifest,
  mergeRawManifests,
  DEFAULT_SCAN_LINES,
  DEFAULT_FALLBACK,
  type RawManifest
} from '../src/main/detect/manifest-load-core'
import { matchManifest, paneMatchesManifest } from '../src/main/detect/screen-detect-core'

/**
 * T4 — `parseManifest` validates + compiles an UNTRUSTED raw manifest into the
 * compiled shape `matchManifest` consumes. The invariants pinned here:
 *
 *   - a structurally invalid manifest is REJECTED with a reason (never a silent
 *     empty matcher);
 *   - a single broken regex / malformed rule is SKIPPED, not fatal — the rest of
 *     the set still compiles;
 *   - defaults fill `scan.lines` (30) and `fallback` (idle);
 *   - a local override takes precedence over the builtin (shallow per-key).
 */

const codexRaw: RawManifest = {
  agent: 'codex',
  match: { titleRegex: 'Codex', contentAny: ['codex>'] },
  scan: { lines: 30 },
  rules: [
    { state: 'blocked', any: ['\\(y/N\\)'] },
    { state: 'working', any: ['Thinking', '⠋|⠙|⠹'] },
    { state: 'idle', any: ['Type your message'] }
  ],
  fallback: 'idle'
}

describe('parseManifest — structural validation', () => {
  it('rejects a non-object with a reason', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      const r = parseManifest(bad)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/object/i)
    }
  })

  it('rejects a manifest with no agent', () => {
    const r = parseManifest({ rules: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/agent/i)
  })

  it('rejects an empty-string agent', () => {
    const r = parseManifest({ agent: '', rules: [] })
    expect(r.ok).toBe(false)
  })

  it('rejects when rules is not an array', () => {
    const r = parseManifest({ agent: 'codex', rules: { state: 'idle' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/rules/i)
  })

  it('accepts a minimal valid manifest', () => {
    const r = parseManifest({ agent: 'codex', rules: [] })
    expect(r.ok).toBe(true)
  })
})

describe('parseManifest — defaults', () => {
  it('defaults scan.lines and fallback when absent', () => {
    const r = parseManifest({ agent: 'codex', rules: [] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.scanLines).toBe(DEFAULT_SCAN_LINES)
      expect(r.manifest.fallback).toBe(DEFAULT_FALLBACK)
    }
  })

  it('rejects a non-positive or non-integer scan.lines back to the default', () => {
    for (const lines of [0, -5, 2.5, 'x']) {
      const r = parseManifest({ agent: 'codex', scan: { lines }, rules: [] })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.manifest.scanLines).toBe(DEFAULT_SCAN_LINES)
    }
  })

  it('keeps a valid scan.lines and fallback', () => {
    const r = parseManifest({ agent: 'codex', scan: { lines: 12 }, rules: [], fallback: 'working' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.scanLines).toBe(12)
      expect(r.manifest.fallback).toBe('working')
    }
  })

  it('ignores an invalid fallback enum and uses the default', () => {
    const r = parseManifest({ agent: 'codex', rules: [], fallback: 'banana' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.fallback).toBe(DEFAULT_FALLBACK)
  })
})

describe('parseManifest — resilient compilation (one bad regex never kills the set)', () => {
  it('skips a broken regex pattern but keeps the good ones', () => {
    const r = parseManifest({
      agent: 'codex',
      rules: [{ state: 'working', any: ['(unclosed', 'Thinking'] }]
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.rules).toHaveLength(1)
      expect(r.manifest.rules[0].any).toHaveLength(1)
      // The surviving pattern still matches.
      expect(matchManifest(['Thinking'], r.manifest)).toBe('working')
    }
  })

  it('drops a rule whose patterns are ALL broken, keeps sibling rules', () => {
    const r = parseManifest({
      agent: 'codex',
      rules: [
        { state: 'working', any: ['(', '['] }, // all broken → dropped
        { state: 'blocked', any: ['\\(y/N\\)'] } // survives
      ]
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.rules).toHaveLength(1)
      expect(r.manifest.rules[0].state).toBe('blocked')
    }
  })

  it('skips a malformed rule (bad state / non-array any) without rejecting', () => {
    const r = parseManifest({
      agent: 'codex',
      rules: [
        { state: 'nope', any: ['x'] }, // invalid state
        { state: 'idle', any: 'not-an-array' }, // any not array
        42, // not even an object
        { state: 'working', any: ['Thinking'] } // good
      ]
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.rules).toHaveLength(1)
      expect(r.manifest.rules[0].state).toBe('working')
    }
  })
})

describe('mergeRawManifests / resolveManifest — override precedence', () => {
  it('override top-level keys win, absent keys inherit the builtin', () => {
    const merged = mergeRawManifests(codexRaw, { fallback: 'working' })
    expect(merged.fallback).toBe('working')
    expect(merged.agent).toBe('codex') // inherited
    expect(merged.rules).toBe(codexRaw.rules) // inherited reference
  })

  it('an undefined override key does NOT clobber the builtin', () => {
    const merged = mergeRawManifests(codexRaw, { fallback: undefined })
    expect(merged.fallback).toBe('idle')
  })

  it('resolveManifest with no override just compiles the builtin', () => {
    const r = resolveManifest(codexRaw, null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.scanLines).toBe(30)
  })

  it('a rules override REPLACES the builtin rules wholesale', () => {
    const r = resolveManifest(codexRaw, {
      rules: [{ state: 'blocked', any: ['CONFIRM'] }]
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.rules).toHaveLength(1)
      // The builtin's "Thinking" working rule is gone; only the override's rule.
      expect(matchManifest(['Thinking'], r.manifest)).toBe('idle') // fallback
      expect(matchManifest(['please CONFIRM'], r.manifest)).toBe('blocked')
    }
  })

  it('does not mutate the inputs', () => {
    const builtin = { ...codexRaw }
    const override: RawManifest = { fallback: 'working' }
    mergeRawManifests(builtin, override)
    expect(builtin.fallback).toBe('idle')
    expect(override).toEqual({ fallback: 'working' })
  })
})

describe('parseManifest — match block compilation', () => {
  it('compiles titleRegex + contentAny into a working classifier', () => {
    const r = parseManifest(codexRaw)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(paneMatchesManifest('Codex CLI', [], r.manifest)).toBe(true)
      expect(paneMatchesManifest(null, ['codex> hi'], r.manifest)).toBe(true)
      expect(paneMatchesManifest('bash', ['$ ls'], r.manifest)).toBe(false)
    }
  })

  it('an absent match block compiles to a no-op classifier (claims nothing)', () => {
    const r = parseManifest({ agent: 'x', rules: [] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.match.titleRegex).toBeNull()
      expect(r.manifest.match.contentAny).toEqual([])
      expect(paneMatchesManifest('anything', ['anything'], r.manifest)).toBe(false)
    }
  })

  it('a broken titleRegex degrades to null without rejecting', () => {
    const r = parseManifest({ agent: 'x', match: { titleRegex: '(unclosed' }, rules: [] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.match.titleRegex).toBeNull()
  })

  it('drops a broken content pattern but keeps the good ones', () => {
    const r = parseManifest({
      agent: 'x',
      match: { contentAny: ['(broken', 'codex>'] },
      rules: []
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.match.contentAny).toHaveLength(1)
      expect(paneMatchesManifest(null, ['codex> '], r.manifest)).toBe(true)
    }
  })

  it('an override of match wins (per-key shallow merge)', () => {
    const r = resolveManifest(codexRaw, { match: { titleRegex: 'Aider' } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(paneMatchesManifest('Aider', [], r.manifest)).toBe(true)
      // The override replaced the whole match block → codex's title no longer claims.
      expect(paneMatchesManifest('Codex', [], r.manifest)).toBe(false)
    }
  })

  it('compiles match.process (array) into a classifier (W6.1)', () => {
    const r = parseManifest({ agent: 'x', match: { process: ['aider', 'codex'] }, rules: [] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.match.process).toHaveLength(2)
      expect(paneMatchesManifest(null, ['neutral'], r.manifest, 'aider')).toBe(true)
      expect(paneMatchesManifest(null, ['neutral'], r.manifest, 'zsh')).toBe(false)
    }
  })

  it('tolerates a bare-string match.process (single pattern)', () => {
    const r = parseManifest({ agent: 'x', match: { process: 'aider' }, rules: [] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.match.process).toHaveLength(1)
      expect(paneMatchesManifest(null, [], r.manifest, 'aider')).toBe(true)
    }
  })
})
