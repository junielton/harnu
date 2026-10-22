/**
 * T570 (browser pane U3, AC-5) — the wait condition engine: first of selector / text / textGone / url /
 * network idle / timeout / closed / disconnected, with `wait.reason` naming it.
 */
import { describe, it, expect } from 'vitest'
import {
  compileUrlPattern,
  isHeavyPattern,
  runWait,
  type WaitProbes
} from '../src/main/browser/wait-for'

function rig(over: Partial<WaitProbes> = {}) {
  let t = 0
  const probes: WaitProbes = {
    selectorPresent: async () => false,
    pageText: async () => '',
    currentUrl: () => 'http://localhost/start',
    networkIdle: () => false,
    paneOpen: () => true,
    disconnected: () => false,
    ...over
  }
  const deps = { now: () => t, sleep: async (ms: number) => void (t += ms), probes }
  return { deps, at: (ms: number) => void (t = ms) }
}

describe('runWait', () => {
  it('returns at once when a condition already holds', async () => {
    const { deps } = rig({ selectorPresent: async () => true })
    expect(await runWait({ selector: '#a' }, 5_000, deps)).toEqual({
      reason: 'selector',
      waitedMs: 0,
      match: '#a'
    })
  })

  it('waits for text to appear', async () => {
    let polls = 0
    const { deps } = rig({ pageText: async () => (++polls > 3 ? 'Order placed' : 'Loading') })
    const out = await runWait({ text: 'placed' }, 5_000, deps)
    expect(out.reason).toBe('text')
    expect(out.waitedMs).toBeGreaterThan(0)
  })

  it('waits for text to go away', async () => {
    let polls = 0
    const { deps } = rig({ pageText: async () => (++polls > 2 ? 'Done' : 'Loading…') })
    expect((await runWait({ textGone: 'Loading' }, 5_000, deps)).reason).toBe('textGone')
  })

  it('matches the url regex against the current url', async () => {
    let url = 'http://localhost/start'
    let polls = 0
    const { deps } = rig({
      currentUrl: () => (++polls > 2 && (url = 'http://localhost/done?x=1'), url)
    })
    const out = await runWait({ url: compileUrlPattern('/done')! }, 5_000, deps)
    expect(out).toMatchObject({ reason: 'url', match: '/done' })
  })

  it('returns networkIdle when the counter says so', async () => {
    let polls = 0
    const { deps } = rig({ networkIdle: (ms) => (ms === 400 ? ++polls > 1 : false) })
    expect((await runWait({ networkIdleMs: 400 }, 5_000, deps)).reason).toBe('networkIdle')
  })

  it('times out without an error, having waited the whole time', async () => {
    const { deps } = rig()
    expect(await runWait({ selector: '#never' }, 1_000, deps)).toEqual({
      reason: 'timeout',
      waitedMs: 1_000
    })
  })

  it('ends when the pane closes or the operator disconnects, and says which', async () => {
    let open = true
    const { deps } = rig({ paneOpen: () => open })
    const closing = runWait({ selector: '#a' }, 5_000, deps)
    open = false
    expect((await closing).reason).toBe('closed')

    let cut = false
    const second = rig({ disconnected: () => cut })
    const waiting = runWait({ text: 'x' }, 5_000, second.deps)
    cut = true
    expect((await waiting).reason).toBe('disconnected')
  })

  it('disconnect outranks a condition that also holds', async () => {
    const { deps } = rig({ disconnected: () => true, selectorPresent: async () => true })
    expect((await runWait({ selector: '#a' }, 5_000, deps)).reason).toBe('disconnected')
  })

  it('treats a probe that throws (the page is navigating) as "not yet"', async () => {
    let polls = 0
    const { deps } = rig({
      selectorPresent: async () => {
        if (++polls < 3) throw new Error('Cannot find context')
        return true
      }
    })
    expect((await runWait({ selector: '#a' }, 5_000, deps)).reason).toBe('selector')
  })

  it('the first condition to hold wins when several are given', async () => {
    const { deps } = rig({ pageText: async () => 'hello', selectorPresent: async () => false })
    expect(
      (await runWait({ selector: '#a', text: 'hello', textGone: 'nope' }, 5_000, deps)).reason
    ).toBe('text')
  })
})

describe('compileUrlPattern', () => {
  it('accepts a regex of 1 to 200 characters and refuses the rest', () => {
    expect(compileUrlPattern('/done$')).toBeInstanceOf(RegExp)
    expect(compileUrlPattern('')).toBeNull()
    expect(compileUrlPattern('a'.repeat(201))).toBeNull()
    expect(compileUrlPattern('(unclosed')).toBeNull()
  })
})

/* ---- T570 delta 1: the url pattern runs in the main process against a page-controlled URL ---------------- */

describe('url pattern bounds', () => {
  it.each([
    '(a+)+$',
    '(a*)*b',
    '(\\w+\\s?)*$',
    '(a|aa)+$',
    '(.*a){3,}',
    '((a+)b)+',
    '(?:x+y)*',
    '(a|b)*c'
  ])('refuses %s: a repetition or an alternation inside a repeated group', (source) => {
    expect(isHeavyPattern(source), source).toBe(true)
    expect(compileUrlPattern(source), source).toBeNull()
  })

  it('refuses a pattern with more than three repetition operators', () => {
    expect(compileUrlPattern('.*.*.*.*x')).toBeNull()
    expect(compileUrlPattern('a+b+c+')).toBeInstanceOf(RegExp)
    expect(compileUrlPattern('a+b+c+d+')).toBeNull()
  })

  it.each([
    '/checkout/\\d+/done$',
    '^https://[^/]+/app/(en|fr)/',
    '\\?step=\\d{1,3}$',
    '^http://localhost:\\d+/(a|b)/?$',
    '[+*]+x',
    '\\(+',
    '/done$'
  ])('still accepts the ordinary pattern %s', (source) => {
    expect(isHeavyPattern(source), source).toBe(false)
    expect(compileUrlPattern(source), source).toBeInstanceOf(RegExp)
  })

  it('treats an escaped or classed quantifier as a literal, not a repetition', () => {
    expect(isHeavyPattern('(\\++a)')).toBe(false)
    expect(isHeavyPattern('([+*]x)')).toBe(false)
    expect(isHeavyPattern('(a\\*)*')).toBe(false)
  })

  it('matches only the first 2048 characters of the URL', async () => {
    const long = `http://localhost/${'a'.repeat(2_100)}/done`
    const { deps } = rig({ currentUrl: () => long })
    const pat = compileUrlPattern('/done$')!
    expect((await runWait({ url: pat }, 200, deps)).reason).toBe('timeout')
    const early = rig({ currentUrl: () => `http://localhost/done${'b'.repeat(3_000)}` })
    expect((await runWait({ url: compileUrlPattern('/done')! }, 200, early.deps)).reason).toBe(
      'url'
    )
  })

  it('a worst-case URL against an accepted pattern finishes at once', async () => {
    const hostile = `http://x/${'a'.repeat(5_000)}!`
    const { deps } = rig({ currentUrl: () => hostile })
    const started = Date.now()
    await runWait({ url: compileUrlPattern('a+b+c+')! }, 100, deps)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
