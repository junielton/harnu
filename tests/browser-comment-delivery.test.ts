import { describe, expect, it } from 'vitest'
import { createPinStore } from '../src/main/browser/comment-pins'
import {
  createCommentDelivery,
  type CommentDeliveryDeps,
  type CommentPaneFacts
} from '../src/main/browser/comment-delivery'
import type { PickedPayload } from '../src/shared/browser-comment'

const picked = (selector: string): PickedPayload => ({
  selector,
  tag: 'div',
  outerHTML: '<div></div>',
  component: null,
  styles: {},
  rect: { x: 0, y: 0, width: 10, height: 10 },
  viewport: { width: 100, height: 100 }
})

function rig(
  over: { pane?: Partial<CommentPaneFacts>; dispatch?: (c: string, p: unknown) => unknown } = {}
) {
  let id = 0
  const pins = createPinStore({ now: () => 1, newId: () => `i${++id}` })
  const calls: Array<[string, unknown]> = []
  const audits: Array<{ verdict: string; result: string }> = []
  const clipboard: string[] = []
  const pane: CommentPaneFacts = {
    folder: '/w/f',
    name: 'Checkout',
    ownerSessionId: 'owner-1',
    disconnected: false,
    ...over.pane
  }
  const deps: CommentDeliveryDeps = {
    now: () => 50_000,
    pins,
    pane: (p) => (p === 'p1' ? pane : undefined),
    delivery: {
      dispatch: async (c, p) => {
        calls.push([c, p])
        return over.dispatch ? over.dispatch(c, p) : { delivered: true, sessionId: 'owner-1' }
      },
      waitForSessionReady: async () => true,
      delay: async () => undefined
    },
    copyToClipboard: (t) => void clipboard.push(t),
    audit: (e) => void audits.push({ verdict: e.verdict, result: e.result })
  }
  const add = (selector: string, comment: string): string => {
    const r = pins.add('p1', picked(selector), 'https://a.test/x?y=1', 'https://a.test/x')
    if (!r.ok) throw new Error('unreachable')
    pins.saveDraft('p1', r.pin.id, comment)
    return r.pin.id
  }
  return { delivery: createCommentDelivery(deps), pins, calls, audits, clipboard, add }
}

describe('submit', () => {
  it('delivers a single comment to the owner through session.userTurn (source overlay) and marks it sent', async () => {
    const r = rig()
    const id = r.add('#a', 'make it squarer')
    const res = await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })
    expect(res).toEqual({ ok: true, delivered: true, count: 1, sessionId: 'owner-1', woke: false })
    expect(r.calls).toHaveLength(1)
    const [cmd, turn] = r.calls[0] as [
      string,
      { sessionId: string; folder: string; text: string; source: string }
    ]
    expect(cmd).toBe('session.userTurn')
    expect(turn.sessionId).toBe('owner-1')
    expect(turn.folder).toBe('/w/f')
    expect(turn.source).toBe('overlay')
    expect(turn.text.startsWith('[harnu-comment] Checkout — 1 comment')).toBe(true)
    expect(turn.text).toContain('#1 comment: "make it squarer"')
    expect(r.pins.list('p1')[0]!.state).toBe('sent')
  })

  it('batches every draft into ONE turn, numbered in pin order', async () => {
    const r = rig()
    r.add('#b', 'second')
    r.add('#a', 'first')
    const res = await r.delivery.submit({ paneId: 'p1', which: 'drafts', sessionId: null })
    expect(res).toMatchObject({ ok: true, delivered: true, count: 2 })
    expect(r.calls).toHaveLength(1)
    const text = (r.calls[0]![1] as { text: string }).text
    expect(text).toContain('— 2 comments')
    expect(text.indexOf('#1 comment: "second"')).toBeLessThan(text.indexOf('#2 comment: "first"'))
  })

  it('prefers the picker destination over the owner', async () => {
    const r = rig({ dispatch: () => ({ delivered: true, sessionId: 'picked-9' }) })
    const id = r.add('#a', 'x')
    await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: 'picked-9' })
    expect((r.calls[0]![1] as { sessionId: string }).sessionId).toBe('picked-9')
  })

  it('uses the folder selected session (sessionId null) when the pane has no owner', async () => {
    const r = rig({ pane: { ownerSessionId: null } })
    const id = r.add('#a', 'x')
    await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })
    expect((r.calls[0]![1] as { sessionId: string | null }).sessionId).toBeNull()
  })

  it('wakes a parked session headlessly, then delivers', async () => {
    let asked = 0
    const r = rig({
      dispatch: (c) => {
        if (c === 'session.wake') return { ok: true }
        return asked++ === 0
          ? { parked: true, sessionId: 'owner-1' }
          : { delivered: true, sessionId: 'owner-1' }
      }
    })
    const id = r.add('#a', 'x')
    const res = await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })
    expect(res).toMatchObject({ ok: true, delivered: true, woke: true })
    expect(r.calls.map(([c]) => c)).toEqual([
      'session.userTurn',
      'session.wake',
      'session.userTurn'
    ])
    expect(r.audits[0]!.result).toContain('COMMENT_DELIVERED_AFTER_WAKE')
  })

  it('copies to the clipboard when there is no session at all, and marks the pins sent', async () => {
    const r = rig({ dispatch: () => ({ held: true }) })
    const id = r.add('#a', 'please')
    const res = await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })
    expect(res).toEqual({ ok: true, delivered: false, held: true, count: 1, copied: true })
    expect(r.clipboard).toHaveLength(1)
    expect(r.clipboard[0]).toContain('#1 comment: "please"')
    expect(r.pins.list('p1')[0]!.state).toBe('sent')
  })

  it('keeps the drafts when delivery fails', async () => {
    const r = rig({ dispatch: () => null })
    const id = r.add('#a', 'x')
    const res = await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })
    expect(res).toMatchObject({ ok: false, error: 'DELIVERY_FAILED' })
    expect(r.pins.list('p1')[0]!.state).toBe('draft')
    expect(r.audits[0]!.verdict).toBe('deny')
  })

  it('refuses before anything is sent: an unknown pane and a disconnected pane', async () => {
    const r = rig({ pane: { disconnected: true } })
    const id = r.add('#a', 'x')
    expect(await r.delivery.submit({ paneId: 'nope', which: [id], sessionId: null })).toEqual({
      ok: false,
      error: 'PANE_NOT_FOUND'
    })
    expect(await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })).toEqual({
      ok: false,
      error: 'BROWSER_DISCONNECTED'
    })
    expect(r.calls).toHaveLength(0)
    expect(r.audits[0]!.result).toContain('BROWSER_DISCONNECTED')
  })

  it('has nothing to send for a sent, empty or unknown pin', async () => {
    const r = rig()
    const empty = r.pins.add('p1', picked('#e'), 'https://a.test/', 'https://a.test/')
    if (!empty.ok) throw new Error('unreachable')
    expect(
      await r.delivery.submit({ paneId: 'p1', which: [empty.pin.id], sessionId: null })
    ).toEqual({
      ok: false,
      error: 'NOTHING_TO_SEND'
    })
    expect(await r.delivery.submit({ paneId: 'p1', which: 'drafts', sessionId: null })).toEqual({
      ok: false,
      error: 'NOTHING_TO_SEND'
    })
  })

  it('does not send the same pin twice when two submits overlap', async () => {
    let release: (v: unknown) => void = () => undefined
    const gate = new Promise((res) => (release = res))
    const r = rig({ dispatch: () => gate })
    const id = r.add('#a', 'x')
    const first = r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })
    const second = await r.delivery.submit({ paneId: 'p1', which: [id], sessionId: null })
    expect(second).toEqual({ ok: false, error: 'NOTHING_TO_SEND' })
    release({ delivered: true, sessionId: 'owner-1' })
    expect(await first).toMatchObject({ ok: true, delivered: true })
    expect(r.calls).toHaveLength(1)
  })

  it('audits batch size, destination and source — never the comment text', async () => {
    const r = rig()
    r.add('#a', 'SECRET OPERATOR WORDS')
    r.add('#b', 'MORE SECRET WORDS')
    await r.delivery.submit({ paneId: 'p1', which: 'drafts', sessionId: null })
    expect(r.audits).toHaveLength(1)
    const line = r.audits[0]!.result
    expect(line).toContain('batch=2')
    expect(line).toContain('destination=owner-1')
    expect(line).toContain('source=overlay')
    expect(line).not.toMatch(/SECRET|MORE/)
  })
})
