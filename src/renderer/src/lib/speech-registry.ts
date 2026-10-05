import type { SpeechBackend, SpeechBackendId } from './speech-backend'
import { createSystemCommandBackend } from './speech-system-command'
import { createKokoroBackend } from './speech-kokoro'

/**
 * The backend registry (T237) — the one place a speech backend is wired in.
 *
 * `SpeechService` never imports a backend module: it is handed a
 * `resolveBackend(id)` and only ever calls `speak`. Adding a second backend is
 * therefore a new module plus one entry here; the queue, the mute, the focus
 * gate and every caller are untouched (AC-5).
 *
 * T241 added `kokoro` and this file grew by exactly the one line the seam
 * promised — the proof that the abstraction held.
 */

/**
 * What a factory is handed. Only the prefs a backend can actually act on — the
 * queue, the mute and the focus gate stay above the seam and are none of its
 * business. `voice` is Kokoro's; the system command has no voice to pick.
 */
export interface SpeechBackendContext {
  /**
   * Read fresh on each utterance rather than captured, so changing the voice in
   * the Voice pane does NOT rebuild the backend — and so does not discard the
   * loaded model along with it.
   */
  voice?: () => string | undefined
}

export type SpeechBackendFactory = (ctx?: SpeechBackendContext) => SpeechBackend

export const SPEECH_BACKENDS: Record<SpeechBackendId, SpeechBackendFactory> = {
  // The operator's own TTS command chooses its own voice; there is nothing here
  // for Harnu to pass down, so the context is deliberately ignored.
  'system-command': () => createSystemCommandBackend(),
  // T239: the Voice pane's chosen voice, coerced by `resolveKokoroVoice` inside
  // the backend — an unset or stale id falls back to `af_heart` (the only
  // A-graded voice) rather than asking for an embedding that was never fetched.
  kokoro: (ctx) => createKokoroBackend({ ...(ctx?.voice ? { voice: ctx.voice } : {}) })
}

/**
 * The one place the app composes a backend from live preferences. `getPrefs` is
 * a getter, not a snapshot: the voice is read at utterance time, so the engine
 * never has to be rebuilt (and the model never reloaded) to change it.
 */
export function resolveSpeechBackend(
  id: SpeechBackendId,
  getPrefs: () => { voice?: string }
): SpeechBackend | null {
  return SPEECH_BACKENDS[id]?.({ voice: () => getPrefs().voice }) ?? null
}
