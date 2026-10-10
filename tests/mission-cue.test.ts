/**
 * Mission v3 §3.12 (AC-10, AC-6) + BUG-173 S3 (spec §3.2) — the owed-to-operator
 * cue decision (`lib/mission-cue.ts`), keyed from the server's `you` list: one
 * key per owed kind with its count, a cue only when a key APPEARS or a count
 * GROWS (never on a tick, a resolution or a decrease), approvals / needs-input
 * excluded, no draft kind (a dead legacy draft never cues). Standing kinds
 * (`close`, `checks`, `review-import`) never re-nudge; blocking kinds (`rescope`,
 * `blocker`, `human-steps`) re-nudge on {@link BLOCKING_NUDGE_MS} and then stop.
 * The memory is persisted, a missing one seeds silently, and an absent mission
 * keeps its entry for {@link ABSENT_TTL_MS}. Time is an injected `now`.
 */
import { describe, it, expect } from 'vitest'
import type { MissionView } from '../src/main/mission-ipc'
import type { MissionYouItem } from '../src/main/mcp/tool-handlers'
import type { DeclaredEnd, Mission } from '../src/main/mission-core'
import {
  ABSENT_TTL_MS,
  BLOCKING_NUDGE_MS,
  decideCue,
  deserializeCueMemory,
  firstOwed,
  isPersistedCueMemory,
  owedKeys,
  seedCueMemory,
  serializeCueMemory,
  type CueMemory
} from '../src/renderer/src/lib/mission-cue'

const END: DeclaredEnd = { kind: 'code', target: 'stacked PRs merged', evidence: 'PR list' }
const T0 = 1_790_000_000_000
const POLL = 20_000
const MIN = 60_000
const HOUR = 60 * MIN

const empty = (): CueMemory => ({ owed: new Map() })

/** A minimal view: only the fields the cue reads are meaningful. */
function view(
  opts: { id?: string; status?: Mission['status']; you?: MissionYouItem[]; stale?: boolean } = {}
): MissionView {
  return {
    root: '/repo',
    mission: { id: opts.id ?? 'mnt-00000001', status: opts.status ?? 'active' },
    title: 'Mission',
    derived: { stale: opts.stale ?? false },
    you: opts.you ?? [],
    closeWarnings: []
  } as unknown as MissionView
}

const checks = (count: number): MissionYouItem => ({ kind: 'checks', count, stepIds: ['stp-2'] })
const humanSteps = (n: number): MissionYouItem => ({
  kind: 'human-steps',
  stepIds: Array.from({ length: n }, (_, i) => `stp-${i + 2}`)
})
const blocker = (reason: string): MissionYouItem => ({ kind: 'blocker', reason, unblocks: 'done' })

/** A view owing `what`: `close`, `rescope:<target>`, `blocker:<reason>` or `checks:<n>`. */
function owedView(id: string, what: string): MissionView {
  if (what === 'close') return view({ id, status: 'delivered', you: [{ kind: 'close' }] })
  if (what.startsWith('rescope:')) {
    return view({ id, you: [{ kind: 'rescope', end: { ...END, target: what.slice(8) } }] })
  }
  if (what.startsWith('blocker:')) return view({ id, you: [blocker(what.slice(8))] })
  if (what.startsWith('checks:')) return view({ id, you: [checks(Number(what.slice(7)))] })
  if (what.startsWith('human-steps:'))
    return view({ id, you: [humanSteps(Number(what.slice(12)))] })
  if (what === 'review-import') return view({ id, you: [{ kind: 'review-import' }] })
  throw new Error(`unknown owed kind ${what}`)
}

describe('owedKeys', () => {
  it('is empty when nothing is owed or only approvals / needs-input are owed', () => {
    expect(owedKeys(view({ you: [] })).size).toBe(0)
    expect(owedKeys(view({ you: [{ kind: 'approvals', count: 1, sessionId: 's' }] })).size).toBe(0)
    expect(owedKeys(view({ you: [{ kind: 'needs-input', sessionId: 's' }] })).size).toBe(0)
  })

  it('keys every cue-worthy kind of the you list, with its count', () => {
    const v = view({
      you: [
        { kind: 'rescope', end: END },
        { kind: 'close' },
        blocker('merge #6'),
        blocker('merge #7'),
        checks(3),
        { kind: 'human-steps', stepIds: ['stp-4', 'stp-5'] },
        { kind: 'review-import' },
        { kind: 'approvals', count: 2, sessionId: 's' }
      ]
    })
    expect(Object.fromEntries(owedKeys(v))).toEqual({
      [`rescope:${END.target}`]: 1,
      close: 1,
      'blocker:merge #6': 1,
      'blocker:merge #7': 1,
      checks: 3,
      'human-steps': 2,
      'review-import': 1
    })
  })

  it('has no draft kind: a legacy draft status alone owes nothing', () => {
    expect(owedKeys(view({ status: 'draft', you: [] })).size).toBe(0)
  })

  it('firstOwed skips approvals and needs-input', () => {
    const v = view({
      you: [{ kind: 'approvals', count: 1, sessionId: 's' }, checks(2)]
    })
    expect(firstOwed(v)).toEqual(checks(2))
    expect(firstOwed(view({ you: [{ kind: 'needs-input', sessionId: 's' }] }))).toBeNull()
  })
})

describe('decideCue — appear or grow only', () => {
  it('cues when due checks grow 1 → 2, never when they shrink 2 → 1', () => {
    const one = decideCue([owedView('a', 'checks:1')], empty(), T0)
    expect(one.cue).toBe(true)
    const two = decideCue([owedView('a', 'checks:2')], one.memory, T0 + POLL)
    expect(two).toMatchObject({ cue: true, missionIds: ['a'] })
    const back = decideCue([owedView('a', 'checks:1')], two.memory, T0 + 2 * POLL)
    expect(back.cue).toBe(false)
    // …and growth is measured from the lower count it remembered.
    expect(decideCue([owedView('a', 'checks:2')], back.memory, T0 + 3 * POLL).cue).toBe(true)
  })

  // BUG-173 S1 (spec §3.1): defence in depth behind the dedupe in main.
  it('a repeated mission id in views cues once and counts once', () => {
    const decision = decideCue(
      [owedView('a', 'close'), owedView('a', 'close'), owedView('b', 'close')],
      empty(),
      T0
    )
    expect(decision.missionIds).toEqual(['a', 'b'])
    expect(decision.memory.owed.size).toBe(2)
  })

  it('a tick that clears the last due check never chimes', () => {
    const first = decideCue([owedView('a', 'checks:1')], empty(), T0)
    const ticked = decideCue([view({ id: 'a' })], first.memory, T0 + POLL)
    expect(ticked.cue).toBe(false)
    expect(ticked.memory.owed.get('a')?.keys.size).toBe(0)
  })

  it('cues when a new kind appears next to one already heard', () => {
    const first = decideCue([owedView('a', 'blocker:merge')], empty(), T0)
    const more = decideCue(
      [view({ id: 'a', you: [blocker('merge'), checks(1)] })],
      first.memory,
      T0 + POLL
    )
    expect(more).toMatchObject({ cue: true, missionIds: ['a'] })
  })

  it('a resolution of one kind while another stays is silent', () => {
    const first = decideCue([view({ id: 'a', you: [blocker('merge'), checks(1)] })], empty(), T0)
    const resolved = decideCue([owedView('a', 'checks:1')], first.memory, T0 + POLL)
    expect(resolved.cue).toBe(false)
  })

  it('a dead legacy draft (active, stale, nothing owed) never cues, not even after hours', () => {
    let memory = empty()
    const dead = view({ id: 'a', status: 'draft', stale: true })
    for (let t = T0; t <= T0 + 6 * HOUR; t += 10 * MIN) {
      const d = decideCue([dead], memory, t)
      expect(d.cue).toBe(false)
      memory = d.memory
    }
    expect([...memory.owed.values()].every((e) => e.keys.size === 0)).toBe(true)
  })

  it('gives one combined cue on the first poll when missions are already owed', () => {
    const d = decideCue([owedView('a', 'checks:1'), owedView('b', 'close')], empty(), T0)
    expect(d.cue).toBe(true)
    expect(d.missionIds.sort()).toEqual(['a', 'b'])
  })

  it('does not cue again on the next poll', () => {
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    expect(decideCue([owedView('a', 'close')], first.memory, T0 + POLL).cue).toBe(false)
  })

  it('does not cue when nothing is owed, including approvals and needs-input', () => {
    const d = decideCue(
      [
        view({ id: 'a' }),
        view({ id: 'b', you: [{ kind: 'approvals', count: 3, sessionId: 's' }] }),
        view({ id: 'c', you: [{ kind: 'needs-input', sessionId: 's' }] })
      ],
      empty(),
      T0
    )
    expect(d).toMatchObject({ cue: false, missionIds: [] })
    expect(d.memory.owed.size).toBe(0)
  })

  it('cues only the mission that newly owes, not the one already heard', () => {
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    const d = decideCue(
      [owedView('a', 'close'), owedView('b', 'rescope:main')],
      first.memory,
      T0 + POLL
    )
    expect(d).toMatchObject({ cue: true, missionIds: ['b'] })
  })

  it('a different blocker reason is a new key and cues', () => {
    const first = decideCue([owedView('a', 'blocker:merge #1')], empty(), T0)
    expect(decideCue([owedView('a', 'blocker:merge #2')], first.memory, T0 + POLL).cue).toBe(true)
  })

  it('a repeated mission id in views cues once and counts once', () => {
    const d = decideCue([owedView('a', 'checks:2'), owedView('a', 'checks:2')], empty(), T0)
    expect(d.missionIds).toEqual(['a'])
    expect(d.memory.owed.size).toBe(1)
    expect(d.memory.owed.get('a')?.keys.get('checks')?.count).toBe(2)
    expect(seedCueMemory([owedView('a', 'close'), owedView('a', 'close')], T0).owed.size).toBe(1)
  })

  it('a key that disappears is dropped, so coming back is a new cue', () => {
    const first = decideCue([owedView('a', 'blocker:merge')], empty(), T0)
    const cleared = decideCue([view({ id: 'a' })], first.memory, T0 + POLL)
    expect(cleared.memory.owed.get('a')?.keys.size).toBe(0)
    expect(decideCue([owedView('a', 'blocker:merge')], cleared.memory, T0 + 2 * POLL).cue).toBe(
      true
    )
  })
})

describe('decideCue — the per-kind policy table (spec §3.2)', () => {
  it('exports the back-off schedule: 30 min, 1 h, 2 h, 4 h', () => {
    expect(BLOCKING_NUDGE_MS).toEqual([30 * MIN, 1 * HOUR, 2 * HOUR, 4 * HOUR])
    expect(ABSENT_TTL_MS).toBe(24 * HOUR)
  })

  /** Poll the same view every 5 minutes for `span` and return the cue times. */
  function cueTimes(v: () => MissionView, span: number): number[] {
    const first = decideCue([v()], empty(), T0)
    let memory = first.memory
    const out = [0]
    for (let dt = 5 * MIN; dt <= span; dt += 5 * MIN) {
      const d = decideCue([v()], memory, T0 + dt)
      memory = d.memory
      if (d.cue) out.push(dt)
    }
    return out
  }

  it.each([
    ['close', 'close'],
    ['checks', 'checks:2'],
    ['review-import', 'review-import']
  ])('%s is standing: it cues on appear and then never re-nudges', (_kind, what) => {
    expect(cueTimes(() => owedView('a', what), 48 * HOUR)).toEqual([0])
  })

  it.each([
    ['rescope', 'rescope:main'],
    ['blocker', 'blocker:merge #6'],
    ['human-steps', 'human-steps:1']
  ])('%s is blocking: one cue, then 30 min, 1 h, 2 h, 4 h later, then silent', (_kind, what) => {
    // Cumulative: +30 min, +1 h, +2 h, +4 h after each previous cue.
    const expected = [0, 30 * MIN, 90 * MIN, 210 * MIN, 450 * MIN]
    expect(cueTimes(() => owedView('a', what), 48 * HOUR)).toEqual(expected)
  })

  it('a re-nudge fires at exactly the scheduled age, not a poll before', () => {
    const first = decideCue([owedView('a', 'blocker:x')], empty(), T0)
    expect(decideCue([owedView('a', 'blocker:x')], first.memory, T0 + 30 * MIN - 1).cue).toBe(false)
    const at = decideCue([owedView('a', 'blocker:x')], first.memory, T0 + 30 * MIN)
    expect(at.cue).toBe(true)
    // The next wait is 1 h from THIS cue, not from the first.
    expect(decideCue([owedView('a', 'blocker:x')], at.memory, T0 + 90 * MIN - 1).cue).toBe(false)
    expect(decideCue([owedView('a', 'blocker:x')], at.memory, T0 + 90 * MIN).cue).toBe(true)
  })

  it('schedule exhaustion: after the fourth reminder the key is silent for good', () => {
    let memory = decideCue([owedView('a', 'blocker:x')], empty(), T0).memory
    let now = T0
    for (const wait of BLOCKING_NUDGE_MS) {
      now += wait
      const d = decideCue([owedView('a', 'blocker:x')], memory, now)
      expect(d.cue).toBe(true)
      memory = d.memory
    }
    expect(memory.owed.get('a')?.keys.get('blocker:x')?.nudges).toBe(BLOCKING_NUDGE_MS.length)
    expect(decideCue([owedView('a', 'blocker:x')], memory, now + 30 * 24 * HOUR).cue).toBe(false)
  })

  it('growth resets the schedule: a second human gate cues and restarts at 30 min', () => {
    let memory = decideCue([owedView('a', 'human-steps:1')], empty(), T0).memory
    const nudged = decideCue([owedView('a', 'human-steps:1')], memory, T0 + 30 * MIN)
    expect(nudged.cue).toBe(true)
    memory = nudged.memory
    const grown = decideCue([owedView('a', 'human-steps:2')], memory, T0 + 40 * MIN)
    expect(grown.cue).toBe(true)
    expect(grown.memory.owed.get('a')?.keys.get('human-steps')).toMatchObject({
      count: 2,
      lastCuedAt: T0 + 40 * MIN,
      nudges: 0,
      firstOwedAt: T0
    })
    // Back at the head of the schedule: 30 min after the growth, not 1 h.
    expect(decideCue([owedView('a', 'human-steps:2')], grown.memory, T0 + 70 * MIN).cue).toBe(true)
  })

  it('a new key resets the schedule too: a different blocker cues from scratch', () => {
    const first = decideCue([owedView('a', 'blocker:one')], empty(), T0)
    const next = decideCue([owedView('a', 'blocker:two')], first.memory, T0 + 10 * MIN)
    expect(next.cue).toBe(true)
    expect(next.memory.owed.get('a')?.keys.get('blocker:two')?.nudges).toBe(0)
  })

  it('keeps one clock per key: a blocker re-nudges while the close next to it never does', () => {
    const both = () =>
      view({ id: 'a', status: 'delivered', you: [{ kind: 'close' }, blocker('k')] })
    const first = decideCue([both()], empty(), T0)
    const nudge = decideCue([both()], first.memory, T0 + 30 * MIN)
    expect(nudge).toMatchObject({ cue: true, missionIds: ['a'] })
    expect(nudge.memory.owed.get('a')?.keys.get('close')?.lastCuedAt).toBe(T0)
    expect(nudge.memory.owed.get('a')?.keys.get('close')?.nudges).toBe(0)
    expect(nudge.memory.owed.get('a')?.keys.get('blocker:k')?.nudges).toBe(1)
  })

  it('a shrinking count keeps its schedule (checks 3 → 1 stays silent, later growth cues)', () => {
    const first = decideCue([owedView('a', 'checks:3')], empty(), T0)
    const fewer = decideCue([owedView('a', 'checks:1')], first.memory, T0 + POLL)
    expect(fewer.cue).toBe(false)
    expect(decideCue([owedView('a', 'checks:1')], fewer.memory, T0 + 2 * HOUR).cue).toBe(false)
  })

  it('never cues a blocker raised and cleared between two polls, nor re-nudges it later', () => {
    let memory = decideCue([view({ id: 'a' })], empty(), T0).memory
    for (let t = T0 + POLL; t <= T0 + 2 * HOUR; t += 10 * MIN) {
      const d = decideCue([view({ id: 'a' })], memory, t)
      expect(d.cue).toBe(false)
      memory = d.memory
    }
  })

  it('does not re-nudge a blocker cleared before its 30 minutes were up', () => {
    const first = decideCue([owedView('a', 'blocker:merge')], empty(), T0)
    const cleared = decideCue([view({ id: 'a' })], first.memory, T0 + POLL)
    expect(decideCue([view({ id: 'a' })], cleared.memory, T0 + 31 * MIN).cue).toBe(false)
  })

  it('does not mutate the memory it was given', () => {
    const memory = decideCue([owedView('a', 'blocker:x')], empty(), T0).memory
    const before = serializeCueMemory(memory)
    decideCue([owedView('a', 'blocker:x'), owedView('b', 'close')], memory, T0 + HOUR)
    expect(serializeCueMemory(memory)).toEqual(before)
  })
})

describe('decideCue — a mission absent from a poll (spec §3.2 Stability)', () => {
  it('keeps its entry for ABSENT_TTL_MS, never cues it, and does not re-cue it on return', () => {
    const first = decideCue([owedView('a', 'blocker:x'), owedView('b', 'close')], empty(), T0)
    // `a` vanishes (unreadable file, shadowed copy flipping winner).
    const gone = decideCue([owedView('b', 'close')], first.memory, T0 + 10 * MIN)
    expect(gone.cue).toBe(false)
    expect(gone.memory.owed.get('a')).toEqual(first.memory.owed.get('a'))
    // Absent ≠ re-nudged, even past the blocker's 30-minute mark.
    const later = decideCue([owedView('b', 'close')], gone.memory, T0 + 3 * HOUR)
    expect(later.cue).toBe(false)
    expect(later.memory.owed.has('a')).toBe(true)
    // It comes back unchanged: not a backlog re-cue, the clock simply continues
    // (the 30-minute reminder was due while it was away, so it fires ONCE).
    const back = decideCue(
      [owedView('a', 'blocker:x'), owedView('b', 'close')],
      later.memory,
      T0 + 3 * HOUR + POLL
    )
    expect(back).toMatchObject({ cue: true, missionIds: ['a'] })
    expect(back.memory.owed.get('a')?.keys.get('blocker:x')?.nudges).toBe(1)
  })

  it('a standing key that was absent for under 24 h does not re-cue the backlog on return', () => {
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    const gone = decideCue([], first.memory, T0 + POLL)
    const back = decideCue([owedView('a', 'close')], gone.memory, T0 + 23 * HOUR)
    expect(back.cue).toBe(false)
  })

  it('an empty poll never cues and never wipes the memory', () => {
    const first = decideCue([owedView('a', 'close'), owedView('b', 'checks:2')], empty(), T0)
    const none = decideCue([], first.memory, T0 + POLL)
    expect(none).toMatchObject({ cue: false, missionIds: [] })
    expect(none.memory.owed.size).toBe(2)
    expect(
      decideCue([owedView('a', 'close'), owedView('b', 'checks:2')], none.memory, T0 + 2 * POLL).cue
    ).toBe(false)
  })

  it('is pruned by lastSeenAt once absent longer than ABSENT_TTL_MS, and then cues as new', () => {
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    const edge = decideCue([], first.memory, T0 + ABSENT_TTL_MS)
    expect(edge.memory.owed.has('a')).toBe(true)
    const pruned = decideCue([], first.memory, T0 + ABSENT_TTL_MS + 1)
    expect(pruned.memory.owed.has('a')).toBe(false)
    expect(decideCue([owedView('a', 'close')], pruned.memory, T0 + ABSENT_TTL_MS + 2).cue).toBe(
      true
    )
  })

  it('a present mission refreshes lastSeenAt, even when it owes nothing', () => {
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    const seen = decideCue([view({ id: 'a' })], first.memory, T0 + 20 * HOUR)
    expect(seen.memory.owed.get('a')).toMatchObject({ lastSeenAt: T0 + 20 * HOUR })
    expect(decideCue([], seen.memory, T0 + 40 * HOUR).memory.owed.has('a')).toBe(true)
  })
})

describe('restart — persisted cue memory (spec §3.2 Restart)', () => {
  it('the first poll after a start cues only what is new or grown since the last run', () => {
    const lastRun = decideCue(
      [owedView('a', 'close'), owedView('b', 'checks:1'), owedView('c', 'blocker:x')],
      empty(),
      T0
    )
    const stored = deserializeCueMemory(
      JSON.parse(JSON.stringify(serializeCueMemory(lastRun.memory)))
    )
    const first = decideCue(
      [
        owedView('a', 'close'), // unchanged backlog
        owedView('b', 'checks:2'), // grew while Harnu was closed
        owedView('c', 'blocker:x'), // unchanged (its 30 min are not up yet)
        owedView('d', 'close') // new
      ],
      stored,
      T0 + 10 * MIN
    )
    expect(first.missionIds.sort()).toEqual(['b', 'd'])
  })

  it('an unchanged backlog is silent on the first poll after a start', () => {
    const lastRun = decideCue([owedView('a', 'close'), owedView('b', 'checks:3')], empty(), T0)
    const stored = deserializeCueMemory(
      JSON.parse(JSON.stringify(serializeCueMemory(lastRun.memory)))
    )
    expect(
      decideCue([owedView('a', 'close'), owedView('b', 'checks:3')], stored, T0 + 5 * HOUR).cue
    ).toBe(false)
  })

  it('a blocker that came due while the app was closed fires once, not once per missed interval', () => {
    const lastRun = decideCue([owedView('a', 'blocker:x')], empty(), T0)
    const stored = deserializeCueMemory(
      JSON.parse(JSON.stringify(serializeCueMemory(lastRun.memory)))
    )
    const first = decideCue([owedView('a', 'blocker:x')], stored, T0 + 3 * HOUR)
    expect(first.cue).toBe(true)
    expect(first.memory.owed.get('a')?.keys.get('blocker:x')?.nudges).toBe(1)
    expect(decideCue([owedView('a', 'blocker:x')], first.memory, T0 + 3 * HOUR + POLL).cue).toBe(
      false
    )
  })

  it('seedCueMemory records the backlog as already heard: silent now and forever, until it grows', () => {
    const views = [owedView('a', 'blocker:x'), owedView('b', 'close'), view({ id: 'c' })]
    const seeded = seedCueMemory(views, T0)
    expect([...seeded.owed.keys()].sort()).toEqual(['a', 'b'])
    expect(seeded.owed.get('a')?.keys.get('blocker:x')).toEqual({
      count: 1,
      firstOwedAt: T0,
      lastCuedAt: T0,
      nudges: BLOCKING_NUDGE_MS.length
    })
    expect(decideCue(views, seeded, T0 + POLL).cue).toBe(false)
    expect(decideCue(views, seeded, T0 + 30 * 24 * HOUR).cue).toBe(false)
    expect(decideCue([owedView('a', 'blocker:y')], seeded, T0 + POLL).cue).toBe(true)
  })

  it('serialization round-trips the memory through JSON', () => {
    const memory = decideCue(
      [
        view({ id: 'a', you: [blocker('merge #6'), checks(2), { kind: 'close' }] }),
        owedView('b', 'human-steps:2')
      ],
      empty(),
      T0
    ).memory
    const nudged = decideCue([owedView('b', 'human-steps:2')], memory, T0 + 45 * MIN).memory
    const json = JSON.stringify(serializeCueMemory(nudged))
    const parsed: unknown = JSON.parse(json)
    expect(isPersistedCueMemory(parsed)).toBe(true)
    expect(deserializeCueMemory(parsed as never)).toEqual(nudged)
    expect(serializeCueMemory(nudged).v).toBe(1)
  })

  it('isPersistedCueMemory accepts only { v: 1, owed } and rejects anything corrupt', () => {
    const entry = (over: object = {}) => ({
      keys: { close: { count: 1, firstOwedAt: 1, lastCuedAt: 1, nudges: 0 } },
      lastSeenAt: 1,
      ...over
    })
    expect(isPersistedCueMemory({ v: 1, owed: {} })).toBe(true)
    expect(isPersistedCueMemory({ v: 1, owed: { a: entry() } })).toBe(true)
    for (const bad of [
      null,
      undefined,
      'x',
      42,
      [],
      {},
      { v: 1 },
      { v: 2, owed: {} },
      { v: 1, owed: null },
      { v: 1, owed: [] },
      { v: 1, owed: { a: null } },
      { v: 1, owed: { a: entry({ lastSeenAt: 'now' }) } },
      { v: 1, owed: { a: entry({ keys: null }) } },
      { v: 1, owed: { a: entry({ keys: { close: { count: 1 } } }) } },
      {
        v: 1,
        owed: {
          a: entry({ keys: { close: { count: NaN, firstOwedAt: 1, lastCuedAt: 1, nudges: 0 } } })
        }
      }
    ]) {
      expect(isPersistedCueMemory(bad)).toBe(false)
    }
  })
})
