import { describe, it, expect } from 'vitest'
import {
  deriveAutonamePrompt,
  parseAutonameResult,
  clampTitle,
  clampSummary,
  shouldAutoname,
  buildHaikuArgs,
  AUTONAME_SYSTEM
} from '../src/main/haiku-autoname'

describe('buildHaikuArgs', () => {
  it('caps to --model haiku and appends the system prompt (exact argv)', () => {
    expect(buildHaikuArgs('PROMPT', 'SYS')).toEqual([
      '-p',
      'PROMPT',
      '--model',
      'haiku',
      '--append-system-prompt',
      'SYS'
    ])
  })
  it('omits the system flag when none is given, and never uses --bare', () => {
    expect(buildHaikuArgs('PROMPT')).toEqual(['-p', 'PROMPT', '--model', 'haiku'])
    expect(buildHaikuArgs('PROMPT')).not.toContain('--bare')
  })
})

describe('deriveAutonamePrompt', () => {
  it('wraps non-empty user text into a non-empty prompt that contains it', () => {
    const p = deriveAutonamePrompt('add a rate-limit cockpit to the usage panel')
    expect(p).not.toBe('')
    expect(p).toContain('add a rate-limit cockpit to the usage panel')
  })
  it('returns empty string for empty / whitespace-only input (handler aborts)', () => {
    expect(deriveAutonamePrompt('')).toBe('')
    expect(deriveAutonamePrompt('   \n  ')).toBe('')
  })
})

describe('AUTONAME_SYSTEM', () => {
  it('is a non-empty instruction string', () => {
    expect(typeof AUTONAME_SYSTEM).toBe('string')
    expect(AUTONAME_SYSTEM.length).toBeGreaterThan(0)
  })
})

describe('parseAutonameResult', () => {
  it('parses a well-formed JSON object', () => {
    const r = parseAutonameResult('{"title":"add cockpit","summary":"Adds a rate-limit cockpit."}')
    expect(r).toEqual({ title: 'add cockpit', summary: 'Adds a rate-limit cockpit.' })
  })
  it('parses JSON embedded in surrounding prose', () => {
    const r = parseAutonameResult(
      'Sure!\n{"title":"fix auth","summary":"Fixes the auth bug."}\nDone'
    )
    expect(r.title).toBe('fix auth')
    expect(r.summary).toBe('Fixes the auth bug.')
  })
  it('falls back to loose title:/summary: lines', () => {
    const r = parseAutonameResult('title: add cockpit\nsummary: Adds a cockpit.')
    expect(r).toEqual({ title: 'add cockpit', summary: 'Adds a cockpit.' })
  })
  it('returns empty fields for garbage or empty stdout without throwing', () => {
    expect(parseAutonameResult('blah blah no structure')).toEqual({ title: '', summary: '' })
    expect(parseAutonameResult('')).toEqual({ title: '', summary: '' })
  })
  it('fills what it can when a JSON field is missing', () => {
    expect(parseAutonameResult('{"title":"only a title"}')).toEqual({
      title: 'only a title',
      summary: ''
    })
  })
})

describe('clampTitle', () => {
  it('strips surrounding quotes, a trailing period, and collapses whitespace', () => {
    expect(clampTitle('  "add  rate-limit cockpit."  ')).toBe('add rate-limit cockpit')
  })
  it('truncates to <= 60 chars', () => {
    expect(clampTitle('x'.repeat(80)).length).toBeLessThanOrEqual(60)
  })
  it('keeps technical nouns intact (no translation, no forced casing)', () => {
    expect(clampTitle('resume worktree on release branch')).toBe(
      'resume worktree on release branch'
    )
  })
})

describe('clampSummary', () => {
  it('flattens to a single line and collapses whitespace', () => {
    expect(clampSummary('line one\nline two')).toBe('line one line two')
  })
  it('truncates to <= 120 chars', () => {
    expect(clampSummary('y'.repeat(200)).length).toBeLessThanOrEqual(120)
  })
})

describe('shouldAutoname', () => {
  const base = {
    enabled: true,
    synthetic: true,
    hasCustomOrAiTitle: false,
    alreadyNamed: false,
    firstUserText: 'do a thing'
  }
  it('fires when enabled, synthetic, unnamed, and there is first-user text', () => {
    expect(shouldAutoname(base)).toBe(true)
  })
  it('does not fire when the feature is off', () => {
    expect(shouldAutoname({ ...base, enabled: false })).toBe(false)
  })
  it('does not fire for a non-synthetic session', () => {
    expect(shouldAutoname({ ...base, synthetic: false })).toBe(false)
  })
  it('does not fire when a custom/ai title already exists', () => {
    expect(shouldAutoname({ ...base, hasCustomOrAiTitle: true })).toBe(false)
  })
  it('does not fire when already named by Haiku', () => {
    expect(shouldAutoname({ ...base, alreadyNamed: true })).toBe(false)
  })
  it('does not fire when the first user text is empty', () => {
    expect(shouldAutoname({ ...base, firstUserText: '   ' })).toBe(false)
  })
})
