import {
  SpeechError,
  speechErrorCodeOf,
  type SpeechBackend,
  type SpeechBackendId,
  type SpeechErrorCode,
  type SpeechSource,
  type SpeechUtterance
} from './speech-backend'
import { resolveSpeechBackend } from './speech-registry'
// T238: the focus rule moved to its own module so the command router can import
// it without also constructing the singleton at the bottom of this file. Both
// names are re-exported here, so the engine's public surface is unchanged.
import { shouldSpeak, type SpeechFocus, type SpeechGateCtx } from './speech-focus'
import { DEFAULT_VOICE_PREFS, loadVoicePrefs, type VoicePrefs } from './speech-prefs'

export { shouldSpeak }
export type { SpeechFocus, SpeechGateCtx }

/**
 * The voice engine (T237) — the hub every other voice card hangs off.
 *
 * One service turns a string into audio, serialises utterances so two callers
 * never overlap in the speakers, and can be silenced instantly. It owns three
 * things and nothing else:
 *
 *  - **a queue, not a mixer** — two concurrent `speak` calls serialise; with
 *    several sessions in a fleet, overlapping speech is unusable;
 *  - **a mute** — `stop()` kills what is playing AND drains what is queued;
 *  - **a readable state** — `state` / `subscribe` report speaking, depth and the
 *    last failure as a code, so a failed utterance is visible instead of silent.
 *
 * Audio lives in the renderer, following `notification-sound.ts`: the main
 * process has no audio device. `speak()` never throws into its caller — the
 * fail-soft posture of `playNotificationSound` applies to a whole engine here,
 * so a missing TTS command degrades a notification, it does not break a turn.
 */

export interface SpeechState {
  enabled: boolean
  muted: boolean
  /** An utterance is being spoken right now. */
  speaking: boolean
  /** Utterances waiting behind the current one. */
  queued: number
  backend: SpeechBackendId
  /** The last failure, or null once an utterance succeeds. */
  lastError: SpeechErrorCode | null
  /** Free-form detail for logs/diagnostics. Never rendered as-is. */
  lastErrorDetail: string | null
}

/**
 * What became of one `speak` call (T239). The engine never rejects, so a caller
 * that has to react to a failure — the notification path falls back to the
 * packaged chime when speech could not be heard — needs the outcome as a VALUE
 * rather than as an exception it will never catch.
 *
 *  - `spoken`  — the backend played it through to the end;
 *  - `dropped` — the gate said no (engine off, muted, or the operator is already
 *                looking at that session), or there was nothing to say. A
 *                success, not a fault: no fallback is owed;
 *  - `stopped` — a mute or `stop()` cut it short. Also deliberate;
 *  - `failed`  — the backend could not speak it. THIS is the one that owes the
 *                operator either a fallback sound or a visible reason, and the
 *                code is in `state.lastError`.
 */
export type SpeakOutcome = 'spoken' | 'dropped' | 'stopped' | 'failed'

export interface SpeakOptions {
  source: SpeechSource
  sessionId?: string
  /**
   * Apply the focus gate. Omit when the caller has already decided (or has no
   * session to reason about) — the utterance is then queued unconditionally.
   */
  focus?: SpeechFocus
}

/**
 * Normalise an utterance for the ear and for an argv slot: collapse whitespace
 * (a multi-line markdown blob is one breath, not one line per newline), drop
 * leading dashes so the text can never be read as a flag by the spawned
 * command, and truncate at a word boundary past `maxChars`.
 */
export function clampSpeechText(text: string, maxChars: number): string {
  if (typeof text !== 'string') return ''
  const flat = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-\s]+/, '')
  const limit = Math.max(1, Math.floor(maxChars))
  if (flat.length <= limit) return flat
  const head = flat.slice(0, limit)
  const lastSpace = head.lastIndexOf(' ')
  return (lastSpace > limit * 0.5 ? head.slice(0, lastSpace) : head).trimEnd()
}

/** The i18n key for a failure code. The engine reports codes; the UI renders text. */
export function speechErrorMessageKey(code: SpeechErrorCode | null): string | null {
  if (!code) return null
  const keys: Record<SpeechErrorCode, string> = {
    'no-backend': 'voice.error.noBackend',
    'invalid-command': 'voice.error.invalidCommand',
    'command-not-found': 'voice.error.commandNotFound',
    'command-failed': 'voice.error.commandFailed',
    'bridge-unavailable': 'voice.error.bridgeUnavailable',
    'model-missing': 'voice.error.modelMissing',
    'engine-unavailable': 'voice.error.engineUnavailable',
    'audio-unavailable': 'voice.error.audioUnavailable'
  }
  return keys[code]
}

interface QueueItem {
  utterance: SpeechUtterance
  controller: AbortController
  settle: (outcome: SpeakOutcome) => void
}

export interface SpeechServiceOptions {
  /**
   * Backend lookup. The ONLY place a second backend has to be wired in.
   *
   * It receives a GETTER for the current prefs alongside the id, because a
   * backend can be parameterised by them — Kokoro reads the chosen voice (T239)
   * on every utterance through it. A getter rather than a snapshot is what lets
   * the cached backend survive a voice change: rebuilding it would discard the
   * loaded model for a setting the engine takes per call.
   */
  resolveBackend: (id: SpeechBackendId, getPrefs: () => VoicePrefs) => SpeechBackend | null
  prefs?: VoicePrefs
}

export class SpeechService {
  private readonly resolveBackend: (
    id: SpeechBackendId,
    getPrefs: () => VoicePrefs
  ) => SpeechBackend | null
  private prefs: VoicePrefs
  private readonly queue: QueueItem[] = []
  private current: QueueItem | null = null
  private draining = false
  private lastError: SpeechErrorCode | null = null
  private lastErrorDetail: string | null = null
  private cachedId: SpeechBackendId | null = null
  private cachedBackend: SpeechBackend | null = null
  private readonly listeners = new Set<(state: SpeechState) => void>()

  constructor(options: SpeechServiceOptions) {
    this.resolveBackend = options.resolveBackend
    this.prefs = { ...DEFAULT_VOICE_PREFS, ...options.prefs }
  }

  get state(): SpeechState {
    return {
      enabled: this.prefs.enabled,
      muted: this.prefs.muted,
      speaking: this.current !== null,
      queued: this.queue.length,
      backend: this.prefs.backend,
      lastError: this.lastError,
      lastErrorDetail: this.lastErrorDetail
    }
  }

  /** Current preferences — a copy, so a caller can never mutate engine state. */
  get config(): VoicePrefs {
    return { ...this.prefs }
  }

  /** Subscribe to state changes. Returns an unsubscribe. */
  subscribe(listener: (state: SpeechState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Apply new preferences. Turning the engine off, muting it, or switching
   * backend stops what is playing and drains the queue — a half-spoken
   * utterance must not survive the change that was supposed to end it.
   */
  configure(patch: Partial<VoicePrefs>): void {
    const before = this.prefs
    this.prefs = { ...before, ...patch }
    const silencing =
      (before.enabled && !this.prefs.enabled) ||
      (!before.muted && this.prefs.muted) ||
      before.backend !== this.prefs.backend ||
      before.voice !== this.prefs.voice
    if (silencing) this.stop()
    else this.emit()
  }

  /** Instant silence (AC-2). Muting also drains — see `stop`. */
  setMuted(muted: boolean): void {
    this.configure({ muted })
  }

  /**
   * Queue an utterance. Resolves with the {@link SpeakOutcome} once it has been
   * spoken, dropped by the gate, stopped, or failed. **Never rejects** — a
   * backend failure lands in `state.lastError` AND in a `'failed'` outcome, so
   * no caller has to wrap `speak` in a try/catch (AC-3), and a caller that owes
   * the operator a fallback can tell a failure from a deliberate silence.
   */
  speak(text: string, options: SpeakOptions): Promise<SpeakOutcome> {
    const clean = clampSpeechText(text, this.prefs.maxChars)
    if (!clean) return Promise.resolve('dropped')

    const gate: SpeechGateCtx = {
      source: options.source,
      enabled: this.prefs.enabled,
      muted: this.prefs.muted,
      windowFocused: options.focus?.windowFocused ?? false,
      isSelected: options.focus?.isSelected ?? false
    }
    if (!shouldSpeak(gate)) return Promise.resolve('dropped')

    const utterance: SpeechUtterance = {
      text: clean,
      source: options.source,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
    }

    return new Promise<SpeakOutcome>((resolve) => {
      this.queue.push({ utterance, controller: new AbortController(), settle: resolve })
      this.emit()
      void this.drain()
    })
  }

  /**
   * Silence everything, immediately (AC-2): abort what is playing, then drain
   * everything queued. Every pending `speak` promise settles — a caller
   * awaiting an utterance that was muted away is released, not stranded.
   */
  stop(): void {
    this.current?.controller.abort()
    const dropped = this.queue.splice(0, this.queue.length)
    for (const item of dropped) {
      item.controller.abort()
      item.settle('stopped')
    }
    this.emit()
  }

  private backend(): SpeechBackend | null {
    if (this.cachedId !== this.prefs.backend) {
      this.cachedId = this.prefs.backend
      try {
        // A getter, not `this.prefs`: the backend reads the voice when it speaks,
        // so a voice change needs no re-resolution (and no model reload).
        this.cachedBackend = this.resolveBackend(this.prefs.backend, () => this.prefs)
      } catch {
        this.cachedBackend = null
      }
    }
    return this.cachedBackend
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const item = this.queue.shift()
        if (!item) break
        this.current = item
        this.emit()
        let outcome: SpeakOutcome = 'stopped'
        try {
          if (!item.controller.signal.aborted) {
            const backend = this.backend()
            if (!backend) throw new SpeechError('no-backend', this.prefs.backend)
            await backend.speak(item.utterance, item.controller.signal)
            // A mute that lands mid-utterance is a `stopped`, not a `spoken` —
            // the caller's fallback must not fire for speech the operator cut off.
            outcome = item.controller.signal.aborted ? 'stopped' : 'spoken'
            if (outcome === 'spoken') this.clearError()
          }
        } catch (err) {
          // An aborted utterance failing is the abort, not a fault — stay quiet.
          if (!item.controller.signal.aborted) {
            outcome = 'failed'
            this.fail(speechErrorCodeOf(err), err instanceof Error ? err.message : String(err))
          }
        } finally {
          this.current = null
          item.settle(outcome)
        }
      }
    } finally {
      this.draining = false
      this.emit()
    }
  }

  private fail(code: SpeechErrorCode, detail: string | null): void {
    this.lastError = code
    this.lastErrorDetail = detail
    console.warn('[speech] utterance failed', code, detail ?? '')
  }

  private clearError(): void {
    this.lastError = null
    this.lastErrorDetail = null
  }

  private emit(): void {
    if (this.listeners.size === 0) return
    const snapshot = this.state
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A subscriber that throws must never break the queue.
      }
    }
  }
}

/**
 * The app-wide engine. Composed here and nowhere else: the registry maps the
 * configured backend id to an implementation, and nothing above the seam knows
 * which one it got.
 */
export const speech = new SpeechService({
  resolveBackend: resolveSpeechBackend,
  prefs: loadVoicePrefs()
})
