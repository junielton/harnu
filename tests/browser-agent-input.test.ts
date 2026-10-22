/**
 * T571 (browser pane U4, AC-5) — the `agentInputAt` seam the emit gate (U2) and the overlay pick (U6) read
 * (spec §5.4 condition 2, §8.6). The window is the whole life of a user activation, not 1.5 s: Chromium keeps an
 * activation sticky for about 5 s, so `setTimeout(emit, 1600)` after an agent click must still be refused.
 */
import { describe, it, expect } from 'vitest'
import { createBrowserRegistry, AGENT_INPUT_WINDOW_MS } from '../src/main/browser/registry'
import { agentInputBlocksEmit } from '../src/main/browser/agent-input-gate'

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
