import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildHookConfig,
  mergeHooks,
  stripOurHooks,
  hasOurHooks,
  SENTINEL,
  LEGACY_SENTINELS,
  installHooks,
  uninstallHooks
} from '../src/main/hook-installer'
import { readClaudeSettings } from '../src/main/claude-settings'

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('buildHookConfig', () => {
  it('registers all observed events with sentinel-tagged http handlers', () => {
    const cfg = buildHookConfig(54231, 'tok')
    expect(Object.keys(cfg).sort()).toEqual(
      [
        'Notification',
        'PermissionRequest',
        'PreToolUse',
        'SessionEnd',
        'SessionStart',
        'Stop',
        'StopFailure',
        'UserPromptSubmit'
      ].sort()
    )
    expect(cfg.Notification).toHaveLength(2)
    expect(cfg.Notification.map((e: any) => e.matcher).sort()).toEqual([
      'idle_prompt',
      'permission_prompt'
    ])
    const handler = cfg.Stop[0].hooks[0] as any
    expect(handler.type).toBe('http')
    expect(handler.url).toBe('http://127.0.0.1:54231/hook/tok/Stop/_')
    expect(handler[SENTINEL]).toBeDefined()
  })

  it('encodes the Notification type into the url path so the bridge can read it', () => {
    const cfg = buildHookConfig(7, 'tok')
    const perm = cfg.Notification.find((e: any) => e.matcher === 'permission_prompt') as any
    expect(perm.hooks[0].url).toBe('http://127.0.0.1:7/hook/tok/Notification/permission_prompt')
  })

  it('can emit command/curl handlers for the fallback transport', () => {
    const cfg = buildHookConfig(1234, 'tok', 'command')
    const handler = cfg.Stop[0].hooks[0] as any
    expect(handler.type).toBe('command')
    expect(handler.command).toContain('curl')
    expect(handler.command).toContain('http://127.0.0.1:1234/hook/tok/Stop/_')
    expect(handler[SENTINEL]).toBeDefined()
  })
})

describe('mergeHooks / stripOurHooks (non-destructive)', () => {
  const userSettings = (): Record<string, unknown> => ({
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }]
    }
  })

  it("adds our hooks without touching the user's existing hooks", () => {
    const merged = mergeHooks(userSettings(), buildHookConfig(5, 't')) as any
    const userEntry = merged.hooks.PreToolUse.find((e: any) => e.matcher === 'Bash')
    expect(userEntry.hooks[0].command).toBe('echo user')
    expect(hasOurHooks(merged)).toBe(true)
    expect(merged.model).toBe('opus')
  })

  it('stripOurHooks removes exactly our sentinel entries and leaves user hooks', () => {
    const merged = mergeHooks(userSettings(), buildHookConfig(5, 't'))
    const stripped = stripOurHooks(merged) as any
    expect(hasOurHooks(stripped)).toBe(false)
    expect(stripped.hooks.PreToolUse.find((e: any) => e.matcher === 'Bash')).toBeTruthy()
    expect(stripped.model).toBe('opus')
  })

  it('re-merging replaces stale entries instead of duplicating (port change)', () => {
    const first = mergeHooks(userSettings(), buildHookConfig(1111, 't'))
    const second = mergeHooks(first, buildHookConfig(2222, 't')) as any
    expect(second.hooks.Stop).toHaveLength(1)
    expect(second.hooks.Stop[0].hooks[0].url).toContain(':2222/')
    expect(second.hooks.PreToolUse.filter((e: any) => e.matcher === 'Bash')).toHaveLength(1)
  })
})

describe('install / uninstall round-trip (temp settings.json)', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnu-hooks-'))
    path = join(dir, 'settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('install then uninstall restores the user file (minus our hooks)', async () => {
    const original =
      JSON.stringify(
        { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } },
        null,
        2
      ) + '\n'
    writeFileSync(path, original, 'utf8')

    await installHooks(54000, 'tok', { path })
    const installed = await readClaudeSettings(path)
    expect(hasOurHooks(installed)).toBe(true)
    expect((installed.hooks as any).Stop).toHaveLength(2) // user's + ours

    await uninstallHooks({ path })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(original))
  })

  it('install into a missing file creates a well-formed settings.json', async () => {
    await installHooks(54000, 'tok', { path })
    expect(existsSync(path)).toBe(true)
    expect(hasOurHooks(await readClaudeSettings(path))).toBe(true)
  })

  it('readClaudeSettings returns {} for a missing or invalid file', async () => {
    expect(await readClaudeSettings(join(dir, 'nope.json'))).toEqual({})
    writeFileSync(path, '{ not json', 'utf8')
    expect(await readClaudeSettings(path)).toEqual({})
  })
})

describe('Harnu sentinel + legacy (_capy / _om2tab) migration', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnu-hooks-'))
    path = join(dir, 'settings.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const userHook = { type: 'command', command: 'echo user' }
  /** A handler as the OLD build wrote it: legacy sentinel, a (dead) peer port, a different token. */
  const legacyHandler = (
    sentinel: string,
    event: string,
    tag: string
  ): Record<string, unknown> => ({
    type: 'http',
    url: `http://127.0.0.1:41111/hook/old-token/${event}/${tag}`,
    timeout: 5,
    [sentinel]: 'v1'
  })

  it('writes the _harnu sentinel, never a legacy one', () => {
    expect(SENTINEL).toBe('_harnu')
    expect([...LEGACY_SENTINELS]).toEqual(['_capy', '_om2tab'])
    const cfg = buildHookConfig(54231, 'tok', 'command') as any
    for (const entries of Object.values(cfg) as any[])
      for (const e of entries)
        for (const h of e.hooks) {
          expect(h._harnu).toBe('v1')
          expect('_capy' in h).toBe(false)
          expect('_om2tab' in h).toBe(false)
        }
  })

  it('install over _capy and _om2tab entries leaves exactly one _harnu entry per hook, user hooks untouched', async () => {
    writeFileSync(
      path,
      JSON.stringify({
        model: 'opus',
        hooks: {
          Stop: [
            { hooks: [userHook] },
            { hooks: [legacyHandler('_capy', 'Stop', '_')] },
            { hooks: [legacyHandler('_om2tab', 'Stop', '_')] }
          ],
          SessionStart: [{ hooks: [legacyHandler('_capy', 'SessionStart', '_')] }],
          PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }]
        }
      }),
      'utf8'
    )

    await installHooks(54000, 'tok', { path })
    const out = (await readClaudeSettings(path)) as any

    const handlers = Object.values(out.hooks).flatMap((entries: any) =>
      entries.flatMap((e: any) => e.hooks)
    ) as any[]
    expect(handlers.filter((h) => '_capy' in h || '_om2tab' in h)).toEqual([])
    // one handler per spec'd event/matcher (EVENT_SPECS), all _harnu, none duplicated
    const ours = handlers.filter((h) => '_harnu' in h)
    expect(ours).toHaveLength(Object.keys(buildHookConfig(54000, 'tok')).length + 1) // Notification has 2 matchers
    expect(new Set(ours.map((h) => h.url)).size).toBe(ours.length)
    expect(out.hooks.Stop.filter((e: any) => e.hooks.some((h: any) => h._harnu))).toHaveLength(1)
    expect(out.hooks.SessionStart).toHaveLength(1)
    // unrelated user hooks and keys survive
    expect(out.hooks.Stop.some((e: any) => e.hooks[0].command === 'echo user')).toBe(true)
    expect(out.hooks.PreToolUse.find((e: any) => e.matcher === 'Bash').hooks).toEqual([userHook])
    expect(out.model).toBe('opus')
  })

  it('a second install is idempotent (no duplicates)', async () => {
    writeFileSync(
      path,
      JSON.stringify({ hooks: { Stop: [{ hooks: [legacyHandler('_capy', 'Stop', '_')] }] } }),
      'utf8'
    )
    await installHooks(54000, 'tok', { path })
    const once = await readClaudeSettings(path)
    await installHooks(54000, 'tok', { path })
    expect(await readClaudeSettings(path)).toEqual(once)
  })

  it('recognizes legacy-sentinel handlers as ours even when the URL shape is foreign', () => {
    const settings = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x', _capy: 'v1' }] }] }
    }
    expect(hasOurHooks(settings)).toBe(true)
    expect(hasOurHooks({ hooks: { Stop: [{ hooks: [{ command: 'x', _om2tab: 'v1' }] }] } })).toBe(
      true
    )
    expect(stripOurHooks(settings).hooks).toBeUndefined()
  })
})
