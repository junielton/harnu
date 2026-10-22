/**
 * T569 delta 1 (F2) — an offline page pane may not navigate away or open a popup: a CSP does not stop
 * `location = 'http://x/?d=…'`, so without this a read-only worker that patches an `<img onerror>` into a panel had
 * an exfiltration channel.
 */
import { describe, expect, it } from 'vitest'
import { decidePageNavigation, isPageUrl, popupAllowedFrom } from '../src/main/browser/page-egress'

const PAGE = 'harnu-page://f0123456789ab/docs/status.html'
const SAME = 'harnu-page://f0123456789ab/docs/other.html'
const OTHER_FOLDER = 'harnu-page://fffffffffffff/docs/status.html'

describe('an OFFLINE page pane (network off)', () => {
  const go = (targetUrl: string) =>
    decidePageNavigation({ currentUrl: PAGE, targetUrl, allowNetwork: false }).allow

  it('may follow a link to another file of its own folder, and about:blank', () => {
    expect(go(SAME)).toBe(true)
    expect(go(`${SAME}#section`)).toBe(true)
    expect(go('about:blank')).toBe(true)
  })

  it.each([
    ['an exfiltration image onerror', 'http://attacker.example/?d=SECRET'],
    ['https', 'https://attacker.example/x'],
    ['localhost (a dev server is still the network)', 'http://localhost:5173/'],
    ['another folder host', OTHER_FOLDER],
    ['a data: URL', 'data:text/html,<script>fetch(1)</script>'],
    ['a blob: URL', 'blob:harnu-page://f0123456789ab/uuid'],
    ['javascript:', 'javascript:fetch(1)'],
    ['ws', 'ws://attacker.example/'],
    ['an unparseable target', 'not a url']
  ])('may not navigate to %s', (_label, target) => {
    expect(go(target)).toBe(false)
  })

  it('may not open any popup', () => {
    expect(popupAllowedFrom({ currentUrl: PAGE, allowNetwork: false })).toBe(false)
  })
})

describe('everything else is left to the other layers', () => {
  it('a pane the operator switched network on for', () => {
    expect(
      decidePageNavigation({
        currentUrl: PAGE,
        targetUrl: 'https://cdn.example/',
        allowNetwork: true
      }).allow
    ).toBe(true)
    expect(popupAllowedFrom({ currentUrl: PAGE, allowNetwork: true })).toBe(true)
  })

  it('a pane that is not showing a page (a dev server, an external site, blank)', () => {
    for (const currentUrl of [
      'http://localhost:3000/',
      'https://example.com/',
      'about:blank',
      ''
    ]) {
      expect(
        decidePageNavigation({ currentUrl, targetUrl: 'https://x.example/', allowNetwork: false })
          .allow
      ).toBe(true)
      expect(popupAllowedFrom({ currentUrl, allowNetwork: false })).toBe(true)
    }
  })

  it('knows a page URL', () => {
    expect(isPageUrl(PAGE)).toBe(true)
    expect(isPageUrl('https://example.com/')).toBe(false)
    expect(isPageUrl('nope')).toBe(false)
  })
})
