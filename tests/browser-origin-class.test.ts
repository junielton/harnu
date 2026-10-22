/**
 * T568 (browser pane U1) — origin class (spec §1.2, §7.2): host-string classification only.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyOrigin,
  hostOf,
  isLoopbackHost,
  originKey,
  scrubUrl
} from '../src/main/browser/origin-class'

describe('classifyOrigin', () => {
  it('classifies the built-in dev hosts as local', () => {
    for (const url of [
      'http://localhost:5173/checkout',
      'https://localhost/',
      'http://127.0.0.1:3000',
      'http://127.1.2.3/',
      'http://[::1]:8080/',
      'http://app.localhost:3000/',
      // IPv4-mapped loopback, in every spelling (the URL parser normalizes the dotted form to hex).
      'http://[::ffff:127.0.0.1]:5188/',
      'http://[::ffff:7f00:1]:5188/',
      'http://[::ffff:7f12:3456]/',
      'http://[0:0:0:0:0:0:0:1]/'
    ]) {
      expect(classifyOrigin(url), url).toBe('local')
    }
  })

  it('classifies a hostname that merely resolves to loopback as external', () => {
    expect(classifyOrigin('http://localtest.me/')).toBe('external')
    expect(classifyOrigin('http://127.0.0.1.nip.io/')).toBe('external')
    expect(classifyOrigin('http://0.0.0.0:3000/')).toBe('external')
    expect(classifyOrigin('http://localhost.evil.com/')).toBe('external')
  })

  it('does not treat IPv4-mapped or other IPv6 literals outside loopback as local', () => {
    expect(classifyOrigin('http://[::ffff:8.8.8.8]/')).toBe('external')
    expect(classifyOrigin('http://[::ffff:808:808]/')).toBe('external')
    expect(classifyOrigin('http://[2001:db8::1]/')).toBe('external')
    expect(classifyOrigin('http://[::2]/')).toBe('external')
  })

  it("keeps Harnu's own port external for IPv4-mapped loopback too", () => {
    expect(classifyOrigin('http://[::ffff:7f00:1]:9222/', { harnuPorts: [9222] })).toBe('external')
  })

  it('classifies other literal IPv4 ranges and out-of-range octets as external', () => {
    expect(classifyOrigin('http://128.0.0.1/')).toBe('external')
    expect(classifyOrigin('http://10.0.0.5:3000/')).toBe('external')
  })

  it("classifies Harnu's own listening ports as external even on a local host", () => {
    expect(classifyOrigin('http://localhost:9222/json', { harnuPorts: [9222] })).toBe('external')
    expect(classifyOrigin('http://127.0.0.1:41999/mcp', { harnuPorts: [41999] })).toBe('external')
    expect(classifyOrigin('http://localhost:5173/', { harnuPorts: [9222] })).toBe('local')
  })

  it('honours per-folder trusted hosts, exact and wildcard, and still guards the Harnu ports', () => {
    const opts = { extraTrustedHosts: ['*.test', 'api-gateway'], harnuPorts: [9222] }
    expect(classifyOrigin('http://shop.test/', opts)).toBe('local')
    expect(classifyOrigin('http://api-gateway:8080/', opts)).toBe('local')
    expect(classifyOrigin('http://test/', opts)).toBe('external')
    expect(classifyOrigin('http://shop.test:9222/', opts)).toBe('external')
    expect(classifyOrigin('http://shop.test/')).toBe('external')
  })

  it('classifies harnu-page: as page and about:blank / garbage as blank', () => {
    expect(classifyOrigin('harnu-page://f0123456789ab/panel.html')).toBe('page')
    expect(classifyOrigin('about:blank')).toBe('blank')
    expect(classifyOrigin('')).toBe('blank')
    expect(classifyOrigin('not a url')).toBe('blank')
  })

  it('is case-insensitive on the host', () => {
    expect(classifyOrigin('http://LOCALHOST:3000/')).toBe('local')
  })
})

describe('url helpers', () => {
  it('scrubs the query string and fragment', () => {
    expect(scrubUrl('https://example.com/a/b?token=s3cret#frag')).toBe('https://example.com/a/b')
    expect(scrubUrl('about:blank')).toBe('about:blank')
    expect(scrubUrl('nonsense')).toBe('')
  })

  it('reports the host without the query', () => {
    expect(hostOf('https://docs.example.com:8443/x?y=1')).toBe('docs.example.com:8443')
    expect(hostOf('nope')).toBe('')
  })

  it('recognises loopback hosts for the certificate rule', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

describe('originKey (the scope of a lease)', () => {
  it('is scheme + host + port without path, query or fragment', () => {
    expect(originKey('https://a.com/x?q=1#f')).toBe('https://a.com')
    expect(originKey('https://a.com:443/y')).toBe('https://a.com')
    expect(originKey('https://a.com:8443/')).toBe('https://a.com:8443')
    expect(originKey('http://a.com/')).toBe('http://a.com')
    expect(originKey('http://LOCALHOST:3000/app')).toBe('http://localhost:3000')
  })
  it('keeps userinfo out, and gives non-http addresses and junk their own keys', () => {
    expect(originKey('https://user:pw@a.com/')).toBe('https://a.com')
    expect(originKey('about:blank')).toBe('about:blank')
    expect(originKey('')).toBe('')
    expect(originKey('not a url')).toBe('')
  })
  it('tells different sites apart', () => {
    expect(originKey('https://a.com/')).not.toBe(originKey('https://b.com/'))
    expect(originKey('https://a.com/')).not.toBe(originKey('http://a.com/'))
    expect(originKey('https://a.com/')).not.toBe(originKey('https://sub.a.com/'))
  })
})
