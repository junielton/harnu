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
  parseCompanionPrefs,
  setCompanionPrefsPath
} from '../../src/main/companion/mode'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-mode-'))
  file = join(dir, 'companion-prefs.json')
  setCompanionPrefsPath(file)
})

afterEach(() => {
  setCompanionPrefsPath(null)
  rmSync(dir, { recursive: true, force: true })
})

import { createCompanionHost } from '../../src/main/companion/host-core'

describe('companion mode seam', () => {
  it('default off starts nothing', async () => {
    // before any hydrate, and with no file at all
    expect(getCompanionMode()).toBe('off')
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('off')
    expect(listenerWanted()).toBe(false)
    expect(familyMode('identity', null)).toBe('off')
    expect(familyMode('approval', '/some/folder')).toBe('off')
  })

  it('with no prefs path configured the mode is off', async () => {
    setCompanionPrefsPath(null)
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('off')
  })

  it('reads the developer key `mode` from the file', async () => {
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'shadow' }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow')
    expect(listenerWanted()).toBe(true)
    // P1W1: every family follows the global mode
    expect(familyMode('taskState', '/x')).toBe('shadow')
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'active' }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('active')
  })

  it('an unreadable or invalid file reads off until a disclosure exists (P1W4)', async () => {
    writeFileSync(file, '{ not json')
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('off')
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'sideways' }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('off')
    writeFileSync(file, JSON.stringify([]))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('off')
  })

  it('onModeChange fires when a hydrate changes the answer, not when it does not', async () => {
    let fired = 0
    const off = onModeChange(() => fired++)
    await hydrateCompanionMode() // off → off
    expect(fired).toBe(0)
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'shadow' }))
    await hydrateCompanionMode()
    expect(fired).toBe(1)
    await hydrateCompanionMode() // unchanged
    expect(fired).toBe(1)
    off()
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'off' }))
    await hydrateCompanionMode()
    expect(fired).toBe(1) // unsubscribed
  })

  it('a throwing listener does not stop the others', async () => {
    let fired = 0
    const a = onModeChange(() => {
      throw new Error('boom')
    })
    const b = onModeChange(() => fired++)
    writeFileSync(file, JSON.stringify({ v: 1, mode: 'shadow' }))
    await hydrateCompanionMode()
    expect(fired).toBe(1)
    a()
    b()
  })

  it('parseCompanionPrefs is pure', () => {
    expect(parseCompanionPrefs('{"v":1,"mode":"shadow"}')).toBe('shadow')
    expect(parseCompanionPrefs('{"mode":"active"}')).toBe('active')
    expect(parseCompanionPrefs('{"mode":"off"}')).toBe('off')
    expect(parseCompanionPrefs('')).toBe('off')
    expect(parseCompanionPrefs('null')).toBe('off')
    expect(parseCompanionPrefs('{"mode":1}')).toBe('off')
  })
})

describe('default off starts nothing', () => {
  it('default off starts nothing: the host creates no directory and no socket', async () => {
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
    await host.register() // no companion-prefs.json at <dir>
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
