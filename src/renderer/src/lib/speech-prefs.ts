import { isSpeechBackendId, type SpeechBackendId } from './speech-backend'
import { resolveKokoroVoice } from './speech-kokoro-voices'
import { DEFAULT_VOICE_PHRASE, normalizeVoicePhrase } from './voice-phrase'

/**
 * Voice-engine preferences (T237). Parse-only, mirroring `parseNotifyPrefs` in
 * `stores/session-notify.ts`: this module owns the shape, the defaults and the
 * coercion; whoever holds the storage (the Voice settings pane, T239) owns the
 * read and the write.
 */

/** localStorage key. Keeps the legacy `om2tab.` prefix — see CLAUDE.md. */
export const VOICE_PREFS_KEY = 'om2tab.voice'

/**
 * NOTE — the TTS command is deliberately NOT in here. It lives in the main
 * process (`src/main/speech-command.ts`, `DEFAULT_SPEECH_COMMAND`), because a
 * `speech:say` message must never be able to name the executable it spawns.
 * Read/write it through `window.api.speechCommandGet` / `speechCommandSet`.
 */

/**
 * Roughly 60 seconds of speech. Past this the caller is expected to speak a
 * summary and say the rest is on screen — audio cannot be skimmed.
 */
export const DEFAULT_SPEECH_MAX_CHARS = 800

/** Hard ceiling for a configured `maxChars`, so a bad value can't wedge the queue. */
export const SPEECH_MAX_CHARS_CEILING = 5000

export interface VoicePrefs {
  /**
   * Master switch. Default OFF: speech is the most intrusive channel Harnu has,
   * and unlike the chime it cannot be ignored while it plays. The operator
   * opts in (same posture as `usageReset` in NotifyPrefs, for the same reason).
   */
  enabled: boolean
  /** Instant silence. Independent of `enabled` so muting doesn't lose the setup. */
  muted: boolean
  backend: SpeechBackendId
  /** Utterances longer than this are truncated at a word boundary. */
  maxChars: number
  /**
   * Which Kokoro voice speaks (T239). Ignored by the system-command backend,
   * which has no say in the matter — the operator's own TTS picks its own voice.
   * Coerced to a voice that exists, so a stale id from an older catalog can never
   * make the engine ask for an embedding that was never downloaded.
   */
  voice: string
  /**
   * The spoken phrase template — `{folder}` / `{session}` / `{event}` (T239).
   * See `voice-phrase.ts`: this is the whole value speech adds over the chime,
   * which is why it is a stored preference and not a hardcoded sentence.
   */
  phrase: string
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  enabled: false,
  muted: false,
  backend: 'system-command',
  maxChars: DEFAULT_SPEECH_MAX_CHARS,
  voice: resolveKokoroVoice(undefined),
  phrase: DEFAULT_VOICE_PHRASE
}

/**
 * Parse a stored `VoicePrefs` blob. Missing / corrupt / non-object input falls
 * back to {@link DEFAULT_VOICE_PREFS}; a partial object fills the rest from
 * defaults (forward-compatible); every field is coerced so a hand-edited or
 * half-migrated blob can never put the engine in an unrunnable state.
 */
export function parseVoicePrefs(raw: string | null): VoicePrefs {
  if (!raw) return { ...DEFAULT_VOICE_PREFS }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_VOICE_PREFS }
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_VOICE_PREFS }
  const o = parsed as Record<string, unknown>

  const maxChars = typeof o.maxChars === 'number' && Number.isFinite(o.maxChars) ? o.maxChars : NaN

  return {
    enabled: 'enabled' in o ? Boolean(o.enabled) : DEFAULT_VOICE_PREFS.enabled,
    muted: 'muted' in o ? Boolean(o.muted) : DEFAULT_VOICE_PREFS.muted,
    backend: isSpeechBackendId(o.backend) ? o.backend : DEFAULT_VOICE_PREFS.backend,
    maxChars: Number.isNaN(maxChars)
      ? DEFAULT_VOICE_PREFS.maxChars
      : Math.min(Math.max(Math.floor(maxChars), 1), SPEECH_MAX_CHARS_CEILING),
    voice: resolveKokoroVoice(o.voice),
    phrase: normalizeVoicePhrase(o.phrase)
  }
}

/**
 * Read the prefs from localStorage, total over a missing or hostile storage.
 * Safe to call at module scope and outside a browser (tests, node): with no
 * `localStorage` it returns the defaults rather than throwing.
 */
export function loadVoicePrefs(): VoicePrefs {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_VOICE_PREFS }
    return parseVoicePrefs(localStorage.getItem(VOICE_PREFS_KEY))
  } catch {
    return { ...DEFAULT_VOICE_PREFS }
  }
}
