// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * T486 U5b — the §3.7 pane ids through the REAL shield and the REAL
 * `useMagicKeys` (spec §7.2–§7.4, §8):
 *
 *  - AC-22: F6 / Shift+F6 are taken from a focused terminal and dispatch
 *    `pane.focusNext` / `pane.focusPrev`; exact modifiers, so one press never
 *    fires both.
 *  - AC-24: both stand down under the `'modal'` scope.
 *  - AC-28 / AC-30: `terminal.toggle` is unbound by default (Ctrl+` reaches the
 *    terminal); once bound, its chord is shielded and never reaches the PTY.
 *  - §7.2: Ctrl+Shift+M (`pane.toggleMaximize`) is NOT shielded: it bubbles out
 *    of the terminal and fires through its renderer watcher, once.
 */

vi.mock('vue', async (orig) => ({
  ...(await orig<typeof import('vue')>()),
  onBeforeUnmount: () => {}
}))

vi.mock('../src/renderer/src/lib/platform', () => ({
  isMac: false,
  macWindowControlsInset: 0
}))

import {
  useShortcuts,
  createShieldListener,
  pushScope,
  popScope,
  resetScopesForTests
} from '../src/renderer/src/composables/useShortcuts'
import { resolveKeybindings, type ResolvedKeybindings } from '../src/main/keybindings-core'

let resolved: ResolvedKeybindings = resolveKeybindings(null, { mac: false })
const next = vi.fn()
const prev = vi.fn()
const maximize = vi.fn()
const toggle = vi.fn()

beforeAll(() => {
  ;(window as unknown as { api: unknown }).api = { onShortcut: () => () => {} }
  const kb = (id: string): string | undefined => resolved.byId[id]?.keys ?? undefined
  useShortcuts(
    [
      { id: 'pane.focusNext', scope: 'global', keys: kb('pane.focusNext'), handler: next },
      { id: 'pane.focusPrev', scope: 'global', keys: kb('pane.focusPrev'), handler: prev },
      {
        id: 'pane.toggleMaximize',
        scope: 'global',
        keys: kb('pane.toggleMaximize'),
        handler: maximize
      },
      { id: 'terminal.toggle', scope: 'global', keys: kb('terminal.toggle'), handler: toggle }
    ],
    () => resolved
  )
})

let listener: ((e: KeyboardEvent) => void) | null = null
let terminal: HTMLTextAreaElement
const terminalSaw = vi.fn()
let clock = Date.parse('2026-10-20T00:00:00Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 10_000
  vi.setSystemTime(clock)
  resetScopesForTests()
  window.dispatchEvent(new Event('blur'))
  for (const fn of [next, prev, maximize, toggle, terminalSaw]) fn.mockClear()
  resolved = resolveKeybindings(null, { mac: false })
  // xterm's hidden textarea: the key starts here, the way a focused terminal gets it.
  terminal = document.createElement('textarea')
  terminal.className = 'xterm-helper-textarea'
  terminal.addEventListener('keydown', terminalSaw)
  document.body.appendChild(terminal)
  listener = createShieldListener(() => resolved)
  window.addEventListener('keydown', listener, true)
})

afterEach(() => {
  if (listener) window.removeEventListener('keydown', listener, true)
  listener = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  terminal.dispatchEvent(e)
  return e
}
function release(init: KeyboardEventInit): void {
  terminal.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, ...init }))
}
async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
}

const F6 = { key: 'F6', code: 'F6' }

describe('F6 / Shift+F6 (AC-22)', () => {
  it('F6 is taken from the terminal and dispatches pane.focusNext only', async () => {
    const e = press(F6)
    await flush()
    release(F6)
    await flush()
    expect(e.defaultPrevented).toBe(true)
    expect(terminalSaw).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(prev).not.toHaveBeenCalled()
  })

  it('Shift+F6 dispatches pane.focusPrev only — never pane.focusNext too', async () => {
    press({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })
    const e = press({ ...F6, shiftKey: true })
    await flush()
    release({ ...F6, shiftKey: true })
    release({ key: 'Shift', code: 'ShiftLeft' })
    await flush()
    expect(e.defaultPrevented).toBe(true)
    expect(prev).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
  })

  it('Ctrl+F6 matches neither', async () => {
    press({ ...F6, ctrlKey: true })
    await flush()
    expect(next).not.toHaveBeenCalled()
    expect(prev).not.toHaveBeenCalled()
  })
})

describe('the modal scope (AC-24)', () => {
  it('F6 and Shift+F6 do nothing while a dialog, the palette or a menu is up', async () => {
    pushScope('modal')
    press(F6)
    press({ ...F6, shiftKey: true })
    await flush()
    popScope('modal')
    expect(next).not.toHaveBeenCalled()
    expect(prev).not.toHaveBeenCalled()
  })
})

const CTRL_BACKQUOTE = { key: '`', code: 'Backquote', ctrlKey: true }

describe('terminal.toggle (AC-28, AC-30)', () => {
  it('ships unbound: Ctrl+` reaches the terminal and dispatches nothing', async () => {
    expect(resolved.byId['terminal.toggle'].keys).toBeNull()
    press(CTRL_BACKQUOTE)
    await flush()
    expect(terminalSaw).toHaveBeenCalledTimes(1)
    expect(toggle).not.toHaveBeenCalled()
  })

  it('once bound, its chord is taken from the terminal and dispatches once', async () => {
    resolved = resolveKeybindings([{ command: 'terminal.toggle', key: 'Ctrl+`' }], {
      mac: false
    })
    const e = press(CTRL_BACKQUOTE)
    await flush()
    expect(e.defaultPrevented).toBe(true)
    expect(terminalSaw).not.toHaveBeenCalled()
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})

describe('pane.toggleMaximize is not shielded (§7.2)', () => {
  it('Ctrl+Shift+M bubbles out of the terminal and fires once', async () => {
    press({ key: 'Control', code: 'ControlLeft', ctrlKey: true })
    press({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true })
    const e = press({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true })
    await flush()
    release({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true })
    release({ key: 'Shift', code: 'ShiftLeft' })
    release({ key: 'Control', code: 'ControlLeft' })
    await flush()
    // The shield left it alone: the terminal saw it, then window's watcher fired.
    expect(terminalSaw.mock.calls.map(([ev]) => ev)).toContain(e)
    expect(maximize).toHaveBeenCalledTimes(1)
  })
})
