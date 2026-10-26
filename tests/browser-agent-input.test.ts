/**
 * T571 (browser pane U4, AC-5), merged in T574 (U7, AC-2) — THE agent-input gate: the one implementation behind
 * `harnu.emit` (U2), the overlay pick (U6) and `agentInputBlocksEmit` (U4), and its one test set (spec §5.4
 * condition 2, §8.6). The window is the whole life of a user activation, not 1.5 s: Chromium keeps an activation
 * sticky for about 5 s, so `setTimeout(emit, 1600)` after an agent click must still be refused.
 */
import { describe, it, expect } from 'vitest'
import { createBrowserRegistry, AGENT_INPUT_WINDOW_MS } from '../src/main/browser/registry'
import {
  ACTIVATION_MAX_AGE_MS,
  ACTIVATION_PADDING_MS,
  agentInputWindowStart,
  believableActivation,
  agentInputBlocksEmit
} from '../src/main/browser/agent-input-gate'
import { evaluateEmitGate } from '../src/main/browser/emit-gate'
import { evaluatePickGate } from '../src/main/browser/comment-plan'

function rig() {
  let clock = 10_000
  const reg = createBrowserRegistry(() => clock)
  return { reg, set: (t: number) => (clock = t), tick: (ms: number) => (clock += ms) }
}

describe('the agent-input record', () => {
  it('has nothing before any verb, then records in flight and the end time', () => {
    const { reg, tick } = rig()
    expect(reg.agentInput('bp-1')).toEqual({ inFlight: false, at: null })
    expect(reg.lastAgentInputAt('bp-1')).toBeNull()
    reg.beginAgentInput('bp-1')
    expect(reg.agentInput('bp-1')).toMatchObject({ inFlight: true })
    tick(40)
    reg.endAgentInput('bp-1')
    expect(reg.agentInput('bp-1')).toEqual({ inFlight: false, at: 10_040 })
    expect(reg.lastAgentInputAt('bp-1')).toBe(10_040)
  })

  it('counts overlapping verbs and is in flight until the last one ends', () => {
    const { reg } = rig()
    reg.beginAgentInput('bp-1')
    reg.beginAgentInput('bp-1')
    reg.endAgentInput('bp-1')
    expect(reg.agentInput('bp-1').inFlight).toBe(true)
    reg.endAgentInput('bp-1')
    expect(reg.agentInput('bp-1').inFlight).toBe(false)
    reg.endAgentInput('bp-1') // an unbalanced end never goes negative
    expect(reg.agentInput('bp-1').inFlight).toBe(false)
  })

  it('is per pane and is dropped with the pane', () => {
    const { reg } = rig()
    reg.beginAgentInput('bp-1')
    expect(reg.agentInput('bp-2').inFlight).toBe(false)
    reg.remove('bp-1')
    expect(reg.agentInput('bp-1')).toEqual({ inFlight: false, at: null })
  })

  it('answers whether any input overlapped an interval', () => {
    const { reg, tick } = rig()
    reg.beginAgentInput('bp-1') // 10_000
    tick(100)
    reg.endAgentInput('bp-1') // 10_100
    expect(reg.agentInputOverlaps('bp-1', 10_050, 10_060)).toBe(true)
    expect(reg.agentInputOverlaps('bp-1', 9_000, 9_999)).toBe(false)
    expect(reg.agentInputOverlaps('bp-1', 10_101, 11_000)).toBe(false)
    expect(reg.agentInputOverlaps('bp-1', 10_100, 10_200)).toBe(true)
    reg.beginAgentInput('bp-1') // still running
    expect(reg.agentInputOverlaps('bp-1', 20_000, 20_001)).toBe(true)
  })
})

describe('agentInputBlocksEmit', () => {
  it('names the window as one constant, at least the 5 s of a user activation', () => {
    expect(AGENT_INPUT_WINDOW_MS).toBeGreaterThanOrEqual(5000)
  })

  it('refuses an emit right after an agent click', () => {
    const { reg, tick } = rig()
    reg.beginAgentInput('bp-1')
    tick(30)
    reg.endAgentInput('bp-1')
    tick(100)
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_130)).toBe(true)
  })

  it('refuses setTimeout(emit, 1600) after an agent click (the self-approval Q8 forbids)', () => {
    const { reg, tick } = rig()
    reg.beginAgentInput('bp-1')
    tick(30)
    reg.endAgentInput('bp-1') // click ends at 10_030; the activation was at ~10_000
    // The panel armed `setTimeout(emit, 1600)` inside the click handler; the emit lands 1.6 s later.
    tick(1600)
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_030 + 1600, 10_000)).toBe(true)
    // …and it is refused even without the activation timestamp, measured back from the emit.
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_030 + 1600)).toBe(true)
  })

  it('still refuses 4.9 s later, and allows an emit whose activation came well after the last agent input', () => {
    const { reg, tick } = rig()
    reg.beginAgentInput('bp-1')
    reg.endAgentInput('bp-1') // 10_000
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_000 + 4900)).toBe(true)
    // the operator clicked at t=20_000, 10 s after the agent's last input
    tick(10_000)
    expect(agentInputBlocksEmit(reg, 'bp-1', 20_050, 20_000)).toBe(false)
  })

  it('an activation that predates an agent input by less than the window is refused even if the emit is late', () => {
    const { reg, set } = rig()
    reg.beginAgentInput('bp-1')
    set(10_200)
    reg.endAgentInput('bp-1')
    // activation at 10_150 (the operator's own click), but the agent was typing 50 ms before it
    expect(agentInputBlocksEmit(reg, 'bp-1', 14_000, 10_150)).toBe(true)
  })

  it('never blocks a pane the agent did not drive', () => {
    const { reg } = rig()
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_000)).toBe(false)
  })
})

describe('which activation timestamp is believed (one rule for the emit and the pick)', () => {
  it('uses the activation when it is recent and not in the future, else nothing (the fallback window applies)', () => {
    expect(believableActivation(10_000, 9_000)).toBe(9_000)
    expect(believableActivation(10_000, null)).toBeNull()
    expect(believableActivation(10_000, undefined)).toBeNull()
    // stale: older than an activation lives
    expect(believableActivation(20_000, 20_000 - ACTIVATION_MAX_AGE_MS - 1)).toBeNull()
    expect(believableActivation(20_000, 20_000 - ACTIVATION_MAX_AGE_MS)).toBe(
      20_000 - ACTIVATION_MAX_AGE_MS
    )
    // future beyond the skew slack
    expect(believableActivation(10_000, 99_999)).toBeNull()
    // slightly ahead (clock skew between worlds): measured from the call, never from the future
    expect(believableActivation(10_000, 10_500)).toBe(10_000)
  })

  it('the window starts at the activation less a small padding, and at 5000 ms before the call without one', () => {
    expect(agentInputWindowStart(10_000, 9_800)).toBe(9_800 - ACTIVATION_PADDING_MS)
    expect(agentInputWindowStart(10_000, null)).toBe(10_000 - AGENT_INPUT_WINDOW_MS)
    expect(agentInputWindowStart(10_000, 99_999)).toBe(10_000 - AGENT_INPUT_WINDOW_MS)
  })

  it('a stale or future timestamp falls back to the 5 s window measured from the call', () => {
    const { reg, set } = rig()
    reg.beginAgentInput('bp-1')
    set(18_000)
    reg.endAgentInput('bp-1') // the run is 10_000..18_000 → the emit at 20_000 is 2 s after its end
    expect(agentInputBlocksEmit(reg, 'bp-1', 20_000, 10_000)).toBe(true) // stale timestamp
    expect(agentInputBlocksEmit(reg, 'bp-1', 20_000, 99_999)).toBe(true) // future timestamp
  })
})

describe('the activation timestamp is the primary anchor (F5 self-approval vs the operator’s own click)', () => {
  // The agent clicked at 8_400 (took 50 ms); the page's script emits at 10_000, while the CDP click's transient
  // activation is still alive. The preload says the activating input was at 8_410.
  function afterAgentClick() {
    const { reg, set } = rig()
    set(8_400)
    reg.beginAgentInput('bp-1')
    set(8_450)
    reg.endAgentInput('bp-1')
    set(10_000)
    return reg
  }

  it('refuses an emit made 1.6 s after an agent click, with or without the timestamp', () => {
    const reg = afterAgentClick()
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_000, 8_410)).toBe(true)
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_000, null)).toBe(true)
  })

  it('lets the operator’s OWN click through when the agent finished before it, with a believable timestamp', () => {
    const reg = afterAgentClick()
    // the operator clicked at 9_800, 1.35 s after the agent's last input: the primary rule lets it through…
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_000, 9_800)).toBe(false)
    // …but without a timestamp the 5 s fallback cannot tell it from the agent's, so it refuses
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_000, null)).toBe(true)
  })

  it('refuses when an agent run overlaps the activation (inside the padding), or is still open', () => {
    const { reg, set } = rig()
    set(9_700)
    reg.beginAgentInput('bp-1')
    set(9_750)
    reg.endAgentInput('bp-1') // ended 50 ms before the activation: inside the padding
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_000, 9_800)).toBe(true)
    // ended 200 ms before: outside it
    const other = rig()
    other.set(9_500)
    other.reg.beginAgentInput('bp-1')
    other.set(9_600)
    other.reg.endAgentInput('bp-1')
    expect(agentInputBlocksEmit(other.reg, 'bp-1', 10_000, 9_800)).toBe(false)
    // a run still open since before the emit blocks it
    reg.beginAgentInput('bp-1')
    set(10_500)
    expect(agentInputBlocksEmit(reg, 'bp-1', 10_500, 10_400)).toBe(true)
  })

  it('setTimeout(emit, 1600) after an agent click stays refused however the page timestamps it', () => {
    const reg = afterAgentClick()
    for (const activationAt of [8_400, 8_410, 8_449, null, 99_999]) {
      expect(agentInputBlocksEmit(reg, 'bp-1', 10_030, activationAt), String(activationAt)).toBe(
        true
      )
    }
  })
})

describe('the three call sites share this verdict', () => {
  // `page-service` (emit) and `overlay-bridge` (pick) compute `agentInputBlocksEmit(...)` and hand the boolean to
  // the pure gates, which honour it and nothing else about agent input.
  it('the emit gate and the pick gate both refuse on the same verdict, and pass on the same verdict', () => {
    const { reg, tick } = rig()
    reg.beginAgentInput('bp-1')
    tick(30)
    reg.endAgentInput('bp-1')
    const blocked = agentInputBlocksEmit(reg, 'bp-1', 10_100, 10_000)
    expect(blocked).toBe(true)
    const emit = evaluateEmitGate({
      now: 10_100,
      userActivationActive: true,
      activatedBy: 'pointer',
      agentInputBlocked: blocked,
      paused: false,
      disconnected: false,
      lastRealKeyDownAt: null
    })
    const pick = evaluatePickGate({
      overlayActive: true,
      disconnected: false,
      agentInputBlocked: blocked
    })
    expect(emit).toMatchObject({ ok: false, failed: 2 })
    expect(pick).toEqual({ ok: false, reason: 'AGENT_INPUT' })
    tick(20_000)
    const clear = agentInputBlocksEmit(reg, 'bp-1', 30_100, 30_000)
    expect(clear).toBe(false)
    expect(
      evaluatePickGate({ overlayActive: true, disconnected: false, agentInputBlocked: clear })
    ).toEqual({ ok: true })
  })
})
