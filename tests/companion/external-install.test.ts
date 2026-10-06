// The shell around the install core. Every path here is a throwaway directory under the OS temp
// dir: this suite never reads or writes the real ~/.claude (P4W3 safety rule).
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createExternalInstall,
  type ExternalInstall,
  type ExternalInstallDeps
} from '../../src/main/companion/external-install'
import type { PolicyProbeClass } from '../../src/main/claude-policy-probe-core'

let root: string
let settingsPath: string
let recordPath: string
let managedFile: string
let dir: string

interface Knobs {
  probe: PolicyProbeClass | null
  check: { exitCode: number; output: string } | null
  staged: string | null
  checks: number
}
let k: Knobs

function make(over: Partial<ExternalInstallDeps> = {}): ExternalInstall {
  return createExternalInstall({
    settingsPath: () => settingsPath,
    recordPath: () => recordPath,
    managedPaths: () => [managedFile],
    ensureStaged: async () => k.staged,
    ensureProbe: async () => k.probe,
    postInstallCheck: async () => {
      k.checks++
      return k.check
    },
    modVersion: () => '1.2.3',
    delimiter: ':',
    now: () => 5_000,
    ...over
  })
}

const read = (p: string): Promise<string> => fs.readFile(p, 'utf8')
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'harnu-p4w3-'))
  // The suite's own guard: a path under the real home is a bug in the test, not a case to run.
  expect(root.startsWith(homedir() + '/.claude')).toBe(false)
  settingsPath = join(root, 'home', '.claude', 'settings.json')
  recordPath = join(root, 'userData', 'companion', 'external-install.json')
  managedFile = join(root, 'etc', 'managed-settings.json')
  dir = join(root, 'userData', 'companion', 'staged', 'abc')
  await fs.mkdir(join(root, 'home', '.claude'), { recursive: true })
  k = { probe: 'loads', check: { exitCode: 0, output: '[]' }, staged: dir, checks: 0 }
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('external install shell (P4W3 §7.3)', () => {
  it('writes one entry, the record, and reads back as installed', async () => {
    const original = JSON.stringify({ model: 'opus', env: { FOO: '1' } }, null, 2) + '\n'
    await fs.writeFile(settingsPath, original)
    const x = make()
    expect(await x.install()).toEqual({ ok: true, installed: true })
    const after = JSON.parse(await read(settingsPath))
    expect(after.env).toEqual({ FOO: '1', CLAUDE_CODE_PLUGIN_DIRS: dir })
    expect(after.model).toBe('opus')
    const rec = JSON.parse(await read(recordPath))
    expect(rec).toMatchObject({
      v: 1,
      installed: true,
      entry: dir,
      settingsPath,
      createdEnv: false,
      createdKey: true
    })
    expect(await x.status()).toMatchObject({ installed: true, entry: dir, path: settingsPath })
    expect(k.checks).toBe(1)
  })

  it('no write under policy: a managed settings file leaves the bytes unchanged', async () => {
    const original = '{\n  "model": "opus"\n}\n'
    await fs.writeFile(settingsPath, original)
    await fs.mkdir(join(root, 'etc'), { recursive: true })
    await fs.writeFile(managedFile, '{"disableSideloadFlags":true}')
    const x = make()
    expect(await x.install()).toEqual({ ok: false, reason: 'policy' })
    expect(await read(settingsPath)).toBe(original)
    expect(await exists(recordPath)).toBe(false)
    expect(k.checks).toBe(0)
  })

  it('no write when the probe shows mods are off', async () => {
    const original = '{"model":"opus"}'
    await fs.writeFile(settingsPath, original)
    for (const p of ['off-here', 'off-remote'] as const) {
      k.probe = p
      expect(await make().install()).toEqual({ ok: false, reason: 'mods-off' })
      expect(await read(settingsPath)).toBe(original)
    }
  })

  it('refuses when there is no staged companion', async () => {
    k.staged = null
    expect(await make().install()).toEqual({ ok: false, reason: 'no-companion' })
    expect(await exists(settingsPath)).toBe(false)
  })

  it('refuses a symlinked settings file and leaves the link and its target alone', async () => {
    const target = join(root, 'dotfiles', 'settings.json')
    await fs.mkdir(join(root, 'dotfiles'), { recursive: true })
    await fs.writeFile(target, '{"model":"opus"}')
    await fs.symlink(target, settingsPath)
    expect(await make().install()).toEqual({ ok: false, reason: 'symlink' })
    expect((await fs.lstat(settingsPath)).isSymbolicLink()).toBe(true)
    expect(await read(target)).toBe('{"model":"opus"}')
  })

  it('refuses a file that does not parse, byte for byte unchanged', async () => {
    await fs.writeFile(settingsPath, '{ "model": ')
    expect(await make().install()).toEqual({ ok: false, reason: 'unparseable' })
    expect(await read(settingsPath)).toBe('{ "model": ')
  })

  it('rolls back and reports policy when the post-install check names managed settings', async () => {
    const original = JSON.stringify({ model: 'opus' }, null, 2) + '\n'
    await fs.writeFile(settingsPath, original)
    k.check = { exitCode: 1, output: 'Error: sideload flags are disabled by managed settings' }
    expect(await make().install()).toEqual({ ok: false, reason: 'policy' })
    expect(await read(settingsPath)).toBe(original)
    expect(await exists(recordPath)).toBe(false)
  })

  it('keeps the install when the check fails for another reason', async () => {
    await fs.writeFile(settingsPath, '{}')
    k.check = { exitCode: 1, output: 'network unreachable' }
    expect(await make().install()).toEqual({ ok: true, installed: true })
    expect(await exists(recordPath)).toBe(true)
  })

  it('on then off restores the original, byte for byte for a CLI-style file', async () => {
    const original = JSON.stringify({ model: 'opus', tui: 'x' }, null, 2) + '\n'
    await fs.writeFile(settingsPath, original)
    const x = make()
    await x.install()
    expect(await read(settingsPath)).not.toBe(original)
    expect(await x.uninstall()).toEqual({ ok: true, installed: false })
    expect(await read(settingsPath)).toBe(original)
    expect(await exists(recordPath)).toBe(false)
    expect(await x.status()).toMatchObject({ installed: false })
  })

  it('a hand-edited settings file that no longer parses: uninstall refuses and names the path', async () => {
    await fs.writeFile(settingsPath, '{}')
    const x = make()
    await x.install()
    await fs.writeFile(settingsPath, '{ broken')
    expect(await x.uninstall()).toEqual({ ok: false, reason: 'unparseable', manualPath: dir })
    expect(await read(settingsPath)).toBe('{ broken')
    expect(await exists(recordPath)).toBe(true)
  })

  it('the user removing the entry by hand clears the record on the next read', async () => {
    await fs.writeFile(settingsPath, '{}')
    const x = make()
    await x.install()
    await fs.writeFile(settingsPath, '{}')
    expect(await x.status()).toMatchObject({ installed: false })
    expect(await exists(recordPath)).toBe(false)
  })

  it('re-points at boot when the staged directory changed, without touching anything else', async () => {
    await fs.writeFile(settingsPath, '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/a/one"}}')
    const x = make()
    await x.install()
    const next = join(root, 'userData', 'companion', 'staged', 'def')
    k.staged = next
    await x.repoint()
    const list = JSON.parse(await read(settingsPath)).env.CLAUDE_CODE_PLUGIN_DIRS as string
    expect(list).toBe(`/a/one:${next}`)
    expect(JSON.parse(await read(recordPath)).entry).toBe(next)
    // The old directory stays pinned for the sessions still running from it.
    expect(x.pinned()).toEqual(expect.arrayContaining([next, dir]))
  })

  it('a repoint with nothing installed does nothing', async () => {
    await fs.writeFile(settingsPath, '{}')
    await make().repoint()
    expect(await read(settingsPath)).toBe('{}')
    expect(await exists(recordPath)).toBe(false)
  })

  it('uses the settings path the record names, never the current resolver', async () => {
    await fs.writeFile(settingsPath, '{}')
    const x = make()
    await x.install()
    const other = join(root, 'elsewhere', 'settings.json')
    await fs.mkdir(join(root, 'elsewhere'), { recursive: true })
    await fs.writeFile(other, '{"model":"keep"}')
    const y = make({ settingsPath: () => other })
    expect(await y.uninstall()).toEqual({ ok: true, installed: false })
    expect(await read(other)).toBe('{"model":"keep"}')
    expect(JSON.parse(await read(settingsPath))).toEqual({})
  })
})
