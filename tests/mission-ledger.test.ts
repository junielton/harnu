/**
 * Campaign ch.1 (T593, spec §3.2) — the mission ledger: rows Harnu appends, never a
 * verb. Pure helpers + the on-disk shape (append-only, optional so a file without
 * events stays byte-identical).
 */
import { describe, it, expect } from 'vitest'
import {
  buildMissionFileContent,
  parseMissionFile,
  LEDGER_KINDS,
  type Mission,
  type MissionStep
} from '../src/main/mission-core'
import {
  appendLedgerRow,
  hasLedgerRow,
  lastLedgerDetail,
  ledgerTail,
  pickLedgerTargets,
  LEDGER_TAIL
} from '../src/main/mission-ledger'

const at = '2026-10-30T10:00:00.000Z'

function step(id: string, links: MissionStep['links'] = []): MissionStep {
  return {
    id,
    ordinal: Number(id.slice(4)),
    kind: 'custom',
    title: id,
    verification: 'existence',
    proof: 'unproven',
    links,
    blockers: []
  }
}

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'mnt-00000001',
    slug: 'm',
    folder: '/repo',
    owner: { sessionId: 'o', folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [step('stp-1'), step('stp-2')],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at },
    ...over
  }
}

describe('ledger kinds', () => {
  it('are the eight events of spec §3.2', () => {
    expect([...LEDGER_KINDS]).toEqual([
      'dispatched',
      'worktree',
      'pr-opened',
      'pr-merged',
      'ci',
      'verified',
      'session-died',
      'compaction'
    ])
  })
})

describe('appendLedgerRow', () => {
  it('appends one row with at, kind, stepId and ref and leaves the input untouched', () => {
    const m = mission()
    const next = appendLedgerRow(m, { kind: 'dispatched', stepId: 'stp-1', ref: 'sess-1' }, at)
    expect(m.ledger).toBeUndefined()
    expect(next.ledger).toEqual([{ at, kind: 'dispatched', stepId: 'stp-1', ref: 'sess-1' }])
  })

  it('is append-only: earlier rows keep their order', () => {
    let m = mission()
    m = appendLedgerRow(m, { kind: 'dispatched', ref: 'a' }, at)
    m = appendLedgerRow(m, { kind: 'worktree', ref: 'b' }, at)
    expect(m.ledger?.map((r) => r.ref)).toEqual(['a', 'b'])
  })

  it('round-trips through the mission file and an empty ledger writes no key', () => {
    const withRows = appendLedgerRow(mission(), { kind: 'ci', ref: '#7', detail: 'passing' }, at)
    const parsed = parseMissionFile(buildMissionFileContent(withRows)) as Mission
    expect(parsed.ledger).toEqual(withRows.ledger)
    expect(buildMissionFileContent(mission())).not.toContain('ledger')
  })

  it('rejects a row whose kind is not one of the eight', () => {
    const bad = { ...mission(), ledger: [{ at, kind: 'merged-by-agent', ref: 'x' }] }
    expect(() => buildMissionFileContent(bad as unknown as Mission)).toThrow(/ledger/)
  })
})

describe('ledger readers', () => {
  it('ledgerTail returns the last 20 rows, oldest first', () => {
    let m = mission()
    for (let i = 0; i < 25; i++) m = appendLedgerRow(m, { kind: 'ci', ref: `#${i}` }, at)
    const tail = ledgerTail(m)
    expect(LEDGER_TAIL).toBe(20)
    expect(tail).toHaveLength(20)
    expect(tail[0].ref).toBe('#5')
    expect(tail[19].ref).toBe('#24')
    expect(ledgerTail(mission())).toEqual([])
  })

  it('hasLedgerRow and lastLedgerDetail look up by kind + ref', () => {
    let m = mission()
    m = appendLedgerRow(m, { kind: 'ci', ref: '#7', detail: 'pending' }, at)
    m = appendLedgerRow(m, { kind: 'ci', ref: '#7', detail: 'passing' }, at)
    expect(hasLedgerRow(m, 'ci', '#7')).toBe(true)
    expect(hasLedgerRow(m, 'ci', '#8')).toBe(false)
    expect(hasLedgerRow(m, 'pr-opened', '#7')).toBe(false)
    expect(lastLedgerDetail(m, 'ci', '#7')).toBe('passing')
    expect(lastLedgerDetail(m, 'ci', '#8')).toBeUndefined()
  })
})

describe('pickLedgerTargets — which mission a dispatch belongs to', () => {
  const a = mission({
    id: 'mnt-0000000a',
    steps: [step('stp-1', [{ kind: 'card', ref: 'T1' }]), step('stp-2')]
  })
  const b = mission({
    id: 'mnt-0000000b',
    steps: [step('stp-1', [{ kind: 'worktree', ref: '/repo/.claude/worktrees/b-1' }])]
  })
  const closed = mission({ id: 'mnt-0000000c', status: 'closed' })

  it('a card link names the mission and the step', () => {
    expect(pickLedgerTargets([a, b], { card: 'T1' })).toEqual([
      { missionId: a.id, stepId: 'stp-1' }
    ])
  })

  it('a worktree path link names the mission and the step', () => {
    expect(pickLedgerTargets([a, b], { folder: '/repo/.claude/worktrees/b-1' })).toEqual([
      { missionId: b.id, stepId: 'stp-1' }
    ])
  })

  it('with no link match, the only open mission gets the row (no step)', () => {
    expect(pickLedgerTargets([a, closed], { folder: '/elsewhere' })).toEqual([{ missionId: a.id }])
  })

  it('with no link match and several open missions, nobody is guessed', () => {
    expect(pickLedgerTargets([a, b], { folder: '/elsewhere' })).toEqual([])
  })

  it('a closed mission never receives a row', () => {
    expect(pickLedgerTargets([closed], { folder: '/repo' })).toEqual([])
  })
})
