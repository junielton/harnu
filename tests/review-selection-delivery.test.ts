import { describe, it, expect } from 'vitest'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import {
  NO_BINDING_REASONS,
  OUTCOME_NEXT,
  REFUSAL_NEXT,
  type DeliveryState,
  type SelectionStateEvent
} from '../src/main/companion/review-selection-core'
import {
  OUTCOME_KEYS,
  REFUSAL_KEYS,
  UNKNOWN_KEY,
  applyStateEvent,
  chipOf,
  copyWithheld,
  noBindingSteps,
  refuse,
  refuseUnknown,
  startDelivery,
  stepsFor,
  turnRunning,
  type DeliveryRecord
} from '../src/renderer/src/lib/review-selection-delivery'
import { HEAD_SHA, BASE_SHA } from './helpers/review-selection-fixture'

/**
 * T257 U2b — the delivery record, as pure functions (spec §7, §9).
 * U2b-AC-3 (every state and outcome has a closed string; an unmapped member fails),
 * U2b-AC-4 ("answered" only after "asked"; "sent" never for a failure).
 */

const get = (tree: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], tree)

const SEL = {
  id: 'sel_abc',
  subjectType: 'LINE' as const,
  path: 'src/main/speech.ts',
  oldPath: null,
  line: 12,
  side: 'RIGHT' as const,
  startLine: 11,
  startSide: 'RIGHT' as const,
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
  prNumber: null
}

const ev = (
  state: DeliveryState,
  extra: Partial<SelectionStateEvent> = {}
): SelectionStateEvent => ({
  selectionId: SEL.id,
  state,
  at: 1,
  ...extra
})

/** A `Record`, so adding a `DeliveryState` to main without listing it here fails to compile. */
const ALL_STATES: Record<DeliveryState, true> = {
  queued: true,
  delivered: true,
  asked: true,
  answered: true,
  'turn-stopped': true,
  'turn-declined': true,
  'turn-failed': true,
  cleared: true,
  ended: true,
  'not-delivered': true
}

describe('U2b-AC-3 — every state and outcome has a closed string', () => {
  it('maps exactly the main-side refusal union, in both locales', () => {
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(Object.keys(REFUSAL_NEXT).sort())
    for (const key of Object.values(REFUSAL_KEYS)) {
      expect(typeof get(en, key), key).toBe('string')
      expect(typeof get(ptBR, key), key).toBe('string')
    }
  })

  it('maps exactly the main-side outcome union, in both locales', () => {
    expect(Object.keys(OUTCOME_KEYS).sort()).toEqual(Object.keys(OUTCOME_NEXT).sort())
    for (const key of Object.values(OUTCOME_KEYS)) {
      expect(typeof get(en, key), key).toBe('string')
      expect(typeof get(ptBR, key), key).toBe('string')
    }
  })

  it('has a sentence for every NO_BINDING reason and for the fallback', () => {
    for (const reason of NO_BINDING_REASONS) {
      expect(typeof get(en, `review.selection.noBinding.${reason}`), reason).toBe('string')
      expect(typeof get(ptBR, `review.selection.noBinding.${reason}`), reason).toBe('string')
    }
    expect(typeof get(en, UNKNOWN_KEY)).toBe('string')
    expect(typeof get(ptBR, UNKNOWN_KEY)).toBe('string')
  })

  it('renders every delivery state through a key that exists', () => {
    for (const state of Object.keys(ALL_STATES) as DeliveryState[]) {
      const rec: DeliveryRecord = { ...startDelivery(SEL), phase: state, code: null }
      const { key } = chipOf(rec)
      expect(typeof get(en, key), `${state} → ${key}`).toBe('string')
      expect(typeof get(ptBR, key), `${state} → ${key}`).toBe('string')
    }
  })

  it('reads "Companion sees this" from delivered on, whatever the conversation does next', () => {
    // The chip answers "does the companion see the selection on screen?" — a question asked,
    // answered, stopped, declined or failed says nothing more about that, so it says nothing.
    const sees = 'review.selection.state.delivered'
    for (const s of [
      'delivered',
      'asked',
      'answered',
      'turn-stopped',
      'turn-declined',
      'turn-failed'
    ] as const) {
      expect(chipOf({ ...startDelivery(SEL), phase: s }).key, s).toBe(sees)
    }
    expect(chipOf(startDelivery(SEL)).key).toBe('review.selection.state.queued')
    // …and the vocabulary has no word for a question or an answer at all.
    const states = en.review.selection.state as Record<string, unknown>
    expect(Object.keys(states).sort()).toEqual(['cleared', 'delivered', 'ended', 'queued'])
    expect(JSON.stringify(en.review.selection.state)).not.toMatch(
      /asked|answered|declined|stopped/i
    )
  })

  it('shows one fixed sentence for a code this build does not know — never the code', () => {
    const refused = chipOf(refuse(startDelivery(SEL), { refusal: 'BRAND_NEW_REFUSAL' }))
    expect(refused.key).toBe(UNKNOWN_KEY)
    const unknownOutcome = applyStateEvent(
      startDelivery(SEL),
      ev('not-delivered', { code: 'BRAND_NEW_OUTCOME' as never })
    )
    expect(chipOf(unknownOutcome).key).toBe(UNKNOWN_KEY)
    expect(chipOf(refuseUnknown(startDelivery(SEL))).key).toBe(UNKNOWN_KEY)
  })

  it('carries no free text from main or the mod into the record', () => {
    const hostile = '<img src=x onerror=alert(1)> mod said: all good'
    const refused = refuse(startDelivery(SEL), {
      refusal: 'NO_BINDING',
      reason: hostile,
      next: ['copy', hostile],
      message: hostile,
      detail: hostile
    } as never)
    const outcome = applyStateEvent(
      startDelivery(SEL),
      ev('not-delivered', {
        code: 'CMD_FAILED',
        next: ['try-again', hostile as never],
        message: hostile
      } as never)
    )
    for (const r of [refused, outcome]) {
      expect(JSON.stringify(r)).not.toContain('mod said')
      expect(JSON.stringify(r)).not.toContain('onerror')
    }
    expect(refused.reason).toBeNull()
    // `next` is derived from the (unknown) reason, never copied from main's list: the hostile
    // entry cannot come through, and an unreadable reason means a companion that predates the mod.
    expect(refused.next).toEqual(['copy', 'reopen-companion'])
    expect(outcome.next).toEqual(['try-again'])
  })
})

describe('U2b-AC-4 — the forward-only path', () => {
  const at = (state: DeliveryState, extra: Partial<SelectionStateEvent> = {}): DeliveryRecord =>
    applyStateEvent(startDelivery(SEL), ev(state, extra))

  it('walks queued → delivered → asked → answered, and only that way', () => {
    let rec = startDelivery(SEL)
    expect(rec.phase).toBe('queued')
    rec = applyStateEvent(rec, ev('delivered'))
    expect(rec.phase).toBe('delivered')
    rec = applyStateEvent(rec, ev('asked'))
    expect(rec.phase).toBe('asked')
    rec = applyStateEvent(rec, ev('answered'))
    expect(rec.phase).toBe('answered')
  })

  it('"answered" is unreachable except through "asked"', () => {
    const queued = startDelivery(SEL)
    const delivered = at('delivered')
    for (const from of [queued, delivered]) {
      for (const s of ['answered', 'turn-stopped', 'turn-declined', 'turn-failed'] as const) {
        expect(applyStateEvent(from, ev(s)), `${from.phase} → ${s}`).toBe(from)
      }
    }
    expect(applyStateEvent(queued, ev('asked'))).toBe(queued)
  })

  it('"asked" may follow "delivered" in the same instant (a mid-turn append joins the turn)', () => {
    let rec = startDelivery(SEL)
    rec = applyStateEvent(rec, ev('delivered', { at: 5 }))
    rec = applyStateEvent(rec, ev('asked', { at: 5 }))
    expect(rec.phase).toBe('asked')
  })

  it('stops at "delivered" when no turn event ever arrives', () => {
    const rec = at('delivered')
    expect(chipOf(rec).key).toBe('review.selection.state.delivered')
    expect(rec.phase).toBe('delivered')
  })

  it('never shows the "sent" state for expired, lost or dropped', () => {
    const sentKey = 'review.selection.state.delivered'
    for (const code of Object.keys(OUTCOME_NEXT)) {
      const rec = at('not-delivered', { code: code as never, next: [] })
      expect(rec.phase).toBe('not-delivered')
      expect(chipOf(rec).key, code).not.toBe(sentKey)
      expect(chipOf(rec).key, code).toBe(OUTCOME_KEYS[code as keyof typeof OUTCOME_KEYS])
    }
  })

  it('a delivered row cannot become "not delivered" afterwards', () => {
    const delivered = at('delivered')
    expect(applyStateEvent(delivered, ev('not-delivered', { code: 'lost' }))).toBe(delivered)
  })

  it('ignores an event about another selection', () => {
    const rec = startDelivery(SEL)
    expect(applyStateEvent(rec, { ...ev('delivered'), selectionId: 'sel_other' })).toBe(rec)
  })

  it('treats a finished record as final', () => {
    for (const s of ['answered', 'cleared', 'ended', 'turn-failed'] as const) {
      const done: DeliveryRecord = { ...startDelivery(SEL), phase: s }
      for (const next of Object.keys(ALL_STATES) as DeliveryState[]) {
        expect(applyStateEvent(done, ev(next)), `${s} → ${next}`).toBe(done)
      }
    }
  })

  it('a clear after delivery says so; an end from any live state says so', () => {
    expect(applyStateEvent(at('delivered'), ev('cleared')).phase).toBe('cleared')
    expect(applyStateEvent(startDelivery(SEL), ev('cleared'))).toEqual(startDelivery(SEL))
    const asked = applyStateEvent(at('delivered'), ev('asked'))
    expect(asked.phase).toBe('asked')
    for (const rec of [startDelivery(SEL), at('delivered'), asked]) {
      expect(applyStateEvent(rec, ev('ended')).phase).toBe('ended')
    }
  })
})

describe('copy and next steps', () => {
  it('withholds Copy only after a moved head or base (the text would be stale)', () => {
    for (const code of Object.keys(REFUSAL_NEXT)) {
      const rec = refuse(startDelivery(SEL), { refusal: code, next: REFUSAL_NEXT[code as never] })
      const stale = code === 'head-moved' || code === 'base-mismatch'
      expect(copyWithheld(rec), code).toBe(stale)
    }
    expect(copyWithheld(null)).toBe(false)
    for (const code of Object.keys(OUTCOME_NEXT)) {
      const rec = applyStateEvent(startDelivery(SEL), ev('not-delivered', { code: code as never }))
      expect(copyWithheld(rec), code).toBe(false)
    }
  })

  it("mirrors main's next steps, minus the persistent Copy action", () => {
    const rec = refuse(startDelivery(SEL), { refusal: 'QUEUE_FULL', next: REFUSAL_NEXT.QUEUE_FULL })
    expect(stepsFor(rec)).toEqual(['try-again'])
    expect(stepsFor(refuse(startDelivery(SEL), { refusal: 'HEADLESS', next: ['copy'] }))).toEqual(
      []
    )
  })

  it('records the NO_BINDING reason it was given, and falls back to "unknown"', () => {
    const given = refuse(startDelivery(SEL), {
      refusal: 'NO_BINDING',
      reason: 'cli-too-old',
      next: []
    })
    expect(chipOf(given).reasonKey).toBe('review.selection.noBinding.cli-too-old')
    const none = refuse(startDelivery(SEL), { refusal: 'NO_BINDING', next: [] })
    expect(chipOf(none).reasonKey).toBe('review.selection.noBinding.unknown')
    expect(
      chipOf(refuse(startDelivery(SEL), { refusal: 'QUEUE_FULL', next: [] })).reasonKey
    ).toBeNull()
  })
})

describe('NO_BINDING leads where its reason says (no dead ends)', () => {
  const noBinding = (reason?: string) =>
    refuse(startDelivery(SEL), {
      refusal: 'NO_BINDING',
      // main's one list always offers Mods settings; the renderer must not trust it blindly
      next: REFUSAL_NEXT.NO_BINDING,
      ...(reason ? { reason } : {})
    })

  it('offers Mods settings only when the mod is actually off', () => {
    expect(stepsFor(noBinding('off'))).toEqual(['open-mods-settings'])
  })

  it('a companion that predates the mod needs a NEW companion, not Settings', () => {
    for (const reason of ['not-claude', 'pre-disclosure', 'unknown', undefined]) {
      const steps = stepsFor(noBinding(reason))
      expect(steps, String(reason)).toEqual(['reopen-companion'])
      expect(steps, String(reason)).not.toContain('open-mods-settings')
    }
  })

  it('a CLI the mod cannot use is fixed by neither, and Copy stays', () => {
    for (const reason of ['cli-too-old', 'cli-unknown']) {
      expect(stepsFor(noBinding(reason)), reason).toEqual([])
      expect(noBinding(reason).next, reason).toContain('copy')
    }
  })

  it('covers every reason main can name', () => {
    for (const reason of NO_BINDING_REASONS) {
      expect(noBindingSteps(reason).includes('copy'), reason).toBe(true)
    }
  })
})

describe('turns and cleared conversations (the hold, and the re-send)', () => {
  it('a turn is running only between "asked" and its end', () => {
    let rec = startDelivery(SEL)
    expect(turnRunning(rec)).toBe(false)
    rec = applyStateEvent(rec, ev('delivered'))
    expect(turnRunning(rec)).toBe(false)
    rec = applyStateEvent(rec, ev('asked'))
    expect(turnRunning(rec)).toBe(true)
    for (const end of ['answered', 'turn-stopped', 'turn-declined', 'turn-failed'] as const) {
      expect(turnRunning(applyStateEvent(rec, ev(end))), end).toBe(false)
    }
    expect(turnRunning(null)).toBe(false)
  })

  it('a cleared conversation no longer holds the row and offers a re-send', () => {
    const cleared = applyStateEvent(
      applyStateEvent(startDelivery(SEL), ev('delivered')),
      ev('cleared')
    )
    expect(chipOf(cleared).key).toBe('review.selection.state.cleared')
    expect(stepsFor(cleared)).toEqual(['try-again'])
  })
})
