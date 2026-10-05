/**
 * The phrase template (T239) — what a spoken notification actually SAYS.
 *
 * This is the product, not decoration. The chime already tells the operator that
 * *something* happened; the only thing speech adds over it is naming **which
 * session** and **what**. A voice that says "Done" is strictly worse than the
 * chime, because it costs the same interruption and carries the same zero bits.
 *
 * Pure by construction (ADR-0001): rendering a template is data in / data out, so
 * the rules below are unit-testable without a window, an engine or an i18n
 * instance. The pane owns the storage, the store owns the wiring, and the event
 * word itself is translated by the caller before it gets here.
 */

import { basename } from '../components/folder-alias'

/**
 * A bare UUID (`3f9a...`), a `synthetic-<uuid>` id, or a standalone 7–40 char
 * hex string (a git SHA) — none of these are speakable, so `normalize*ForSpeech`
 * drops them to `''` and lets `renderVoicePhrase`'s separator-eating regex take
 * the rest (BUG-129 AC-1).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SYNTHETIC_ID_RE = new RegExp(`^synthetic-${UUID_RE.source.slice(1, -1)}$`, 'i')
const HEX_ID_RE = /^[0-9a-f]{7,40}$/i

/**
 * A leading branch/worktree prefix, dropped before the value is spoken (AC-2).
 * Matched AFTER `basename()`, so a slash form (`feat/x`) is already gone by then;
 * what survives is the dash form `slugifyBranch` writes worktree dirs as
 * (`fix-bug-42-toast`). `docs-` is deliberately absent: it is a plausible real
 * folder name (`docs-site`), and eating it costs more than saying "docs".
 */
const BRANCH_PREFIX_RE = /^(?:(?:card|feat(?:ure)?|fix|chore)[-/]|origin-)/i

/**
 * Pictographs/emoji, backticks, markdown emphasis markers and bracket
 * characters — none of these are speakable, and an engine that tries reads
 * "asterisk asterisk" or the raw codepoint name (AC-5). Emoji sequences (a
 * pictograph optionally chained with zero-width joiners and a variation
 * selector, e.g. an emoji-with-skin-tone or a flag) are matched separately
 * from the plain punctuation class — combining them in one character class
 * trips `no-misleading-character-class`, since U+200D (ZWJ) / U+FE0F (VS16) only mean
 * anything as part of a sequence, not as a standalone class member.
 */
const EMOJI_SEQUENCE_RE = new RegExp(
  '\\p{Extended_Pictographic}(?:\\u200D\\p{Extended_Pictographic})*\\uFE0F?',
  'gu'
)
const MARKDOWN_AND_BRACKET_CHARS_RE = /[`*_~[\](){}<>]/g

function stripUnspeakableChars(value: string): string {
  return value
    .replace(EMOJI_SEQUENCE_RE, ' ')
    .replace(MARKDOWN_AND_BRACKET_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isBareIdentifier(value: string): boolean {
  return UUID_RE.test(value) || SYNTHETIC_ID_RE.test(value) || HEX_ID_RE.test(value)
}

/**
 * `{folder}` for the ear: a path collapses to its last segment (AC-3), a
 * branch-style prefix is dropped, and slug separators (`- _ / .`) become word
 * breaks so `card-BUG-117-kokoro-synthesis-…` reads as words instead of dashes
 * (AC-2). Bounded to a "key" (a short letter word + a number, e.g. `bug 117`)
 * plus at most `FOLDER_CONTENT_WORD_LIMIT` more words — long enough to say
 * which card it is, short enough that a notification stays one breath (AC-4).
 * Numbers chosen and tested here: 2 key words, 4 content words.
 */
const FOLDER_KEY_WORD_COUNT = 2
const FOLDER_CONTENT_WORD_LIMIT = 4

export function normalizeFolderForSpeech(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (!text) return ''

  text = basename(text)
  text = stripUnspeakableChars(text)
  if (!text) return ''
  if (isBareIdentifier(text)) return ''

  text = text.replace(BRANCH_PREFIX_RE, '')
  text = text
    .replace(/[-_/.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
  if (!text) return ''
  if (isBareIdentifier(text)) return ''

  const words = text.split(' ').filter(Boolean)
  const hasKey =
    words.length >= FOLDER_KEY_WORD_COUNT && /^[a-z]{1,6}$/.test(words[0]) && /^\d+$/.test(words[1])

  if (!hasKey) {
    return words.slice(0, FOLDER_KEY_WORD_COUNT + FOLDER_CONTENT_WORD_LIMIT).join(' ')
  }
  const key = words.slice(0, FOLDER_KEY_WORD_COUNT).join(' ')
  const content = words.slice(
    FOLDER_KEY_WORD_COUNT,
    FOLDER_KEY_WORD_COUNT + FOLDER_CONTENT_WORD_LIMIT
  )
  return content.length ? `${key}, ${content.join(' ')}` : key
}

/**
 * `{session}` for the ear: a session label is usually prose already (the
 * summary), so unlike the folder it is NOT slug-word-split — only stripped of
 * unspeakable characters and bounded in length. Cut at the first clause
 * boundary (`. ; : , or " — "`) once past `SESSION_MIN_CHARS`, else hard-capped
 * at `SESSION_MAX_CHARS` on a word boundary, so a long summary trails off at a
 * natural pause instead of stopping mid-word or reading a wall of text.
 * Numbers chosen and tested here: min 20 chars before a clause boundary
 * counts, hard cap 60 chars.
 */
const SESSION_MIN_CHARS = 20
const SESSION_MAX_CHARS = 60
const CLAUSE_BOUNDARY_RE = /(?:\s+—\s+|[.;:,])/

export function normalizeSessionForSpeech(value: string | null | undefined): string {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  if (!text) return ''

  text = stripUnspeakableChars(text)
  if (!text) return ''
  if (isBareIdentifier(text)) return ''

  // Search only past the minimum: `exec` returns the FIRST match, so an early
  // comma would otherwise hide every later boundary and skip the cut entirely.
  const boundary = CLAUSE_BOUNDARY_RE.exec(text.slice(SESSION_MIN_CHARS))
  if (boundary) {
    text = text.slice(0, SESSION_MIN_CHARS + boundary.index).trim()
  }

  if (text.length > SESSION_MAX_CHARS) {
    const cut = text.slice(0, SESSION_MAX_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    text = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()
  }

  return text.replace(/[.;:,\s]+$/, '').trim()
}

/** The placeholders a template may use. Anything else is dropped, see `renderVoicePhrase`. */
export const VOICE_PHRASE_TOKENS = ['folder', 'session', 'event'] as const

export type VoicePhraseToken = (typeof VOICE_PHRASE_TOKENS)[number]

/**
 * The default template, and the reason the field exists at all: folder, session
 * and event, in the order an operator would say them out loud —
 * "harnu — feat t216 is waiting for you".
 */
export const DEFAULT_VOICE_PHRASE = '{folder} — {session} {event}'

/** Longest template we will store. A phrase, not an essay — the engine caps the rest. */
export const VOICE_PHRASE_MAX_CHARS = 200

export type VoicePhraseVars = Partial<Record<VoicePhraseToken, string>>

function isToken(name: string): name is VoicePhraseToken {
  return (VOICE_PHRASE_TOKENS as readonly string[]).includes(name)
}

/**
 * Substitute the known tokens and tidy what is left.
 *
 * Three rules, each of which exists because the alternative is spoken out loud:
 *
 *  - an **unknown** placeholder (`{sesion}`, a typo) is DROPPED rather than left
 *    verbatim — the engine would otherwise read the braces aloud;
 *  - a **known but empty** value (a session with no summary yet) is dropped
 *    TOGETHER WITH THE SEPARATOR IN FRONT OF IT, which is why the match also
 *    captures that separator: `"{folder} — {session} {event}"` with no session
 *    must say "harnu finished", not "harnu — finished";
 *  - the leftovers are then collapsed: repeated whitespace, separators that
 *    ended up adjacent, and any separator left dangling at either end.
 */
export function renderVoicePhrase(template: string, vars: VoicePhraseVars): string {
  const raw = typeof template === 'string' ? template : ''
  const substituted = raw.replace(
    /([\s·—–\-|,;:]*)\{([a-zA-Z]+)\}/g,
    (_all, separator: string, name: string) => {
      const value = isToken(name) ? (vars[name] ?? '').trim() : ''
      return value ? `${separator}${value}` : ''
    }
  )
  return substituted
    .replace(/\s+/g, ' ')
    .replace(/([·—–|,;:])\s*(?=[·—–|,;:])/g, '')
    .replace(/(?:^[\s·—–\-|,;:]+)|(?:[\s·—–\-|,;:]+$)/g, '')
    .trim()
}

/**
 * Coerce a stored/hand-edited template to something storable. An EMPTY template
 * returns the default rather than an empty string: a phrase field the operator
 * cleared would otherwise silently disable the feature while the switch still
 * reads "on", which is exactly the mute-with-no-explanation this card forbids.
 */
export function normalizeVoicePhrase(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_VOICE_PHRASE
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return DEFAULT_VOICE_PHRASE
  return flat.slice(0, VOICE_PHRASE_MAX_CHARS)
}
