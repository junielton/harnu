import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VOICE_PHRASE,
  VOICE_PHRASE_MAX_CHARS,
  VOICE_PHRASE_TOKENS,
  normalizeVoicePhrase,
  normalizeFolderForSpeech,
  normalizeSessionForSpeech,
  renderVoicePhrase
} from '../src/renderer/src/lib/voice-phrase'
import { needsChimeFallback, VOICE_EVENT_KEY } from '../src/renderer/src/stores/voice-notify'

/**
 * T239 product rule 2 — "what it says IS the product". These are the rules that
 * decide whether a spoken notification carries the session's name and what
 * happened, or degrades into the "Done" that is worth less than the chime.
 */

describe('renderVoicePhrase — the {folder}/{session}/{event} template', () => {
  it('substitutes all three tokens (the card’s own example)', () => {
    expect(
      renderVoicePhrase(DEFAULT_VOICE_PHRASE, {
        folder: 'harnu',
        session: 'feat t216',
        event: 'is waiting for you'
      })
    ).toBe('harnu — feat t216 is waiting for you')
  })

  it('exposes exactly the three documented tokens', () => {
    expect([...VOICE_PHRASE_TOKENS]).toEqual(['folder', 'session', 'event'])
  })

  it('drops an UNKNOWN placeholder rather than reading the braces aloud', () => {
    // A typo must not become "open brace sesion close brace" in the speakers.
    expect(
      renderVoicePhrase('{folder} {sesion} {event}', { folder: 'harnu', event: 'failed' })
    ).toBe('harnu failed')
  })

  it('drops a known-but-empty value and tidies the separator it leaves behind', () => {
    // A session with no summary yet: the phrase degrades to the parts that have
    // content instead of speaking a dangling em dash.
    expect(
      renderVoicePhrase(DEFAULT_VOICE_PHRASE, { folder: 'harnu', session: '  ', event: 'finished' })
    ).toBe('harnu finished')
  })

  it('collapses whitespace so a multi-line template is one breath', () => {
    expect(renderVoicePhrase('{folder}\n\n  {event}', { folder: 'harnu', event: 'finished' })).toBe(
      'harnu finished'
    )
  })

  it('trims separators left dangling at either end', () => {
    expect(renderVoicePhrase('— {event} ·', { event: 'finished' })).toBe('finished')
  })

  it('returns an empty string when nothing survives, so the caller can stay silent', () => {
    expect(renderVoicePhrase('{folder} {session}', {})).toBe('')
  })

  it('is total over a non-string template', () => {
    expect(renderVoicePhrase(undefined as unknown as string, { event: 'x' })).toBe('')
  })
})

describe('normalizeVoicePhrase — storing a template', () => {
  it('falls back to the default rather than storing an empty phrase', () => {
    // An empty field would silently disable speech while the switch still reads
    // "on" — the mute-with-no-explanation this card forbids.
    expect(normalizeVoicePhrase('   ')).toBe(DEFAULT_VOICE_PHRASE)
    expect(normalizeVoicePhrase('')).toBe(DEFAULT_VOICE_PHRASE)
    expect(normalizeVoicePhrase(null)).toBe(DEFAULT_VOICE_PHRASE)
    expect(normalizeVoicePhrase(42)).toBe(DEFAULT_VOICE_PHRASE)
  })

  it('keeps a real template, collapsed and capped', () => {
    expect(normalizeVoicePhrase('  {session}   {event} ')).toBe('{session} {event}')
    expect(normalizeVoicePhrase('x'.repeat(500))).toHaveLength(VOICE_PHRASE_MAX_CHARS)
  })
})

describe('needsChimeFallback — product rule 3', () => {
  it('fires only when speech FAILED and no chime had already played', () => {
    expect(needsChimeFallback('failed', false)).toBe(true)
  })

  it('does not double up on a chime that already sounded', () => {
    expect(needsChimeFallback('failed', true)).toBe(false)
  })

  it('owes nothing for a deliberate silence', () => {
    // `dropped` is the focus rule / mute working; `stopped` is the operator
    // cutting speech off. Neither is a failure, so neither earns a fallback.
    expect(needsChimeFallback('dropped', false)).toBe(false)
    expect(needsChimeFallback('stopped', false)).toBe(false)
    expect(needsChimeFallback('spoken', false)).toBe(false)
  })
})

/**
 * BUG-129 — a spoken notification must sound like a phrase a person would say,
 * not a spelled-out identifier. These normalizers run before `renderVoicePhrase`
 * substitutes `{folder}`/`{session}`; a value that normalizes to `''` is dropped
 * by `renderVoicePhrase` together with its separator (see above), so these
 * tests only assert the normalized text, never the full rendered phrase.
 */
describe('normalizeFolderForSpeech — {folder} for the ear', () => {
  it('leaves a plain alias untouched (AC-7 sample value)', () => {
    expect(normalizeFolderForSpeech('harnu')).toBe('harnu')
  })

  it('collapses a path to its last segment before anything else runs (AC-3)', () => {
    expect(normalizeFolderForSpeech('/home/x/Workspace/harnu')).toBe('harnu')
    expect(normalizeFolderForSpeech('C:\\Users\\x\\Workspace\\harnu')).toBe('harnu')
  })

  it('drops a bare UUID, a synthetic id, or a git SHA to the empty string (AC-1)', () => {
    expect(normalizeFolderForSpeech('3f9a1234-5678-90ab-cdef-1234567890ab')).toBe('')
    expect(normalizeFolderForSpeech('synthetic-3f9a1234-5678-90ab-cdef-1234567890ab')).toBe('')
    expect(normalizeFolderForSpeech('a1b2c3d')).toBe('') // 7-char hex SHA
    expect(normalizeFolderForSpeech('deadbeefcafebabe0123456789abcdef01234567')).toBe('') // 40-char
  })

  it('turns the card worktree slug into words with the key attached, dropping the "card-" prefix (AC-2, worked example)', () => {
    expect(
      normalizeFolderForSpeech(
        'card-BUG-117-kokoro-synthesis-runs-on-the-renderer-main-thread-and-freezes'
      )
    ).toBe('bug 117, kokoro synthesis runs on')
  })

  it('drops other branch-style prefixes', () => {
    expect(normalizeFolderForSpeech('feat/t216-quiet-hours')).toBe('t216 quiet hours')
    expect(normalizeFolderForSpeech('origin-main')).toBe('main')
  })

  it('drops the dash-form prefix a slugified worktree dir carries, but keeps "docs-"', () => {
    expect(normalizeFolderForSpeech('/repo/.claude/worktrees/fix-bug-42-toast')).toBe(
      'bug 42, toast'
    )
    expect(normalizeFolderForSpeech('feat-login-flow')).toBe('login flow')
    expect(normalizeFolderForSpeech('docs-site')).toBe('docs site')
  })

  it('keeps a short tracker key with no separator attached, lowercased (AC-2, the T239 case)', () => {
    // Chosen form: no space forced between letters and digits when the slug
    // never separated them — "T239" reads as "t239", not "T two three nine".
    expect(normalizeFolderForSpeech('T239')).toBe('t239')
  })

  it('caps folder speech at a key plus a handful of content words (AC-4: 2 key words + 4 content words)', () => {
    expect(normalizeFolderForSpeech('one-two-three-four-five-six-seven-eight')).toBe(
      'one two three four five six'
    )
  })

  it('strips emoji, backticks and brackets before checking anything else (AC-5)', () => {
    expect(normalizeFolderForSpeech('🔈 harnu')).toBe('harnu')
    expect(normalizeFolderForSpeech('`harnu`')).toBe('harnu')
  })

  it('returns an empty string for a value that is unspeakable after stripping (AC-5)', () => {
    expect(normalizeFolderForSpeech('🔈🔈🔈')).toBe('')
  })

  it('is total over non-string, null and empty input', () => {
    expect(normalizeFolderForSpeech(null)).toBe('')
    expect(normalizeFolderForSpeech(undefined)).toBe('')
    expect(normalizeFolderForSpeech('   ')).toBe('')
  })
})

describe('normalizeSessionForSpeech — {session} for the ear', () => {
  it('leaves a short prose summary untouched (AC-7 sample value)', () => {
    expect(normalizeSessionForSpeech('feat t216')).toBe('feat t216')
  })

  it('drops a bare UUID or synthetic session id to the empty string (AC-1)', () => {
    expect(normalizeSessionForSpeech('3f9a1234-5678-90ab-cdef-1234567890ab')).toBe('')
    expect(normalizeSessionForSpeech('synthetic-3f9a1234-5678-90ab-cdef-1234567890ab')).toBe('')
  })

  it('cuts at the first clause boundary once past the minimum length (AC-4: 20-char minimum)', () => {
    expect(
      normalizeSessionForSpeech(
        'Kokoro synthesis has pending questions, waiting on the operator to answer'
      )
    ).toBe('Kokoro synthesis has pending questions')
  })

  it('does not cut at a clause boundary before the minimum length', () => {
    expect(normalizeSessionForSpeech('Fix, then ship')).toBe('Fix, then ship')
  })

  it('still cuts at a later boundary when an earlier one sits before the minimum', () => {
    expect(
      normalizeSessionForSpeech(
        'Refactor sessions.ts to split the notification path, then add tests'
      )
    ).toBe('Refactor sessions.ts to split the notification path')
    expect(normalizeSessionForSpeech('Fix, then refactor the store; add tests')).toBe(
      'Fix, then refactor the store'
    )
  })

  it('hard-caps a long summary with no early clause boundary on a word boundary (AC-4: 60-char cap)', () => {
    expect(
      normalizeSessionForSpeech('Kokoro synthesis runs on the renderer main thread and freezes')
    ).toBe('Kokoro synthesis runs on the renderer main thread and')
  })

  it('strips emoji and markdown emphasis before speaking (AC-5)', () => {
    expect(normalizeSessionForSpeech('🔈 Kokoro')).toBe('Kokoro')
    expect(normalizeSessionForSpeech('**Kokoro** synthesis')).toBe('Kokoro synthesis')
  })

  it('leaves no trailing punctuation after truncation', () => {
    expect(normalizeSessionForSpeech('Done.')).toBe('Done')
  })

  it('is total over non-string, null and empty input', () => {
    expect(normalizeSessionForSpeech(null)).toBe('')
    expect(normalizeSessionForSpeech(undefined)).toBe('')
    expect(normalizeSessionForSpeech('   ')).toBe('')
  })
})

describe('VOICE_EVENT_KEY', () => {
  it('names every notify kind, so no event can silently lose its word', () => {
    expect(Object.keys(VOICE_EVENT_KEY).sort()).toEqual(['completed', 'failed', 'needs-input'])
  })
})
