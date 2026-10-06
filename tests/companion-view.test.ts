import { describe, expect, it } from 'vitest'
import {
  monitorCell,
  ownsAnyFamily,
  settingsStatusKey,
  stateLine,
  unloadedNotices
} from '../src/renderer/src/lib/companion-view'
import en from '../src/renderer/src/i18n/en.json'
import type { CompanionStatus } from '../src/main/companion/companion-status'

const dict = en as unknown as Record<string, unknown>
/** A tiny stand-in for vue-i18n over the real English file: `{param}` interpolation only. */
const t = (key: string, params: Record<string, unknown> = {}): string => {
  let cur: unknown = dict
  for (const part of key.split('.')) cur = (cur as Record<string, unknown>)?.[part]
  if (typeof cur !== 'string') throw new Error(`missing i18n key ${key}`)
  return cur.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k]))
}

const ownership = (owner: 'legacy' | 'companion') =>
  ({
    identity: { owner, reason: 'owned' },
    taskState: { owner, reason: 'owned' }
  }) as unknown as CompanionStatus['sessions'][string]['ownership']

function status(over: Partial<CompanionStatus> = {}): CompanionStatus {
  return {
    enabled: true,
    disclosureShownAt: 1,
    stagedDir: null,
    modVersion: '0.1.0',
    cliGate: 'ok',
    families: {} as CompanionStatus['families'],
    sessions: {},
    probe: null,
    ...over
  }
}

describe('stateLine', () => {
  it('words live, off and legacy with the reason', () => {
    expect(stateLine(null, t)).toBeNull()
    expect(stateLine({ state: 'live' }, t)).toEqual({ text: 'Harnu mod: live', reason: null })
    expect(stateLine({ state: 'off' }, t)).toEqual({ text: 'Harnu mod: off', reason: null })
    expect(stateLine({ state: 'legacy', reason: 'notInjected' }, t)).toEqual({
      text: 'Harnu mod: legacy — started without it',
      reason: 'started without it'
    })
  })

  it('every legacy reason has words, and none claims a cause the host did not observe', () => {
    const reasons = [
      'cliTooOld',
      'cliUnknown',
      'policy',
      'modsOff',
      'remoteOff',
      'noHello',
      'refused',
      'unloaded',
      'hostRestart',
      'notInjected'
    ] as const
    for (const reason of reasons) {
      const line = stateLine({ state: 'legacy', reason }, t)
      expect(line?.text).toContain('Harnu mod: legacy — ')
    }
    // the neutral reason never says "policy" alone, and "did not load" says no cause at all
    expect(t('harnuMod.reason.modsOff')).toContain('a setting or by your organization')
    expect(t('harnuMod.reason.noHello')).toBe('the mod did not load')
  })

  it('the state nouns are never wording that implies protection', () => {
    for (const k of ['live', 'off']) {
      expect(t(`harnuMod.state.${k}`)).not.toMatch(/protect|secure|safe/i)
    }
  })
})

describe('monitorCell', () => {
  it('shows the state, with the reason in the tooltip only for legacy', () => {
    expect(monitorCell(null, t)).toBeNull()
    expect(monitorCell({ state: 'live' }, t)).toEqual({ text: 'Harnu mod live', title: undefined })
    expect(monitorCell({ state: 'legacy', reason: 'unloaded' }, t)).toEqual({
      text: 'Harnu mod legacy',
      title: 'unloaded mid-session'
    })
  })
})

describe('settingsStatusKey', () => {
  const legacy = (reason: 'policy' | 'remoteOff' | 'modsOff' | 'noHello') =>
    status({
      sessions: {
        a: { state: { state: 'legacy', reason }, ownership: ownership('legacy') }
      }
    })

  it('says nothing by default, and nothing when the switch is off', () => {
    expect(settingsStatusKey(null)).toBeNull()
    expect(settingsStatusKey(status())).toBeNull()
    expect(settingsStatusKey(status({ enabled: false, cliGate: 'below' }))).toBeNull()
  })

  it('names the CLI gate first, then the observed cause', () => {
    expect(settingsStatusKey(status({ cliGate: 'below' }))).toBe('harnuMod.settings.cliTooOld')
    expect(settingsStatusKey(status({ cliGate: 'above' }))).toBe('harnuMod.settings.cliUntested')
    expect(settingsStatusKey(legacy('policy'))).toBe('harnuMod.settings.policy')
    expect(settingsStatusKey(legacy('remoteOff'))).toBe('harnuMod.settings.remoteOff')
    expect(settingsStatusKey(legacy('modsOff'))).toBe('harnuMod.settings.modsOff')
    expect(settingsStatusKey(legacy('noHello'))).toBeNull() // no cause was observed
  })
})

describe('unloadedNotices', () => {
  const unloaded = status({
    sessions: {
      a: { state: { state: 'legacy', reason: 'unloaded' }, ownership: ownership('legacy') }
    }
  })
  const owned = status({
    sessions: { a: { state: { state: 'live' }, ownership: ownership('companion') } }
  })
  const shadowLive = status({
    sessions: { a: { state: { state: 'live' }, ownership: ownership('legacy') } }
  })

  it('notices a session that owned a family and lost the mod, once', () => {
    expect(ownsAnyFamily(owned.sessions.a)).toBe(true)
    expect(unloadedNotices(owned, unloaded, new Set())).toEqual(['a'])
    expect(unloadedNotices(owned, unloaded, new Set(['a']))).toEqual([])
  })

  it('stays silent in plain shadow: nothing changed for the operator', () => {
    expect(unloadedNotices(shadowLive, unloaded, new Set())).toEqual([])
  })

  it('stays silent on the first status and for other reasons', () => {
    expect(unloadedNotices(null, unloaded, new Set())).toEqual([])
    const other = status({
      sessions: {
        a: { state: { state: 'legacy', reason: 'noHello' }, ownership: ownership('legacy') }
      }
    })
    expect(unloadedNotices(owned, other, new Set())).toEqual([])
  })
})
