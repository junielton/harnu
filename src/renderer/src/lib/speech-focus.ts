import type { SpeechSource } from './speech-backend'

/**
 * "Only speak what you cannot see" — the focus rule, alone in a module with no
 * imports that do anything.
 *
 * It lives here rather than in `speech.ts` because `speech.ts` constructs the
 * app-wide `SpeechService` singleton (and reads `localStorage`) at module scope.
 * The command router (T238's `speech.say`) needs this ONE pure predicate and
 * documents itself as a pure factory, so importing it must not drag a singleton
 * into every module that loads the router. `speech.ts` re-exports both names, so
 * the engine's public surface is unchanged.
 */

/** Where the operator's attention is, for the "only speak what you cannot see" rule. */
export interface SpeechFocus {
  windowFocused: boolean
  /** Is the utterance's session the one currently selected? */
  isSelected: boolean
}

export interface SpeechGateCtx extends SpeechFocus {
  source: SpeechSource
  enabled: boolean
  muted: boolean
}

/**
 * Pure, so the rule is unit-testable and has exactly one home — the same shape as
 * `decideNotification` in `stores/session-notify.ts`, which is where the rule
 * comes from.
 *
 * An **agent**-initiated utterance is suppressed for the session the operator is
 * staring at (window focused AND that session selected): they can already read
 * it. A **human**-initiated one is never suppressed — if the operator asked to
 * be read to, they get read to regardless of focus.
 */
export function shouldSpeak(ctx: SpeechGateCtx): boolean {
  if (!ctx.enabled) return false
  if (ctx.muted) return false
  if (ctx.source === 'human') return true
  return !(ctx.windowFocused && ctx.isSelected)
}
