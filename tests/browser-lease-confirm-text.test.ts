/**
 * T571 (browser pane U4, AC-2) — the lease confirm disclosure (spec §7.1): shows the pane, the origin, the verb and
 * an escaped, length-stated preview; the page and the agent cannot make it say something else.
 */
import { describe, it, expect } from 'vitest'
import {
  PREVIEW_MAX_CHARS,
  describeFirstAction,
  leaseConfirmPrompt,
  type LeaseConfirmFacts
} from '../src/main/browser/lease-confirm-text'

const facts = (over: Partial<LeaseConfirmFacts> = {}): LeaseConfirmFacts => ({
  op: 'browser_eval',
  args: { expression: 'document.title' },
  paneName: 'example.com',
  shortPaneId: 'bp-3f9a21',
  openedBy: 'agent',
  host: 'example.com',
  originClass: 'external',
  folder: '~/work/app',
  ...over
})

describe('leaseConfirmPrompt', () => {
  it('names the pane, who opened it, the site and class, the folder and the first action', () => {
    const p = leaseConfirmPrompt(facts())
    expect(p).toContain('Pane: example.com (bp-3f9a21)')
    expect(p).toContain('Opened by: agent')
    expect(p).toContain('Site: example.com (external)')
    expect(p).toContain('Folder: ~/work/app')
    expect(p).toContain('eval (14 characters): "document.title"')
  })

  it('says an Allow performs nothing, the 10-minute and 5-minute rules, and that typing runs as the operator', () => {
    const p = leaseConfirmPrompt(facts())
    expect(p).toContain('Nothing happens when you Allow')
    expect(p).toContain('while it stays on example.com')
    expect(p).toContain('no agent write for 10 minutes')
    expect(p).toContain('If the pane moves to another site, this approval ends')
    expect(p).toContain('Deny blocks writes to this pane for 5 minutes')
    expect(p).toContain('What an agent types runs as you on this page.')
  })

  it('spells out invisible and direction-changing characters so the text cannot hide its length', () => {
    const p = describeFirstAction(facts({ args: { expression: 'a‮b​c\n"x"' } }))
    expect(p).toContain('\\u{202e}')
    expect(p).toContain('\\u{200b}')
    expect(p).toContain('\\n')
    expect(p).toContain('\\"x\\"')
    expect(p).not.toContain('‮')
  })

  it('cuts a long expression at 200 characters and states its true length', () => {
    const p = describeFirstAction(facts({ args: { expression: 'x'.repeat(500) } }))
    expect(p).toContain('(500 characters)')
    expect(p).toContain('…')
    expect(p.length).toBeLessThan(PREVIEW_MAX_CHARS + 80)
  })

  it('shows what a click targets, resolved by main (role and name), and what a type types and where', () => {
    expect(
      describeFirstAction(
        facts({
          op: 'browser_click',
          args: { ref: 's4e12' },
          target: { role: 'button', name: 'Pay now' }
        })
      )
    ).toBe('click button "Pay now" (s4e12)')
    expect(describeFirstAction(facts({ op: 'browser_click', args: { ref: 's4e12' } }))).toBe(
      'click element s4e12'
    )
    expect(
      describeFirstAction(
        facts({
          op: 'browser_type',
          args: { ref: 's1e2', text: 'hunter2', submit: true },
          target: { role: 'textbox', name: 'Password' }
        })
      )
    ).toBe('type (7 characters): "hunter2" into textbox "Password" (s1e2), then press Enter')
  })

  it('summarises fill, press, navigate and network without trusting their text', () => {
    expect(
      describeFirstAction(
        facts({
          op: 'browser_fill',
          args: {
            fields: [
              { ref: 'a', value: 'v1' },
              { ref: 'b', value: 'v2' }
            ]
          }
        })
      )
    ).toBe('fill 2 fields; the first value (2 characters): "v1"')
    expect(
      describeFirstAction(facts({ op: 'browser_press', args: { keys: ['Ctrl+A', 'Enter'] } }))
    ).toBe('press 2 keys: Ctrl+A, Enter')
    expect(
      describeFirstAction(
        facts({ op: 'browser_navigate', args: { url: 'https://evil.test/x?q=1' } })
      )
    ).toBe('go to evil.test')
    expect(describeFirstAction(facts({ op: 'browser_network', args: { action: 'start' } }))).toBe(
      'start network traffic recording'
    )
  })

  it('scrubs secrets in what it previews, before the cut, and still states the true length', () => {
    const scrub = (t: string): string => t.replace(/Bearer [A-Za-z0-9]+/g, '<redacted>')
    const secret = 'fetch(u,{h:"Bearer abcdefghijklmnop0123456789"})'
    const p = describeFirstAction(facts({ args: { expression: secret }, scrub }))
    expect(p).not.toContain('abcdefghijklmnop0123456789')
    expect(p).toContain('<redacted>')
    expect(p).toContain(`(${secret.length} characters)`)
    expect(
      describeFirstAction(
        facts({
          op: 'browser_click',
          args: { ref: 's1e1' },
          target: { role: 'button', name: 'Bearer zzzzzzzz1234' },
          scrub
        })
      )
    ).not.toContain('zzzzzzzz1234')
  })

  it('handles an operator pane with nothing loaded', () => {
    const p = leaseConfirmPrompt(facts({ openedBy: 'operator', host: '', originClass: 'blank' }))
    expect(p).toContain('Opened by: operator')
    expect(p).toContain('Site: (nothing loaded)')
  })
})
