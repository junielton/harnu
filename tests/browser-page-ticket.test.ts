/**
 * T569 delta 1 (F1, AC-4) — the one-shot ticket that gates the `harnu-page:` protocol handler. The origin check in
 * `onBeforeRequest` cannot see a dedicated worker's requests (confirmed live and by the verifier: `importScripts`
 * read a file, and a no-cors fetch was a timing oracle), so the handler serves only what the check ALLOWED.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_TICKETS,
  TICKET_TTL_MS,
  UNTICKETED_BODY,
  UNTICKETED_STATUS,
  createPageTickets,
  normalizePageRequestUrl,
  unticketedHeaders
} from '../src/main/browser/page-ticket'
import { decidePageRequest } from '../src/main/browser/page-guard'

const A = 'harnu-page://f0123456789ab/docs/data.js'
const B = 'harnu-page://f0123456789ab/docs/other.js'

describe('page tickets', () => {
  it('serves exactly what was allowed, once', () => {
    const t = 0
    const tickets = createPageTickets(() => t)
    expect(tickets.redeem(A)).toBe(false) // never allowed: a worker's request
    tickets.issue(A)
    expect(tickets.redeem(B)).toBe(false) // a ticket is for ONE url
    expect(tickets.redeem(A)).toBe(true)
    expect(tickets.redeem(A)).toBe(false) // spent
    expect(tickets.size()).toBe(0)
  })

  it('counts: two allowed requests buy two serves, not three', () => {
    const tickets = createPageTickets(() => 0)
    tickets.issue(A)
    tickets.issue(A)
    expect([tickets.redeem(A), tickets.redeem(A), tickets.redeem(A)]).toEqual([true, true, false])
  })

  it('a ticket expires, so a request cancelled after the check leaves nothing to spend', () => {
    let t = 1000
    const tickets = createPageTickets(() => t)
    tickets.issue(A)
    t += TICKET_TTL_MS - 1
    expect(tickets.redeem(A)).toBe(true)
    tickets.issue(A)
    t += TICKET_TTL_MS
    expect(tickets.redeem(A)).toBe(false)
    expect(tickets.size()).toBe(0)
  })

  it('ignores the fragment (never sent) and refuses what is not a URL', () => {
    const tickets = createPageTickets(() => 0)
    tickets.issue(`${A}#top`)
    expect(tickets.redeem(A)).toBe(true)
    expect(normalizePageRequestUrl('not a url')).toBeNull()
    tickets.issue('not a url')
    expect(tickets.redeem('not a url')).toBe(false)
  })

  it('keeps the query string significant: a ticket for ?a=1 does not serve ?a=2', () => {
    const tickets = createPageTickets(() => 0)
    tickets.issue(`${A}?a=1`)
    expect(tickets.redeem(`${A}?a=2`)).toBe(false)
    expect(tickets.redeem(`${A}?a=1`)).toBe(true)
  })

  it('is bounded: when full it issues nothing more (the request then fails visibly)', () => {
    const tickets = createPageTickets(() => 0, TICKET_TTL_MS, 3)
    for (let i = 0; i < 5; i++) tickets.issue(`${A}?i=${i}`)
    expect(tickets.size()).toBe(3)
    expect(tickets.redeem(`${A}?i=4`)).toBe(false)
    expect(MAX_TICKETS).toBeGreaterThan(100)
  })
})

describe('the worker bypass (the verifier probe, as a model)', () => {
  /**
   * Model of what Electron does: a PAGE request goes through the origin check (and gets a ticket when allowed); a
   * WORKER request skips `onBeforeRequest` and goes straight to the handler.
   */
  function world() {
    const tickets = createPageTickets(() => 0)
    const origin = 'harnu-page://f0123456789ab'
    const check = (url: string, issuerOrigin: string): void => {
      const v = decidePageRequest({
        url,
        resourceType: 'script',
        frame: { origin: issuerOrigin, parent: null }
      })
      if (v.allow) tickets.issue(url)
    }
    return { tickets, check, origin }
  }

  it('an external PAGE is refused by the check, so it never gets a ticket', () => {
    const w = world()
    w.check(A, 'https://evil.example')
    expect(w.tickets.redeem(A)).toBe(false)
  })

  it('an external page’s WORKER skips the check entirely: no ticket, so the handler refuses it', () => {
    const w = world()
    // importScripts(A) / fetch(A, { mode: 'no-cors' }) from a worker: nothing calls `check`.
    expect(w.tickets.redeem(A)).toBe(false)
    expect(w.tickets.redeem(B)).toBe(false)
  })

  it('our own page is served', () => {
    const w = world()
    w.check(A, w.origin)
    expect(w.tickets.redeem(A)).toBe(true)
  })

  it('every unticketed request gets the SAME response, whether the file exists or not', () => {
    // The handler builds it without any I/O from constants: nothing about the URL can show in it.
    const init = (): string =>
      JSON.stringify([UNTICKETED_STATUS, UNTICKETED_BODY, unticketedHeaders("default-src 'self'")])
    expect(init()).toBe(init())
    expect(UNTICKETED_STATUS).toBe(404)
    expect(UNTICKETED_BODY).not.toMatch(/f0123456789ab|data\.js|exist|jail|denied/i)
  })
})
