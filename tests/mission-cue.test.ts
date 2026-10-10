/**
 * Mission v3 §3.12 (AC-10, AC-6) — the owed-to-operator cue decision
 * (`lib/mission-cue.ts`), keyed from the server's `you` list: one key per owed
 * kind with its count, a cue only when a key APPEARS or a count GROWS (never on
 * a tick, a resolution or a decrease), approvals / needs-input excluded, no
 * draft kind (a dead legacy draft never cues), one combined cue on the first
 * poll after a start, and the 30-min re-nudge while the mission still owes.
 * Time is an injected `now`.
 */
import { describe, it, expect } from 'vitest'
import type { MissionView } from '../src/main/mission-ipc'
import type { MissionYouItem } from '../src/main/mcp/tool-handlers'
import type { DeclaredEnd, Mission } from '../src/main/mission-core'
import {
  decideCue,
  firstOwed,
  owedKeys,
  RENUDGE_MS,
  type CueMemory
} from '../src/renderer/src/lib/mission-cue'

const END: DeclaredEnd = { kind: 'code', target: 'stacked PRs merged', evidence: 'PR list' }
const T0 = 1_790_000_000_000
const POLL = 20_000

const empty = (): CueMemory => ({ owed: new Map(), primed: false })

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
const blocker = (reason: string): MissionYouItem => ({ kind: 'blocker', reason, unblocks: 'done' })

/** A view owing `what`: `close`, `rescope:<target>`, `blocker:<reason>` or `checks:<n>`. */
function owedView(id: string, what: string): MissionView {
  if (what === 'close') return view({ id, status: 'delivered', you: [{ kind: 'close' }] })
  if (what.startsWith('rescope:')) {
    return view({ id, you: [{ kind: 'rescope', end: { ...END, target: what.slice(8) } }] })
  }
  if (what.startsWith('blocker:')) return view({ id, you: [blocker(what.slice(8))] })
  if (what.startsWith('checks:')) return view({ id, you: [checks(Number(what.slice(7)))] })
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
    expect(ticked.memory.owed.has('a')).toBe(false)
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
    for (let t = T0; t <= T0 + 3 * RENUDGE_MS; t += POLL) {
      const d = decideCue([dead], memory, t)
      expect(d.cue).toBe(false)
      memory = d.memory
    }
    expect(memory.owed.size).toBe(0)
  })

  it('gives one combined cue on the first poll when missions are already owed', () => {
    const d = decideCue([owedView('a', 'checks:1'), owedView('b', 'close')], empty(), T0)
    expect(d.cue).toBe(true)
    expect(d.missionIds.sort()).toEqual(['a', 'b'])
    expect(d.memory.primed).toBe(true)
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
})

describe('decideCue — the 30-minute re-nudge', () => {
  it('re-nudges after RENUDGE_MS while still owed, then waits another RENUDGE_MS', () => {
    expect(RENUDGE_MS).toBe(30 * 60 * 1000)
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    const early = decideCue([owedView('a', 'close')], first.memory, T0 + RENUDGE_MS - POLL)
    expect(early.cue).toBe(false)
    const second = decideCue([owedView('a', 'close')], early.memory, T0 + RENUDGE_MS + 1)
    expect(second).toMatchObject({ cue: true, missionIds: ['a'] })
    expect(decideCue([owedView('a', 'close')], second.memory, T0 + RENUDGE_MS + POLL).cue).toBe(
      false
    )
    expect(decideCue([owedView('a', 'close')], second.memory, T0 + 2 * RENUDGE_MS + 2).cue).toBe(
      true
    )
  })

  it('stays silent on every 20 s poll for 30 minutes after a restart cue', () => {
    let memory = decideCue([owedView('a', 'checks:2'), owedView('b', 'close')], empty(), T0).memory
    for (let t = T0 + POLL; t <= T0 + RENUDGE_MS; t += POLL) {
      const d = decideCue([owedView('a', 'checks:2'), owedView('b', 'close')], memory, t)
      expect(d.cue).toBe(false)
      memory = d.memory
    }
  })

  it('a shrinking list still re-nudges while anything is owed (the list as a whole)', () => {
    const first = decideCue([owedView('a', 'checks:3')], empty(), T0)
    const fewer = decideCue([owedView('a', 'checks:1')], first.memory, T0 + POLL)
    expect(fewer.cue).toBe(false)
    expect(decideCue([owedView('a', 'checks:1')], fewer.memory, T0 + RENUDGE_MS + 1).cue).toBe(true)
  })

  it('keeps firstOwedAt across re-nudges and moves lastCuedAt', () => {
    const first = decideCue([owedView('a', 'close')], empty(), T0)
    const second = decideCue([owedView('a', 'close')], first.memory, T0 + RENUDGE_MS + 1)
    expect(second.memory.owed.get('a')).toEqual({
      keys: new Map([['close', 1]]),
      firstOwedAt: T0,
      lastCuedAt: T0 + RENUDGE_MS + 1
    })
  })

  it('never cues a blocker raised and cleared between two polls, nor re-nudges it later', () => {
    let memory = decideCue([view({ id: 'a' })], empty(), T0).memory
    for (let t = T0 + POLL; t <= T0 + 2 * RENUDGE_MS; t += POLL) {
      const d = decideCue([view({ id: 'a' })], memory, t)
      expect(d.cue).toBe(false)
      memory = d.memory
    }
    expect(memory.owed.size).toBe(0)
  })

  it('does not re-nudge an item cleared before its 30 minutes were up', () => {
    const first = decideCue([owedView('a', 'blocker:merge')], empty(), T0)
    const cleared = decideCue([view({ id: 'a' })], first.memory, T0 + POLL)
    expect(decideCue([view({ id: 'a' })], cleared.memory, T0 + RENUDGE_MS + 1).cue).toBe(false)
  })

  it('does not mutate the memory it was given', () => {
    const memory = empty()
    decideCue([owedView('a', 'close')], memory, T0)
    expect(memory).toEqual(empty())
  })
})
