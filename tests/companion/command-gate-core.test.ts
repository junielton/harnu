/**
 * The origin gate and argument rules of the command channel (T389 P2W1 §7.4): a constant matrix,
 * `registerGateRow` for later waves, profile and shadow admission, and closed argument schemas.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMMAND_NAMES,
  checkOrigin,
  gateRowFor,
  profileRefusal,
  registerGateRow,
  resetGateRowsForTests,
  shadowRefusal,
  UI_TEXTS,
  uiText,
  validateArgs
} from '../../src/main/companion/command-gate-core'
import type { CommandCause } from '../../src/main/companion/command-types'
import type { CommandName } from '../../src/main/companion/contract'

afterEach(() => resetGateRowsForTests())

/** The matrix of spec §7.4, written out by hand: the test does not read the table it checks. */
const MATRIX: Partial<
  Record<
    CommandName,
    { operator?: string[]; verb?: string[]; internal?: string[]; debug?: boolean }
  >
> = {
  flush: { operator: ['diagnostics.ping'], internal: ['arbitration', 'parity'] },
  'config.update': { internal: ['prefs'], debug: true },
  'turn.abort': { debug: true },
  'session.compact': { debug: true },
  'ui.toast': { operator: ['diagnostics.ping'] },
  'ui.status': { internal: ['arbitration'], debug: true }
}

const GESTURES = ['diagnostics.ping', 'debug', 'bogus', '']
const VERBS = ['message_session', 'orchestrator_arm', 'notify', 'bogus']
const SUBSYSTEMS = ['arbitration', 'parity', 'prefs', 'bogus']

function expected(name: CommandName, cause: CommandCause, debugOn: boolean): boolean {
  const row = MATRIX[name]
  if (!row) return false
  if (cause.kind === 'operator') {
    if (cause.gesture === 'debug') return debugOn && row.debug === true
    return row.operator?.includes(cause.gesture) ?? false
  }
  if (cause.kind === 'verb') return row.verb?.includes(cause.verb) ?? false
  return row.internal?.includes(cause.subsystem) ?? false
}

describe('origin gate', () => {
  it('origin matrix is exhaustive', () => {
    let cells = 0
    for (const name of COMMAND_NAMES) {
      for (const debugOn of [false, true]) {
        const causes: CommandCause[] = [
          ...GESTURES.map((gesture) => ({ kind: 'operator', gesture }) as const),
          ...VERBS.map((verb) => ({ kind: 'verb', verb }) as const),
          ...SUBSYSTEMS.map((subsystem) => ({ kind: 'internal', subsystem }) as const)
        ]
        for (const cause of causes) {
          const got = checkOrigin(name, cause, { debug: debugOn })
          expect(got.ok, `${name} ${JSON.stringify(cause)} debug=${debugOn}`).toBe(
            expected(name, cause, debugOn)
          )
          if (!got.ok) expect(got.reason).toBe('ORIGIN_DENIED')
          cells++
        }
      }
    }
    expect(cells).toBe(
      COMMAND_NAMES.length * 2 * (GESTURES.length + VERBS.length + SUBSYSTEMS.length)
    )
  })

  it('names the feature of each of the six rows', () => {
    const feature = (n: CommandName): string | undefined => gateRowFor(n)?.feature
    expect(feature('flush')).toBe('act.channel')
    expect(feature('config.update')).toBe('act.channel')
    expect(feature('turn.abort')).toBe('act.turn')
    expect(feature('session.compact')).toBe('act.compact')
    expect(feature('ui.toast')).toBe('act.ui')
    expect(feature('ui.status')).toBe('act.ui')
  })

  it('unregistered rows: a command with no row is ORIGIN_DENIED for every cause', () => {
    for (const name of ['prompt.submit', 'message.deliver', 'guard.set', 'ui.band.set'] as const) {
      expect(
        checkOrigin(name, { kind: 'internal', subsystem: 'arbitration' }, { debug: true })
      ).toEqual({
        ok: false,
        reason: 'ORIGIN_DENIED'
      })
    }
  })

  it('a later wave registers its own row, and only its row opens', () => {
    registerGateRow('prompt.submit', {
      feature: 'act.prompt',
      operator: ['card.dispatch'],
      debug: true
    })
    expect(
      checkOrigin('prompt.submit', { kind: 'operator', gesture: 'card.dispatch' }, { debug: false })
        .ok
    ).toBe(true)
    expect(
      checkOrigin('prompt.submit', { kind: 'operator', gesture: 'debug' }, { debug: false }).ok
    ).toBe(false)
    expect(
      checkOrigin('prompt.submit', { kind: 'operator', gesture: 'debug' }, { debug: true }).ok
    ).toBe(true)
    expect(
      checkOrigin('prompt.submit', { kind: 'verb', verb: 'create_session' }, { debug: true }).ok
    ).toBe(false)
  })
})

describe('profile admission', () => {
  it('headless admits only the two housekeeping commands', () => {
    expect(profileRefusal('headless', 'flush')).toBeNull()
    expect(profileRefusal('headless', 'config.update')).toBeNull()
    for (const n of [
      'turn.abort',
      'session.compact',
      'ui.toast',
      'ui.status',
      'ui.band.set'
    ] as const) {
      expect(profileRefusal('headless', n)).toBe('HEADLESS')
    }
  })

  it('external profile', () => {
    expect(profileRefusal('external', 'flush')).toBeNull()
    expect(profileRefusal('external', 'config.update')).toBeNull()
    expect(profileRefusal('external', 'ui.band.set')).toBeNull()
    expect(profileRefusal('external', 'ui.toast')).toBe('EXTERNAL')
    expect(profileRefusal('external', 'turn.abort')).toBe('EXTERNAL')
  })

  it('interactive admits everything', () => {
    for (const n of COMMAND_NAMES) expect(profileRefusal('interactive', n)).toBeNull()
  })
})

describe('the channel key', () => {
  it('off refuses everything as FEATURE_OFF', () => {
    for (const n of COMMAND_NAMES) expect(shadowRefusal('off', n, {})).toBe('FEATURE_OFF')
  })

  it('active admits everything', () => {
    for (const n of COMMAND_NAMES) expect(shadowRefusal('active', n, {})).toBeNull()
  })

  it('shadow admits the observe-only set', () => {
    expect(shadowRefusal('shadow', 'flush', {})).toBeNull()
    expect(shadowRefusal('shadow', 'config.update', { config: { flushMs: 100 } })).toBeNull()
    expect(shadowRefusal('shadow', 'sentinel.set', { tools: [] })).toBeNull()
    expect(shadowRefusal('shadow', 'ui.band.set', { line: null })).toBeNull()
    expect(shadowRefusal('shadow', 'guard.set', { armed: true, enforce: false })).toBeNull()
  })

  it('shadow refuses the rest as MODE_SHADOW', () => {
    expect(shadowRefusal('shadow', 'guard.set', { armed: true })).toBe('MODE_SHADOW')
    expect(shadowRefusal('shadow', 'guard.set', { armed: true, enforce: true })).toBe('MODE_SHADOW')
    for (const n of [
      'turn.abort',
      'session.compact',
      'ui.toast',
      'ui.status',
      'prompt.submit'
    ] as const) {
      expect(shadowRefusal('shadow', n, {})).toBe('MODE_SHADOW')
    }
  })
})

describe('arguments', () => {
  it('flush and session.compact take no argument at all', () => {
    expect(validateArgs('flush', {}).ok).toBe(true)
    expect(validateArgs('flush', { x: 1 }).ok).toBe(false)
    expect(validateArgs('session.compact', {}).ok).toBe(true)
    // protocol 1 narrows session.compact to {}: `instructions` is refused (smoke D5)
    expect(validateArgs('session.compact', { instructions: 'be brief' }).ok).toBe(false)
    expect(validateArgs('flush', null).ok).toBe(false)
    expect(validateArgs('flush', []).ok).toBe(false)
  })

  it('config.update checks every field against CONFIG_BOUNDS', () => {
    expect(validateArgs('config.update', { config: { pollHoldMs: 25_000 } }).ok).toBe(true)
    expect(validateArgs('config.update', { config: { pollHoldMs: 25_001 } }).ok).toBe(false)
    expect(validateArgs('config.update', { config: { pollHoldMs: 999 } }).ok).toBe(false)
    expect(validateArgs('config.update', { config: { flushMs: 100.5 } }).ok).toBe(false)
    expect(validateArgs('config.update', { config: { flushMs: '100' } }).ok).toBe(false)
    expect(validateArgs('config.update', { config: { nope: 1 } }).ok).toBe(false)
    expect(validateArgs('config.update', { config: {} }).ok).toBe(false)
    expect(validateArgs('config.update', {}).ok).toBe(false)
    expect(validateArgs('config.update', { config: { flushMs: 100 }, extra: 1 }).ok).toBe(false)
  })

  it('turn.abort takes an optional short turn id', () => {
    expect(validateArgs('turn.abort', {}).ok).toBe(true)
    expect(validateArgs('turn.abort', { turnId: 'turn_1' }).ok).toBe(true)
    expect(validateArgs('turn.abort', { turnId: '' }).ok).toBe(false)
    expect(validateArgs('turn.abort', { turnId: 'x'.repeat(129) }).ok).toBe(false)
    expect(validateArgs('turn.abort', { turnId: 5 }).ok).toBe(false)
  })

  it('ui.toast and ui.status take text from the constant table only', () => {
    expect(validateArgs('ui.toast', { text: uiText('channel-ok') }).ok).toBe(true)
    expect(validateArgs('ui.toast', { text: 'anything an agent wrote' }).ok).toBe(false)
    expect(validateArgs('ui.toast', { text: null }).ok).toBe(false)
    expect(validateArgs('ui.status', { text: uiText('status-test') }).ok).toBe(true)
    expect(validateArgs('ui.status', { text: null }).ok).toBe(true) // clears the line
    expect(validateArgs('ui.status', { text: 'free text' }).ok).toBe(false)
  })

  it('every constant text fits the 200 character cap', () => {
    for (const t of Object.values(UI_TEXTS)) expect(t.length).toBeLessThanOrEqual(200)
  })

  it('a command with no validator is refused', () => {
    expect(validateArgs('prompt.submit', { text: 'hi' }).ok).toBe(false)
  })

  it('a later wave may register a validator with its row', () => {
    registerGateRow('sentinel.set', {
      feature: 'gate.sentinel',
      internal: ['sentinel'],
      validate: (a) => Array.isArray((a as { tools?: unknown }).tools)
    })
    expect(validateArgs('sentinel.set', { tools: [] }).ok).toBe(true)
    expect(validateArgs('sentinel.set', { tools: 'x' }).ok).toBe(false)
  })
})
