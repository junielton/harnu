import { describe, it, expect } from 'vitest'
import {
  verbAllowRule,
  mergeVerbAllowRule,
  settingsAllowsVerb,
  isAlwaysAllowableVerb,
  alwaysAllowDefaultFor,
  ALWAYS_ALLOWABLE_VERBS,
  DANGEROUS_ALWAYS_ALLOW_VERBS,
  hasHookEntry,
  mergeHookEntry,
  removeHookEntry
} from '../src/main/mcp/settings-local'

/**
 * T93 piece 4 — the pure halves of the durable "always allow this verb here" grant:
 * the read-merge-write transform into `.claude/settings.local.json` and the
 * honor-side match, plus the allowable/dangerous verb sets. Two security invariants
 * are load-bearing: `plan_mission` is NEVER allowable (a durable auto-allow of the
 * grant minter would remove the human from mission approval), and the merge must
 * PRESERVE every unrelated key (clobbering the user's own permissions would be a
 * silent security downgrade).
 */

describe('verbAllowRule', () => {
  it('formats the mcp__harnu__<verb> permission rule', () => {
    expect(verbAllowRule('create_session')).toBe('mcp__harnu__create_session')
    expect(verbAllowRule('open_file')).toBe('mcp__harnu__open_file')
  })
})

describe('verb sets', () => {
  it('ALWAYS_ALLOWABLE_VERBS excludes plan_mission and every read', () => {
    expect(ALWAYS_ALLOWABLE_VERBS).not.toContain('plan_mission')
    for (const read of [
      'get_fleet',
      'get_session',
      'memory_read',
      'memory_query',
      'list_worktrees'
    ])
      expect(isAlwaysAllowableVerb(read)).toBe(false)
    expect(isAlwaysAllowableVerb('plan_mission')).toBe(false)
  })

  it('the mutating verbs (except plan_mission) are allowable', () => {
    for (const verb of [
      'create_session',
      'create_worktree',
      'spawn_terminal',
      'adopt_folder',
      'memory_append',
      'open_file'
    ])
      expect(isAlwaysAllowableVerb(verb)).toBe(true)
  })

  it('dangerous verbs default the checkbox UNCHECKED; the rest checked', () => {
    expect([...DANGEROUS_ALWAYS_ALLOW_VERBS].sort()).toEqual(['create_worktree', 'spawn_terminal'])
    expect(alwaysAllowDefaultFor('create_worktree')).toBe(false)
    expect(alwaysAllowDefaultFor('spawn_terminal')).toBe(false)
    expect(alwaysAllowDefaultFor('create_session')).toBe(true)
    expect(alwaysAllowDefaultFor('open_file')).toBe(true)
    expect(alwaysAllowDefaultFor('adopt_folder')).toBe(true)
    expect(alwaysAllowDefaultFor('memory_append')).toBe(true)
  })
})

describe('mergeVerbAllowRule (read-merge-write matrix)', () => {
  const rule = verbAllowRule('create_session')

  it('creates the whole structure when the file is absent (undefined)', () => {
    expect(mergeVerbAllowRule(undefined, rule)).toEqual({
      permissions: { allow: [rule] }
    })
  })

  it('creates the structure from a non-object / array base (malformed file)', () => {
    expect(mergeVerbAllowRule(null, rule)).toEqual({ permissions: { allow: [rule] } })
    expect(mergeVerbAllowRule('garbage', rule)).toEqual({ permissions: { allow: [rule] } })
    expect(mergeVerbAllowRule([1, 2, 3], rule)).toEqual({ permissions: { allow: [rule] } })
  })

  it('preserves unrelated TOP-LEVEL keys', () => {
    const out = mergeVerbAllowRule({ model: 'sonnet', hooks: { PreToolUse: [] } }, rule)
    expect(out.model).toBe('sonnet')
    expect(out.hooks).toEqual({ PreToolUse: [] })
    expect(out.permissions).toEqual({ allow: [rule] })
  })

  it('preserves unrelated permissions.* keys (deny / ask / defaultMode)', () => {
    const out = mergeVerbAllowRule(
      { permissions: { deny: ['Bash(rm *)'], ask: ['Edit'], defaultMode: 'ask' } },
      rule
    )
    expect(out.permissions).toEqual({
      deny: ['Bash(rm *)'],
      ask: ['Edit'],
      defaultMode: 'ask',
      allow: [rule]
    })
  })

  it('appends to an existing allow array, preserving its members', () => {
    const out = mergeVerbAllowRule({ permissions: { allow: ['Bash(git *)'] } }, rule)
    expect(out.permissions?.allow).toEqual(['Bash(git *)', rule])
  })

  it('is idempotent — re-adding the same rule does not duplicate it', () => {
    const once = mergeVerbAllowRule({ permissions: { allow: [rule] } }, rule)
    expect(once.permissions?.allow).toEqual([rule])
    const twice = mergeVerbAllowRule(once, rule)
    expect(twice.permissions?.allow).toEqual([rule])
  })

  it('dedupes a pre-existing duplicate + non-string junk in the allow array', () => {
    const out = mergeVerbAllowRule(
      { permissions: { allow: ['Edit', 'Edit', 42, null, 'Edit'] } },
      rule
    )
    expect(out.permissions?.allow).toEqual(['Edit', rule])
  })

  it('replaces a malformed (non-array) allow rather than throwing', () => {
    const out = mergeVerbAllowRule({ permissions: { allow: 'oops' } }, rule)
    expect(out.permissions?.allow).toEqual([rule])
  })

  it('never mutates the input object', () => {
    const input = { permissions: { allow: ['Edit'] }, model: 'opus' }
    const snapshot = JSON.parse(JSON.stringify(input))
    mergeVerbAllowRule(input, rule)
    expect(input).toEqual(snapshot)
  })
})

describe('settingsAllowsVerb (honor-side match)', () => {
  it('matches when the folder allows the verb', () => {
    const settings = { permissions: { allow: ['mcp__harnu__create_session', 'Edit'] } }
    expect(settingsAllowsVerb(settings, 'create_session')).toBe(true)
  })

  it('still honors a rule saved under the pre-rename mcp__capy__ prefix', () => {
    const settings = { permissions: { allow: ['mcp__capy__create_session', 'Edit'] } }
    expect(settingsAllowsVerb(settings, 'create_session')).toBe(true)
  })

  it('a legacy rule for one verb never grants a different verb', () => {
    const settings = { permissions: { allow: ['mcp__capy__create_session'] } }
    expect(settingsAllowsVerb(settings, 'create_worktree')).toBe(false)
    expect(settingsAllowsVerb(settings, 'spawn_terminal')).toBe(false)
  })

  it('does not match a different verb', () => {
    const settings = { permissions: { allow: ['mcp__harnu__create_session'] } }
    expect(settingsAllowsVerb(settings, 'spawn_terminal')).toBe(false)
  })

  it('NEVER honors a hand-written plan_mission rule (grant minter is not allowable)', () => {
    for (const prefix of ['mcp__harnu__', 'mcp__capy__']) {
      const settings = { permissions: { allow: [`${prefix}plan_mission`] } }
      expect(settingsAllowsVerb(settings, 'plan_mission')).toBe(false)
    }
  })

  it('is false on missing / malformed settings', () => {
    expect(settingsAllowsVerb(undefined, 'create_session')).toBe(false)
    expect(settingsAllowsVerb(null, 'create_session')).toBe(false)
    expect(settingsAllowsVerb('garbage', 'create_session')).toBe(false)
    expect(settingsAllowsVerb({}, 'create_session')).toBe(false)
    expect(settingsAllowsVerb({ permissions: {} }, 'create_session')).toBe(false)
    expect(settingsAllowsVerb({ permissions: { allow: 'x' } }, 'create_session')).toBe(false)
  })

  it('round-trips with mergeVerbAllowRule (what we write, we honor)', () => {
    const written = mergeVerbAllowRule(undefined, verbAllowRule('open_file'))
    expect(settingsAllowsVerb(written, 'open_file')).toBe(true)
    expect(settingsAllowsVerb(written, 'create_worktree')).toBe(false)
  })
})

/**
 * T109 §1/§3/§4 — the generic `hooks.<Event>` command-entry read-merge-write,
 * extended onto this module (not forked) for the orchestrator guard's
 * `PreToolUse` registration in a folder's `.claude/settings.local.json`.
 */
describe('mergeHookEntry / removeHookEntry / hasHookEntry (hooks.<Event> matrix)', () => {
  const EVENT = 'PreToolUse'
  const MATCHER = 'Edit|Write|NotebookEdit'
  const COMMAND = 'node "/userData/orchestrator-guard/guard.mjs"'

  it('creates the whole structure when the file is absent', () => {
    expect(mergeHookEntry(undefined, EVENT, MATCHER, COMMAND)).toEqual({
      hooks: { [EVENT]: [{ matcher: MATCHER, hooks: [{ type: 'command', command: COMMAND }] }] }
    })
  })

  it('creates the structure from a non-object / array base (malformed file)', () => {
    expect(mergeHookEntry(null, EVENT, MATCHER, COMMAND).hooks).toBeDefined()
    expect(mergeHookEntry('garbage', EVENT, MATCHER, COMMAND).hooks).toBeDefined()
    expect(mergeHookEntry([1, 2], EVENT, MATCHER, COMMAND).hooks).toBeDefined()
  })

  it('preserves unrelated top-level keys', () => {
    const out = mergeHookEntry(
      { model: 'sonnet', permissions: { allow: ['Edit'] } },
      EVENT,
      MATCHER,
      COMMAND
    )
    expect(out.model).toBe('sonnet')
    expect(out.permissions).toEqual({ allow: ['Edit'] })
  })

  it('preserves an unrelated hook EVENT untouched', () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }
    const out = mergeHookEntry(existing, EVENT, MATCHER, COMMAND)
    expect(out.hooks?.Stop).toEqual(existing.hooks.Stop)
    expect(out.hooks?.[EVENT]).toEqual([
      { matcher: MATCHER, hooks: [{ type: 'command', command: COMMAND }] }
    ])
  })

  it('preserves an unrelated matcher entry within the SAME event', () => {
    const existing = {
      hooks: { [EVENT]: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-hook' }] }] }
    }
    const out = mergeHookEntry(existing, EVENT, MATCHER, COMMAND)
    expect(out.hooks?.[EVENT]).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-hook' }] },
      { matcher: MATCHER, hooks: [{ type: 'command', command: COMMAND }] }
    ])
  })

  it('is idempotent — re-adding the same (event, matcher, command) does not duplicate it', () => {
    const once = mergeHookEntry(undefined, EVENT, MATCHER, COMMAND)
    const twice = mergeHookEntry(once, EVENT, MATCHER, COMMAND)
    expect(twice.hooks?.[EVENT]).toHaveLength(1)
  })

  it('never mutates the input object', () => {
    const input = { hooks: { [EVENT]: [{ matcher: 'Bash', hooks: [] }] } }
    const snapshot = JSON.parse(JSON.stringify(input))
    mergeHookEntry(input, EVENT, MATCHER, COMMAND)
    expect(input).toEqual(snapshot)
  })

  describe('hasHookEntry', () => {
    it('matches what mergeHookEntry writes (round-trip)', () => {
      const written = mergeHookEntry(undefined, EVENT, MATCHER, COMMAND)
      expect(hasHookEntry(written, EVENT, MATCHER, COMMAND)).toBe(true)
    })

    it('is false for a different command, matcher, event, or malformed settings', () => {
      const written = mergeHookEntry(undefined, EVENT, MATCHER, COMMAND)
      expect(hasHookEntry(written, EVENT, MATCHER, 'node other.mjs')).toBe(false)
      expect(hasHookEntry(written, EVENT, 'Bash', COMMAND)).toBe(false)
      expect(hasHookEntry(written, 'Stop', MATCHER, COMMAND)).toBe(false)
      expect(hasHookEntry(undefined, EVENT, MATCHER, COMMAND)).toBe(false)
      expect(hasHookEntry('garbage', EVENT, MATCHER, COMMAND)).toBe(false)
    })
  })

  describe('removeHookEntry', () => {
    it('removes the entry, dropping the emptied matcher entry and the hooks key entirely', () => {
      const written = mergeHookEntry(undefined, EVENT, MATCHER, COMMAND)
      const out = removeHookEntry(written, EVENT, MATCHER, COMMAND)
      expect(out.hooks).toBeUndefined()
    })

    it('preserves a sibling matcher entry in the same event after removal', () => {
      const existing = mergeHookEntry(
        {
          hooks: {
            [EVENT]: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'keep-me' }] }]
          }
        },
        EVENT,
        MATCHER,
        COMMAND
      )
      const out = removeHookEntry(existing, EVENT, MATCHER, COMMAND)
      expect(out.hooks?.[EVENT]).toEqual([
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'keep-me' }] }
      ])
    })

    it('preserves unrelated events and top-level keys', () => {
      const existing = {
        model: 'opus',
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
          [EVENT]: [{ matcher: MATCHER, hooks: [{ type: 'command', command: COMMAND }] }]
        }
      }
      const out = removeHookEntry(existing, EVENT, MATCHER, COMMAND)
      expect(out.model).toBe('opus')
      expect(out.hooks?.Stop).toEqual(existing.hooks.Stop)
      expect(out.hooks?.[EVENT]).toBeUndefined()
    })

    it('is a safe no-op when the entry is absent (missing hooks / different command)', () => {
      expect(removeHookEntry(undefined, EVENT, MATCHER, COMMAND)).toEqual({})
      const other = {
        hooks: { [EVENT]: [{ matcher: MATCHER, hooks: [{ type: 'command', command: 'x' }] }] }
      }
      const out = removeHookEntry(other, EVENT, MATCHER, COMMAND)
      expect(out.hooks?.[EVENT]).toEqual(other.hooks[EVENT])
    })

    it('never mutates the input object', () => {
      const input = mergeHookEntry(undefined, EVENT, MATCHER, COMMAND)
      const snapshot = JSON.parse(JSON.stringify(input))
      removeHookEntry(input, EVENT, MATCHER, COMMAND)
      expect(input).toEqual(snapshot)
    })
  })
})
