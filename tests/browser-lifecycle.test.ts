/**
 * T574 (browser pane U7, AC-4) — discard / revive, pure: when a hidden pane is discarded, what is recorded, when it
 * comes back (spec §10.1, §2.3).
 */
import { describe, expect, it } from 'vitest'
import { createBrowserRegistry } from '../src/main/browser/registry'
import {
  DISCARD_MS_TEST_ENV,
  HIDDEN_DISCARD_MS,
  OPERATOR_RECENT_MS,
  buildDiscardState,
  createHiddenTracker,
  discardBlockedBy,
  opNeedsLivePage,
  planDiscard,
  resolveDiscardMs,
  reviveOnShow,
  sanitizeScroll,
  type DiscardFacts
} from '../src/main/browser/lifecycle'

const facts = (over: Partial<DiscardFacts> = {}): DiscardFacts => ({
  paneId: 'bp-1',
  discarded: false,
  hiddenSince: 0,
  verbInFlight: false,
  captureActive: false,
  operatorAt: null,
  downloadPending: false,
  ...over
})

describe('the discard time', () => {
  it('is ten minutes, one named constant', () => {
    expect(HIDDEN_DISCARD_MS).toBe(10 * 60 * 1000)
  })

  it('can be shortened by the test env var only in an unpackaged build', () => {
    expect(resolveDiscardMs({}, false)).toBe(HIDDEN_DISCARD_MS)
    expect(resolveDiscardMs({ [DISCARD_MS_TEST_ENV]: '5000' }, false)).toBe(5000)
    // packaged: the variable is ignored, whatever it says
    expect(resolveDiscardMs({ [DISCARD_MS_TEST_ENV]: '5000' }, true)).toBe(HIDDEN_DISCARD_MS)
  })

  it('ignores a value that is not a sane number of milliseconds', () => {
    for (const bad of ['', 'abc', '-5', '1.5', '10', '199', '99999999999', '700000', ' 5000']) {
      expect(resolveDiscardMs({ [DISCARD_MS_TEST_ENV]: bad }, false), bad).toBe(HIDDEN_DISCARD_MS)
    }
    expect(resolveDiscardMs({ [DISCARD_MS_TEST_ENV]: '200' }, false)).toBe(200)
    expect(resolveDiscardMs({ [DISCARD_MS_TEST_ENV]: String(HIDDEN_DISCARD_MS) }, false)).toBe(
      HIDDEN_DISCARD_MS
    )
  })
})

describe('the hidden tracker', () => {
  it('keeps the first moment of a hidden stretch and clears it when the pane is shown', () => {
    const t = createHiddenTracker()
    expect(t.since('p')).toBeNull()
    t.markHidden('p', 100)
    t.markHidden('p', 900) // still the same stretch
    expect(t.since('p')).toBe(100)
    t.markShown('p')
    expect(t.since('p')).toBeNull()
    t.markHidden('p', 2000) // a new stretch
    expect(t.since('p')).toBe(2000)
    t.forget('p')
    expect(t.since('p')).toBeNull()
  })
})

describe('when a pane is discarded (spec §10.1)', () => {
  const MS = HIDDEN_DISCARD_MS

  it('discards a pane hidden for the whole time', () => {
    expect(discardBlockedBy(facts(), MS, MS)).toBeNull()
    expect(discardBlockedBy(facts(), MS + 1, MS)).toBeNull()
  })

  it('never before the time is up, and never while it is shown', () => {
    expect(discardBlockedBy(facts(), MS - 1, MS)).toBe('too-soon')
    expect(discardBlockedBy(facts({ hiddenSince: null }), MS * 5, MS)).toBe('shown')
  })

  it('never while a verb is in flight', () => {
    expect(discardBlockedBy(facts({ verbInFlight: true }), MS * 2, MS)).toBe('verb')
  })

  it('never while network capture is active', () => {
    expect(discardBlockedBy(facts({ captureActive: true }), MS * 2, MS)).toBe('capture')
  })

  it('never while a download is arriving or waiting for an answer', () => {
    expect(discardBlockedBy(facts({ downloadPending: true }), MS * 2, MS)).toBe('download')
  })

  it('never while an operator interaction is recent', () => {
    const now = MS * 2
    expect(discardBlockedBy(facts({ operatorAt: now - OPERATOR_RECENT_MS + 1 }), now, MS)).toBe(
      'operator'
    )
    expect(discardBlockedBy(facts({ operatorAt: now - OPERATOR_RECENT_MS }), now, MS)).toBeNull()
    expect(discardBlockedBy(facts({ operatorAt: 5 }), now, MS)).toBeNull()
  })

  it('does nothing for a pane that is already discarded', () => {
    expect(discardBlockedBy(facts({ discarded: true }), MS * 2, MS)).toBe('discarded')
  })

  it('plans exactly the panes that pass, in order', () => {
    const now = MS * 2
    const plan = planDiscard(
      [
        facts({ paneId: 'a' }),
        facts({ paneId: 'b', hiddenSince: null }),
        facts({ paneId: 'c', verbInFlight: true }),
        facts({ paneId: 'd', hiddenSince: now - 1 }),
        facts({ paneId: 'e' })
      ],
      now,
      MS
    )
    expect(plan).toEqual(['a', 'e'])
  })

  it('a parked pane counts as hidden from the moment it was parked', () => {
    // the host marks a pane hidden when it parks it; the tracker then drives the same rule
    const t = createHiddenTracker()
    t.markHidden('p', 1000)
    expect(discardBlockedBy(facts({ hiddenSince: t.since('p') }), 1000 + MS, MS)).toBeNull()
    expect(discardBlockedBy(facts({ hiddenSince: t.since('p') }), 1000 + MS - 1, MS)).toBe(
      'too-soon'
    )
  })
})

describe('what is recorded at discard', () => {
  it('keeps the address, scroll, zoom and how long the pane was hidden', () => {
    const s = buildDiscardState({
      reason: 'idle',
      url: 'http://localhost:3000/cart',
      title: 'Cart',
      scroll: { x: 0, y: 1234.6 },
      zoom: 1.25,
      now: 700_000,
      hiddenSince: 100_000
    })
    expect(s).toEqual({
      reason: 'idle',
      url: 'http://localhost:3000/cart',
      title: 'Cart',
      scroll: { x: 0, y: 1235 },
      zoom: 1.25,
      discardedAt: 700_000,
      hiddenMs: 600_000
    })
  })

  it('survives a page that gave no scroll, a bad zoom and no hidden time', () => {
    const s = buildDiscardState({
      reason: 'restored',
      url: 'about:blank',
      title: '',
      scroll: null,
      zoom: Number.NaN,
      now: 5,
      hiddenSince: null
    })
    expect(s).toMatchObject({ scroll: null, zoom: 1, hiddenMs: 0 })
  })

  it('cleans a scroll position from untrusted input', () => {
    expect(sanitizeScroll({ x: -5, y: 10 })).toEqual({ x: 0, y: 10 })
    expect(sanitizeScroll({ x: 1, y: Infinity })).toBeNull()
    expect(sanitizeScroll({ x: '1', y: 2 })).toBeNull()
    expect(sanitizeScroll(null)).toBeNull()
    expect(sanitizeScroll({ x: 1e12, y: 0 })).toEqual({ x: 10_000_000, y: 0 })
  })
})

describe('coming back', () => {
  it('a verb that needs a live page revives the pane; the ones that do not, never', () => {
    for (const op of [
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_console',
      'browser_wait_for',
      'browser_eval',
      'browser_click',
      'browser_type',
      'browser_fill',
      'browser_press',
      'browser_emulate',
      'browser_upload',
      'browser_download',
      'browser_patch'
    ]) {
      expect(opNeedsLivePage(op), op).toBe(true)
    }
    for (const op of ['browser_open', 'browser_list', 'browser_close', 'browser_set_data']) {
      expect(opNeedsLivePage(op), op).toBe(false)
    }
  })

  it('browser_network revives only to start a capture', () => {
    expect(opNeedsLivePage('browser_network', { action: 'start' })).toBe(true)
    expect(opNeedsLivePage('browser_network', { action: 'read' })).toBe(false)
    expect(opNeedsLivePage('browser_network', { action: 'stop' })).toBe(false)
  })

  it('a restored pane loads when it is shown; an idle discard waits for the click', () => {
    expect(reviveOnShow('restored')).toBe(true)
    expect(reviveOnShow('idle')).toBe(false)
  })
})

describe('the registry facts the sweep reads', () => {
  it('counts verbs in flight per pane, and an end is idempotent', () => {
    const reg = createBrowserRegistry(() => 1)
    const endA = reg.beginVerb('p')
    const endB = reg.beginVerb('p')
    expect(reg.verbsInFlight('p')).toBe(2)
    endA()
    endA()
    expect(reg.verbsInFlight('p')).toBe(1)
    endB()
    expect(reg.verbsInFlight('p')).toBe(0)
    expect(reg.verbsInFlight('other')).toBe(0)
  })

  it('reports a revival once, and forgets everything with the pane', () => {
    const reg = createBrowserRegistry(() => 1)
    expect(reg.takeRevived('p')).toBe(false)
    reg.noteRevived('p')
    expect(reg.takeRevived('p')).toBe(true)
    expect(reg.takeRevived('p')).toBe(false)
    reg.noteRevived('p')
    reg.beginVerb('p')
    reg.remove('p')
    expect(reg.takeRevived('p')).toBe(false)
    expect(reg.verbsInFlight('p')).toBe(0)
  })

  it('exposes when the operator last used the pane', () => {
    let t = 50
    const reg = createBrowserRegistry(() => t)
    expect(reg.operatorInteractionAt('p')).toBeNull()
    t = 90
    reg.noteOperatorInteraction('p')
    expect(reg.operatorInteractionAt('p')).toBe(90)
  })
})
