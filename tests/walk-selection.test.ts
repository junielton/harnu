// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClickGuard, paneHasSelection } from '../src/renderer/src/lib/walk-selection'

/**
 * BUG-292: the walk pane's content is selectable, so two things must hold while the operator drags over it:
 * a letter typed over a selection is not an outcome (AC-6, the key map reads `paneHasSelection`), and a drag
 * that starts on plain text and ends on a link, a copy button or Done must not press it (AC-2, AC-7).
 */

let root: HTMLElement

beforeEach(() => {
  document.body.innerHTML = `
    <div id="root">
      <p id="text">Run curl http://localhost:3000 and look at the rows</p>
      <span data-walk-link><button id="open" data-walk-chip>PR 101</button>
        <button id="copy" data-walk-chip>copy</button></span>
      <button id="done" data-walk-done>Done</button>
      <ul role="listbox"><li id="opt" role="option">Run 2</li></ul>
      <input id="field" value="a typed failure line" />
    </div>
    <p id="outside">outside the pane</p>`
  root = document.getElementById('root') as HTMLElement
})
afterEach(() => {
  window.getSelection()?.removeAllRanges()
  document.body.innerHTML = ''
})

function select(el: Element, from = 0, to?: number): void {
  const node = el.firstChild as Text
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to ?? node.length)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

describe('paneHasSelection', () => {
  it('is false with no selection and with a collapsed caret', () => {
    expect(paneHasSelection(root)).toBe(false)
    select(document.getElementById('text')!, 3, 3)
    expect(paneHasSelection(root)).toBe(false)
  })

  it('is true for selected text inside the pane', () => {
    select(document.getElementById('text')!, 4, 8)
    expect(paneHasSelection(root)).toBe(true)
  })

  it('ignores a selection that lives outside the pane', () => {
    select(document.getElementById('outside')!)
    expect(paneHasSelection(root)).toBe(false)
  })

  it('ignores a selection made inside a field: the field keeps its own keys', () => {
    const field = document.getElementById('field') as HTMLInputElement
    field.focus()
    field.setSelectionRange(2, 8)
    expect(paneHasSelection(root)).toBe(false)
  })

  it('is false without a root', () => {
    expect(paneHasSelection(null)).toBe(false)
  })
})

describe('click guard: a drag is not a click (AC-2, AC-7)', () => {
  const click = (guard: ReturnType<typeof createClickGuard>, id: string, detail = 1): boolean =>
    guard.shouldSwallow({ target: document.getElementById(id), detail })

  it('swallows a click on a link chip when the press began on plain text', () => {
    const g = createClickGuard()
    g.press(document.getElementById('text'))
    expect(click(g, 'open')).toBe(true)
  })

  it('swallows a click on a copy button and on Done when the press began on plain text', () => {
    const g = createClickGuard()
    g.press(document.getElementById('text'))
    expect(click(g, 'copy')).toBe(true)
    g.press(document.getElementById('text'))
    expect(click(g, 'done')).toBe(true)
  })

  it('swallows a click on a button when the press began on another button', () => {
    const g = createClickGuard()
    g.press(document.getElementById('done'))
    expect(click(g, 'copy')).toBe(true)
  })

  it('lets a real click through: press and release on the same button', () => {
    const g = createClickGuard()
    g.press(document.getElementById('done'))
    expect(click(g, 'done')).toBe(false)
  })

  it('lets a click through when the press was on the chip icon inside the same button', () => {
    const g = createClickGuard()
    const icon = document.createElement('i')
    document.getElementById('open')!.append(icon)
    g.press(icon)
    expect(click(g, 'open')).toBe(false)
  })

  it('lets a keyboard click through (Enter on a focused button has no press and detail 0)', () => {
    const g = createClickGuard()
    expect(click(g, 'done', 0)).toBe(false)
    // a stale press that never became a click must not eat a later keyboard click
    g.press(document.getElementById('text'))
    expect(click(g, 'done', 0)).toBe(false)
  })

  it('forgets the press once its click arrived: the next press decides', () => {
    const g = createClickGuard()
    g.press(document.getElementById('text'))
    expect(click(g, 'open')).toBe(true)
    g.press(document.getElementById('open'))
    expect(click(g, 'open')).toBe(false)
  })

  it('treats a run-selector option as a control too', () => {
    const g = createClickGuard()
    g.press(document.getElementById('text'))
    expect(click(g, 'opt')).toBe(true)
  })

  it('never swallows a click that is not on a control', () => {
    const g = createClickGuard()
    g.press(document.getElementById('text'))
    expect(click(g, 'text')).toBe(false)
  })
})
