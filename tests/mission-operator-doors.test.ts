/**
 * T370 (T358 S9), Mission v3 — the operator doors in `mission-core.ts`: the
 * human-step tick, the one end door (close as delivered or discard) with its
 * warnings, and the human checks.
 * Also pins the posture every door shares with `applyApprovedRescope` /
 * `applyOperatorClose`: nothing under `src/main/mcp/` — no `mission_*` handler,
 * no catalog entry — can reach one. The UI reaches them through
 * `src/main/mission-ipc.ts` only.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  applyAddCheck,
  applyDeleteCheck,
  applyOperatorEnd,
  applyTickCheck,
  applyOperatorVerifyStep,
  closeWarnings,
  OPERATOR_VERIFIER,
  type Mission
} from '../src/main/mission-core'
import { computeProgress } from '../src/main/mission-progress'

const AT = '2026-09-28T15:00:00.000Z'

function draftMission(): Mission {
  return {
    id: 'mnt-00c0ffee',
    slug: 'ship-it',
    folder: '/repo',
    owner: { sessionId: '11111111-2222-4333-8444-555555555555', folder: '/repo' },
    status: 'draft',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'fixed-start',
        title: 'Scope confirmed',
        verification: 'existence',
        proof: 'unproven',
        links: [],
        blockers: []
      },
      {
        id: 'stp-3',
        ordinal: 2,
        kind: 'custom',
        title: 'Copy review',
        verification: 'human',
        proof: 'unproven',
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
        ordinal: 3,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-09-28T10:00:00.000Z' }
  }
}

describe('applyOperatorVerifyStep — the human-level step is the operator’s', () => {
  it('ticks a human step verified with the operator as verifier, and un-ticks it', () => {
    const active = { ...draftMission(), status: 'active' as const }
    const ticked = applyOperatorVerifyStep(active, 'stp-3', { at: AT, verified: true })
    expect(ticked.steps[1].proof).toBe('verified')
    expect(ticked.steps[1].verifiedBy).toEqual({
      sessionId: OPERATOR_VERIFIER,
      at: AT,
      verdict: 'met'
    })
    const unticked = applyOperatorVerifyStep(ticked, 'stp-3', { at: AT, verified: false })
    expect(unticked.steps[1].proof).toBe('unproven')
    expect(unticked.steps[1].verifiedBy).toBeUndefined()
    expect(active.steps[1].proof).toBe('unproven') // pure
  })

  it('refuses a non-human step, an unknown step, and a draft or closed mission', () => {
    const active = { ...draftMission(), status: 'active' as const }
    expect(() => applyOperatorVerifyStep(active, 'stp-2', { at: AT, verified: true })).toThrow(
      /verifier-level/
    )
    expect(() => applyOperatorVerifyStep(active, 'stp-1', { at: AT, verified: true })).toThrow(
      /existence-level/
    )
    expect(() => applyOperatorVerifyStep(active, 'stp-9', { at: AT, verified: true })).toThrow(
      /no step stp-9/
    )
    for (const status of ['draft', 'closed'] as const) {
      expect(() =>
        applyOperatorVerifyStep({ ...active, status }, 'stp-3', { at: AT, verified: true })
      ).toThrow(new RegExp(status))
    }
  })
})

describe('applyOperatorEnd — one operator door: close as delivered, or discard (Mission v3 §3.5)', () => {
  const blocker = { reason: 'r', unblocks: 'u', owner: 'agent' as const, raisedAt: AT }

  /** An active mission carrying every kind of warning: unverified end, left-behind, open check, blocker. */
  function messy(): Mission {
    let m: Mission = { ...draftMission(), status: 'active' }
    m.steps.splice(2, 0, {
      id: 'stp-4',
      ordinal: 3,
      kind: 'custom',
      title: 'Build',
      verification: 'verifier',
      proof: 'claimed',
      links: [],
      blockers: []
    })
    m.blockers.push(blocker)
    m = applyAddCheck(m, 'stp-4', 'Validated visually', 'agent', AT)
    return m
  }

  it('(a) closeWarnings lists every open matter — warnings, never refusals', () => {
    const m = messy()
    const warnings = closeWarnings(m, computeProgress(m, [], 0))
    expect(warnings.map((w) => w.kind)).toEqual([
      'end-unverified',
      'left-behind',
      'checks-open',
      'blockers-open'
    ])
    for (const w of warnings) expect(w.detail.length).toBeGreaterThan(0)
    const staged = { ...m, pendingRescope: { kind: 'other' as const, target: 't', evidence: 'e' } }
    expect(closeWarnings(staged, computeProgress(staged, [], 0)).map((w) => w.kind)).toContain(
      'rescope-staged'
    )
  })

  it('(a) closes any non-closed mission as delivered, whatever the warnings', () => {
    for (const status of ['active', 'stale', 'delivered'] as const) {
      const m = { ...messy(), status, pendingClose: { at: AT, requestedBy: 'x' } }
      const closed = applyOperatorEnd(m, { at: AT, closedAs: 'delivered' })
      expect(closed.status).toBe('closed')
      expect(closed.closedAs).toBe('delivered')
      expect(closed.closeReason).toBeUndefined()
      expect(closed.pendingClose).toBeUndefined()
      expect(closed.updatedAt).toBe(AT)
      expect(m.status).toBe(status) // pure
    }
  })

  it('(b) discard records closedAs discarded and the reason', () => {
    const ended = applyOperatorEnd(messy(), {
      at: AT,
      closedAs: 'discarded',
      reason: '  superseded by v3  '
    })
    expect(ended).toMatchObject({
      status: 'closed',
      closedAs: 'discarded',
      closeReason: 'superseded by v3'
    })
  })

  it('(c) a second end is refused MISSION_CLOSED (Review Focus: a double Close)', () => {
    const closed = applyOperatorEnd(messy(), { at: AT, closedAs: 'delivered' })
    expect(() => applyOperatorEnd(closed, { at: AT, closedAs: 'discarded' })).toThrow(
      /^MISSION_CLOSED/
    )
  })

  it('a clean mission has no warnings', () => {
    const m: Mission = { ...draftMission(), status: 'active' }
    m.steps[1].proof = 'verified'
    m.steps[2].proof = 'verified'
    expect(closeWarnings(m, computeProgress(m, [], 0))).toEqual([])
  })
})

describe('human checks (Mission v3 §3.6)', () => {
  const active = (): Mission => ({ ...draftMission(), status: 'active' })

  it('adds a check with the next chk-<n> id, its source and createdAt', () => {
    const m = applyAddCheck(active(), 'stp-3', '  DSQA   done ', 'agent', AT)
    expect(m.steps[1].checks).toEqual([
      { id: 'chk-1', label: 'DSQA done', source: 'agent', createdAt: AT }
    ])
    const m2 = applyAddCheck(m, 'stp-3', 'designer sign-off', 'operator', AT)
    expect(m2.steps[1].checks!.map((c) => c.id)).toEqual(['chk-1', 'chk-2'])
    expect(active().steps[1].checks).toBeUndefined() // pure
    expect(m2.updatedAt).toBe(AT)
  })

  it('dedupes a label case-insensitively per step — the first creator keeps the source (Review Focus)', () => {
    const v = applyAddCheck(active(), 'stp-3', 'Designer sign-off', 'verifier', AT)
    const o = applyAddCheck(v, 'stp-3', 'DESIGNER SIGN-OFF', 'operator', '2026-09-28T16:00:00.000Z')
    expect(o.steps[1].checks).toEqual([
      { id: 'chk-1', label: 'Designer sign-off', source: 'verifier', createdAt: AT }
    ])
    // The same label on ANOTHER step is a different check.
    const other = applyAddCheck(o, 'stp-2', 'designer sign-off', 'operator', AT)
    expect(other.steps[2].checks).toHaveLength(1)
  })

  it('refuses an empty or over-long label, an unknown step, and a closed mission', () => {
    expect(() => applyAddCheck(active(), 'stp-3', '   ', 'agent', AT)).toThrow(/BAD_ARGS/)
    expect(() => applyAddCheck(active(), 'stp-3', 'x'.repeat(201), 'agent', AT)).toThrow(/BAD_ARGS/)
    expect(() => applyAddCheck(active(), 'stp-9', 'x', 'agent', AT)).toThrow(/STEP_NOT_FOUND/)
    expect(() =>
      applyAddCheck({ ...active(), status: 'closed' }, 'stp-3', 'x', 'agent', AT)
    ).toThrow(/^MISSION_CLOSED/)
  })

  it('the operator ticks, un-ticks and deletes a check', () => {
    const m = applyAddCheck(active(), 'stp-3', 'DSQA', 'agent', AT)
    const ticked = applyTickCheck(m, 'stp-3', 'chk-1', { at: AT, ticked: true })
    expect(ticked.steps[1].checks![0].ticked).toEqual({ at: AT })
    const unticked = applyTickCheck(ticked, 'stp-3', 'chk-1', { at: AT, ticked: false })
    expect(unticked.steps[1].checks![0]).not.toHaveProperty('ticked')
    const deleted = applyDeleteCheck(unticked, 'stp-3', 'chk-1', { at: AT })
    expect(deleted.steps[1].checks).toEqual([])
    expect(() => applyTickCheck(m, 'stp-3', 'chk-9', { at: AT, ticked: true })).toThrow(
      /CHECK_NOT_FOUND/
    )
    expect(() => applyDeleteCheck(m, 'stp-3', 'chk-9', { at: AT })).toThrow(/CHECK_NOT_FOUND/)
    expect(() =>
      applyTickCheck({ ...m, status: 'closed' }, 'stp-3', 'chk-1', { at: AT, ticked: true })
    ).toThrow(/^MISSION_CLOSED/)
  })

  it('checks never change progress — ticked or not', () => {
    const base = active()
    base.steps[1].proof = 'claimed'
    const withChecks = applyTickCheck(
      applyAddCheck(applyAddCheck(base, 'stp-3', 'a', 'agent', AT), 'stp-2', 'b', 'operator', AT),
      'stp-3',
      'chk-1',
      { at: AT, ticked: true }
    )
    const strip = (p: ReturnType<typeof computeProgress>): unknown => ({ ...p, computedAt: '' })
    expect(strip(computeProgress(withChecks, [], 0))).toEqual(strip(computeProgress(base, [], 0)))
  })
})

describe('no MCP code path reaches an operator door', () => {
  const DOORS = [
    'applyApprovedRescope',
    'applyOperatorVerifyStep',
    'applyOperatorEnd',
    // Mission v3 §3.6: only the operator ticks or deletes a check.
    'applyTickCheck',
    'applyDeleteCheck'
  ]
  const mcpDir = path.join(__dirname, '..', 'src', 'main', 'mcp')

  function sources(dir: string): Array<{ file: string; text: string }> {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return sources(full)
      return e.name.endsWith('.ts') ? [{ file: full, text: readFileSync(full, 'utf8') }] : []
    })
  }

  it('no file under src/main/mcp/ calls a door or imports the IPC module that does', () => {
    const files = sources(mcpDir)
    expect(files.length).toBeGreaterThan(10)
    for (const { file, text } of files) {
      for (const door of DOORS) {
        // A mention in a comment is fine; a call or an import binding is not.
        expect(text, `${file} calls ${door}`).not.toMatch(new RegExp(`\\b${door}\\s*\\(`))
        expect(text, `${file} imports ${door}`).not.toMatch(
          new RegExp(`import[^;]*\\b${door}\\b[^;]*from`, 's')
        )
      }
      expect(text, `${file} imports mission-ipc`).not.toMatch(/from ['"][./]*mission-ipc['"]/)
    }
  })
})

describe('Mission v3 §3.4/§3.5 — the draft ceremony is gone', () => {
  it('no source file under src/main refers to MISSION_DRAFT or the approve door', () => {
    const root = path.join(__dirname, '..')
    let hits = ''
    try {
      hits = execFileSync(
        'git',
        ['grep', '-n', '-e', 'MISSION_DRAFT', '-e', 'applyOperatorApprove', '--', 'src/main'],
        { cwd: root, encoding: 'utf8' }
      ).trim()
    } catch (err) {
      // git grep exits 1 when nothing matches — the outcome this test wants.
      if ((err as { status?: number }).status !== 1) throw err
    }
    expect(hits).toBe('')
  })
})
