import { clampSpeechText, speechErrorMessageKey, type SpeakOutcome } from './speech'
import { shouldSpeak } from './speech-focus'
import type { SpeechErrorCode, SpeechSource } from './speech-backend'

/**
 * What the Voice pane renders while (and after) it asks the engine to speak
 * (BUG-104).
 *
 * The Test button's entire output is audio — the one output an operator cannot
 * see. Four completely different situations look identical without this module:
 * the OS is muted, the first Kokoro call is loading ~92 MB of model, the gate
 * dropped the utterance on purpose, or the backend failed and the chime covered
 * it. `speak()` already distinguishes them; it resolves with a
 * {@link SpeakOutcome} rather than throwing precisely so a caller can tell a
 * real failure from the rule working. All the pane was missing is the rendering.
 *
 * Everything here is pure: a phase in, an i18n key + a tone out. The pane owns
 * the timing, this module owns the wording, and `en.json` owns the words.
 */

/**
 * The probe's lifecycle. `pending` covers the click itself — before the engine
 * has taken the utterance, which on a cold Kokoro is the beat where the model
 * loads — and the four terminal phases are exactly `SpeakOutcome`, so no
 * outcome the engine can report is unrenderable here.
 */
export type SpeechProbePhase = 'idle' | 'pending' | 'speaking' | SpeakOutcome

/**
 * WHY an utterance was dropped. `speak()` collapses all of these into
 * `'dropped'` because the engine owes its callers a decision, not a diagnosis —
 * so the pane re-derives the reason from the same inputs the gate read. A
 * `dropped` with no reason attached would be the bug this card is about, one
 * layer down: "nothing happened", again.
 *
 * `unknown` is the honest floor: a drop the re-derivation cannot account for
 * (the prefs moved between the read and the call) says "nothing was spoken" and
 * stops there, rather than naming a cause it does not have.
 */
export type SpeechDropReason = 'empty' | 'disabled' | 'muted' | 'focus' | 'unknown'

/** How the line is coloured. Maps to tokens in the pane — never to a raw color. */
export type SpeechProbeTone = 'busy' | 'ok' | 'info' | 'warn'

export interface SpeechDropCtx {
  text: string
  maxChars: number
  enabled: boolean
  muted: boolean
  source: SpeechSource
  windowFocused?: boolean
  isSelected?: boolean
}

/**
 * Re-derive why `speak()` would drop this utterance, in the SAME order the
 * engine checks: the text is clamped first (an empty clamp is dropped before
 * the gate is even consulted), then `shouldSpeak`. Returns `null` when nothing
 * would drop it — the caller then trusts the real outcome instead.
 *
 * This is a SECOND projection of a decision `speak()` already makes, which is
 * the shape that silently drifts (`docs/lessons/code-patterns/003-derived-
 * classifier-must-mirror-its-canonical-source.md`). Two things keep it honest:
 * the `enabled`/`muted` branches only NAME the two early-outs `shouldSpeak`
 * already has, everything else is delegated to `shouldSpeak` itself rather than
 * paraphrased; and `tests/voice-probe.test.ts` pins the two against each other
 * over the whole input cartesian product, so a new rule in the gate fails here
 * instead of quietly rendering as "the focus rule".
 */
export function speechDropReason(ctx: SpeechDropCtx): SpeechDropReason | null {
  if (!clampSpeechText(ctx.text, ctx.maxChars)) return 'empty'
  if (!ctx.enabled) return 'disabled'
  if (ctx.muted) return 'muted'
  if (
    !shouldSpeak({
      source: ctx.source,
      enabled: ctx.enabled,
      muted: ctx.muted,
      windowFocused: ctx.windowFocused ?? false,
      isSelected: ctx.isSelected ?? false
    })
  ) {
    return 'focus'
  }
  return null
}

export interface SpeechProbeView {
  phase: SpeechProbePhase
  /** The i18n key to render, or `null` when there is nothing to say yet. */
  messageKey: string | null
  tone: SpeechProbeTone
  /** True while the engine still owes an outcome — the controls stay disabled. */
  busy: boolean
}

export interface SpeechProbeDetail {
  dropReason?: SpeechDropReason | null
  errorCode?: SpeechErrorCode | null
}

/**
 * One phase → one line of copy. A failure borrows the engine's own error
 * vocabulary (`speechErrorMessageKey`), which names WHAT failed — a missing
 * command, a model that was never downloaded — and never guesses at the
 * operator's volume knob. `voice.test.failed` is the last resort for a failure
 * the engine could not code.
 */
export function speechProbeView(
  phase: SpeechProbePhase,
  detail: SpeechProbeDetail = {}
): SpeechProbeView {
  switch (phase) {
    case 'pending':
      return { phase, messageKey: 'voice.test.pending', tone: 'busy', busy: true }
    case 'speaking':
      return { phase, messageKey: 'voice.test.speaking', tone: 'busy', busy: true }
    case 'spoken':
      return { phase, messageKey: 'voice.test.spoken', tone: 'ok', busy: false }
    case 'dropped':
      return {
        phase,
        // No reason means no reason is claimed — never a guess dressed as one.
        messageKey: `voice.test.dropped.${detail.dropReason ?? 'unknown'}`,
        tone: 'info',
        busy: false
      }
    case 'stopped':
      return { phase, messageKey: 'voice.test.stopped', tone: 'info', busy: false }
    case 'failed':
      return {
        phase,
        messageKey: speechErrorMessageKey(detail.errorCode ?? null) ?? 'voice.test.failed',
        tone: 'warn',
        busy: false
      }
    default:
      return { phase: 'idle', messageKey: null, tone: 'info', busy: false }
  }
}
