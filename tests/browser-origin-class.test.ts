/**
 * T568 (browser pane U1) — origin class (spec §1.2, §7.2): host-string classification only.
 */
import { describe, it, expect } from 'vitest'
import { classifyOrigin, hostOf, isLoopbackHost, scrubUrl } from '../src/main/browser/origin-class'

describe('classifyOrigin', () => {
  it('classifies the built-in dev hosts as local', () => {
    for (const url of [
      'http://localhost:5173/checkout',
      'https://localhost/',
      'http://127.0.0.1:3000',
      'http://127.1.2.3/',
      'http://[::1]:8080/',
      'http://app.localhost:3000/'
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
