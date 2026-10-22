/**
 * T571 (browser pane U4, AC-8) — the per-folder trusted dev hosts list (spec §7.2): what an entry may be,
 * and that a listed host really changes the origin class by host string only, re-evaluated after a redirect.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_TRUSTED_HOSTS,
  addTrustedHost,
  parseTrustedHost,
  removeTrustedHost,
  sanitizeTrustedHosts
} from '../src/shared/browser-trusted-hosts'
import { classifyOrigin } from '../src/main/browser/origin-class'

describe('parseTrustedHost', () => {
  it.each([
    ['app.test', 'app.test'],
    ['  APP.Test. ', 'app.test'],
    ['*.test', '*.test'],
    ['web', 'web'],
    ['api-gateway', 'api-gateway'],
    ['*.dev.example.org', '*.dev.example.org'],
    ['*.app.test', '*.app.test'],
    ['*.corp.internal', '*.corp.internal'],
    ['192.168.1.5', '192.168.1.5'],
    ['[::1]', '[::1]']
  ])('accepts %j as %j', (raw, host) => {
    expect(parseTrustedHost(raw)).toEqual({ ok: true, host })
  })

  it.each([
    ['', 'EMPTY'],
    ['   ', 'EMPTY'],
    ['http://app.test', 'HAS_SCHEME_OR_PATH'],
    ['app.test/x', 'HAS_SCHEME_OR_PATH'],
    ['user@app.test', 'HAS_SCHEME_OR_PATH'],
    ['app.test:3000', 'HAS_PORT'],
    ['*', 'WILDCARD_POSITION'],
    ['a.*.test', 'WILDCARD_POSITION'],
    ['*.com', 'WILDCARD_TOO_BROAD'],
    ['*.dev', 'WILDCARD_TOO_BROAD'],
    ['*.io', 'WILDCARD_TOO_BROAD'],
    ['*.co.uk', 'WILDCARD_TOO_BROAD'],
    ['*.github.io', 'WILDCARD_TOO_BROAD'],
    ['*.example.com', 'WILDCARD_TOO_BROAD'],
    ['*.1.1', 'WILDCARD_TOO_BROAD'],
    ['*.10', 'WILDCARD_TOO_BROAD'],
    ['*.', 'WILDCARD_POSITION'],
    ['bad_name.test', 'BAD_CHARACTERS'],
    ['-x.test', 'BAD_CHARACTERS'],
    ['a'.repeat(260), 'TOO_LONG']
  ])('refuses %j (%s)', (raw, error) => {
    expect(parseTrustedHost(raw)).toEqual({ ok: false, error })
  })
})

describe('the list', () => {
  it('adds sorted, refuses a duplicate and a full list, and removes', () => {
    let list: string[] = []
    for (const h of ['b.test', 'a.test']) {
      const r = addTrustedHost(list, h)
      expect(r.ok).toBe(true)
      if (r.ok) list = r.hosts
    }
    expect(list).toEqual(['a.test', 'b.test'])
    expect(addTrustedHost(list, 'A.TEST')).toEqual({ ok: false, error: 'DUPLICATE' })
    const full = Array.from({ length: MAX_TRUSTED_HOSTS }, (_, i) => `h${i}.test`)
    expect(addTrustedHost(full, 'one-more.test')).toEqual({ ok: false, error: 'LIST_FULL' })
    expect(removeTrustedHost(list, 'a.test')).toEqual(['b.test'])
  })

  it('drops what a hand-edited file holds that the editor would have refused', () => {
    expect(sanitizeTrustedHosts(['ok.test', '*.com', 7, 'ok.test', 'http://x', '*.test'])).toEqual([
      '*.test',
      'ok.test'
    ])
    expect(sanitizeTrustedHosts('nope')).toEqual([])
  })
})

describe('what a listed host changes (spec §7.2)', () => {
  const opts = { extraTrustedHosts: ['app.test', '*.test', 'web'], harnuPorts: [41999] }
  it('classifies listed hosts as local and the rest as external', () => {
    expect(classifyOrigin('http://app.test:3000/x', opts)).toBe('local')
    expect(classifyOrigin('http://shop.test/', opts)).toBe('local')
    expect(classifyOrigin('http://web:8080/', opts)).toBe('local')
    expect(classifyOrigin('https://app.test.evil.com/', opts)).toBe('external')
    expect(classifyOrigin('https://example.com/', opts)).toBe('external')
  })
  it('looks at the host string only: a name that resolves to loopback is not trusted by itself', () => {
    expect(classifyOrigin('http://localtest.me/', opts)).toBe('external')
  })
  it('keeps Harnu’s own ports external even on a listed host', () => {
    expect(classifyOrigin('http://app.test:41999/', opts)).toBe('external')
  })
  it('is re-evaluated at every call: a local page that redirects to an external site is external next', () => {
    expect(classifyOrigin('http://app.test/login', opts)).toBe('local')
    expect(classifyOrigin('https://accounts.example.com/oauth', opts)).toBe('external')
  })
  it('an empty list changes nothing', () => {
    expect(classifyOrigin('http://app.test/', { harnuPorts: [] })).toBe('external')
  })
})
