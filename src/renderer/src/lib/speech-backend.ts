/**
 * The backend seam for the voice engine (T237).
 *
 * A backend is the only part of the engine that knows HOW a string becomes
 * audio. Everything above it — the queue, the mute, the focus gate, the state
 * every caller reads — lives in `speech.ts` and is backend-agnostic by
 * construction: it only ever calls {@link SpeechBackend.speak} and aborts the
 * signal it handed over.
 *
 * Two implementations exist: `speech-system-command.ts` (T237 — spawns the
 * operator's own TTS command) and `speech-kokoro.ts` (T241 — a downloaded
 * offline neural voice). Adding a third means a new member in
 * {@link SpeechBackendId}, a new module implementing this interface, and one
 * line in `speech-registry.ts`. The queue, the mute and the callers do not
 * change — T241 added a backend without touching any of them.
 */

/**
 * Machine-readable failure reasons. Deliberately a closed set: the engine never
 * surfaces a raw exception message as its state — a caller (and, later, the
 * Voice settings pane) maps the code to a translated string via
 * `speechErrorMessageKey`. The free-form `detail` rides alongside for logs.
 */
export const SPEECH_ERROR_CODES = [
  /** No backend is registered for the configured id. */
  'no-backend',
  /** The configured command is empty, or has an unterminated quote. */
  'invalid-command',
  /** The command is not on PATH (spawn ENOENT). */
  'command-not-found',
  /** The command ran and exited non-zero, or the spawn itself faulted. */
  'command-failed',
  /** The preload bridge is missing — no `window.api.speechSay` to call. */
  'bridge-unavailable',
  /**
   * The Kokoro backend is selected but nothing has been downloaded (T241).
   * Deliberately NOT a trigger: the engine reports this and stays quiet, it
   * never starts a ~119 MB fetch on its own (AC-3).
   */
  'model-missing',
  /** The downloaded engine is present but failed to load or to synthesise. */
  'engine-unavailable',
  /** No usable audio output — no `AudioContext` in this window. */
  'audio-unavailable'
] as const

export type SpeechErrorCode = (typeof SPEECH_ERROR_CODES)[number]

export function isSpeechErrorCode(value: unknown): value is SpeechErrorCode {
  return typeof value === 'string' && (SPEECH_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * The error a backend rejects with. Carries a {@link SpeechErrorCode} on `code`.
 *
 * Consumers read `.code` structurally rather than using `instanceof` — the
 * object crosses no realm boundary today, but a future worker-hosted backend
 * would, and a structural read keeps that swap free.
 */
export class SpeechError extends Error {
  readonly code: SpeechErrorCode

  constructor(code: SpeechErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'SpeechError'
    this.code = code
  }
}

/** Reads a {@link SpeechErrorCode} off an unknown throwable. */
export function speechErrorCodeOf(err: unknown): SpeechErrorCode {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return isSpeechErrorCode(code) ? code : 'command-failed'
}

/** The registered backends. One member per implementation — see the module doc. */
export type SpeechBackendId = 'system-command' | 'kokoro'

export const SPEECH_BACKEND_IDS: readonly SpeechBackendId[] = ['system-command', 'kokoro']

export function isSpeechBackendId(value: unknown): value is SpeechBackendId {
  return typeof value === 'string' && (SPEECH_BACKEND_IDS as readonly string[]).includes(value)
}

/**
 * Who asked for this utterance. Drives the focus gate in `shouldSpeak`: an
 * agent speaking on its own initiative obeys "only speak what you cannot see";
 * an operator who asked to be read to is never gated.
 */
export type SpeechSource = 'agent' | 'human'

export interface SpeechUtterance {
  /** Already normalised and length-capped by the service. */
  text: string
  source: SpeechSource
  /** The session this utterance belongs to, when it has one. */
  sessionId?: string
}

export interface SpeechBackend {
  readonly id: SpeechBackendId
  /**
   * Speak `utterance`, resolving when the audio is done (or as close as the
   * backend can observe). Rejects with a {@link SpeechError} on failure.
   *
   * `signal` is aborted by `stop()` / mute. A backend must stop its audio as
   * soon as it can and is free to resolve or reject afterwards — the service
   * discards the outcome of an aborted utterance either way.
   */
  speak(utterance: SpeechUtterance, signal: AbortSignal): Promise<void>
}
