/**
 * T257 U2b — the delivery record behind the selection bar's chip, as pure functions.
 *
 * Spec: `docs/specs/2026-10-20-t257-review-selection.md` §7 and §9. `main` reports what happened as
 * stable CODES (`review:selection:state`, and the refusal of `review:selection:send`); this file is
 * the only place those codes become a record and then a `review.selection.*` string key. Every map
 * here is a `Record` over the main-side union, so a member added there and not mapped here does not
 * compile — and a runtime code this build does not know falls back to one fixed sentence, never to
 * the code and never to any text main or the model wrote (PRD P7).
 *
 * There is ONE record (`last`), never a list: nothing here counts, totals or reports a ratio
 * (PRD D7). "Answered" means a turn the operator started after delivery completed — nothing else
 * (spec §9.3); the transitions below only ever move forward along `queued → delivered → asked →
 * answered`, so it cannot be reached out of order.
 */

import type {
  DeliveryState,
  NextStep,
  NoBindingReason,
  OutcomeCode,
  SelectionRefusalCode,
  SelectionStateEvent
} from '../../../main/companion/review-selection-core'
import { rangeLabelOf, type RangeLabel, type ReviewSelection } from './review-selection'

export type { DeliveryState, NextStep, NoBindingReason, OutcomeCode, SelectionRefusalCode }

/** A delivery state, or `refused`: the send never reached the queue. */
export type DeliveryPhase = DeliveryState | 'refused'

export interface DeliveryRecord {
  /** The selection this record is about (`sel_…`); the key every state event carries. */
  selectionId: string
  phase: DeliveryPhase
  /** The refusal (`refused`) or the outcome (`not-delivered`). `null` = a code this build lacks. */
  code: SelectionRefusalCode | OutcomeCode | null
  /** `NO_BINDING` only. */
  reason: NoBindingReason | null
  next: readonly NextStep[]
  /** What it was about, kept so the chip can name it once the live selection moves on. */
  path: string
  range: RangeLabel
}

// ---- the closed vocabularies -----------------------------------------------------------------

const NEXT_STEPS: ReadonlySet<string> = new Set<NextStep>([
  'copy',
  'try-again',
  'open-mods-settings',
  'reselect',
  'refresh',
  'reopen-companion'
])

const NO_BINDING_REASONS: ReadonlySet<string> = new Set<NoBindingReason>([
  'off',
  'cli-too-old',
  'cli-unknown',
  'pre-disclosure',
  'not-claude',
  'unknown'
])

/** Spec §7.1 and §7.2: one i18n key per refusal. A `Record`, so an unmapped member fails to compile. */
export const REFUSAL_KEYS: Readonly<Record<SelectionRefusalCode, string>> = {
  NO_BINDING: 'review.selection.outcome.NO_BINDING',
  NO_LEASE: 'review.selection.outcome.NO_LEASE',
  STICKY_LEGACY: 'review.selection.outcome.STICKY_LEGACY',
  HEADLESS: 'review.selection.outcome.HEADLESS',
  EXTERNAL: 'review.selection.outcome.EXTERNAL',
  FEATURE_OFF: 'review.selection.outcome.FEATURE_OFF',
  MODE_SHADOW: 'review.selection.outcome.MODE_SHADOW',
  ORIGIN_DENIED: 'review.selection.outcome.ORIGIN_DENIED',
  TARGET_DENIED: 'review.selection.outcome.TARGET_DENIED',
  FOLDER_BLOCKED: 'review.selection.outcome.FOLDER_BLOCKED',
  BAD_ARGS: 'review.selection.outcome.BAD_ARGS',
  QUEUE_FULL: 'review.selection.outcome.QUEUE_FULL',
  SID_UNSETTLED: 'review.selection.outcome.SID_UNSETTLED',
  AUDIT_FAILED: 'review.selection.outcome.AUDIT_FAILED',
  'head-moved': 'review.selection.outcome.head-moved',
  'base-mismatch': 'review.selection.outcome.base-mismatch',
  'head-unreadable': 'review.selection.outcome.head-unreadable',
  'no-companion': 'review.selection.outcome.no-companion'
}

/** Spec §7.3: one i18n key per way a queued command ends without being delivered. */
export const OUTCOME_KEYS: Readonly<Record<OutcomeCode, string>> = {
  CMD_PRECONDITION: 'review.selection.outcome.CMD_PRECONDITION',
  CMD_UNSUPPORTED: 'review.selection.outcome.CMD_UNSUPPORTED',
  FEATURE_DISABLED: 'review.selection.outcome.FEATURE_DISABLED',
  CMD_FAILED: 'review.selection.outcome.CMD_FAILED',
  CMD_EXPIRED: 'review.selection.outcome.CMD_EXPIRED',
  expired: 'review.selection.outcome.expired',
  lost: 'review.selection.outcome.lost',
  'dropped-lease-lost': 'review.selection.outcome.dropped.lease-lost',
  'dropped-rebound': 'review.selection.outcome.dropped.rebound',
  'dropped-session-end': 'review.selection.outcome.dropped.session-end',
  'dropped-revoked': 'review.selection.outcome.dropped.revoked',
  'dropped-host-shutdown': 'review.selection.outcome.dropped.host-shutdown',
  'dropped-cancelled': 'review.selection.outcome.dropped.cancelled'
}

/** Spec §9.2: the chip text of each state that is not an outcome. */
const STATE_KEYS: Readonly<Record<Exclude<DeliveryState, 'not-delivered'>, string>> = {
  queued: 'review.selection.state.queued',
  delivered: 'review.selection.state.delivered',
  asked: 'review.selection.state.asked',
  answered: 'review.selection.state.answered',
  'turn-stopped': 'review.selection.state.stopped.aborted',
  'turn-declined': 'review.selection.state.stopped.refusal',
  'turn-failed': 'review.selection.state.stopped.error',
  cleared: 'review.selection.state.cleared',
  ended: 'review.selection.state.ended'
}

/** What a code this build does not know shows. One fixed sentence; the code itself never renders. */
export const UNKNOWN_KEY = 'review.selection.outcome.unknown'

const has = <T extends object>(table: T, key: string): key is Extract<keyof T, string> =>
  Object.prototype.hasOwnProperty.call(table, key)

// ---- building the record ---------------------------------------------------------------------

/** The record a send starts from: the row is on its way, nothing is confirmed. */
export function startDelivery(sel: ReviewSelection): DeliveryRecord {
  return {
    selectionId: sel.id,
    phase: 'queued',
    code: null,
    reason: null,
    next: [],
    path: sel.path,
    range: rangeLabelOf(sel)
  }
}

/** The shape of a refused result, as far as this file reads it. */
export interface RefusalLike {
  refusal: string
  next?: unknown
  reason?: unknown
}

function stepsOf(raw: unknown): NextStep[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((s): s is NextStep => typeof s === 'string' && NEXT_STEPS.has(s))
}

/** The send (or the compose) was refused before anything was queued. */
export function refuse(rec: DeliveryRecord, r: RefusalLike): DeliveryRecord {
  return {
    ...rec,
    phase: 'refused',
    code: has(REFUSAL_KEYS, r.refusal) ? r.refusal : null,
    reason:
      typeof r.reason === 'string' && NO_BINDING_REASONS.has(r.reason)
        ? (r.reason as NoBindingReason)
        : null,
    next: stepsOf(r.next)
  }
}

/** The call itself failed (it is documented never to reject): nothing is known, so nothing is claimed. */
export function refuseUnknown(rec: DeliveryRecord): DeliveryRecord {
  return { ...rec, phase: 'refused', code: null, reason: null, next: [] }
}

// ---- following the tracker's events ------------------------------------------------------------

/**
 * Which state a given one may follow. The tracker only emits forward, and this repeats the rule on
 * the receiving side so that "Answered" is unreachable except through "Asked" (U2b-AC-4) even if an
 * event arrives twice or out of order.
 */
const MAY_FOLLOW: Readonly<Record<DeliveryState, readonly DeliveryPhase[]>> = {
  queued: [],
  delivered: ['queued'],
  asked: ['delivered'],
  answered: ['asked'],
  'turn-stopped': ['asked'],
  'turn-declined': ['asked'],
  'turn-failed': ['asked'],
  cleared: ['delivered', 'asked'],
  ended: ['queued', 'delivered', 'asked'],
  'not-delivered': ['queued']
}

/**
 * Fold one `review:selection:state` event into the record. Returns the SAME object when the event
 * is not about this selection or is not allowed at this point, so a caller can tell nothing changed.
 */
export function applyStateEvent(rec: DeliveryRecord, ev: SelectionStateEvent): DeliveryRecord {
  if (ev.selectionId !== rec.selectionId) return rec
  if (!has(MAY_FOLLOW, ev.state) || !MAY_FOLLOW[ev.state].includes(rec.phase)) return rec
  if (ev.state === 'not-delivered') {
    return {
      ...rec,
      phase: 'not-delivered',
      code: typeof ev.code === 'string' && has(OUTCOME_KEYS, ev.code) ? ev.code : null,
      reason: null,
      next: stepsOf(ev.next)
    }
  }
  return { ...rec, phase: ev.state, code: null, reason: null, next: [] }
}

// ---- what the chip shows ----------------------------------------------------------------------

export interface ChipText {
  /** The one sentence, an i18n key. */
  key: string
  /** A second, quieter sentence (`NO_BINDING`'s reason), an i18n key, or `null`. */
  reasonKey: string | null
}

export function chipOf(rec: DeliveryRecord): ChipText {
  if (rec.phase === 'refused') {
    const key =
      rec.code !== null && has(REFUSAL_KEYS, rec.code) ? REFUSAL_KEYS[rec.code] : UNKNOWN_KEY
    const reasonKey =
      rec.code === 'NO_BINDING' ? `review.selection.noBinding.${rec.reason ?? 'unknown'}` : null
    return { key, reasonKey }
  }
  if (rec.phase === 'not-delivered') {
    const key =
      rec.code !== null && has(OUTCOME_KEYS, rec.code) ? OUTCOME_KEYS[rec.code] : UNKNOWN_KEY
    return { key, reasonKey: null }
  }
  return { key: STATE_KEYS[rec.phase], reasonKey: null }
}

/** A record that can still change. The others are final until the next send. */
export function isFinished(rec: DeliveryRecord): boolean {
  return rec.phase !== 'queued' && rec.phase !== 'delivered' && rec.phase !== 'asked'
}

/**
 * Whether **Copy as text** is withheld: after a moved head or base the text would be stale
 * (spec §7.2). Every other failure state keeps it — it needs only git (U2b-AC-2).
 */
export function copyWithheld(rec: DeliveryRecord | null): boolean {
  return rec?.phase === 'refused' && (rec.code === 'head-moved' || rec.code === 'base-mismatch')
}

/** Where the operator goes next, without `copy` (that is the persistent action in the bar). */
export function stepsFor(rec: DeliveryRecord): NextStep[] {
  return rec.next.filter((s) => s !== 'copy')
}
