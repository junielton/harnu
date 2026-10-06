// The switch as the pane drives it: every path is a throwaway temp directory.
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createCompanionHost } from '../../src/main/companion/host-core'
import { createExternalHost, type ExternalHost } from '../../src/main/companion/external-host'
import { fakeMode } from './support/host-rig'

let root: string
let settingsPath: string
let dir: string
let on = false
let companionOn = true
let hosts: ExternalHost[] = []
let pinned: (() => string[])[] = []

async function make(): Promise<ExternalHost> {
  const core = createCompanionHost({ dir: '/nowhere', mode: fakeMode('shadow').mode })
  const h = createExternalHost({
    install: {
      settingsPath: () => settingsPath,
      recordPath: () => join(root, 'userData', 'companion', 'external-install.json'),
      managedPaths: () => [],
      ensureStaged: async () => dir,
      ensureProbe: async () => 'loads',
      postInstallCheck: async () => ({ exitCode: 0, output: '[]' }),
      modVersion: () => '1.0.0',
      delimiter: ':',
      now: () => 1
    },
    binding: {
      host: core.facade,
      mode: () => 'shadow',
      sessionOwnedByHarnu: () => false,
      corroborates: async () => false,
      now: () => 1
    },
    key: { get: () => on, set: (v) => void (on = v) },
    companionOn: () => companionOn,
    pin: (fn) => void pinned.push(fn),
    sweepMs: 10_000
  })
  hosts.push(h)
  return h
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'harnu-p4w3-host-'))
  settingsPath = join(root, 'home', '.claude', 'settings.json')
  dir = join(root, 'userData', 'companion', 'staged', 'abc')
  await fs.mkdir(join(root, 'home', '.claude'), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify({ model: 'opus' }, null, 2) + '\n')
  on = false
  companionOn = true
  hosts = []
  pinned = []
})
afterEach(async () => {
  for (const h of hosts) h.stop()
  await fs.rm(root, { recursive: true, force: true })
})

describe('the Harnu mod outside Harnu switch (P4W3 §7.3)', () => {
  it('is off by default and writes nothing until it is turned on', async () => {
    const h = await make()
    await h.start()
    expect(await h.get()).toMatchObject({
      on: false,
      path: settingsPath,
      entry: null,
      lastSeenAt: null,
      companionOn: true,
      live: 0
    })
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('turns on after the install and off with the exact undo', async () => {
    const original = await fs.readFile(settingsPath, 'utf8')
    const h = await make()
    await h.start()
    expect(await h.set(true)).toEqual({ ok: true, on: true })
    expect(on).toBe(true)
    expect(await h.get()).toMatchObject({ on: true, entry: dir })
    expect(await h.set(false)).toEqual({ ok: true, on: false })
    expect(on).toBe(false)
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(original)
  })

  it('cannot be turned on while the Harnu mod itself is off', async () => {
    const h = await make()
    companionOn = false
    expect(await h.set(true)).toEqual({ ok: false, reason: 'no-companion' })
    expect(on).toBe(false)
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('a refused install leaves the key off', async () => {
    await fs.writeFile(settingsPath, '{ not json')
    const h = await make()
    expect(await h.set(true)).toEqual({ ok: false, reason: 'unparseable' })
    expect(on).toBe(false)
    expect(await fs.readFile(settingsPath, 'utf8')).toBe('{ not json')
  })

  it('off with a file that no longer parses: key off, path to remove by hand', async () => {
    const h = await make()
    await h.set(true)
    await fs.writeFile(settingsPath, '{ broken')
    expect(await h.set(false)).toEqual({ ok: false, reason: 'unparseable', manualPath: dir })
    expect(on).toBe(false) // the host already stopped accepting claims and revoked the live ones
  })

  it('the key follows the file: removing the entry by hand turns the switch off', async () => {
    const h = await make()
    await h.set(true)
    await fs.writeFile(settingsPath, '{"model":"opus"}')
    expect((await h.get()).on).toBe(false)
    expect(on).toBe(false)
  })

  it('boot pins the install record and re-points a changed staged directory', async () => {
    const h = await make()
    await h.set(true)
    dir = join(root, 'userData', 'companion', 'staged', 'def')
    const again = await make()
    await again.start()
    expect(pinned.length).toBeGreaterThan(0)
    const list = JSON.parse(await fs.readFile(settingsPath, 'utf8')).env
      .CLAUDE_CODE_PLUGIN_DIRS as string
    expect(list).toBe(dir)
    expect(pinned.at(-1)!()).toContain(dir)
  })
})
