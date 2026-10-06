import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveMode } from '../../src/main/companion/arbitration-core'
import {
  buildRollout,
  companionModeOf,
  decideInject,
  defaultPrefs,
  listenerWantedFor,
  parsePrefs,
  serializePrefs
} from '../../src/main/companion/companion-prefs-core'
import {
  companionInjectDecision,
  flushCompanionPrefs,
  hydrateCompanionPrefs,
  markDisclosureShown,
  onModeChange,
  prefsKey,
  registerPrefsKey,
  resetPrefsKeysForTests,
  rolloutView,
  setAllFolders,
  setCompanionCliGate,
  setCompanionEnabled,
  setCompanionPrefsPath,
  setFamilyMode,
  setPrefsKey,
  setRampFolders
} from '../../src/main/companion/companion-prefs'
import {
  familyMode,
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted
} from '../../src/main/companion/mode'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-prefs-'))
  file = join(dir, 'companion-prefs.json')
  setCompanionPrefsPath(file)
  setCompanionCliGate('ok')
  resetPrefsKeysForTests()
})

afterEach(() => {
  setCompanionPrefsPath(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('parsePrefs (pure)', () => {
  it('invalid mode reads as shadow', () => {
    const p = parsePrefs(
      JSON.stringify({ v: 1, families: { taskState: 'banana', identity: 'active' } })
    )
    const r = buildRollout({ ...p, allFolders: true }, 'ok', new Set())
    expect(effectiveMode('taskState', '/x', r)).toBe('shadow')
    expect(effectiveMode('identity', '/x', r)).toBe('active')
  })

  it('no file, invalid JSON and a wrong type degrade field by field and never throw', () => {
    expect(parsePrefs(null)).toEqual(defaultPrefs())
    expect(parsePrefs('{ not json')).toEqual(defaultPrefs())
    expect(parsePrefs('[]')).toEqual(defaultPrefs())
    const odd = parsePrefs(
      JSON.stringify({
        enabled: 'yes',
        mode: 7,
        families: 'x',
        allFolders: 1,
        disclosureShownAt: 'now',
        keys: []
      })
    )
    expect(odd.enabled).toBe(true)
    expect(odd.allFolders).toBe(false)
    expect(odd.disclosureShownAt).toBeUndefined()
    expect(odd.families).toEqual({})
    expect(odd.keys).toEqual({})
  })

  it('an unknown family is dropped, a known one keeps its mode', () => {
    const p = parsePrefs(JSON.stringify({ families: { nonsense: 'active', guard: 'off' } }))
    expect(p.families).toEqual({ guard: 'off' })
  })

  it('persists only overrides, so a later default change reaches users who never touched the file', () => {
    expect(JSON.parse(serializePrefs(defaultPrefs()))).toEqual({ v: 1 })
    const p = { ...defaultPrefs(), enabled: false, families: { guard: 'off' as const } }
    expect(JSON.parse(serializePrefs(p))).toEqual({
      v: 1,
      enabled: false,
      families: { guard: 'off' }
    })
  })
})

describe('injection decision', () => {
  const prefs = { ...defaultPrefs(), disclosureShownAt: 1_790_000_000_000 }

  it('no injection before the notice', () => {
    expect(decideInject(defaultPrefs(), { kind: 'claude-new', cliGate: 'ok' })).toEqual({
      inject: false,
      skip: 'pre-disclosure'
    })
    expect(decideInject(prefs, { kind: 'claude-new', cliGate: 'ok' })).toEqual({ inject: true })
  })

  it('unknown gate behaves as below', () => {
    expect(decideInject(prefs, { kind: 'claude-resume', cliGate: 'unknown' })).toEqual({
      inject: false,
      skip: 'cli-unknown'
    })
    expect(decideInject(prefs, { kind: 'claude-resume', cliGate: 'below' })).toEqual({
      inject: false,
      skip: 'cli-too-old'
    })
    const r = buildRollout(prefs, 'unknown', new Set())
    for (const f of ['identity', 'taskState', 'telemetry', 'approval'] as const) {
      expect(effectiveMode(f, '/x', r)).toBe('off')
    }
    expect(companionModeOf(prefs, 'unknown', new Set())).toBe('off')
  })

  it('the kill switch and a non-claude kind skip with their own reason', () => {
    expect(
      decideInject({ ...prefs, enabled: false }, { kind: 'claude-new', cliGate: 'ok' })
    ).toEqual({ inject: false, skip: 'off' })
    expect(decideInject(prefs, { kind: 'shell', cliGate: 'ok' })).toEqual({
      inject: false,
      skip: 'not-claude'
    })
    // above the ceiling still injects: the mod only observes
    expect(decideInject(prefs, { kind: 'claude-fork', cliGate: 'above' })).toEqual({ inject: true })
  })
})

describe('the mode seam', () => {
  it('the listener does not wait for the CLI gate', () => {
    expect(listenerWantedFor({ ...defaultPrefs() })).toBe(true)
    setCompanionCliGate('unknown')
    expect(listenerWanted()).toBe(true)
    expect(getCompanionMode()).toBe('off') // the gate decides the mode, not the socket
  })

  it('the listener wants the developer key or some family not off, and the kill switch gates all', () => {
    const allOff = {
      ...defaultPrefs(),
      families: {
        identity: 'off',
        taskState: 'off',
        telemetry: 'off',
        planUsage: 'off',
        approval: 'off',
        guard: 'off',
        startPrompt: 'off',
        message: 'off'
      } as const
    }
    expect(listenerWantedFor(allOff)).toBe(false)
    expect(listenerWantedFor({ ...allOff, mode: 'shadow' })).toBe(true)
    expect(listenerWantedFor({ ...defaultPrefs(), enabled: false })).toBe(false)
  })

  it('a fresh install reads shadow: the default is loaded behind the notice (OD-1)', async () => {
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow')
    expect(familyMode('taskState', '/work/example-web')).toBe('shadow')
    expect(listenerWanted()).toBe(true)
    expect(existsSync(file)).toBe(false) // nothing is written until something changes
  })

  it('reads active only where a family is active for some folder', async () => {
    writeFileSync(file, JSON.stringify({ v: 1, families: { taskState: 'active' } }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow') // active, but no folder is on the ramp
    expect(familyMode('taskState', '/work/ramped')).toBe('shadow')
    setRampFolders(['/work/ramped'])
    expect(getCompanionMode()).toBe('active')
    expect(familyMode('taskState', '/work/ramped')).toBe('active')
    expect(familyMode('taskState', '/work/other')).toBe('shadow')
    setCompanionCliGate('above')
    expect(getCompanionMode()).toBe('shadow') // ARB-7b
    setCompanionCliGate('below')
    expect(getCompanionMode()).toBe('off')
  })

  it('an unreadable file reads the shipped defaults, never off by accident', async () => {
    writeFileSync(file, '{ not json')
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('shadow')
  })

  it('turning the switch on wakes the host', async () => {
    writeFileSync(file, JSON.stringify({ v: 1, enabled: false }))
    await hydrateCompanionMode()
    expect(getCompanionMode()).toBe('off')
    expect(listenerWanted()).toBe(false)
    let fired = 0
    const off = onModeChange(() => fired++)
    await setCompanionEnabled(true)
    expect(fired).toBe(1)
    expect(listenerWanted()).toBe(true)
    expect(getCompanionMode()).toBe('shadow')
    await setCompanionEnabled(true) // unchanged
    expect(fired).toBe(1)
    await setCompanionEnabled(false)
    expect(fired).toBe(2)
    off()
  })

  it('the settled CLI probe fires onModeChange once per change', () => {
    let fired = 0
    const off = onModeChange(() => fired++)
    setCompanionCliGate('unknown')
    expect(fired).toBe(1)
    setCompanionCliGate('unknown')
    expect(fired).toBe(1)
    setCompanionCliGate('ok')
    expect(fired).toBe(2)
    off()
  })

  it('a throwing listener does not stop the others', async () => {
    let fired = 0
    const a = onModeChange(() => {
      throw new Error('boom')
    })
    const b = onModeChange(() => fired++)
    await setCompanionEnabled(false)
    expect(fired).toBe(1)
    a()
    b()
  })
})

describe('the prefs store', () => {
  it('writes mode 0600, only overrides, and survives a restart', async () => {
    await hydrateCompanionPrefs()
    await setFamilyMode('taskState', 'active')
    await setAllFolders(true)
    await markDisclosureShown(1_790_000_000_000)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk).toEqual({
      v: 1,
      families: { taskState: 'active' },
      allFolders: true,
      disclosureShownAt: 1_790_000_000_000
    })
    setCompanionPrefsPath(file) // a fresh process
    await hydrateCompanionPrefs()
    expect(rolloutView().families).toEqual({ taskState: 'active' })
    expect(rolloutView().allFolders).toBe(true)
    expect(companionInjectDecision({ kind: 'claude-new', cliGate: 'ok' })).toEqual({ inject: true })
  })

  it('the disclosure is stamped once', async () => {
    await markDisclosureShown(111)
    await markDisclosureShown(222)
    expect(JSON.parse(readFileSync(file, 'utf8')).disclosureShownAt).toBe(111)
  })

  it('normalizes the ramp like the responder ramp does', () => {
    setRampFolders(['/work/ramped/', '/work/a/../b'])
    expect([...rolloutView().rampFolders].sort()).toEqual(['/work/b', '/work/ramped'])
  })
})

describe('feature keys', () => {
  it('feature keys are capped above the ceiling', async () => {
    registerPrefsKey<string>('channel', {
      default: 'shadow',
      parse: (raw) => (raw === 'off' || raw === 'shadow' || raw === 'active' ? raw : 'shadow'),
      observeCap: 'shadow'
    })
    writeFileSync(file, JSON.stringify({ v: 1, keys: { channel: 'active' } }))
    await hydrateCompanionPrefs()
    expect(prefsKey<string>('channel')).toBe('active')
    setCompanionCliGate('above')
    expect(prefsKey<string>('channel')).toBe('shadow')
    setCompanionCliGate('ok')
    expect(prefsKey<string>('channel')).toBe('active')
  })

  it('an unset key reads its default, a bad value its parse fallback, a set value is persisted', async () => {
    registerPrefsKey<boolean>('context', { default: true, parse: (raw) => raw === true })
    writeFileSync(file, JSON.stringify({ v: 1, keys: { other: 1 } }))
    await hydrateCompanionPrefs()
    expect(prefsKey<boolean>('context')).toBe(true)
    setPrefsKey<boolean>('context', false)
    await flushCompanionPrefs()
    expect(prefsKey<boolean>('context')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).keys).toEqual({ other: 1, context: false })
    expect(() => prefsKey('nope')).toThrow()
  })
})
