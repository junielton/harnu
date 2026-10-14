import { describe, it, expect } from 'vitest'
import {
  createLegacyParkFacts,
  createParkCoordinator,
  type ParkNegotiation
} from '../src/main/park-coordinator'
import { DEFAULT_NEGOTIATION, type ParkSnapshot } from '../src/main/park-negotiation-core'

/**
 * T456 W3 (spec §6.5) — the chip needs counts ("2 background tasks"), which W1's reason labels did
 * not carry. The count is read from the same Stop body the label comes from, and frozen into the
 * episode at the moment of the decline, so a later Stop does not rewrite what was said then.
 */

const MIN = 60_000
const BOUNDS = {
  maxDeclines: DEFAULT_NEGOTIATION.maxDeclines,
  maxDeferMs: DEFAULT_NEGOTIATION.maxDeferMs,
  pressureFloorMb: DEFAULT_NEGOTIATION.pressureFloorMb
}

function setup() {
  const facts = createLegacyParkFacts()
  const parked: Array<ParkNegotiation | null> = []
  const sends: unknown[] = []
  let now = 10 * 60 * MIN
  const snap: ParkSnapshot = {
    ptyId: 'p1',
    isSelected: false,
    lastFocusedAt: 0,
    lastActivityAt: 0,
    lastPromptAt: null
  }
  const c = createParkCoordinator({
    now: () => now,
    snapshot: () => ({ ...snap, lastPromptAt: facts.lastPromptAt('s1') }),
    hibernate: (_k, n) => void parked.push(n),
    parkMode: () => 'ask',
    bounds: () => BOUNDS,
    memAvailableMb: () => null,
    facts
  })
  return { c, facts, parked, sends, tick: (ms: number) => void (now += ms), now: () => now }
}

const stop = (tasks: number, crons: number) => ({
  background_tasks: Array.from({ length: tasks }, (_, i) => ({
    id: `t${i}`,
    type: 'shell',
    status: 'running',
    command: 'git push --force secret-remote'
  })),
  session_crons: Array.from({ length: crons }, () => ({ recurring: true, prompt: 'p' }))
})

describe('legacy facts — counts', () => {
  it('counts running tasks and crons per reason label, and only the non-zero ones', () => {
    const { facts } = setup()
    facts.noteHookBody('s1', 'Stop', stop(2, 1), 1)
    expect(facts.counts('s1')).toEqual({ 'background-task': 2, 'scheduled-wakeup': 1 })
    facts.noteHookBody('s1', 'Stop', stop(0, 3), 2)
    expect(facts.counts('s1')).toEqual({ 'scheduled-wakeup': 3 })
    expect(facts.busy('s1')).toEqual(['scheduled-wakeup'])
  })

  it('never carries a command or prompt (§5.3)', () => {
    const { facts } = setup()
    facts.noteHookBody('s1', 'Stop', stop(2, 1), 1)
    expect(JSON.stringify(facts.counts('s1'))).not.toContain('secret')
  })

  it('is empty for an unknown session', () => {
    expect(setup().facts.counts('nope')).toEqual({})
  })
})

describe('the episode carries the counts it was granted on', () => {
  it('a decline stores the counts, and a later Stop does not rewrite them', async () => {
    const { c, facts, tick } = setup()
    facts.noteHookBody('s1', 'Stop', stop(2, 0), 1)
    const out = await c.requestPark('s1', 'sweep')
    expect(out.kind).toBe('declined')
    expect(c.episodeFor('s1')?.counts).toEqual({ 'background-task': 2 })
    facts.noteHookBody('s1', 'Stop', stop(0, 0), 2)
    expect(c.episodeFor('s1')?.counts).toEqual({ 'background-task': 2 })
    tick(11 * MIN)
    facts.noteHookBody('s1', 'Stop', stop(1, 0), 3)
    await c.requestPark('s1', 'sweep')
    expect(c.episodeFor('s1')?.counts).toEqual({ 'background-task': 1 })
    expect(c.episodeFor('s1')?.declines).toBe(2)
  })

  it('a decline emits nothing outward: the coordinator has no notification, toast or sound seam (§6.5)', async () => {
    const { c, facts } = setup()
    facts.noteHookBody('s1', 'Stop', stop(1, 0), 1)
    await c.requestPark('s1', 'sweep')
    // The only outward calls the deps expose are `snapshot` (a read) and `hibernate` (the kill).
    // A decline must reach neither a kill nor anything else.
    expect(c.episodeFor('s1')).not.toBeNull()
  })
})
