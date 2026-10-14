import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T456 W3 (spec §9.1) — the operator's setter for the three bounds and the `park` key. The clamps
 * are W1's (`policy-store.ts`): maxDeclines [1, 100], maxDeferMs [0, 24 h], floor >= 0. W3 only
 * exposes them; this suite pins that the setter enforces them, persists, and that a policy edit
 * does not wipe them.
 */

let userData = ''
vi.mock('electron', () => ({ app: { getPath: () => userData, isPackaged: false } }))

const H = 60 * 60_000

async function load() {
  vi.resetModules()
  const store = await import('../src/main/monitor/policy-store')
  const settings = await import('../src/main/monitor/negotiation-settings')
  const prefs = await import('../src/main/companion/companion-prefs')
  await import('../src/main/park-coordinator') // registers the `park` key
  return { store, settings, prefs }
}

const file = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(userData, 'monitor-policy.json'), 'utf8'))

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'harnu-w3-'))
})

describe('setNegotiationSettings — clamps', () => {
  it('ignores a payload that is not a plain object', async () => {
    const { settings } = await load()
    const before = settings.getNegotiationSettings()
    for (const bad of [null, undefined, 'x', 7, [1, 2]]) {
      expect(settings.setNegotiationSettings(bad as never)).toEqual(before)
    }
  })

  it('starts at the spec defaults', async () => {
    const { settings } = await load()
    expect(settings.getNegotiationSettings()).toEqual({
      park: 'ask',
      maxDeclines: 8,
      maxDeferMs: 2 * H,
      pressureFloorMb: 1536
    })
  })

  it('clamps maxDeclines to [1, 100] and rounds', async () => {
    const { settings } = await load()
    expect(settings.setNegotiationSettings({ maxDeclines: 0 }).maxDeclines).toBe(1)
    expect(settings.setNegotiationSettings({ maxDeclines: -4 }).maxDeclines).toBe(1)
    expect(settings.setNegotiationSettings({ maxDeclines: 1000 }).maxDeclines).toBe(100)
    expect(settings.setNegotiationSettings({ maxDeclines: 2.6 }).maxDeclines).toBe(3)
  })

  it('clamps maxDeferMs to [0, 24 h]', async () => {
    const { settings } = await load()
    expect(settings.setNegotiationSettings({ maxDeferMs: -5 }).maxDeferMs).toBe(0)
    expect(settings.setNegotiationSettings({ maxDeferMs: 25 * H }).maxDeferMs).toBe(24 * H)
    expect(settings.setNegotiationSettings({ maxDeferMs: 90 * 60_000 }).maxDeferMs).toBe(
      90 * 60_000
    )
  })

  it('clamps the pressure floor to >= 0', async () => {
    const { settings } = await load()
    expect(settings.setNegotiationSettings({ pressureFloorMb: -1 }).pressureFloorMb).toBe(0)
    expect(settings.setNegotiationSettings({ pressureFloorMb: 2048.4 }).pressureFloorMb).toBe(2048)
  })

  it('ignores a non-finite or non-numeric value and keeps the others', async () => {
    const { settings } = await load()
    settings.setNegotiationSettings({ maxDeclines: 5 })
    const out = settings.setNegotiationSettings({
      maxDeclines: Number.NaN,
      maxDeferMs: 'x' as unknown as number,
      pressureFloorMb: 900
    })
    expect(out.maxDeclines).toBe(5)
    expect(out.maxDeferMs).toBe(2 * H)
    expect(out.pressureFloorMb).toBe(900)
  })
})

describe('setNegotiationSettings — persistence', () => {
  it('writes the bounds beside the policy fields and a fresh process reads them back', async () => {
    const { settings } = await load()
    settings.setNegotiationSettings({
      maxDeclines: 3,
      maxDeferMs: 30 * 60_000,
      pressureFloorMb: 800
    })
    expect(file()).toMatchObject({
      maxLive: 5,
      maxDeclines: 3,
      maxDeferMs: 30 * 60_000,
      pressureFloorMb: 800
    })
    const again = await load()
    expect(again.settings.getNegotiationSettings()).toMatchObject({
      maxDeclines: 3,
      maxDeferMs: 30 * 60_000,
      pressureFloorMb: 800
    })
  })

  it('survives a policy edit', async () => {
    const { store, settings } = await load()
    settings.setNegotiationSettings({ maxDeclines: 4, pressureFloorMb: 700 })
    store.setPolicy({ maxLive: 9 })
    expect(file()).toMatchObject({ maxLive: 9, maxDeclines: 4, pressureFloorMb: 700 })
    expect(store.getNegotiationBounds()).toMatchObject({ maxDeclines: 4, pressureFloorMb: 700 })
  })

  it('a bounds edit keeps the policy fields (and a hand-edited file is clamped on load)', async () => {
    writeFileSync(
      join(userData, 'monitor-policy.json'),
      JSON.stringify({ maxLive: 7, lruIdleMs: 120_000, hardIdleMs: 240_000, maxDeclines: 9999 })
    )
    const { store, settings } = await load()
    expect(settings.getNegotiationSettings().maxDeclines).toBe(100)
    settings.setNegotiationSettings({ pressureFloorMb: 1000 })
    expect(store.getPolicy()).toMatchObject({ maxLive: 7, lruIdleMs: 120_000, hardIdleMs: 240_000 })
    expect(file()).toMatchObject({ maxLive: 7, lruIdleMs: 120_000, pressureFloorMb: 1000 })
  })

  it('the coordinator reads the new bound on its very next decision', async () => {
    const { store, settings } = await load()
    settings.setNegotiationSettings({ maxDeclines: 2 })
    expect(store.getNegotiationBounds().maxDeclines).toBe(2)
  })
})

describe('the `park` key', () => {
  it('sets and reads the three modes through the prefs key', async () => {
    const { settings, prefs } = await load()
    expect(settings.setNegotiationSettings({ park: 'off' }).park).toBe('off')
    expect(prefs.prefsKey('park')).toBe('off')
    expect(settings.setNegotiationSettings({ park: 'ask' }).park).toBe('ask')
    expect(settings.setNegotiationSettings({ park: 'facts' }).park).toBe('facts')
  })

  it('ignores a value that is not one of the three modes', async () => {
    const { settings } = await load()
    settings.setNegotiationSettings({ park: 'off' })
    const out = settings.setNegotiationSettings({ park: 'maybe' as never })
    expect(out.park).toBe('off')
  })

  it('reads `facts` when the CLI is above the tested ceiling and `ask` is stored (ARB-7b)', async () => {
    const { settings, prefs } = await load()
    settings.setNegotiationSettings({ park: 'ask' })
    prefs.setCompanionCliGate('above')
    expect(settings.getNegotiationSettings().park).toBe('facts')
  })

  it('the cap only lowers: a stored `off` stays `off` above the ceiling, so the switch can work', async () => {
    const { settings, prefs } = await load()
    prefs.setCompanionCliGate('above')
    expect(settings.setNegotiationSettings({ park: 'off' }).park).toBe('off')
    expect(settings.setNegotiationSettings({ park: 'facts' }).park).toBe('facts')
    expect(settings.setNegotiationSettings({ park: 'ask' }).park).toBe('facts')
  })
})
