/**
 * Campaign ch.5a (T597, spec §3.7 + Amendment b) — the three hooks Harnu installs in a folder's
 * `.claude/settings.local.json` when a mission with a steward is created, and removes at close;
 * and the Mission Brief the SessionStart(compact) hook prints. Pure: the merge works on parsed
 * objects, so "the user's own hooks are never touched" is a byte-level assertion here.
 */
import { describe, it, expect } from 'vitest'
import {
  buildMissionBrief,
  isStewardHook,
  mergeStewardHooks,
  removeStewardHooks,
  stewardHookFragment,
  BRIEF_MAX_CHARS
} from '../src/main/steward-hooks'
import type { Mission } from '../src/main/mission-core'

const TOKEN = 'bridge-secret'
const PORT = 4711

const userHook = { type: 'command', command: 'echo user-pre-compact' }
const userSettings = (): Record<string, unknown> => ({
  permissions: { allow: ['mcp__harnu__create_session'], deny: ['Bash(rm:*)'] },
  env: { FOO: 'bar' },
  hooks: {
    PreCompact: [{ hooks: [userHook] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }]
  }
})

describe('AC-5a.5 — the fragment', () => {
  it('has SessionStart(compact) → brief, PreCompact → precompact, Stop and SubagentStop → wake', () => {
    const f = stewardHookFragment({ port: PORT, token: TOKEN })
    expect(Object.keys(f).sort()).toEqual(['PreCompact', 'SessionStart', 'Stop', 'SubagentStop'])
    expect(f.SessionStart[0].matcher).toBe('compact')
    const url = (e: string): string => String(f[e][0].hooks[0].command)
    expect(url('SessionStart')).toContain(`http://127.0.0.1:${PORT}/steward/${TOKEN}/brief`)
    expect(url('PreCompact')).toContain(`/steward/${TOKEN}/precompact`)
    expect(url('Stop')).toContain(`/steward/${TOKEN}/wake`)
    expect(url('SubagentStop')).toContain(`/steward/${TOKEN}/wake`)
    for (const e of Object.keys(f)) expect(isStewardHook(f[e][0].hooks[0])).toBe(true)
  })

  it('never blocks a session: a failing curl still exits 0', () => {
    const f = stewardHookFragment({ port: PORT, token: TOKEN })
    for (const e of Object.keys(f)) {
      expect(String(f[e][0].hooks[0].command)).toMatch(/\|\| true$/)
    }
  })
})

describe('AC-5a.5 — install into settings.local.json', () => {
  it("adds the four hooks and leaves the user's settings, permissions and hooks untouched", () => {
    const before = userSettings()
    const snapshot = JSON.stringify(before)
    const merged = mergeStewardHooks(before, { port: PORT, token: TOKEN }) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>
      permissions: unknown
      env: unknown
    }
    expect(JSON.stringify(before)).toBe(snapshot) // pure: the input is not mutated
    expect(merged.permissions).toEqual((before as { permissions: unknown }).permissions)
    expect(merged.env).toEqual({ FOO: 'bar' })
    // The user's handlers are still there, in place, and ours are added beside them.
    expect(merged.hooks.PreCompact[0].hooks).toEqual([userHook])
    expect(merged.hooks.PreCompact.some((e) => e.hooks.some((h) => isStewardHook(h)))).toBe(true)
    expect(merged.hooks.PreToolUse).toEqual((before.hooks as Record<string, unknown>).PreToolUse)
    expect(merged.hooks.SessionStart.some((e) => e.hooks.some((h) => isStewardHook(h)))).toBe(true)
    expect(merged.hooks.SubagentStop.length).toBe(1)
  })

  it('creates the file shape from nothing', () => {
    const merged = mergeStewardHooks(undefined, { port: PORT, token: TOKEN }) as {
      hooks: Record<string, unknown[]>
    }
    expect(Object.keys(merged.hooks).sort()).toEqual([
      'PreCompact',
      'SessionStart',
      'Stop',
      'SubagentStop'
    ])
  })

  it('is idempotent, and a stale port/token is replaced rather than duplicated', () => {
    const once = mergeStewardHooks(userSettings(), { port: 1111, token: 'old' })
    const twice = mergeStewardHooks(once, { port: PORT, token: TOKEN })
    const again = mergeStewardHooks(twice, { port: PORT, token: TOKEN })
    expect(JSON.stringify(again)).toBe(JSON.stringify(twice))
    const text = JSON.stringify(twice)
    expect(text).not.toContain('/steward/old/')
    expect(text.match(/\/steward\//g)!.length).toBe(4)
  })
})

describe('AC-5a.5 — removal at close', () => {
  it("removes exactly the steward hooks: install → remove restores the user's settings byte for byte", () => {
    const before = userSettings()
    const merged = mergeStewardHooks(before, { port: PORT, token: TOKEN })
    expect(JSON.stringify(removeStewardHooks(merged))).toBe(JSON.stringify(before))
  })

  it("drops an event array and the hooks key when nothing of the user's is left, keeping other keys", () => {
    const merged = mergeStewardHooks({ env: { A: '1' } }, { port: PORT, token: TOKEN })
    expect(removeStewardHooks(merged)).toEqual({ env: { A: '1' } })
  })

  it('removes nothing from a file that has none of ours', () => {
    const before = userSettings()
    expect(removeStewardHooks(before)).toEqual(before)
  })

  it('does not mistake a user hook that mentions /steward/ in prose for ours', () => {
    expect(isStewardHook({ type: 'command', command: 'echo see /steward/ docs' })).toBe(false)
    expect(isStewardHook(userHook)).toBe(false)
    expect(isStewardHook(null)).toBe(false)
  })
})

// ── the Mission Brief ────────────────────────────────────────────────────────

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'mnt-0a1b2c3d',
    slug: 'ship-it',
    folder: '/repo',
    owner: { sessionId: '11111111-2222-4333-8444-555555555555', folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'every page migrated', evidence: 'the audit is green' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Build the importer',
        verification: 'verifier',
        proof: 'verified',
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'custom',
        title: 'Migrate the pages',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: [
          {
            reason: 'Rebase onto main conflicted',
            unblocks: 'resolve by hand',
            owner: 'agent',
            raisedAt: '2026-10-31T10:00:00.000Z'
          }
        ]
      },
      {
        id: 'stp-3',
        ordinal: 3,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [
      {
        reason: 'Waiting for the CDN key',
        unblocks: 'operator pastes it',
        owner: 'operator',
        raisedAt: '2026-10-31T09:00:00.000Z'
      }
    ],
    openQuestions: [],
    createdAt: '2026-10-31T08:00:00.000Z',
    updatedAt: '2026-10-31T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-10-31T08:00:00.000Z' },
    ledger: [
      { at: '2026-10-31T08:30:00.000Z', kind: 'dispatched', ref: 'sess-a', stepId: 'stp-1' },
      { at: '2026-10-31T09:30:00.000Z', kind: 'pr-opened', ref: '#305', pr: 305, stepId: 'stp-2' },
      {
        at: '2026-10-31T09:40:00.000Z',
        kind: 'ci',
        ref: '#305',
        pr: 305,
        detail: 'red',
        stepId: 'stp-2'
      }
    ],
    ...over
  }
}

describe('AC-5a.5 — the Mission Brief (≤ 1.5k tokens)', () => {
  const gates = {
    'stp-1': { pr: 'green', ci: 'green', main: 'green', verifier: 'green', checks: 'na' },
    'stp-2': { pr: 'running', ci: 'red', main: 'off', verifier: 'off', checks: 'na' }
  } as const

  it('carries the declared end, the step table with gates, the ledger tail and the open blockers', () => {
    const brief = buildMissionBrief({ mission: mission(), title: 'Ship it', gates })
    expect(brief).toContain('mnt-0a1b2c3d')
    expect(brief).toContain('Ship it')
    expect(brief).toContain('every page migrated')
    expect(brief).toContain('the audit is green')
    expect(brief).toContain('stp-1')
    expect(brief).toContain('Build the importer')
    expect(brief).toMatch(/stp-2[^\n]*pr:running[^\n]*ci:red/)
    expect(brief).toMatch(/pr-opened[^\n]*#305/)
    expect(brief).toMatch(/ci[^\n]*#305[^\n]*red/)
    expect(brief).toContain('Waiting for the CDN key')
    expect(brief).toContain('Rebase onto main conflicted')
  })

  it('names the doors it can not cross, so a resumed owner does not try', () => {
    expect(buildMissionBrief({ mission: mission(), title: 'Ship it' })).toMatch(/operator/i)
  })

  it('works without gates (the derive is best-effort on a SessionStart hook)', () => {
    const brief = buildMissionBrief({ mission: mission(), title: 'Ship it' })
    expect(brief).toContain('Migrate the pages')
    expect(brief).not.toContain('undefined')
  })

  it('stays within the cap on a huge mission, dropping the OLDEST ledger rows first, never the declared end or a blocker', () => {
    const steps = Array.from({ length: 150 }, (_, i) => ({
      id: `stp-${i + 1}`,
      ordinal: i + 1,
      kind: 'custom' as const,
      title: `Step number ${i + 1} with a reasonably long descriptive title to take space`,
      verification: 'verifier' as const,
      proof: 'unproven' as const,
      links: [],
      blockers: []
    }))
    const ledger = Array.from({ length: 400 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 9, 31, 0, i)).toISOString(),
      kind: 'ci' as const,
      ref: `#${i}`,
      pr: i,
      detail: 'green'
    }))
    const brief = buildMissionBrief({ mission: mission({ steps, ledger }), title: 'Ship it' })
    expect(BRIEF_MAX_CHARS).toBeLessThanOrEqual(6000)
    expect(brief.length).toBeLessThanOrEqual(BRIEF_MAX_CHARS)
    expect(brief).toContain('every page migrated')
    expect(brief).toContain('Waiting for the CDN key')
    expect(brief).toContain('#399') // newest ledger row survives
    expect(brief).not.toContain('#0 ') // oldest does not
  })
})
