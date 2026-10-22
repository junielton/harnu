/**
 * T569 (browser pane U2, AC-4) — the `onBeforeRequest` origin check: a `local` or `external` page cannot load a
 * `harnu-page:` script, frame, image or fetch (spec §3.2). Hostile fixtures, including a worker.
 */
import { describe, expect, it } from 'vitest'
import { decidePageRequest, issuerOriginOf } from '../src/main/browser/page-guard'

const HOST = 'f0123456789ab'
const OWN = `harnu-page://${HOST}`
const TARGET = `${OWN}/data.json`
const frame = (origin: string, parent: string | null = null) => ({
  origin,
  parent: parent === null ? null : { origin: parent }
})

describe('the harnu-page origin check', () => {
  it.each(['script', 'image', 'xhr', 'stylesheet', 'font', 'media', 'other'])(
    'lets a page of the SAME folder load a %s',
    (resourceType) => {
      expect(decidePageRequest({ url: TARGET, resourceType, frame: frame(OWN) })).toEqual({
        allow: true
      })
    }
  )

  it.each(['script', 'image', 'xhr', 'stylesheet', 'font', 'media', 'other', 'ping'])(
    'refuses an external page loading our %s',
    (resourceType) => {
      expect(
        decidePageRequest({ url: TARGET, resourceType, frame: frame('https://evil.example') })
      ).toMatchObject({ allow: false, reason: 'foreign-origin' })
    }
  )

  it('refuses a local dev server page too', () => {
    expect(
      decidePageRequest({
        url: TARGET,
        resourceType: 'script',
        frame: frame('http://localhost:5173')
      })
    ).toMatchObject({ allow: false })
  })

  it('refuses a page of ANOTHER folder (each folder is its own origin)', () => {
    expect(
      decidePageRequest({
        url: TARGET,
        resourceType: 'xhr',
        frame: frame('harnu-page://fffffffffffff')
      })
    ).toMatchObject({ allow: false, reason: 'other-folder' })
  })

  it('judges a subFrame navigation by the PARENT frame, not the frame being created', () => {
    expect(
      decidePageRequest({
        url: `${OWN}/frame.html`,
        resourceType: 'subFrame',
        frame: frame('null', 'https://evil.example')
      })
    ).toMatchObject({ allow: false })
    expect(
      decidePageRequest({
        url: `${OWN}/frame.html`,
        resourceType: 'subFrame',
        frame: frame('null', OWN)
      })
    ).toEqual({ allow: true })
    // A subframe with no parent cannot name its issuer.
    expect(
      decidePageRequest({ url: `${OWN}/frame.html`, resourceType: 'subFrame', frame: frame(OWN) })
    ).toMatchObject({ allow: false, reason: 'no-issuer' })
  })

  it('refuses a request with no frame (defence in depth: onBeforeRequest does NOT observe workers, the ticket does)', () => {
    for (const resourceType of ['script', 'xhr', 'other', 'subFrame']) {
      expect(decidePageRequest({ url: TARGET, resourceType, frame: null })).toMatchObject({
        allow: false,
        reason: 'no-issuer'
      })
    }
  })

  it('refuses an opaque (sandboxed or data:) origin', () => {
    expect(
      decidePageRequest({ url: TARGET, resourceType: 'script', frame: frame('null') })
    ).toMatchObject({ allow: false })
  })

  it('leaves a top-level navigation to will-navigate / will-redirect', () => {
    expect(decidePageRequest({ url: TARGET, resourceType: 'mainFrame', frame: null })).toEqual({
      allow: true
    })
  })

  it('does not touch requests for other schemes', () => {
    expect(
      decidePageRequest({ url: 'https://cdn.example/a.js', resourceType: 'script', frame: null })
    ).toEqual({ allow: true })
    expect(decidePageRequest({ url: 'not a url', resourceType: 'script', frame: null })).toEqual({
      allow: true
    })
  })

  it('names the issuer from frame.origin or frame.parent.origin', () => {
    expect(issuerOriginOf({ resourceType: 'script', frame: frame('a', 'b') })).toBe('a')
    expect(issuerOriginOf({ resourceType: 'subFrame', frame: frame('a', 'b') })).toBe('b')
    expect(issuerOriginOf({ resourceType: 'script', frame: null })).toBeNull()
  })
})
