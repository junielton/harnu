/**
 * Campaign ch.1 (T593, spec §3.2) — the mission ledger: rows Harnu appends, never a
 * verb. Pure helpers + the on-disk shape (append-only, optional so a file without
 * events stays byte-identical).
 */
import { describe, it, expect } from 'vitest'
import {
  hasLedgerRow,
  lastLedgerDetail,
  mergeLedger,
  pickLedgerTargets,
  LEDGER_KINDS,
  LEDGER_TAIL,
  type LedgerRow
} from '../src/main/mission-ledger'
import { parseV3MissionFile, type V3Mission } from '../src/main/missions/v3-read'
import { buildV3MissionFile } from './helpers/v3-mission-file'

const at = '2026-10-30T10:00:00.000Z'

type Step = { id: string; links: Array<{ kind: string; ref: string }>; card?: string }

function step(id: string, links: Step['links'] = []): Step {
  return { id, links }
}

function mission(over: Partial<{ id: string; status: string; steps: Step[] }> = {}): {
  id: string
  status: string
  steps: Step[]
} {
  return { id: 'mnt-00000001', status: 'active', steps: [step('stp-1'), step('stp-2')], ...over }
}

/** A complete v3 file's frontmatter, with the ledger the caller gives it. */
function v3File(ledger?: unknown[]): string {
  return buildV3MissionFile({
    id: 'mnt-00000001',
    slug: 'm',
    folder: '/repo',
    owner: { sessionId: 'o', folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 't', evidence: 'e' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'stp-1',
        verification: 'existence',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at },
    ...(ledger ? { ledger } : {})
  })
}

describe('ledger kinds', () => {
  it('are the events of spec §3.2 plus the T654 owner-transfer row', () => {
    expect([...LEDGER_KINDS]).toEqual([
      'dispatched',
      'worktree',
      'pr-opened',
      'pr-merged',
      'ci',
      'verified',
      'session-died',
      'compaction',
      'owner-transfer'
    ])
  })
})

describe('a ledger written into an old v3 mission file', () => {
  it('still reads: the rows come back as written, in order', () => {
    const rows: LedgerRow[] = [
      { at, kind: 'dispatched', stepId: 'stp-1', ref: 'sess-1' },
      { at, kind: 'ci', ref: '#7', detail: 'passing' }
    ]
    const parsed = parseV3MissionFile(v3File(rows)) as V3Mission
    expect(parsed.ledger).toEqual(rows)
  })

  it('a file without events has no ledger key', () => {
    const parsed = parseV3MissionFile(v3File()) as V3Mission
    expect(parsed.ledger).toBeUndefined()
  })

  it('rejects a row whose kind is not a ledger kind', () => {
    const bad = parseV3MissionFile(v3File([{ at, kind: 'merged-by-agent', ref: 'x' }]))
    expect('error' in bad && bad.error).toMatch(/ledger/)
  })
})

describe('ledger readers', () => {
  it('a read returns the last 20 rows', () => {
    expect(LEDGER_TAIL).toBe(20)
  })

  it('hasLedgerRow and lastLedgerDetail look up by kind + ref', () => {
    const m = {
      ledger: [
        { at, kind: 'ci', ref: '#7', detail: 'pending' },
        { at, kind: 'ci', ref: '#7', detail: 'passing' }
      ] as LedgerRow[]
    }
    expect(hasLedgerRow(m, 'ci', '#7')).toBe(true)
    expect(hasLedgerRow(m, 'ci', '#8')).toBe(false)
    expect(hasLedgerRow(m, 'pr-opened', '#7')).toBe(false)
    expect(lastLedgerDetail(m, 'ci', '#7')).toBe('passing')
    expect(lastLedgerDetail(m, 'ci', '#8')).toBeUndefined()
    expect(hasLedgerRow({}, 'ci', '#7')).toBe(false)
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

  it('a v4 step that names its card receives the row, with no link needed', () => {
    const v4 = mission({
      id: 'mnt-0000000d',
      steps: [{ id: 'stp-1', links: [], card: 'T9' }, step('stp-2')]
    })
    expect(pickLedgerTargets([v4, b], { card: 'T9' })).toEqual([
      { missionId: v4.id, stepId: 'stp-1' }
    ])
  })

  it('a closed mission never receives a row', () => {
    expect(pickLedgerTargets([closed], { folder: '/repo' })).toEqual([])
  })
})

describe('mergeLedger — file rows and observed rows read as one ledger', () => {
  const row = (atIso: string, ref: string): { at: string; kind: 'ci'; ref: string } => ({
    at: atIso,
    kind: 'ci',
    ref
  })

  it('orders by time, keeps insertion order on ties, and never mutates its inputs', () => {
    const file = [row('2026-10-30T10:00:00.000Z', 'a'), row('2026-10-30T10:02:00.000Z', 'c')]
    const observed = [row('2026-10-30T10:01:00.000Z', 'b'), row('2026-10-30T10:02:00.000Z', 'd')]
    const merged = mergeLedger(file, observed)
    expect(merged.map((r) => r.ref)).toEqual(['a', 'b', 'c', 'd'])
    expect(file).toHaveLength(2)
    expect(observed).toHaveLength(2)
  })

  it('handles a mission with no file ledger', () => {
    expect(mergeLedger(undefined, [])).toEqual([])
  })
})
