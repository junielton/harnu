import { describe, expect, it } from 'vitest'
import {
  HELLO_GRACE_MS,
  deriveCompanionState,
  sideloadRefusalMatches,
  type StateFacts
} from '../../src/main/companion/companion-state-core'

/** A spawn that carried the mod, said hello, and is leased: the `live` row. */
function facts(over: Partial<StateFacts> = {}): StateFacts {
  return {
    pty: { kind: 'claude-new' },
    killSwitchOff: false,
    inject: { inject: true },
    sideload: null,
    refusal: null,
    hostRestart: false,
    binding: { enabledEmpty: false, leaseLive: true, ended: false },
    spawnAgeMs: 60_000,
    probe: null,
    refusalTexts: [],
    ...over
  }
}

const noHello = (over: Partial<StateFacts> = {}): StateFacts => facts({ binding: null, ...over })

describe('deriveCompanionState', () => {
  it('state table', () => {
    // row 1: no Harnu PTY, or a kind that is not claude-*
    expect(deriveCompanionState(facts({ pty: null }))).toBeNull()
    expect(deriveCompanionState(facts({ pty: { kind: 'shell' } }))).toBeNull()
    expect(deriveCompanionState(facts({ pty: { kind: 'claude-resume' } }))).toEqual({
      state: 'live'
    })
    // row 2: the kill switch now, or a spawn that skipped for it
    expect(deriveCompanionState(facts({ killSwitchOff: true }))).toEqual({ state: 'off' })
    expect(deriveCompanionState(facts({ inject: { inject: false, skip: 'off' } }))).toEqual({
      state: 'off'
    })
    // rows 3 and 4: the CLI gate
    expect(deriveCompanionState(facts({ inject: { inject: false, skip: 'cli-too-old' } }))).toEqual(
      {
        state: 'legacy',
        reason: 'cliTooOld'
      }
    )
    expect(deriveCompanionState(facts({ inject: { inject: false, skip: 'cli-unknown' } }))).toEqual(
      {
        state: 'legacy',
        reason: 'cliUnknown'
      }
    )
    // row 5: exited early and respawned bare
    expect(
      deriveCompanionState(
        noHello({ sideload: { respawnedBare: true, output: 'blocked by policy' } })
      )
    ).toEqual({ state: 'legacy', reason: 'noHello' }) // no text recorded yet: never a guess
    expect(
      deriveCompanionState(
        noHello({
          sideload: { respawnedBare: true, output: 'x: sideloaded plugins are blocked' },
          refusalTexts: ['sideloaded plugins are blocked']
        })
      )
    ).toEqual({ state: 'legacy', reason: 'policy' })
    expect(
      deriveCompanionState(
        noHello({
          sideload: { respawnedBare: true, output: 'something else' },
          refusalTexts: ['sideloaded plugins are blocked']
        })
      )
    ).toEqual({ state: 'legacy', reason: 'noHello' })
    // row 6: spawned before the notice
    expect(
      deriveCompanionState(noHello({ inject: { inject: false, skip: 'pre-disclosure' } }))
    ).toEqual({ state: 'legacy', reason: 'notInjected' })
    // row 7: refused, and a host restart
    expect(deriveCompanionState(noHello({ refusal: { code: 'FEATURE_DISABLED' } }))).toEqual({
      state: 'legacy',
      reason: 'refused'
    })
    expect(deriveCompanionState(noHello({ refusal: { code: 'UNKNOWN_SESSION' } }))).toEqual({
      state: 'legacy',
      reason: 'hostRestart'
    })
    expect(deriveCompanionState(noHello({ hostRestart: true }))).toEqual({
      state: 'legacy',
      reason: 'hostRestart'
    })
    // row 8: hello answered enable [] (inert): off, never a lease loss
    expect(
      deriveCompanionState(
        facts({ binding: { enabledEmpty: true, leaseLive: false, ended: false } })
      )
    ).toEqual({ state: 'off' })
    // row 9: hello done, lease lost
    expect(
      deriveCompanionState(
        facts({ binding: { enabledEmpty: false, leaseLive: false, ended: false } })
      )
    ).toEqual({ state: 'legacy', reason: 'unloaded' })
    // row 10: injected, no hello, still inside the grace
    expect(deriveCompanionState(noHello({ spawnAgeMs: HELLO_GRACE_MS - 1 }))).toBeNull()
    // row 11: past the grace, the probe says mods are off here / remotely
    expect(deriveCompanionState(noHello({ probe: 'off-here' }))).toEqual({
      state: 'legacy',
      reason: 'modsOff'
    })
    expect(deriveCompanionState(noHello({ probe: 'off-remote' }))).toEqual({
      state: 'legacy',
      reason: 'remoteOff'
    })
    // row 12: the probe says they load, or could not tell, or has not run yet
    expect(deriveCompanionState(noHello({ probe: 'loads' }))).toEqual({
      state: 'legacy',
      reason: 'noHello'
    })
    expect(deriveCompanionState(noHello({ probe: 'unknown' }))).toEqual({
      state: 'legacy',
      reason: 'noHello'
    })
    expect(deriveCompanionState(noHello({ probe: null }))).toEqual({
      state: 'legacy',
      reason: 'noHello'
    })
    // row 13
    expect(deriveCompanionState(facts())).toEqual({ state: 'live' })
  })

  it('the first matching row wins', () => {
    // the kill switch beats a CLI-gate skip and a lost lease
    expect(
      deriveCompanionState(
        facts({
          killSwitchOff: true,
          inject: { inject: false, skip: 'cli-too-old' },
          binding: { enabledEmpty: false, leaseLive: false, ended: false }
        })
      )
    ).toEqual({ state: 'off' })
    // a gate problem beats a missing notice
    expect(
      deriveCompanionState(noHello({ inject: { inject: false, skip: 'cli-unknown' } }))
    ).toEqual({ state: 'legacy', reason: 'cliUnknown' })
    // a lost lease beats the probe
    expect(
      deriveCompanionState(
        facts({
          binding: { enabledEmpty: false, leaseLive: false, ended: false },
          probe: 'off-here'
        })
      )
    ).toEqual({ state: 'legacy', reason: 'unloaded' })
  })

  it('shows nothing where nothing is known', () => {
    expect(deriveCompanionState(facts({ inject: null }))).toBeNull() // spawn decision never recorded
    expect(
      deriveCompanionState(
        facts({ binding: { enabledEmpty: false, leaseLive: false, ended: true } })
      )
    ).toBeNull() // the session is ending
    expect(deriveCompanionState(noHello({ spawnAgeMs: null }))).toBeNull()
  })

  it('the state never implies protection: only live, off and legacy exist', () => {
    const seen = new Set<string>()
    for (const probe of [null, 'loads', 'off-here', 'off-remote', 'unknown'] as const) {
      const s = deriveCompanionState(noHello({ probe }))
      if (s) seen.add(s.state)
    }
    expect([...seen]).toEqual(['legacy'])
  })
})

describe('sideloadRefusalMatches', () => {
  it('matches only a recorded text, and never when none is recorded', () => {
    expect(sideloadRefusalMatches('anything', [])).toBe(false)
    expect(sideloadRefusalMatches(null, ['x'])).toBe(false)
    expect(
      sideloadRefusalMatches('Plugin sideload is disabled by policy', ['sideload is disabled'])
    ).toBe(true)
  })
})
