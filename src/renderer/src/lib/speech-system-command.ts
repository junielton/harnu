import { SpeechError, isSpeechErrorCode, type SpeechBackend } from './speech-backend'
import type { SpeechUtterance } from './speech-backend'

/**
 * The system-command speech backend (T237) — the only backend this card ships.
 *
 * It speaks by asking the main process to run the operator's TTS command with
 * the utterance as its last argument. The spawn has to happen in main (the
 * renderer cannot start a process), and so does the choice of *which* command:
 * this backend sends text and an id, never an executable. See
 * `src/main/speech.ts` for why that split is deliberate.
 *
 * Serialisation caveat, worth knowing before configuring a command: the backend
 * resolves when the spawned process EXITS. A command that backgrounds its own
 * playback and returns immediately (plain `spd-say` without `-w` does this)
 * cannot be serialised by any caller, so utterances may still overlap in the
 * speakers. Configure a blocking command (`say`, `spd-say -w`, `espeak`) for real
 * serialisation. The engine's queue is correct either way; what it can
 * observe is bounded by what the command reports.
 *
 * The mirror of that bound: a configured command that never exits holds the
 * queue open indefinitely. There is deliberately no timeout — guessing how long
 * a legitimate utterance may take would cut real speech short — so the escape
 * hatch is the mute: `stop()` aborts the signal, which kills the process. The
 * engine's state reports `speaking: true` throughout, so the stall is visible
 * rather than silent.
 */

/** Failure codes the main-process shell can report back. */
export type SpeechCommandFailure = 'invalid-command' | 'command-not-found' | 'command-failed'

export interface SpeechSayOutcome {
  ok: boolean
  error?: SpeechCommandFailure | string
  detail?: string
}

/** The seam onto the preload bridge — injected in tests, defaulted in the app. */
export interface SpeechCommandPort {
  say(req: { id: string; text: string }): Promise<SpeechSayOutcome>
  cancel(id: string): void
}

let utteranceSeq = 0

/** Monotonic per-renderer id. Deterministic (no randomness) so tests can assert it. */
export function nextUtteranceId(): string {
  utteranceSeq += 1
  return `speech-${utteranceSeq}`
}

/** Test seam: reset the id counter between cases. */
export function resetUtteranceIds(): void {
  utteranceSeq = 0
}

export interface SystemCommandBackendOptions {
  /** Defaults to the `window.api` bridge. */
  port?: SpeechCommandPort
}

/** The slice of `window.api` this backend needs (see `src/preload/index.ts`). */
interface SpeechBridge {
  speechSay(req: { id: string; text: string }): Promise<SpeechSayOutcome>
  speechCancel(id: string): void
}

/** Resolve the preload bridge, or null when it isn't there (tests, torn-down window). */
function bridgePort(): SpeechCommandPort | null {
  const api = (globalThis as { window?: { api?: Partial<SpeechBridge> } }).window?.api
  if (!api || typeof api.speechSay !== 'function' || typeof api.speechCancel !== 'function') {
    return null
  }
  const { speechSay, speechCancel } = api as SpeechBridge
  return {
    say: (req) => speechSay(req),
    cancel: (id) => speechCancel(id)
  }
}

export function createSystemCommandBackend(
  options: SystemCommandBackendOptions = {}
): SpeechBackend {
  return {
    id: 'system-command',
    async speak(utterance: SpeechUtterance, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return

      const port = options.port ?? bridgePort()
      if (!port) throw new SpeechError('bridge-unavailable', 'window.api.speechSay is missing')

      const id = nextUtteranceId()
      const onAbort = (): void => {
        try {
          port.cancel(id)
        } catch {
          // Cancelling a process that already exited is not an error.
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const outcome = await port.say({ id, text: utterance.text })
        if (signal.aborted) return
        if (!outcome.ok) {
          const code = isSpeechErrorCode(outcome.error) ? outcome.error : 'command-failed'
          throw new SpeechError(code, outcome.detail)
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }
}
