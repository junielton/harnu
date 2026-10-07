/* eslint-disable @typescript-eslint/no-explicit-any -- test code drives the engine's `$` loosely */
import { expect } from 'claude-code/testing'
import type { FleetStep, WireExpect } from '../fixtures/fleet/traces'
import { FLEET_FEATURES, defaultScript, helloOk, type Rig, type Script } from './rig'

/** A host that enables the identity and the three fleet sensors, and acknowledges every event. */
export const fleetScript: Script = (route, body, n) =>
  route === 'hello' ? helloOk([...FLEET_FEATURES]) : defaultScript(route, body, n)

/** Raises each step through the engine's own `$`, as a session would. */
export async function play($: any, rig: Rig, steps: readonly FleetStep[]): Promise<void> {
  for (const s of steps) {
    if (s.verdict) rig.verdict.value = s.verdict
    switch (s.hook) {
      case 'prompt.submit':
        await $.prompt.submit(s.input)
        break
      case 'turn.start':
        await $.turn.start(s.input)
        break
      case 'tool.check':
        await $.tool.check(s.input)
        break
      case 'turn.complete':
        await $.turn.complete(s.input)
        break
      default:
        await $.classic[s.hook.slice('classic.'.length)](s.input)
    }
  }
  await rig.clock.settle()
}

const FLEET_EVENTS = /^(turn\.|attention\.|subagent\.|mod\.error)/

/** What the host received, without the snapshots and the identity events. */
export function fleetWire(rig: Rig): { t: string; d: any; turnId?: string; agentId?: string }[] {
  return rig.events().filter((e) => FLEET_EVENTS.test(e.t)) as never
}

/** `d` is matched as a subset: a fixture names what it cares about. */
export function expectWire(rig: Rig, want: readonly WireExpect[]): void {
  const got = fleetWire(rig)
  expect(got.map((e) => e.t)).toEqual(want.map((e) => e.t))
  want.forEach((w, i) => {
    const g = got[i] as any
    expect(g.d).toMatchObject(w.d)
    if (w.turnId !== undefined) expect(g.turnId).toBe(w.turnId)
    if (w.agentId !== undefined) expect(g.agentId).toBe(w.agentId)
  })
}
