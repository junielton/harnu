/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T109 — the Capy-managed orchestrator guard shell: install/refresh, arm/disarm,
 * boot sweep, hook (de)registration into a folder's `.claude/settings.local.json`,
 * and personal-hook coexistence detection (spec §1-§4). `electron` is mocked so
 * `app.getPath('userData')` points at a fresh tmpdir per test, mirroring the
 * responder-registry / usage-poller approach; `isPackaged: false` +
 * `getAppPath: () => process.cwd()` route the resource read at the real
 * `resources/orchestrator-guard/guard.mjs` checked into this repo.
 */

let userDataDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

import {
  installOrchestratorGuard,
  guardScriptPath,
  guardHookCommand,
  arm,
  disarm,
  isArmed,
  listArmedSessionIds,
  ensureGuardHookRegistration,
  removeGuardHookRegistration,
  refreshGuardHookCommand,
  refreshGuardHookRegistration,
  pruneArmed,
  sweepOnBoot,
  hasPersonalGuardHook,
  shouldDisarmOnEvent,
  shouldArmAtSpawn,
  shouldDisarmEntry,
  registerOrchestratorGuard,
  GUARD_HOOK_EVENT,
  GUARD_HOOK_MATCHER,
  type ArmedMap
} from '../src/main/orchestrator-guard'

function settingsLocalPath(folder: string): string {
  return join(folder, '.claude', 'settings.local.json')
}

function readSettingsLocal(folder: string): unknown {
  return JSON.parse(readFileSync(settingsLocalPath(folder), 'utf8'))
}

let folder = ''

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orchestrator-guard-userdata-'))
  folder = mkdtempSync(join(tmpdir(), 'orchestrator-guard-folder-'))
})

describe('installOrchestratorGuard', () => {
  it('copies the checked-in resource script verbatim into <userData>/orchestrator-guard/guard.mjs', async () => {
    await installOrchestratorGuard()
    const installed = readFileSync(guardScriptPath(), 'utf8')
    const source = readFileSync(
      join(process.cwd(), 'resources/orchestrator-guard/guard.mjs'),
      'utf8'
    )
    expect(installed).toBe(source)
  })

  it('is safe to run twice (refresh on every boot)', async () => {
    await installOrchestratorGuard()
    await installOrchestratorGuard()
    expect(existsSync(guardScriptPath())).toBe(true)
  })
})

describe('arm / disarm / isArmed (lifecycle, spec §3)', () => {
  it('arm writes an armed.json entry and registers the hook idempotently', async () => {
    await arm('sess-1', folder)
    expect(await isArmed('sess-1')).toBe(true)

    const armedPath = join(userDataDir, 'orchestrator-guard', 'armed.json')
    const map = JSON.parse(readFileSync(armedPath, 'utf8')) as ArmedMap
    expect(map['sess-1'].folder).toBe(folder)
    expect(typeof map['sess-1'].armedAt).toBe('number')

    const settings = readSettingsLocal(folder) as { hooks?: Record<string, unknown[]> }
    expect(settings.hooks?.[GUARD_HOOK_EVENT]).toHaveLength(1)
  })

  it('arming twice does not duplicate the hook registration', async () => {
    await arm('sess-1', folder)
    await arm('sess-2', folder)
    const settings = readSettingsLocal(folder) as { hooks?: Record<string, unknown[]> }
    expect(settings.hooks?.[GUARD_HOOK_EVENT]).toHaveLength(1)
  })

  it('disarm removes ONLY the armed.json entry, leaving the folder hook registered', async () => {
    await arm('sess-1', folder)
    await disarm('sess-1')
    expect(await isArmed('sess-1')).toBe(false)

    const settings = readSettingsLocal(folder) as { hooks?: Record<string, unknown[]> }
    expect(settings.hooks?.[GUARD_HOOK_EVENT]).toHaveLength(1) // still registered
  })

  it('disarming a session that was never armed is a safe no-op', async () => {
    await expect(disarm('never-armed')).resolves.toBeUndefined()
    expect(await isArmed('never-armed')).toBe(false)
  })

  it('arming two different sessions in the same folder keeps both entries', async () => {
    await arm('sess-1', folder)
    await arm('sess-2', folder)
    expect(await isArmed('sess-1')).toBe(true)
    expect(await isArmed('sess-2')).toBe(true)
    await disarm('sess-1')
    expect(await isArmed('sess-1')).toBe(false)
    expect(await isArmed('sess-2')).toBe(true)
  })
})

describe('listArmedSessionIds (T98 — renderer visible-role hydration)', () => {
  it('is empty when nothing is armed', async () => {
    expect(await listArmedSessionIds()).toEqual([])
  })

  it('lists every currently-armed session id', async () => {
    await arm('sess-1', folder)
    await arm('sess-2', folder)
    expect(new Set(await listArmedSessionIds())).toEqual(new Set(['sess-1', 'sess-2']))
  })

  it('drops a session once disarmed', async () => {
    await arm('sess-1', folder)
    await arm('sess-2', folder)
    await disarm('sess-1')
    expect(await listArmedSessionIds()).toEqual(['sess-2'])
  })
})

describe('ensureGuardHookRegistration / removeGuardHookRegistration (spec §1.3, §3 uninstall)', () => {
  it('preserves unrelated settings.local.json keys on install', async () => {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(
      settingsLocalPath(folder),
      JSON.stringify({ permissions: { allow: ['mcp__capy__open_file'] } }, null, 2)
    )
    await ensureGuardHookRegistration(folder)
    const settings = readSettingsLocal(folder) as {
      permissions?: unknown
      hooks?: Record<string, unknown[]>
    }
    expect(settings.permissions).toEqual({ allow: ['mcp__capy__open_file'] })
    expect(settings.hooks?.[GUARD_HOOK_EVENT]).toHaveLength(1)
  })

  it('removes the hook entry cleanly, leaving no dead scaffolding', async () => {
    await ensureGuardHookRegistration(folder)
    await removeGuardHookRegistration(folder)
    const settings = readSettingsLocal(folder) as { hooks?: unknown }
    expect(settings.hooks).toBeUndefined()
  })

  it('remove is a safe no-op when never installed', async () => {
    await expect(removeGuardHookRegistration(folder)).resolves.toBeUndefined()
  })

  it('the registered matcher and command match the exported constants', async () => {
    await ensureGuardHookRegistration(folder)
    const settings = readSettingsLocal(folder) as {
      hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>
    }
    const entry = settings.hooks[GUARD_HOOK_EVENT][0]
    expect(entry.matcher).toBe(GUARD_HOOK_MATCHER)
    expect(entry.hooks[0].command).toBe(guardHookCommand())
  })
})

describe('stale guard hook command after the userData rename (Capy → Harnu)', () => {
  const OLD_CAPITAL = 'node "/home/u/.config/Capy/orchestrator-guard/guard.mjs"'
  const OLD_LOWER = 'node "/home/u/.config/capy/orchestrator-guard/guard.mjs"'
  const staleSettings = (command: string): Record<string, unknown> => ({
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      PreToolUse: [
        { matcher: GUARD_HOOK_MATCHER, hooks: [{ type: 'command', command }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }
      ]
    }
  })
  const writeSettings = (obj: unknown): void => {
    mkdirSync(join(folder, '.claude'), { recursive: true })
    writeFileSync(settingsLocalPath(folder), JSON.stringify(obj), 'utf8')
  }

  describe('refreshGuardHookCommand (pure)', () => {
    it.each([OLD_CAPITAL, OLD_LOWER])('rewrites %s to the current userData path', (old) => {
      const { next, changed } = refreshGuardHookCommand(staleSettings(old), guardHookCommand())
      expect(changed).toBe(true)
      const pre = (next as any).hooks.PreToolUse
      expect(pre[0].hooks).toEqual([{ type: 'command', command: guardHookCommand() }])
      expect(pre[1].hooks[0].command).toBe('echo user') // unrelated hook untouched
      expect((next as any).permissions).toEqual({ allow: ['Bash(ls)'] })
    })

    it('is a no-op when the command is already current', () => {
      const cur = staleSettings(guardHookCommand())
      const { next, changed } = refreshGuardHookCommand(cur, guardHookCommand())
      expect(changed).toBe(false)
      expect(next).toEqual(cur)
    })

    it('does not touch a foreign command that merely sits under the guard matcher', () => {
      const foreign = staleSettings('node "/opt/other/thing.mjs"')
      expect(refreshGuardHookCommand(foreign, guardHookCommand()).changed).toBe(false)
    })

    it('collapses the old and the current command into one handler', () => {
      const both = {
        hooks: {
          PreToolUse: [
            {
              matcher: GUARD_HOOK_MATCHER,
              hooks: [
                { type: 'command', command: OLD_CAPITAL },
                { type: 'command', command: guardHookCommand() }
              ]
            }
          ]
        }
      }
      const { next } = refreshGuardHookCommand(both, guardHookCommand())
      expect((next as any).hooks.PreToolUse[0].hooks).toEqual([
        { type: 'command', command: guardHookCommand() }
      ])
    })

    it('does not rewrite a user script that merely lives in an orchestrator-guard dir', () => {
      for (const own of [
        'node "/home/u/tools/orchestrator-guard/guard.mjs" --strict',
        'bash /home/u/tools/orchestrator-guard/guard.mjs',
        'node /home/u/tools/orchestrator-guard/guard.mjs'
      ]) {
        const userOwn = staleSettings(own)
        const { next, changed } = refreshGuardHookCommand(userOwn, guardHookCommand())
        expect(changed).toBe(false)
        expect(next).toEqual(userOwn)
      }
    })

    it('does not rewrite a user guard.mjs at a foreign path, even in an orchestrator-guard dir', () => {
      for (const own of [
        'node "/home/me/tools/orchestrator-guard/guard.mjs"',
        'node "/home/me/.config/other-app/orchestrator-guard/guard.mjs"',
        'node "C:\\\\Users\\\\me\\\\tools\\\\orchestrator-guard\\\\guard.mjs"'
      ]) {
        const userOwn = staleSettings(own)
        const { next, changed } = refreshGuardHookCommand(userOwn, guardHookCommand())
        expect(changed).toBe(false)
        expect(next).toEqual(userOwn)
      }
    })

    it('keeps a user guard beside ours instead of deduping it away', () => {
      const own = 'node "/home/me/tools/orchestrator-guard/guard.mjs"'
      const both = {
        hooks: {
          PreToolUse: [
            {
              matcher: GUARD_HOOK_MATCHER,
              hooks: [
                { type: 'command', command: own },
                { type: 'command', command: OLD_CAPITAL }
              ]
            }
          ]
        }
      }
      const { next } = refreshGuardHookCommand(both, guardHookCommand())
      expect((next as any).hooks.PreToolUse[0].hooks).toEqual([
        { type: 'command', command: own },
        { type: 'command', command: guardHookCommand() }
      ])
    })

    it.each([
      'node "/home/u/.config/Capy/orchestrator-guard/guard.mjs"',
      'node "/home/u/.config/capy/orchestrator-guard/guard.mjs"',
      'node "/home/u/.config/Harnu/orchestrator-guard/guard.mjs"',
      'node "/home/u/.config/harnu/orchestrator-guard/guard.mjs"',
      'node "C:\\\\Users\\\\u\\\\AppData\\\\Roaming\\\\Capy\\\\orchestrator-guard\\\\guard.mjs"'
    ])('still rewrites our own old userData path: %s', (old) => {
      const { next, changed } = refreshGuardHookCommand(staleSettings(old), guardHookCommand())
      expect(changed).toBe(true)
      expect((next as any).hooks.PreToolUse[0].hooks[0].command).toBe(guardHookCommand())
    })

    it('collapses the old and current command across separate matcher entries', () => {
      // An old build arming after a Harnu one appends its own entry beside ours.
      const split = {
        hooks: {
          PreToolUse: [
            {
              matcher: GUARD_HOOK_MATCHER,
              hooks: [{ type: 'command', command: guardHookCommand() }]
            },
            { matcher: GUARD_HOOK_MATCHER, hooks: [{ type: 'command', command: OLD_CAPITAL }] },
            { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }
          ]
        }
      }
      const { next, changed } = refreshGuardHookCommand(split, guardHookCommand())
      expect(changed).toBe(true)
      expect((next as any).hooks.PreToolUse).toEqual([
        { matcher: GUARD_HOOK_MATCHER, hooks: [{ type: 'command', command: guardHookCommand() }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }
      ])
    })

    it('tolerates garbage input', () => {
      for (const v of [undefined, null, 'x', [1], { hooks: 'nope' }])
        expect(refreshGuardHookCommand(v, guardHookCommand()).changed).toBe(false)
    })
  })

  it('arm() rewrites a stale-path guard hook in the folder instead of adding a second one', async () => {
    writeSettings(staleSettings(OLD_CAPITAL))
    await arm('sess-1', folder)
    const pre = (readSettingsLocal(folder) as any).hooks.PreToolUse
    const guards = pre.filter((e: any) => e.matcher === GUARD_HOOK_MATCHER)
    expect(guards).toHaveLength(1)
    expect(guards[0].hooks).toEqual([{ type: 'command', command: guardHookCommand() }])
    expect(pre.some((e: any) => e.matcher === 'Bash')).toBe(true)
  })

  it('ensureGuardHookRegistration rewrites a stale-path hook (lowercase capy dir too)', async () => {
    writeSettings(staleSettings(OLD_LOWER))
    await ensureGuardHookRegistration(folder)
    const pre = (readSettingsLocal(folder) as any).hooks.PreToolUse
    expect(pre.filter((e: any) => e.matcher === GUARD_HOOK_MATCHER)[0].hooks[0].command).toBe(
      guardHookCommand()
    )
  })

  describe('refreshGuardHookRegistration (refresh-only shell)', () => {
    it('rewrites an existing stale hook', async () => {
      writeSettings(staleSettings(OLD_CAPITAL))
      await refreshGuardHookRegistration(folder)
      expect((readSettingsLocal(folder) as any).hooks.PreToolUse[0].hooks[0].command).toBe(
        guardHookCommand()
      )
    })

    it('never creates a settings file (or the folder) that is not there', async () => {
      await refreshGuardHookRegistration(folder)
      expect(existsSync(settingsLocalPath(folder))).toBe(false)
      const gone = join(folder, 'deleted-worktree')
      await refreshGuardHookRegistration(gone)
      expect(existsSync(gone)).toBe(false)
    })

    it('does not add a guard hook where none was registered', async () => {
      writeSettings({ model: 'opus' })
      await refreshGuardHookRegistration(folder)
      expect(readSettingsLocal(folder)).toEqual({ model: 'opus' })
    })
  })

  it('boot (registerOrchestratorGuard) refreshes the hook of every still-armed folder', async () => {
    writeSettings(staleSettings(OLD_CAPITAL))
    // armed.json as carried over by the userData migration
    mkdirSync(join(userDataDir, 'orchestrator-guard'), { recursive: true })
    writeFileSync(
      join(userDataDir, 'orchestrator-guard', 'armed.json'),
      JSON.stringify({ alive: { folder, armedAt: 1 } }),
      'utf8'
    )
    const root = mkdtempSync(join(tmpdir(), 'orchestrator-guard-projects-'))
    mkdirSync(join(root, 'p'), { recursive: true })
    writeFileSync(join(root, 'p', 'alive.jsonl'), '', 'utf8')

    const handle = await registerOrchestratorGuard({ sweepRoot: root })
    try {
      expect(await isArmed('alive')).toBe(true)
      expect((readSettingsLocal(folder) as any).hooks.PreToolUse[0].hooks[0].command).toBe(
        guardHookCommand()
      )
    } finally {
      handle.close()
    }
  })
})

describe('guardHookCommand', () => {
  it('is a `node "<installed guard.mjs path>"` command', () => {
    expect(guardHookCommand()).toBe(`node ${JSON.stringify(guardScriptPath())}`)
    expect(guardHookCommand()).toContain('guard.mjs')
  })
})

describe('pruneArmed (pure sweep rule)', () => {
  it('keeps only entries whose session id is in the existing set', () => {
    const map: ArmedMap = {
      alive: { folder: '/a', armedAt: 1 },
      dead: { folder: '/b', armedAt: 2 }
    }
    expect(pruneArmed(map, new Set(['alive']))).toEqual({ alive: { folder: '/a', armedAt: 1 } })
  })

  it('returns an empty object when nothing is alive', () => {
    const map: ArmedMap = { a: { folder: '/a', armedAt: 1 } }
    expect(pruneArmed(map, new Set())).toEqual({})
  })

  it('is a no-op when everything is alive', () => {
    const map: ArmedMap = { a: { folder: '/a', armedAt: 1 }, b: { folder: '/b', armedAt: 2 } }
    expect(pruneArmed(map, new Set(['a', 'b']))).toEqual(map)
  })
})

describe('sweepOnBoot (spec §3 / AC-1 — no orphan survives a restart)', () => {
  it('drops an armed entry whose session transcript no longer exists', async () => {
    await arm('alive-session', folder)
    await arm('orphan-session', folder)

    const root = mkdtempSync(join(tmpdir(), 'orchestrator-guard-projects-'))
    const projectDir = join(root, 'some-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'alive-session.jsonl'), '{}\n')
    // no file for 'orphan-session' -> should be swept

    await sweepOnBoot(root)

    expect(await isArmed('alive-session')).toBe(true)
    expect(await isArmed('orphan-session')).toBe(false)
  })

  it('is a no-op (skips the scan) when armed.json is already empty', async () => {
    const root = join(tmpdir(), 'orchestrator-guard-projects-does-not-exist')
    await expect(sweepOnBoot(root)).resolves.toBeUndefined()
  })

  it('leaves armed.json untouched when the transcript root cannot be read at all', async () => {
    await arm('sess-1', folder)
    await sweepOnBoot('/definitely/does/not/exist/anywhere')
    // Can't verify aliveness -> must NOT prune (else a transient fs glitch would
    // spuriously disarm an active orchestrator session).
    expect(await isArmed('sess-1')).toBe(true)
  })
})

describe('hasPersonalGuardHook (spec §4 coexistence detection)', () => {
  it('detects the operator personal hook by its script basename', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/orchestrator-guard.sh' }]
          }
        ]
      }
    }
    expect(hasPersonalGuardHook(settings)).toBe(true)
  })

  it('is false when only Capy-managed or unrelated hooks are present', () => {
    expect(
      hasPersonalGuardHook({
        hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: guardHookCommand() }] }] }
      })
    ).toBe(false)
    expect(hasPersonalGuardHook({ hooks: { Stop: [{ hooks: [{ command: 'x' }] }] } })).toBe(false)
  })

  it('is false on missing/malformed settings', () => {
    expect(hasPersonalGuardHook(undefined)).toBe(false)
    expect(hasPersonalGuardHook(null)).toBe(false)
    expect(hasPersonalGuardHook('garbage')).toBe(false)
    expect(hasPersonalGuardHook({})).toBe(false)
    expect(hasPersonalGuardHook({ hooks: {} })).toBe(false)
    expect(hasPersonalGuardHook({ hooks: { PreToolUse: 'not-an-array' } })).toBe(false)
  })
})

describe('shouldDisarmOnEvent', () => {
  it('disarms only on a real SessionEnd', () => {
    expect(shouldDisarmOnEvent('SessionEnd')).toBe(true)
    expect(shouldDisarmOnEvent('Stop')).toBe(false)
    expect(shouldDisarmOnEvent('UserPromptSubmit')).toBe(false)
    expect(shouldDisarmOnEvent('')).toBe(false)
  })
})

describe('shouldArmAtSpawn (T344 AC-2/AC-3 — folder-default arm decision)', () => {
  const base = {
    kind: 'claude-new' as const,
    agentControlled: false,
    readOnly: false,
    spawnedBy: 'operator' as const,
    folderDefaultOn: true
  }

  it('AC-2: arms a plain operator new session when the folder default is ON', () => {
    expect(shouldArmAtSpawn(base)).toBe(true)
  })

  it('never arms when the folder default is OFF', () => {
    expect(shouldArmAtSpawn({ ...base, folderDefaultOn: false })).toBe(false)
  })

  it('AC-3: never arms an agentControlled (MCP create_session) spawn', () => {
    expect(shouldArmAtSpawn({ ...base, agentControlled: true })).toBe(false)
  })

  it("AC-3: never arms a session whose spawnedBy is 'agent' (board/manifest dispatch)", () => {
    expect(shouldArmAtSpawn({ ...base, spawnedBy: 'agent' })).toBe(false)
  })

  it('AC-3: never arms a read-only companion (T245)', () => {
    expect(shouldArmAtSpawn({ ...base, readOnly: true })).toBe(false)
  })

  it('never arms a resume or a fork — only a fresh claude-new', () => {
    expect(shouldArmAtSpawn({ ...base, kind: 'claude-resume' })).toBe(false)
    expect(shouldArmAtSpawn({ ...base, kind: 'claude-fork' })).toBe(false)
  })

  it('never arms a plain shell', () => {
    expect(shouldArmAtSpawn({ ...base, kind: 'shell' })).toBe(false)
  })
})

describe('shouldDisarmEntry (T344 AC-4 — survive hibernation, honor an explicit demote)', () => {
  it('an explicit demote always disarms, regardless of source', () => {
    expect(shouldDisarmEntry('demote', 'default')).toBe(true)
    expect(shouldDisarmEntry('demote', 'manual')).toBe(true)
    expect(shouldDisarmEntry('demote', undefined)).toBe(true)
  })

  it("a SessionEnd disarms a manually-promoted session (today's behavior, unchanged)", () => {
    expect(shouldDisarmEntry('sessionEnd', 'manual')).toBe(true)
    expect(shouldDisarmEntry('sessionEnd', undefined)).toBe(true)
  })

  it('AC-4: a SessionEnd does NOT disarm a folder-default-armed session — it must survive a park/resume', () => {
    expect(shouldDisarmEntry('sessionEnd', 'default')).toBe(false)
  })
})

describe('arm/disarm with source (T344 AC-4)', () => {
  it('arm defaults to source "manual" when omitted (back-compat)', async () => {
    await arm('sess-1', folder)
    const armedPath = join(userDataDir, 'orchestrator-guard', 'armed.json')
    const map = JSON.parse(readFileSync(armedPath, 'utf8')) as ArmedMap
    expect(map['sess-1'].source).toBe('manual')
  })

  it('arm records an explicit "default" source', async () => {
    await arm('sess-1', folder, 'default')
    const armedPath = join(userDataDir, 'orchestrator-guard', 'armed.json')
    const map = JSON.parse(readFileSync(armedPath, 'utf8')) as ArmedMap
    expect(map['sess-1'].source).toBe('default')
  })

  it('disarm(id, "sessionEnd") leaves a default-armed session armed (AC-4 survives park/resume)', async () => {
    await arm('sess-1', folder, 'default')
    await disarm('sess-1', 'sessionEnd')
    expect(await isArmed('sess-1')).toBe(true)
  })

  it('disarm(id, "sessionEnd") still disarms a manually-armed session (unchanged behavior)', async () => {
    await arm('sess-1', folder)
    await disarm('sess-1', 'sessionEnd')
    expect(await isArmed('sess-1')).toBe(false)
  })

  it('disarm(id, "demote") always removes the entry, default-armed or not (operator override wins)', async () => {
    await arm('sess-1', folder, 'default')
    await disarm('sess-1', 'demote')
    expect(await isArmed('sess-1')).toBe(false)
  })

  it('disarm() with no reason defaults to "demote" (explicit operator action)', async () => {
    await arm('sess-1', folder, 'default')
    await disarm('sess-1')
    expect(await isArmed('sess-1')).toBe(false)
  })
})

describe('registerOrchestratorGuard (boot wiring)', () => {
  it('installs the script, sweeps orphans, and returns a working unsubscribe handle', async () => {
    await arm('orphan', folder)
    const root = mkdtempSync(join(tmpdir(), 'orchestrator-guard-projects-'))

    const handle = await registerOrchestratorGuard({ sweepRoot: root })
    try {
      expect(existsSync(guardScriptPath())).toBe(true)
      expect(await isArmed('orphan')).toBe(false) // swept: no transcript under `root`
    } finally {
      handle.close()
    }
  })
})

describe('the installed script is valid, importable JS', () => {
  it('round-trips: what installOrchestratorGuard writes still parses as ESM', async () => {
    await installOrchestratorGuard()
    const installed = await readFile(guardScriptPath(), 'utf8')
    expect(installed).toContain('export function decide')
  })
})
