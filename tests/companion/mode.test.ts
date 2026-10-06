import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  familyMode,
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted,
  onModeChange,
  setCompanionPrefsPath
} from '../../src/main/companion/mode'
import { setCompanionCliGate } from '../../src/main/companion/companion-prefs'
import { createCompanionHost } from '../../src/main/companion/host-core'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-mode-'))
  file = join(dir, 'companion-prefs.json')
  setCompanionPrefsPath(file)
  setCompanionCliGate('ok')
})

afterEach(() => {
  setCompanionPrefsPath(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('companion mode seam', () => {
  it('the kill switch off at boot starts nothing and reads off', async () => {
    writeFileSync(file, JSON.stringify({ v: 1, enabled: false }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('off')
    expect(listenerWanted()).toBe(false)
    expect(familyMode('identity', null)).toBe('off')
    expect(familyMode('approval', '/some/folder')).toBe('off')
  })

  it('with no prefs path configured nothing is read and the shipped default applies', async () => {
    setCompanionPrefsPath(null)
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow')
  })

  it('reads the developer key `mode` from the file as the default of every family', async () => {
    setCompanionCliGate('ok')
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'shadow' }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow')
    expect(listenerWanted()).toBe(true)
    expect(familyMode('taskState', '/x')).toBe('shadow')
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'active', allFolders: true }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('active')
    expect(familyMode('taskState', '/x')).toBe('active')
  })

  it('an unreadable or invalid file reads the shipped defaults (OD-1: shadow)', async () => {
    writeFileSync(file, '{ not json')
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow')
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'sideways' }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow') // an invalid mode reads shadow (ARB-6a)
    writeFileSync(file, JSON.stringify([]))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow')
  })

  it('onModeChange fires when a hydrate changes the answer, not when it does not', async () => {
    let fired = 0
    await hydrateCompanionMode()
    const off = onModeChange(() => fired++)
    await hydrateCompanionMode() // shadow → shadow
    expect(fired).toBe(0)
    writeFileSync(file, JSON.stringify({ v: 1, enabled: false }))
    await hydrateCompanionMode()
    expect(fired).toBe(1)
    await hydrateCompanionMode() // unchanged
    expect(fired).toBe(1)
    off()
    writeFileSync(file, JSON.stringify({ v: 1 }))
    await hydrateCompanionMode()
    expect(fired).toBe(1) // unsubscribed
  })

  it('a throwing listener does not stop the others', async () => {
    let fired = 0
    const a = onModeChange(() => {
      throw new Error('boom')
    })
    const b = onModeChange(() => fired++)
    writeFileSync(file, JSON.stringify({ v: 1, enabled: false }))
    await hydrateCompanionMode()
    expect(fired).toBe(1)
    a()
    b()
  })
})

describe('the kill switch off at boot starts nothing', () => {
  it('the host creates no directory and no socket, and mints no spawn token', async () => {
    writeFileSync(file, JSON.stringify({ v: 1, enabled: false }))
    const companionDir = join(dir, 'companion')
    let started = 0
    const host = createCompanionHost({
      dir: companionDir,
      mode: {
        getMode: getCompanionMode,
        listenerWanted,
        hydrate: hydrateCompanionMode,
        onChange: onModeChange
      },
      start: async () => {
        started++
        throw new Error('must not start')
      }
    })
    await host.register()
    expect(getCompanionMode()).toBe('off')
    expect(started).toBe(0)
    expect(existsSync(companionDir)).toBe(false)
    expect(existsSync(join(companionDir, 'c.sock'))).toBe(false)
    expect(
      host.facade.mintSpawnToken({
        owner: { kind: 'pty', ptyId: 'p' },
        trust: 'operator',
        cwd: '/x'
      })
    ).toBeNull()
    await host.close()
  })
})
