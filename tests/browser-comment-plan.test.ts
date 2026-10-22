import { describe, expect, it } from 'vitest'
import {
  REAL_MOUSEDOWN_WINDOW_MS,
  evaluatePickGate,
  evaluateSubmitGate,
  resolveDestination,
  selectPins
} from '../src/main/browser/comment-plan'
import type { PinRecord } from '../src/main/browser/comment-pins'

const NOW = 100_000
const calm = { now: NOW, agentInputInFlight: false, agentInputAt: null }

describe('evaluatePickGate', () => {
  const ok = { ...calm, overlayActive: true, lastRealMouseDownAt: NOW - 50 }
  it('accepts a pick after a real press with no agent input around', () => {
    expect(evaluatePickGate(ok)).toEqual({ ok: true })
  })
  it('refuses a pick while the overlay is off', () => {
    expect(evaluatePickGate({ ...ok, overlayActive: false })).toEqual({
      ok: false,
      reason: 'OVERLAY_OFF'
    })
  })
  it('refuses within 1500 ms of an agent input verb, and while one is running', () => {
    expect(evaluatePickGate({ ...ok, agentInputAt: NOW - 1499 })).toEqual({
      ok: false,
      reason: 'AGENT_INPUT'
    })
    expect(evaluatePickGate({ ...ok, agentInputAt: NOW - 1500 })).toEqual({ ok: true })
    expect(evaluatePickGate({ ...ok, agentInputInFlight: true })).toEqual({
      ok: false,
      reason: 'AGENT_INPUT'
    })
  })
  it('refuses a pick the OS never saw a mouse press for (a script-driven click)', () => {
    expect(evaluatePickGate({ ...ok, lastRealMouseDownAt: null })).toEqual({
      ok: false,
      reason: 'NO_REAL_MOUSE'
    })
    expect(
      evaluatePickGate({ ...ok, lastRealMouseDownAt: NOW - REAL_MOUSEDOWN_WINDOW_MS - 1 })
    ).toEqual({ ok: false, reason: 'NO_REAL_MOUSE' })
  })
})

describe('evaluateSubmitGate', () => {
  const ok = { ...calm, paused: false, disconnected: false }
  it('passes a calm pane', () => {
    expect(evaluateSubmitGate(ok)).toEqual({ ok: true })
  })
  it('refuses a disconnected pane first, then a paused one, then recent agent input', () => {
    expect(
      evaluateSubmitGate({ ...ok, disconnected: true, paused: true, agentInputInFlight: true })
    ).toEqual({
      ok: false,
      error: 'BROWSER_DISCONNECTED'
    })
    expect(evaluateSubmitGate({ ...ok, paused: true, agentInputInFlight: true })).toEqual({
      ok: false,
      error: 'BROWSER_PAUSED'
    })
    expect(evaluateSubmitGate({ ...ok, agentInputAt: NOW - 1000 })).toEqual({
      ok: false,
      error: 'COMMENT_AGENT_INPUT'
    })
    expect(evaluateSubmitGate({ ...ok, agentInputAt: NOW - 1500 })).toEqual({ ok: true })
  })
})

function pin(n: number, over: Partial<PinRecord> = {}): PinRecord {
  return {
    id: `p${n}`,
    n,
    state: 'draft',
    origin: 'https://a.test',
    url: 'https://a.test/',
    selector: `#n${n}`,
    tag: 'div',
    html: '',
    component: null,
    styles: {},
    rect: { x: 0, y: 0, width: 1, height: 1 },
    cropPath: null,
    comment: `c${n}`,
    batchId: 'b',
    createdAt: n,
    ...over
  }
}

describe('selectPins', () => {
  const all = [pin(3), pin(1), pin(2, { state: 'sent' }), pin(4, { comment: '  ' })]
  it('"drafts" takes every unsent pin that has text, in pin order', () => {
    expect(selectPins(all, 'drafts').map((p) => p.n)).toEqual([1, 3])
  })
  it('named ids take only those, skipping sent and empty ones', () => {
    expect(selectPins(all, ['p3', 'p2', 'p4', 'nope']).map((p) => p.n)).toEqual([3])
  })
})

describe('resolveDestination', () => {
  it('prefers the picker, then the owner, else null (the folder selected session)', () => {
    expect(resolveDestination('s1', 'owner')).toBe('s1')
    expect(resolveDestination(null, 'owner')).toBe('owner')
    expect(resolveDestination(null, null)).toBeNull()
  })
})
