import { describe, expect, it } from 'vitest'
import { MAX_PINS_PER_PANE, type PickedPayload } from '../src/shared/browser-comment'
import {
  createPinStore,
  type PinPersistence,
  type PinRecord
} from '../src/main/browser/comment-pins'

const picked = (selector = '#a', over: Partial<PickedPayload> = {}): PickedPayload => ({
  selector,
  tag: 'div',
  outerHTML: '<div id="a"></div>',
  component: null,
  styles: { color: 'red' },
  rect: { x: 1, y: 2, width: 30, height: 40 },
  viewport: { width: 1280, height: 800 },
  ...over
})

function store(persistence?: PinPersistence) {
  let t = 1000
  let id = 0
  return createPinStore({
    now: () => t++,
    newId: () => `id${++id}`,
    ...(persistence ? { persistence } : {})
  })
}

const URL_A = 'https://app.test/checkout?x=1'

describe('pin numbering and states', () => {
  it('numbers pins in order, as drafts, and keeps the numbers after a send', () => {
    const s = store()
    const a = s.add('p1', picked('#a'), URL_A, 'https://app.test/checkout')
    const b = s.add('p1', picked('#b'), URL_A, 'https://app.test/checkout')
    expect(a.ok && a.pin.n).toBe(1)
    expect(b.ok && b.pin.n).toBe(2)
    if (!a.ok || !b.ok) throw new Error('unreachable')
    s.markSent('p1', [a.pin.id])
    const c = s.add('p1', picked('#c'), URL_A, 'x')
    expect(c.ok && c.pin.n).toBe(3)
    expect(s.list('p1').map((p) => [p.n, p.state])).toEqual([
      [1, 'sent'],
      [2, 'draft'],
      [3, 'draft']
    ])
  })

  it('numbers panes independently', () => {
    const s = store()
    s.add('p1', picked(), URL_A, 'u')
    const other = s.add('p2', picked(), URL_A, 'u')
    expect(other.ok && other.pin.n).toBe(1)
  })

  it('refuses a draft edit once a pin is sent, and an unknown id', () => {
    const s = store()
    const a = s.add('p1', picked(), URL_A, 'u')
    if (!a.ok) throw new Error('unreachable')
    expect(s.saveDraft('p1', a.pin.id, 'text')).toBe(true)
    s.markSent('p1', [a.pin.id])
    expect(s.saveDraft('p1', a.pin.id, 'again')).toBe(false)
    expect(s.saveDraft('p1', 'nope', 'x')).toBe(false)
  })

  it('caps the pins per pane', () => {
    const s = store()
    for (let i = 0; i < MAX_PINS_PER_PANE; i++) s.add('p1', picked(`#n${i}`), URL_A, 'u')
    expect(s.add('p1', picked('#x'), URL_A, 'u')).toEqual({ ok: false, reason: 'PIN_LIMIT' })
  })

  it('drafts() lists only saved, non-empty drafts in pin order', () => {
    const s = store()
    const a = s.add('p1', picked('#a'), URL_A, 'u')
    const b = s.add('p1', picked('#b'), URL_A, 'u')
    s.add('p1', picked('#c'), URL_A, 'u') // never given text
    if (!a.ok || !b.ok) throw new Error('unreachable')
    s.saveDraft('p1', b.pin.id, 'second')
    s.saveDraft('p1', a.pin.id, 'first')
    expect(s.drafts('p1').map((p) => p.comment)).toEqual(['first', 'second'])
  })

  it('removes a pin', () => {
    const s = store()
    const a = s.add('p1', picked(), URL_A, 'u')
    if (!a.ok) throw new Error('unreachable')
    expect(s.remove('p1', a.pin.id)).toBe(true)
    expect(s.remove('p1', a.pin.id)).toBe(false)
    expect(s.list('p1')).toEqual([])
  })
})

describe('batch directories', () => {
  it('keeps one batch id while drafts wait and starts a new one once all are sent', () => {
    const s = store()
    const first = s.batchId('p1')
    const a = s.add('p1', picked('#a'), URL_A, 'u')
    const b = s.add('p1', picked('#b'), URL_A, 'u')
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.pin.batchId).toBe(first)
    expect(b.pin.batchId).toBe(first)
    s.markSent('p1', [a.pin.id])
    expect(s.batchId('p1')).toBe(first) // b is still a draft in the same directory
    s.markSent('p1', [b.pin.id])
    expect(s.batchId('p1')).not.toBe(first)
    const c = s.add('p1', picked('#c'), URL_A, 'u')
    expect(c.ok && c.pin.batchId).toBe(s.batchId('p1'))
  })
})

describe('pins follow the origin (spec §8.4)', () => {
  it('shows a pin only while the page is on the origin it was made on, and again on return', () => {
    const s = store()
    s.add('p1', picked('#a'), 'https://app.test/checkout?x=1', 'u')
    expect(s.guestPins('p1', 'https://app.test/cart').map((p) => p.selector)).toEqual(['#a'])
    expect(s.guestPins('p1', 'https://other.test/cart')).toEqual([])
    expect(s.guestPins('p1', 'http://app.test/cart')).toEqual([]) // a different scheme is a different origin
    expect(s.guestPins('p1', 'https://app.test/x').map((p) => p.selector)).toEqual(['#a'])
  })

  it('carries no comment text to the guest', () => {
    const s = store()
    const a = s.add('p1', picked('#a'), URL_A, 'u')
    if (!a.ok) throw new Error('unreachable')
    s.saveDraft('p1', a.pin.id, 'private words')
    const guest = JSON.stringify(s.guestPins('p1', URL_A))
    expect(guest).not.toContain('private words')
    expect(Object.keys(s.guestPins('p1', URL_A)[0]!).sort()).toEqual([
      'id',
      'n',
      'rect',
      'selector',
      'state'
    ])
  })

  it('keeps the last reported rect so a detached pin draws where it was', () => {
    const s = store()
    const a = s.add('p1', picked('#a'), URL_A, 'u')
    if (!a.ok) throw new Error('unreachable')
    s.updateRects('p1', {
      [a.pin.id]: { x: 5, y: 6, width: 7, height: 8 },
      ghost: { x: 0, y: 0, width: 1, height: 1 }
    })
    expect(s.guestPins('p1', URL_A)[0]!.rect).toEqual({ x: 5, y: 6, width: 7, height: 8 })
  })
})

describe('persistence seam (U7)', () => {
  it('loads a pane once and hands every change to save', () => {
    const saved: PinRecord[][] = []
    const seed: PinRecord = {
      id: 'old',
      n: 4,
      state: 'draft',
      origin: 'https://app.test',
      url: 'https://app.test/',
      selector: '#old',
      tag: 'div',
      html: '',
      component: null,
      styles: {},
      rect: { x: 0, y: 0, width: 1, height: 1 },
      cropPath: null,
      comment: 'kept',
      batchId: 'oldbatch',
      createdAt: 1
    }
    let loads = 0
    const s = store({
      load: () => (loads++, [seed]),
      save: (_p, pins) => void saved.push(pins)
    })
    expect(s.list('p1').map((p) => p.id)).toEqual(['old'])
    expect(s.batchId('p1')).toBe('oldbatch')
    const b = s.add('p1', picked('#b'), URL_A, 'u')
    expect(b.ok && b.pin.n).toBe(5)
    s.list('p1')
    expect(loads).toBe(1)
    expect(saved.length).toBe(1)
    expect(saved[0]!.map((p) => p.n)).toEqual([4, 5])
  })

  it('forget drops a pane', () => {
    const s = store()
    s.add('p1', picked(), URL_A, 'u')
    s.forget('p1')
    expect(s.list('p1')).toEqual([])
  })
})

describe('views', () => {
  it('summarises a pin for the chrome without the page html itself', () => {
    const s = store()
    const a = s.add('p1', picked('#a', { component: 'src/A.vue:3' }), URL_A, 'u')
    if (!a.ok) throw new Error('unreachable')
    s.setCrop('p1', a.pin.id, '.harnu/out/browser/comments/x/1.png')
    expect(s.views('p1')).toEqual([
      {
        id: a.pin.id,
        n: 1,
        state: 'draft',
        selector: '#a',
        component: 'src/A.vue:3',
        styleCount: 1,
        hasCrop: true,
        hasHtml: true,
        comment: ''
      }
    ])
  })
})
