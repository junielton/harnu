import { describe, it, expect } from 'vitest'
import {
  evaluateFleet,
  DEFAULT_POLICY,
  type LiveSession,
  type Policy
} from '../src/main/fleet-policy'

const NOW = 1_700_000_000_000
const MIN = 60_000

const POLICY: Policy = { maxLive: 5, lruIdleMs: 15 * MIN, hardIdleMs: 60 * MIN }

/** A session that IS a valid eviction candidate unless a field is overridden. */
function cold(key: string, idleMin: number, over: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionKey: key,
    kind: 'claude-resume',
    taskState: 'idle',
    lastFocusedAt: NOW - idleMin * MIN,
    lastActivityAt: NOW - idleMin * MIN,
    isSelected: false,
    hasPendingApproval: false,
    ...over
  }
}

// The `cap` trigger fires from `pty:create`, i.e. one MORE session is about to exist.
// So it must free `live - maxLive + 1` slots to keep `live <= maxLive` after the spawn.
describe('evaluateFleet — cap trigger (growth)', () => {
  it('below the cap evicts nobody (hot path untouched)', () => {
    const fleet = [cold('a', 99), cold('b', 99), cold('c', 99)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual([])
  })

  it('at the cap evicts the coldest eligible session to make room for the newcomer', () => {
    const fleet = [cold('a', 20), cold('b', 45), cold('c', 30), cold('d', 20), cold('e', 20)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['b'])
  })

  it('8 live against a cap of 5 frees 4 — exactly enough to land at 5 after the spawn', () => {
    const fleet = [
      cold('a', 20),
      cold('b', 21),
      cold('c', 22),
      cold('d', 23),
      cold('e', 24),
      cold('f', 25),
      cold('g', 26),
      cold('h', 27)
    ]
    const victims = evaluateFleet(fleet, NOW, POLICY, 'cap')
    // coldest-first, and never one more than needed
    expect(victims).toEqual(['h', 'g', 'f', 'e'])
    expect(fleet.length - victims.length + 1).toBe(POLICY.maxLive)
  })
})

// A `working` claim is CORROBORATED against the pulse, not trusted outright. The hook FSM
// over-reports (BUG-1): a real resumed session was measured latched at `working` with ZERO
// bytes emitted for 108s+. An absolute veto would make hibernation inert AND let one stuck
// session hold a cap slot forever. So `working` buys the STRICT (hard) threshold, not immunity.
describe('evaluateFleet — a `working` claim must be corroborated by the pulse', () => {
  it('does NOT evict a `working` session under the cap, even when it is by far the coldest', () => {
    const fleet = [
      cold('working-but-coldish', 30, { taskState: 'working' }), // 30min < hardIdleMs (60min)
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 25)
    ]
    // 'e' (25m) loses to 'working-but-coldish' (30m) on raw coldness, but the working
    // session needs 60min of silence to qualify, so it is not a candidate at all.
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  it('a session emitting bytes is never parked, whatever the FSM says', () => {
    const fleet = [
      cold('busy', 99, { taskState: 'working', lastActivityAt: NOW - 2_000 }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  // THE regression test for what live verification caught. Without this, the feature is inert.
  it('DOES evict a session latched at `working` that has emitted nothing for over an hour', () => {
    const fleet = [cold('latched-liar', 90, { taskState: 'working' }), cold('b', 5)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual(['latched-liar'])
  })

  it('a stuck `working` session cannot squat on a cap slot forever', () => {
    const fleet = [
      cold('latched-liar', 120, { taskState: 'working' }), // 2h silent, still claims to work
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 25)
    ]
    // Past the hard threshold, the liar is the coldest candidate and gets reclaimed.
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['latched-liar'])
  })
})

describe('evaluateFleet — the immunity list (the rules that prevent disaster)', () => {
  // Spec §5.2: a synthetic has no JSONL on disk, so `claude --resume` cannot restore it —
  // and `resolveSpawnSpec` would wake it into `claude-new`, ORPHANING the transcript.
  it('NEVER evicts a plain synthetic (claude-new) — no transcript to resume from', () => {
    const fleet = [
      cold('synthetic-xyz', 99, { kind: 'claude-new' }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  it('NEVER evicts a fork synthetic (claude-fork) — same no-transcript hazard', () => {
    const fleet = [
      cold('synthetic-fork', 99, { kind: 'claude-fork' }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  it('NEVER evicts a plain shell — nothing to resume', () => {
    const fleet = [
      cold('a-shell', 99, { kind: 'shell' }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  it('NEVER evicts a teammate — it is owned by its lead, not by us', () => {
    const fleet = [
      cold('mate', 99, { kind: 'teammate' }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  it('NEVER evicts the selected session, regardless of LRU', () => {
    const fleet = [
      cold('selected', 99, { isSelected: true }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  it('NEVER evicts a session with a pending approval (would orphan the confirm)', () => {
    const fleet = [
      cold('awaiting', 99, { hasPendingApproval: true }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  // Spec §3.5. A ceiling that blocks the operator's work is worse than the problem it solves.
  it('when NOTHING is eligible the cap YIELDS — returns [] instead of blocking the spawn', () => {
    // Five genuinely busy sessions: all emitting, so none is cold on the activity axis.
    const busy = (k: string): LiveSession =>
      cold(k, 99, { taskState: 'working', lastActivityAt: NOW - 1_000 })
    const fleet = [busy('a'), busy('b'), busy('c'), busy('d'), busy('e')]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual([])
  })
})

// Spec §3.4. Focus and pulse are INDEPENDENT sources; a session is only cold when both are.
describe('evaluateFleet — both coldness sources must be cold', () => {
  it('unfocused 40min but still emitting => IMMUNE ("I left it running and went to lunch")', () => {
    const fleet = [
      cold('lunch', 40, { lastActivityAt: NOW - 10_000 }), // 10s since its last byte
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })

  it('just looked at but silent => IMMUNE', () => {
    const fleet = [
      cold('just-looked', 40, { lastFocusedAt: NOW - 5_000 }),
      cold('b', 20),
      cold('c', 20),
      cold('d', 20),
      cold('e', 30)
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['e'])
  })
})

// Spec §3.3. The cap only fires when the fleet GROWS; the sweep catches the decay case —
// five sessions opened, operator walks away, nothing spawns, ~2 GB sits idle.
describe('evaluateFleet — sweep trigger (decay)', () => {
  it('below the cap, a session idle past hardIdleMs IS evicted', () => {
    const fleet = [cold('rotten', 61), cold('b', 5)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual(['rotten'])
  })

  it('ignores a session merely past lruIdleMs — the sweep threshold is hardIdleMs', () => {
    const fleet = [cold('warm', 20), cold('b', 5)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([])
  })

  it('evicts ALL qualifying sessions, not just enough to reach the cap', () => {
    const fleet = [cold('a', 90), cold('b', 70), cold('c', 5)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual(['a', 'b'])
  })

  it('honors the immunity list too', () => {
    const fleet = [
      // genuinely busy (emitting), not merely CLAIMING to work — see the corroboration block
      cold('a', 90, { taskState: 'working', lastActivityAt: NOW - 3_000 }),
      cold('b', 90, { isSelected: true }),
      cold('c', 90, { kind: 'claude-new' }),
      cold('d', 90, { hasPendingApproval: true })
    ]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([])
  })
})

// BUG-65: `pty:rekey` now promotes a migrated synthetic's kind to `claude-resume`
// (pty.ts's `applyRekeyToRecord`) so it reaches this policy at all. These document what
// the policy does with that promoted session — the pure half of the fix, alongside
// `tests/pty-rekey.test.ts` (the record-mutation half).
describe('evaluateFleet — a migrated (post-rekey) session', () => {
  it('a session promoted from claude-new/claude-fork is parkable exactly like any other claude-resume', () => {
    const fleet = [cold('migrated', 90), cold('b', 5)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual(['migrated'])
  })

  // The ordering hazard the fix must not reintroduce: `isSelected` is derived from
  // `sessionKey === selectedSessionKey`. If `pty:rekey` promoted `kind` without also
  // updating `selectedSessionKey` to match, a migrated-and-currently-open session would
  // never register as selected and the policy would happily park it out from under the
  // operator.
  it('the operator-selected session is still immune even once its kind is promoted', () => {
    const fleet = [cold('migrated-and-selected', 90, { isSelected: true }), cold('b', 5)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([])
  })
})

describe('DEFAULT_POLICY', () => {
  it('caps at 5 — the 4–5 concurrent-agent supervisor-cognition ceiling, not a round number', () => {
    expect(DEFAULT_POLICY.maxLive).toBe(5)
    expect(DEFAULT_POLICY.lruIdleMs).toBe(15 * MIN)
    expect(DEFAULT_POLICY.hardIdleMs).toBe(60 * MIN)
  })
})
