import { describe, expect, it } from 'vitest'
import {
  evaluatePickGate,
  evaluateSubmitGate,
  resolveDestination,
  selectPins
} from '../src/main/browser/comment-plan'
import type { PinRecord } from '../src/main/browser/comment-pins'

const calm = { agentInputBlocked: false }

describe('evaluatePickGate', () => {
  const ok = { ...calm, overlayActive: true, disconnected: false }
  it('accepts a pick with no agent input around', () => {
    expect(evaluatePickGate(ok)).toEqual({ ok: true })
  })
  it('refuses a pick while the overlay is off', () => {
    expect(evaluatePickGate({ ...ok, overlayActive: false })).toEqual({
      ok: false,
      reason: 'OVERLAY_OFF'
    })
  })
  it('refuses when the agent-input gate says an agent input verb ran around the pick', () => {
    // The window itself (5000 ms, in-flight runs, the activation time) is decided by `agentInputBlocksEmit` and
    // tested once, in browser-agent-input.test.ts; this gate only honours its verdict.
    expect(evaluatePickGate({ ...ok, agentInputBlocked: true })).toEqual({
      ok: false,
      reason: 'AGENT_INPUT'
    })
  })
})

describe('evaluatePickGate on a disconnected pane', () => {
  it('refuses: the operator cut this pane off from agents, so it takes no comments', () => {
    expect(evaluatePickGate({ ...calm, overlayActive: true, disconnected: true })).toEqual({
      ok: false,
      reason: 'DISCONNECTED'
    })
  })
})

describe('evaluateSubmitGate', () => {
  it('passes a pane that is connected', () => {
    expect(evaluateSubmitGate({ disconnected: false })).toEqual({ ok: true })
  })
  it('refuses only a DISCONNECTED pane', () => {
    expect(evaluateSubmitGate({ disconnected: true })).toEqual({
      ok: false,
      error: 'BROWSER_DISCONNECTED'
    })
  })
  it('has no agent-input window and no pause check: the composer is renderer code an agent cannot drive', () => {
    // The gate's input is the disconnected flag alone: extra facts (a pause, a verb in flight) change nothing.
    const gate = evaluateSubmitGate as (i: Record<string, unknown>) => unknown
    expect(gate({ disconnected: false, paused: true, agentInputBlocked: true })).toEqual({
      ok: true
    })
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
