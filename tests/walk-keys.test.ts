import { describe, it, expect } from 'vitest'
import {
  DONE_DEBOUNCE_MS,
  classifyTarget,
  isDoneDebounced,
  keepPaneFocusOnPointer,
  mapWalkKey,
  type KeyContext,
  type KeyLike
} from '../src/renderer/src/lib/walk-keys'

/** A DOM-ish element: only the bits the module reads (`closest`, `tagName`, `isContentEditable`). */
function el(
  kind: 'pane' | 'done' | 'button' | 'chip' | 'link' | 'input' | 'textarea' | 'editable'
) {
  const tag =
    kind === 'input' ? 'INPUT' : kind === 'textarea' ? 'TEXTAREA' : kind === 'link' ? 'A' : 'DIV'
  const match: Record<string, boolean> = {
    '[data-walk-done]': kind === 'done',
    'button, [role="button"]': kind === 'done' || kind === 'button' || kind === 'chip',
    '[data-walk-chip]': kind === 'chip',
    'a[href], [data-walk-link]': kind === 'link'
  }
  return {
    tagName: tag,
    isContentEditable: kind === 'editable',
    closest: (sel: string) => (match[sel] ? { sel } : null)
  }
}

const key = (
  k: string,
  over: Partial<KeyLike> = {},
  kind: Parameters<typeof el>[0] = 'pane'
): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  target: el(kind),
  ...over
})

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  mode: 'check',
  primary: 'done',
  available: new Set(['done', 'failed', 'back', 'skip', 'explain']),
  lightbox: false,
  roadmapOpen: false,
  formOpen: false,
  ...over
})

describe('walk keys', () => {
  it('maps each key, debounces Done and ignores keys in a field', () => {
    // Enter is Done on the pane and on the Done button
    expect(mapWalkKey(key('Enter'), ctx())).toEqual({ action: 'done' })
    expect(mapWalkKey(key('Enter', {}, 'done'), ctx())).toEqual({ action: 'done' })

    // Enter keeps its own meaning on a chip, another button and a link
    expect(mapWalkKey(key('Enter', {}, 'chip'), ctx())).toBeNull()
    expect(mapWalkKey(key('Enter', {}, 'button'), ctx())).toBeNull()
    expect(mapWalkKey(key('Enter', {}, 'link'), ctx())).toBeNull()

    // the primary follows the screen: Start with 1 on the roadmap, Try again on a retry
    expect(mapWalkKey(key('Enter'), ctx({ mode: 'roadmap', primary: 'start' }))).toEqual({
      action: 'start'
    })
    expect(
      mapWalkKey(key('Enter'), ctx({ primary: 'try-again', available: new Set(['try-again']) }))
    ).toEqual({ action: 'try-again' })

    // the shortcuts: F, B / Left, S, E, L
    expect(mapWalkKey(key('f'), ctx())).toEqual({ action: 'failed' })
    expect(mapWalkKey(key('F'), ctx())).toEqual({ action: 'failed' })
    expect(mapWalkKey(key('b'), ctx())).toEqual({ action: 'back' })
    expect(mapWalkKey(key('ArrowLeft'), ctx())).toEqual({ action: 'back' })
    expect(mapWalkKey(key('s'), ctx())).toEqual({ action: 'skip' })
    expect(mapWalkKey(key('e'), ctx())).toEqual({ action: 'explain' })
    expect(mapWalkKey(key('l'), ctx())).toEqual({ action: 'roadmap' })

    // a shortcut acts only when its outcome is on screen (awaiting shows none)
    const awaiting = ctx({ primary: null, available: new Set() })
    expect(mapWalkKey(key('Enter'), awaiting)).toBeNull()
    expect(mapWalkKey(key('f'), awaiting)).toBeNull()
    expect(mapWalkKey(key('s'), awaiting)).toBeNull()
    // but L (the roadmap) is a way to look, never an outcome
    expect(mapWalkKey(key('l'), awaiting)).toEqual({ action: 'roadmap' })

    // a modifier turns a shortcut into the browser's or the app's own
    expect(mapWalkKey(key('f', { ctrlKey: true }), ctx())).toBeNull()
    expect(mapWalkKey(key('s', { metaKey: true }), ctx())).toBeNull()
    expect(mapWalkKey(key('b', { altKey: true }), ctx())).toBeNull()
    // a held key does not repeat an outcome
    expect(mapWalkKey(key('Enter', { repeat: true }), ctx())).toBeNull()
    expect(mapWalkKey(key('f', { repeat: true }), ctx())).toBeNull()

    // Esc closes what is open, innermost first
    expect(mapWalkKey(key('Escape'), ctx({ lightbox: true, roadmapOpen: true }))).toEqual({
      action: 'close-lightbox'
    })
    expect(mapWalkKey(key('Escape'), ctx({ roadmapOpen: true }))).toEqual({
      action: 'close-roadmap'
    })
    expect(mapWalkKey(key('Escape'), ctx({ mode: 'failed-form', formOpen: true }))).toEqual({
      action: 'close-form'
    })
    expect(mapWalkKey(key('Escape'), ctx())).toBeNull()

    // in a field every key is the field's: only Enter sends, and only in the failure form
    for (const kind of ['input', 'textarea', 'editable'] as const) {
      for (const k of ['f', 'b', 's', 'e', 'l', 'ArrowLeft', 'Escape']) {
        const c = ctx({ mode: 'failed-form', formOpen: true, primary: 'send' })
        expect(mapWalkKey(key(k, {}, kind), c)?.action).not.toBe('failed')
        expect(mapWalkKey(key(k, {}, kind), c)?.action).not.toBe('back')
      }
    }
    expect(
      mapWalkKey(
        key('Enter', {}, 'input'),
        ctx({ mode: 'failed-form', formOpen: true, primary: 'send' })
      )
    ).toEqual({ action: 'send' })
    // Enter in a field outside the failure form is not ours
    expect(mapWalkKey(key('Enter', {}, 'input'), ctx())).toBeNull()
    // Esc inside the failure form's field still leaves the form: it is how you get out of a field
    expect(
      mapWalkKey(key('Escape', {}, 'input'), ctx({ mode: 'failed-form', formOpen: true }))
    ).toEqual({ action: 'close-form' })

    // Done is ignored for 400 ms after a new check is served, and works after
    expect(DONE_DEBOUNCE_MS).toBe(400)
    expect(isDoneDebounced(1_000, 1_000)).toBe(true)
    expect(isDoneDebounced(1_000, 1_399)).toBe(true)
    expect(isDoneDebounced(1_000, 1_400)).toBe(false)
    expect(isDoneDebounced(null, 1_000)).toBe(false)
  })

  it('classifies the target and keeps the pane focused on a pointer click on a chip', () => {
    expect(classifyTarget(el('chip'))).toBe('chip')
    expect(classifyTarget(el('link'))).toBe('link')
    expect(classifyTarget(el('done'))).toBe('done')
    expect(classifyTarget(el('button'))).toBe('button')
    expect(classifyTarget(el('input'))).toBe('field')
    expect(classifyTarget(el('textarea'))).toBe('field')
    expect(classifyTarget(el('editable'))).toBe('field')
    expect(classifyTarget(el('pane'))).toBe('pane')
    expect(classifyTarget(null)).toBe('pane')

    let prevented = 0
    const down = (kind: Parameters<typeof el>[0]): void => {
      keepPaneFocusOnPointer({ target: el(kind), preventDefault: () => prevented++ })
    }
    down('chip')
    expect(prevented).toBe(1) // the chip's click still fires, the focus does not leave the pane
    down('link')
    expect(prevented).toBe(2)
    down('input') // a field must take focus
    expect(prevented).toBe(2)
    down('pane')
    expect(prevented).toBe(2)
  })
})
