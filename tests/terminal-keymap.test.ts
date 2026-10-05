import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { installTerminalKeymap } from '../src/renderer/src/lib/terminalKeymap'

/**
 * Regression coverage for the focus-jump bug: an intercepted chord (e.g.
 * `Shift+Enter`) must `stopPropagation()` so the keydown never reaches the
 * window-level shortcut layer (`useMagicKeys`), where the global `Enter`
 * binding (`sidebar.cursor.activate`) would otherwise fire and switch the
 * visible session out from under the terminal.
 *
 * The keymap only reads `e.type` / `e.code` / modifier flags and calls
 * `preventDefault` / `stopPropagation`, so a plain spy object stands in for a
 * real `KeyboardEvent` — no jsdom needed.
 */

type Handler = (e: KeyboardEvent) => boolean

function fakeTerminal(): { term: Terminal; getHandler: () => Handler } {
  let handler: Handler = () => true
  const term = {
    attachCustomKeyEventHandler: (h: Handler) => {
      handler = h
    },
    hasSelection: () => false,
    getSelection: () => '',
    paste: vi.fn()
  } as unknown as Terminal
  return { term, getHandler: () => handler }
}

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type: 'keydown',
    code: '',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides
  } as unknown as KeyboardEvent
}

describe('installTerminalKeymap', () => {
  let hooks: {
    write: ReturnType<typeof vi.fn>
    fontStep: ReturnType<typeof vi.fn>
    fontReset: ReturnType<typeof vi.fn>
  }
  let getHandler: () => Handler

  beforeEach(() => {
    hooks = { write: vi.fn(), fontStep: vi.fn(), fontReset: vi.fn() }
    const t = fakeTerminal()
    installTerminalKeymap(t.term, hooks)
    getHandler = t.getHandler
  })

  it('Shift+Enter sends a soft newline and fully swallows the event', () => {
    const e = keyEvent({ code: 'Enter', shiftKey: true })
    const result = getHandler()(e)

    expect(hooks.write).toHaveBeenCalledWith('\x0a')
    expect(e.preventDefault).toHaveBeenCalledOnce()
    // The regression assertion: without stopPropagation the keydown leaks to
    // the global `Enter` shortcut and steals focus to another session.
    expect(e.stopPropagation).toHaveBeenCalledOnce()
    expect(result).toBe(false)
  })

  it('plain Enter is left for xterm (no soft newline, event not swallowed)', () => {
    const e = keyEvent({ code: 'Enter', shiftKey: false })
    const result = getHandler()(e)

    expect(hooks.write).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(e.stopPropagation).not.toHaveBeenCalled()
    expect(result).toBe(true)
  })

  it('keyup events are ignored', () => {
    const e = keyEvent({ type: 'keyup', code: 'Enter', shiftKey: true })
    const result = getHandler()(e)

    expect(hooks.write).not.toHaveBeenCalled()
    expect(result).toBe(true)
  })

  it('Ctrl+Backspace deletes a word and stops propagation', () => {
    const e = keyEvent({ code: 'Backspace', ctrlKey: true })
    const result = getHandler()(e)

    expect(hooks.write).toHaveBeenCalledWith('\x17')
    expect(e.stopPropagation).toHaveBeenCalledOnce()
    expect(result).toBe(false)
  })

  it('Ctrl+= steps the font up and stops propagation', () => {
    const e = keyEvent({ code: 'Equal', ctrlKey: true })
    const result = getHandler()(e)

    expect(hooks.fontStep).toHaveBeenCalledWith(1)
    expect(e.stopPropagation).toHaveBeenCalledOnce()
    expect(result).toBe(false)
  })
})
