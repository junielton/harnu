/**
 * T568 (browser pane U1, AC-1, AC-9, AC-12) — the pane's view model: address input, chip states, countdown.
 */
import { describe, it, expect } from 'vitest'
import {
  chipFor,
  formatCountdown,
  headerTitle,
  normalizeAddressInput,
  originBadgeKey,
  splitAddress
} from '../src/renderer/src/lib/browser-pane'

describe('normalizeAddressInput', () => {
  it('adds http for localhost and IP literals and https for named hosts', () => {
    expect(normalizeAddressInput('localhost:5173/checkout')).toBe('http://localhost:5173/checkout')
    expect(normalizeAddressInput('127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(normalizeAddressInput('app.localhost')).toBe('http://app.localhost')
    expect(normalizeAddressInput('example.com/docs?q=1')).toBe('https://example.com/docs?q=1')
    expect(normalizeAddressInput('  docs.example.com  ')).toBe('https://docs.example.com')
  })

  it('passes an explicit scheme through for main to judge, blocked ones included', () => {
    expect(normalizeAddressInput('https://example.com/a')).toBe('https://example.com/a')
    expect(normalizeAddressInput('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeAddressInput('file:///etc/passwd')).toBe('file:///etc/passwd')
    expect(normalizeAddressInput('javascript:alert(1)')).toBe('javascript:alert(1)')
    expect(normalizeAddressInput('about:blank')).toBe('about:blank')
  })

  it('refuses text that is not an address', () => {
    expect(normalizeAddressInput('')).toBeNull()
    expect(normalizeAddressInput('   ')).toBeNull()
    expect(normalizeAddressInput('how do I fix this')).toBeNull()
    expect(normalizeAddressInput('intranet')).toBeNull()
  })
})

describe('formatCountdown', () => {
  it('formats mm:ss, rounding up, never negative', () => {
    expect(formatCountdown(600_000)).toBe('10:00')
    expect(formatCountdown(59_001)).toBe('1:00')
    expect(formatCountdown(9_000)).toBe('0:09')
    expect(formatCountdown(0)).toBe('0:00')
    expect(formatCountdown(-5)).toBe('0:00')
  })
})

describe('headerTitle', () => {
  it('prefers the title, falls back to the host, then to nothing', () => {
    expect(headerTitle({ title: ' Checkout ', url: 'http://localhost:5173/' })).toBe('Checkout')
    expect(headerTitle({ title: '', url: 'http://localhost:5173/a' })).toBe('localhost:5173')
    expect(headerTitle({ title: '', url: 'about:blank' })).toBe('')
  })
})

describe('chipFor', () => {
  const base = {
    openedBy: 'agent',
    disconnected: false,
    pausedUntil: null,
    ownerSessionId: 's1'
  } as const

  it('shows the connected chip with the live word and a Disconnect button on an agent pane', () => {
    expect(chipFor(base, 'driving', 1000)).toEqual({
      kind: 'connected',
      ownerSessionId: 's1',
      pausedMs: 0,
      word: 'driving',
      disconnectable: true
    })
  })

  it('names "an agent" when the owner is unknown', () => {
    expect(chipFor({ ...base, ownerSessionId: null }, null, 0)?.kind).toBe('connectedAgent')
  })

  it('shows the paused chip with the time left, and the connected one again once it lapses', () => {
    const paused = { ...base, pausedUntil: 61_000 }
    expect(chipFor(paused, 'driving', 1000)).toMatchObject({
      kind: 'paused',
      pausedMs: 60_000,
      word: null
    })
    expect(chipFor(paused, null, 61_000)?.kind).toBe('connected')
    expect(chipFor(paused, null, 99_000)?.kind).toBe('connected')
  })

  it('shows disconnected with no button, outranking paused', () => {
    expect(chipFor({ ...base, disconnected: true, pausedUntil: 99_999 }, null, 0)).toMatchObject({
      kind: 'disconnected',
      disconnectable: false
    })
  })

  it('shows disconnected even on an operator-opened pane, and nothing otherwise', () => {
    expect(chipFor({ ...base, openedBy: 'operator' }, null, 0)).toBeNull()
    expect(chipFor({ ...base, openedBy: 'operator', disconnected: true }, null, 0)?.kind).toBe(
      'disconnected'
    )
  })
})

describe('originBadgeKey', () => {
  it('has no badge for blank', () => {
    expect(originBadgeKey('blank')).toBeNull()
    expect(originBadgeKey('local')).toBe('local')
    expect(originBadgeKey('external')).toBe('external')
    expect(originBadgeKey('page')).toBe('page')
  })
})

describe('splitAddress', () => {
  it('cuts scheme, host (with port) and the rest', () => {
    expect(splitAddress('http://localhost:5173/checkout?x=1#a')).toEqual({
      scheme: 'http://',
      host: 'localhost:5173',
      rest: '/checkout?x=1#a'
    })
    expect(splitAddress('https://example.com')).toEqual({
      scheme: 'https://',
      host: 'example.com',
      rest: ''
    })
    expect(splitAddress('http://[::ffff:7f00:1]:5188/a')).toMatchObject({
      host: '[::ffff:7f00:1]:5188'
    })
  })

  it('treats a non scheme://host text as all rest', () => {
    expect(splitAddress('about:blank')).toEqual({ scheme: '', host: '', rest: 'about:blank' })
    expect(splitAddress('exam')).toEqual({ scheme: '', host: '', rest: 'exam' })
    expect(splitAddress('')).toEqual({ scheme: '', host: '', rest: '' })
  })
})

describe('networkRemainingMs (the red "Network m:ss" counter, T570)', () => {
  it('counts down to the moment capture stops itself, and shows nothing without a capture or after it ended', async () => {
    const { networkRemainingMs, formatCountdown } =
      await import('../src/renderer/src/lib/browser-pane')
    expect(networkRemainingMs({ networkUntil: null }, 1_000)).toBeNull()
    expect(networkRemainingMs({ networkUntil: 1_000 }, 1_000)).toBeNull()
    expect(networkRemainingMs({ networkUntil: 1_000 }, 5_000)).toBeNull()
    const left = networkRemainingMs({ networkUntil: 5_000 + 252_000 }, 5_000)
    expect(left).toBe(252_000)
    expect(formatCountdown(left!)).toBe('4:12')
  })
})
