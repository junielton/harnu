/**
 * Campaign ch.5a (T597, spec §3.4) — the steward's pure core: the allowlist as argv, the
 * per-steward bearer the server recognises, the server-side refusals, the kill-switch gate
 * and the worker shape. Nothing here spawns a process.
 */
import { describe, it, expect } from 'vitest'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { MCP_SERVER_NAMES, mcpToolName } from '../src/main/mcp/config-file'
import { tickArgv, newWorker, dueWorkers, type Worker } from '../src/main/scheduler-core'
import {
  STEWARD_WAKE_GAP_MS,
  wakeDecision,
  STEWARD_ALLOW_VERBS,
  STEWARD_EVERY_MINUTES,
  STEWARD_NATIVE_TOOLS,
  stewardBearer,
  stewardBlockedReason,
  stewardCallRefusal,
  stewardWorkerFor,
  verifyStewardBearer
} from '../src/main/steward-core'

const MISSION = 'mnt-0a1b2c3d'

function steward(over: Partial<Worker> = {}): Worker {
  return {
    ...stewardWorkerFor({ id: 'w-1', missionId: MISSION, folder: '/repo', title: 'T' }),
    ...over
  }
}

const valueOf = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}
const rulesOf = (csv: string | undefined): string[] => (csv ?? '').split(',').filter(Boolean)
const CATALOG = MCP_TOOLS.map((t) => t.name)
const ctx = { mcpConfigPath: '/ud/steward-mcp/w-1.json' }

describe('AC-5a.1 — steward mode allowlist is exactly spec §3.4', () => {
  it('names the verbs: every mission_*, campaign_get, message_session, notify, create_session, rebase_stack', () => {
    const missionVerbs = CATALOG.filter((v) => v.startsWith('mission_'))
    expect(missionVerbs.length).toBeGreaterThan(10)
    expect([...STEWARD_ALLOW_VERBS].sort()).toEqual(
      [
        ...missionVerbs,
        'campaign_get',
        'message_session',
        'notify',
        'create_session',
        'rebase_stack'
      ].sort()
    )
  })

  it('loads only Read, Grep, Glob and Skill as built-ins: no shell, no write tool', () => {
    expect([...STEWARD_NATIVE_TOOLS]).toEqual(['Read', 'Grep', 'Glob', 'Skill'])
    const argv = tickArgv(steward(), ctx)
    expect(valueOf(argv, '--tools')).toBe('Read,Grep,Glob,Skill')
    const deny = rulesOf(valueOf(argv, '--disallowedTools'))
    for (const t of ['Bash', 'Edit', 'Write', 'Monitor', 'EnterWorktree', 'SendMessage']) {
      expect(deny).toContain(t)
    }
    expect(argv).not.toContain('bypassPermissions')
  })

  it('allows its verbs and denies EVERY other catalog verb by name, under both server prefixes', () => {
    const argv = tickArgv(steward(), ctx)
    const allow = rulesOf(valueOf(argv, '--allowedTools'))
    const deny = rulesOf(valueOf(argv, '--disallowedTools'))
    for (const server of MCP_SERVER_NAMES) {
      for (const verb of CATALOG) {
        const rule = mcpToolName(verb, server)
        if (STEWARD_ALLOW_VERBS.includes(verb)) {
          expect(allow, rule).toContain(rule)
          expect(deny, rule).not.toContain(rule)
        } else {
          expect(deny, rule).toContain(rule)
          expect(allow, rule).not.toContain(rule)
        }
      }
    }
    // The bare server rule would allow every verb: it must never be in a steward's allow list.
    expect(allow).not.toContain('mcp__harnu')
    expect(allow).not.toContain('mcp__capy')
  })

  it('a verb added to the catalog tomorrow is denied until someone allows it by name', () => {
    const denied = CATALOG.filter((v) => !STEWARD_ALLOW_VERBS.includes(v))
    expect(denied).toEqual(
      expect.arrayContaining(['create_worker', 'update_worker', 'delete_worker'])
    )
    expect(denied).toEqual(
      expect.arrayContaining(['spawn_terminal', 'send_terminal', 'create_worktree'])
    )
    expect(denied).toEqual(
      expect.arrayContaining(['submit_manifest', 'plan_mission', 'campaign_create'])
    )
  })

  it('stewardCallRefusal: create_session only with role "verifier"', () => {
    const args = { folder: '/repo', prePrompt: 'x' }
    expect(stewardCallRefusal({ op: 'create_session', args, missionId: MISSION })).toMatch(
      /^STEWARD_ROLE_REQUIRED/
    )
    expect(
      stewardCallRefusal({
        op: 'create_session',
        args: { ...args, role: 'executor' },
        missionId: MISSION
      })
    ).toMatch(/^STEWARD_ROLE_REQUIRED/)
    expect(
      stewardCallRefusal({
        op: 'create_session',
        args: { ...args, role: 'verifier' },
        missionId: MISSION
      })
    ).toBeNull()
  })

  it('stewardCallRefusal: refuses a verb outside the allowlist, even if the CLI-level deny were bypassed', () => {
    for (const op of [
      'create_worker',
      'create_worktree',
      'submit_manifest',
      'send_terminal',
      'update_card'
    ]) {
      expect(stewardCallRefusal({ op, args: {}, missionId: MISSION }), op).toMatch(
        /^STEWARD_VERB_NOT_ALLOWED/
      )
    }
    for (const op of [
      'mission_get',
      'mission_log',
      'campaign_get',
      'notify',
      'message_session',
      'rebase_stack'
    ]) {
      expect(
        stewardCallRefusal({ op, args: { missionId: MISSION }, missionId: MISSION }),
        op
      ).toBeNull()
    }
  })

  it('stewardCallRefusal: a steward works on its OWN mission only', () => {
    expect(
      stewardCallRefusal({
        op: 'mission_log',
        args: { missionId: 'mnt-ffffffff' },
        missionId: MISSION
      })
    ).toMatch(/^STEWARD_SCOPE/)
    expect(
      stewardCallRefusal({
        op: 'rebase_stack',
        args: { missionId: 'mnt-ffffffff' },
        missionId: MISSION
      })
    ).toMatch(/^STEWARD_SCOPE/)
    // mission_create / mission_import_legacy name no mission: a steward never mints another one.
    expect(stewardCallRefusal({ op: 'mission_create', args: {}, missionId: MISSION })).toMatch(
      /^STEWARD_SCOPE/
    )
    expect(
      stewardCallRefusal({ op: 'mission_import_legacy', args: {}, missionId: MISSION })
    ).toMatch(/^STEWARD_SCOPE/)
    expect(stewardCallRefusal({ op: 'mission_list', args: {}, missionId: MISSION })).toBeNull()
  })
})

describe('the per-steward bearer', () => {
  it('round-trips, and a different secret, a forged mac or a mangled value never verifies', () => {
    const b = stewardBearer('secret-a', 'w-1')
    expect(verifyStewardBearer('secret-a', b)).toBe('w-1')
    expect(verifyStewardBearer('secret-b', b)).toBeNull()
    expect(verifyStewardBearer('secret-a', b.slice(0, -2) + 'zz')).toBeNull()
    expect(verifyStewardBearer('secret-a', 'secret-a')).toBeNull()
    expect(verifyStewardBearer('secret-a', 'stw_.')).toBeNull()
    expect(verifyStewardBearer('secret-a', '')).toBeNull()
  })

  it('is not the main token and does not contain it', () => {
    const b = stewardBearer('secret-a', 'w-1')
    expect(b).not.toBe('secret-a')
    expect(b).not.toContain('secret-a')
  })
})

describe('AC-5a.3 — the system worker shape', () => {
  it('is a steward-mode, steward-category worker bound to its mission, enabled, on the 20-minute fallback', () => {
    const w = stewardWorkerFor({ id: 'w-1', missionId: MISSION, folder: '/repo', title: 'Ship it' })
    expect(w).toMatchObject({
      id: 'w-1',
      mode: 'steward',
      category: 'steward',
      missionId: MISSION,
      folder: '/repo',
      enabled: true,
      everyMinutes: STEWARD_EVERY_MINUTES,
      allowNetwork: false,
      notifyOn: 'silent'
    })
    expect(STEWARD_EVERY_MINUTES).toBe(20)
    expect(w.name).toContain('Ship it')
    expect(w.prompt).toContain(MISSION)
    expect(w.prompt.trim().length).toBeGreaterThan(0)
  })

  it('never takes WebFetch, whatever allowNetwork says', () => {
    const argv = tickArgv(steward({ allowNetwork: true }), ctx)
    expect(valueOf(argv, '--tools')).not.toContain('WebFetch')
    expect(rulesOf(valueOf(argv, '--disallowedTools'))).toContain('WebFetch')
  })

  it('newWorker stays a plain user worker', () => {
    const w = newWorker('x')
    expect(w.category).toBeUndefined()
    expect(w.mode).toBe('observe')
  })
})

describe('AC-5a.3 — the global kill-switches stop a steward too', () => {
  it('runs when agent control is on and the folder is not blocked', () => {
    expect(stewardBlockedReason({ serverEnabled: true, folderDenied: false })).toBeNull()
  })
  it('SERVER_DISABLED: agent control off', () => {
    expect(stewardBlockedReason({ serverEnabled: false, folderDenied: false })).toMatch(
      /SERVER_DISABLED/
    )
  })
  it('FOLDER_NOT_ALLOWED: the operator blocked the folder', () => {
    expect(stewardBlockedReason({ serverEnabled: true, folderDenied: true })).toMatch(
      /FOLDER_NOT_ALLOWED/
    )
  })
})

describe('AC-5a.4 — the 20-minute fallback and the wake decision', () => {
  it('the scheduler beat picks a steward up 20 minutes after its last run, not before', () => {
    const w = steward()
    const last = 1_000_000
    expect(dueWorkers([w], { [w.id]: last }, [], last + 19 * 60_000)).toEqual([])
    expect(dueWorkers([w], { [w.id]: last }, [], last + 20 * 60_000)).toEqual([w])
  })

  const base = {
    enabled: true,
    running: false,
    blockedReason: null,
    now: 100_000,
    lastStartedAt: undefined
  }
  it('starts at once when idle, enabled, unblocked and outside the gap', () => {
    expect(wakeDecision({ ...base, gapMs: 60_000 })).toEqual({ action: 'start' })
    expect(wakeDecision({ ...base, gapMs: 60_000, lastStartedAt: 100_000 - 60_000 })).toEqual({
      action: 'start'
    })
  })
  it('defers to the end of the gap when a tick started inside it', () => {
    expect(wakeDecision({ ...base, gapMs: 60_000, lastStartedAt: 100_000 - 10_000 })).toEqual({
      action: 'defer',
      inMs: 50_000
    })
  })
  it('defers a full gap when a tick is running now (the event may be newer than its read)', () => {
    expect(wakeDecision({ ...base, gapMs: 60_000, running: true })).toEqual({
      action: 'defer',
      inMs: 60_000
    })
  })
  it('skips when disabled or blocked, naming why', () => {
    expect(wakeDecision({ ...base, gapMs: 1, enabled: false })).toMatchObject({ action: 'skip' })
    expect(wakeDecision({ ...base, gapMs: 1, blockedReason: 'SERVER_DISABLED: off' })).toEqual({
      action: 'skip',
      reason: 'SERVER_DISABLED: off'
    })
  })
  it('the default gap is a minute', () => {
    expect(STEWARD_WAKE_GAP_MS).toBe(60_000)
  })
})
