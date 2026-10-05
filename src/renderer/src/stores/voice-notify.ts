import type { SpeakOutcome } from '../lib/speech'
import type { NotifyKind } from './session-notify'

/**
 * The pure half of "speak the notification" (T239).
 *
 * Voice does not invent a second notification decision: it rides the one
 * `decideNotification` already made, so the master switch and the three event
 * toggles (`needsInput` / `completed` / `failed`) gate speech exactly as they
 * gate the toast, the OS notification and the chime. That is deliberate — the
 * card asks for "the three existing notification events", not for a parallel set
 * the operator would have to keep in sync by hand.
 *
 * What is new here is only the two decisions the notification path did not have
 * before: which WORD names the event, and when a failed utterance owes the
 * operator a chime.
 */

/**
 * The i18n key naming each event in a spoken phrase. These are the `{event}`
 * substitution — a fragment ("is waiting for you"), not a title, because it is
 * read out mid-sentence rather than shown as a heading.
 */
export const VOICE_EVENT_KEY: Record<NotifyKind, string> = {
  'needs-input': 'voice.events.needsInput',
  completed: 'voice.events.completed',
  failed: 'voice.events.failed'
}

/**
 * Product rule 3, decided as a value rather than buried in a callback.
 *
 * A voice that could not speak must NOT leave the operator with nothing — but it
 * also must not double up on a chime that already played. So the fallback fires
 * on exactly one combination: the utterance genuinely `failed`, and the
 * notification's own chime was suppressed (the operator turned the sound off, or
 * `decideNotification` muted it).
 *
 * Every other outcome is a deliberate silence and owes nothing: `dropped` is the
 * focus rule or the mute working, `stopped` is the operator cutting speech off,
 * and `spoken` needs no consolation prize. The REASON for a failure stays
 * visible in the Voice pane's status line — quiet, not hidden.
 */
export function needsChimeFallback(outcome: SpeakOutcome, chimeAlreadyPlayed: boolean): boolean {
  return outcome === 'failed' && !chimeAlreadyPlayed
}
