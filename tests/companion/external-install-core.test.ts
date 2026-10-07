import { describe, expect, it } from 'vitest'
import {
  managedSettingsPaths,
  namesManagedSettings,
  planInstall,
  planUninstall,
  type ExternalInstallRecord,
  type InstallInput
} from '../../src/main/companion/external-install-core'

const DIR = '/data/example/companion/staged/abc123'
const SETTINGS_PATH = '/tmp/example-home/.claude/settings.json'

const input = (over: Partial<InstallInput> = {}): InstallInput => ({
  settingsText: JSON.stringify({ model: 'opus' }, null, 2) + '\n',
  isSymlink: false,
  dir: DIR,
  record: null,
  delimiter: ':',
  managedPresent: false,
  probe: 'loads',
  modVersion: '1.2.3',
  settingsPath: SETTINGS_PATH,
  now: 1_000,
  ...over
})

function installed(over: Partial<InstallInput> = {}): {
  settings: Record<string, unknown>
  record: ExternalInstallRecord
} {
  const r = planInstall(input(over))
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  return { settings: r.settings, record: r.record }
}

describe('planInstall / planUninstall (P4W3 §7.3)', () => {
  it('adds one item and nothing else', () => {
    const before = {
      model: 'opus',
      permissions: { allow: ['Read'] },
      env: { FOO: 'bar', CLAUDE_CODE_PLUGIN_DIRS: '/a/one:/b/two' },
      tui: 'fullscreen'
    }
    const { settings } = installed({ settingsText: JSON.stringify(before, null, 2) + '\n' })
    const env = settings.env as Record<string, string>
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(`/a/one:/b/two:${DIR}`)
    // Everything else is identical, key order included.
    expect(Object.keys(settings)).toEqual(Object.keys(before))
    expect(Object.keys(env)).toEqual(['FOO', 'CLAUDE_CODE_PLUGIN_DIRS'])
    const { env: _a, ...restBefore } = before
    const { env: _b, ...restAfter } = settings
    expect(restAfter).toEqual(restBefore)
    expect(env.FOO).toBe('bar')
  })

  it('creates the env object and the key when neither exists, and records that it did', () => {
    const { settings, record } = installed()
    expect(settings.env).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: DIR })
    expect(record).toMatchObject({
      v: 1,
      installed: true,
      entry: DIR,
      settingsPath: SETTINGS_PATH,
      createdEnv: true,
      createdKey: true,
      modVersion: '1.2.3',
      at: 1_000
    })
  })

  it('undo is exact', () => {
    const originals = [
      { model: 'opus' },
      { model: 'opus', env: { FOO: 'bar' } },
      { env: { CLAUDE_CODE_PLUGIN_DIRS: '/a/one:/b/two' }, tui: 'x' },
      {}
    ]
    for (const original of originals) {
      const text = JSON.stringify(original, null, 2) + '\n'
      const { settings, record } = installed({ settingsText: text })
      const installedText = JSON.stringify(settings, null, 2) + '\n'
      const undo = planUninstall({ settingsText: installedText, record, delimiter: ':' })
      expect(undo.ok).toBe(true)
      if (!undo.ok) continue
      expect(undo.changed).toBe(true)
      // The parsed result is the original, and so are the bytes of a file written the CLI's way.
      expect(undo.settings).toEqual(original)
      expect(JSON.stringify(undo.settings, null, 2) + '\n').toBe(text)
      expect(Object.keys(undo.settings!)).toEqual(Object.keys(original))
    }
  })

  it('refuses rather than overwrites', () => {
    const refusal = (over: Partial<InstallInput>): string | null => {
      const r = planInstall(input(over))
      return r.ok ? null : r.reason
    }
    expect(refusal({ settingsText: '{ not json' })).toBe('unparseable')
    expect(refusal({ settingsText: '[1,2]' })).toBe('unparseable')
    expect(refusal({ settingsText: '"text"' })).toBe('unparseable')
    expect(refusal({ settingsText: JSON.stringify({ env: 'x' }) })).toBe('occupied')
    expect(refusal({ settingsText: JSON.stringify({ env: ['a'] }) })).toBe('occupied')
    expect(refusal({ settingsText: JSON.stringify({ env: null }) })).toBe('occupied')
    expect(refusal({ settingsText: JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: 7 } }) })).toBe(
      'occupied'
    )
    expect(
      refusal({ settingsText: JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: ['/a'] } }) })
    ).toBe('occupied')
    expect(refusal({ isSymlink: true })).toBe('symlink')
    expect(refusal({ dir: null })).toBe('no-companion')
  })

  it('a missing or blank file starts from an empty object', () => {
    expect(installed({ settingsText: null }).settings).toEqual({
      env: { CLAUDE_CODE_PLUGIN_DIRS: DIR }
    })
    expect(installed({ settingsText: '  \n' }).settings).toEqual({
      env: { CLAUDE_CODE_PLUGIN_DIRS: DIR }
    })
  })

  it('removes only what it created', () => {
    // Harnu created both: the key and env go away.
    const a = installed({ settingsText: '{"model":"opus"}' })
    const undoA = planUninstall({
      settingsText: JSON.stringify(a.settings),
      record: a.record,
      delimiter: ':'
    })
    expect(undoA.ok && undoA.settings).toEqual({ model: 'opus' })

    // env existed, the key did not: env stays, the key goes.
    const b = installed({ settingsText: '{"env":{"FOO":"1"}}' })
    expect(b.record).toMatchObject({ createdEnv: false, createdKey: true })
    const undoB = planUninstall({
      settingsText: JSON.stringify(b.settings),
      record: b.record,
      delimiter: ':'
    })
    expect(undoB.ok && undoB.settings).toEqual({ env: { FOO: '1' } })

    // Both existed with another item: only our item leaves, nothing is deleted.
    const c = installed({ settingsText: '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/a/one"}}' })
    expect(c.record).toMatchObject({ createdEnv: false, createdKey: false })
    const undoC = planUninstall({
      settingsText: JSON.stringify(c.settings),
      record: c.record,
      delimiter: ':'
    })
    expect(undoC.ok && undoC.settings).toEqual({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/a/one' } })

    // Created flags are honoured even when the list empties: without them the key is kept.
    const forged: ExternalInstallRecord = { ...a.record, createdKey: false, createdEnv: false }
    const undoD = planUninstall({
      settingsText: JSON.stringify(a.settings),
      record: forged,
      delimiter: ':'
    })
    expect(undoD.ok && undoD.settings).toEqual({
      model: 'opus',
      env: { CLAUDE_CODE_PLUGIN_DIRS: '' }
    })
  })

  it('changes nothing when the entry is no longer in the list, and says so', () => {
    const { record } = installed()
    const text = JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: '/a/one' } })
    const undo = planUninstall({ settingsText: text, record, delimiter: ':' })
    expect(undo).toMatchObject({ ok: true, changed: false })
    const noEnv = planUninstall({ settingsText: '{"model":"x"}', record, delimiter: ':' })
    expect(noEnv).toMatchObject({ ok: true, changed: false })
    const missing = planUninstall({ settingsText: null, record, delimiter: ':' })
    expect(missing).toMatchObject({ ok: true, changed: false })
  })

  it('uninstall of a file that no longer parses names the one path to remove by hand', () => {
    const { record } = installed()
    const undo = planUninstall({ settingsText: '{ nope', record, delimiter: ':' })
    expect(undo).toEqual({ ok: false, reason: 'unparseable', manualPath: DIR })
  })

  it('re-points on a version bump', () => {
    const first = installed({ settingsText: '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/a/one"}}' })
    const NEW = '/data/example/companion/staged/def456'
    const second = planInstall(
      input({
        settingsText: JSON.stringify(first.settings, null, 2) + '\n',
        dir: NEW,
        record: first.record,
        modVersion: '1.3.0',
        now: 2_000
      })
    )
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const list = (second.settings.env as Record<string, string>).CLAUDE_CODE_PLUGIN_DIRS
    expect(list).toBe(`/a/one:${NEW}`)
    expect(list.split(':').filter((x) => x === DIR)).toHaveLength(0)
    expect(second.record).toMatchObject({ entry: NEW, modVersion: '1.3.0', at: 2_000 })
    // The created flags survive a re-point: they describe the file before Harnu first wrote.
    expect(second.record.createdKey).toBe(first.record.createdKey)
    expect(second.record.createdEnv).toBe(first.record.createdEnv)
  })

  it('keeps the entry once when the same directory is installed twice', () => {
    const first = installed()
    const again = planInstall(
      input({ settingsText: JSON.stringify(first.settings), record: first.record })
    )
    expect(again.ok && (again.settings.env as Record<string, string>).CLAUDE_CODE_PLUGIN_DIRS).toBe(
      DIR
    )
  })

  it('uses the platform delimiter', () => {
    const win = installed({
      delimiter: ';',
      settingsText: '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"C:\\\\a;C:\\\\b"}}',
      dir: 'C:\\harnu\\staged\\x'
    })
    expect((win.settings.env as Record<string, string>).CLAUDE_CODE_PLUGIN_DIRS).toBe(
      'C:\\a;C:\\b;C:\\harnu\\staged\\x'
    )
  })

  it('drops empty items from the list, keeps every other item verbatim', () => {
    const { settings } = installed({
      settingsText: '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/a/one::/b/two:"}}'
    })
    expect((settings.env as Record<string, string>).CLAUDE_CODE_PLUGIN_DIRS).toBe(
      `/a/one:/b/two:${DIR}`
    )
  })
})

describe('policy refusals (OD-5, P4W3-S4): nothing is proposed', () => {
  it('a managed settings file is "policy", whatever else is true', () => {
    const r = planInstall(input({ managedPresent: true }))
    expect(r).toEqual({ ok: false, reason: 'policy' })
  })

  it('a probe that shows mods are off is "mods-off", never "policy"', () => {
    expect(planInstall(input({ probe: 'off-here' }))).toEqual({ ok: false, reason: 'mods-off' })
    expect(planInstall(input({ probe: 'off-remote' }))).toEqual({
      ok: false,
      reason: 'mods-off'
    })
  })

  it('an unknown or missing probe does not block (the second net catches it)', () => {
    expect(planInstall(input({ probe: 'unknown' })).ok).toBe(true)
    expect(planInstall(input({ probe: null })).ok).toBe(true)
  })

  it('policy comes before the symlink and parse checks', () => {
    const r = planInstall(input({ managedPresent: true, isSymlink: true, settingsText: '{' }))
    expect(r).toEqual({ ok: false, reason: 'policy' })
  })

  it('knows where each platform keeps managed settings', () => {
    expect(managedSettingsPaths('linux')).toContain('/etc/claude-code/managed-settings.json')
    expect(managedSettingsPaths('darwin')).toContain(
      '/Library/Application Support/ClaudeCode/managed-settings.json'
    )
    expect(managedSettingsPaths('win32').some((p) => /ClaudeCode/.test(p))).toBe(true)
  })

  it('reads a "managed settings" line from the post-install check output', () => {
    expect(namesManagedSettings('Error: disabled by managed settings (disableSideloadFlags)')).toBe(
      true
    )
    expect(namesManagedSettings("blocked by your organization's managed policy")).toBe(true)
    expect(namesManagedSettings('[]')).toBe(false)
    expect(namesManagedSettings('')).toBe(false)
  })
})
