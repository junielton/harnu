// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * T486 U5a — the generic shield (§7.4, AC-44, AC-45) and `dispatchShortcut`.
 *
 * One window CAPTURE keydown listener matches the event's chord against every
 * shielded action's RESOLVED chord:
 *  - menu-backed off macOS (`nav.*`): `stopPropagation` only — the key stays
 *    unhandled so the native accelerator fires, and the Alt release never
 *    toggles the auto-hidden menu bar;
 *  - otherwise: `preventDefault` + `stopPropagation` + `dispatchShortcut(id, 'shield')`.
 * Shielded actions get no `useMagicKeys` watcher, so one press dispatches once.
 *
 * The REAL `useMagicKeys` runs here (no mock), so the renderer-watcher half is
 * the production code path. `isMac` is a getter over a hoisted flag so each test
 * picks its platform.
 */

const platform = vi.hoisted(() => ({ mac: false }))

vi.mock('vue', async (orig) => ({
  ...(await orig<typeof import('vue')>()),
  // No component instance in a plain test — silence the lifecycle warning.
  onBeforeUnmount: () => {}
}))

vi.mock('../src/renderer/src/lib/platform', () => ({
  get isMac() {
    return platform.mac
  },
  macWindowControlsInset: 0
}))

import {
  useShortcuts,
  createShieldListener,
  dispatchShortcut,
  pushScope,
  popScope,
  resetScopesForTests
} from '../src/renderer/src/composables/useShortcuts'
import { resolveKeybindings, type ResolvedKeybindings } from '../src/main/keybindings-core'

let resolved: ResolvedKeybindings
const back = vi.fn()
const forward = vi.fn()
let menuFire: ((id: string) => void) | null = null
let clock = Date.parse('2026-10-20T00:00:00Z')

beforeAll(() => {
  ;(window as unknown as { api: unknown }).api = {
    onShortcut: (cb: (id: string) => void) => {
      menuFire = cb
      return () => {}
    }
  }
  resolved = resolveKeybindings(null, { mac: false })
  useShortcuts(
    [
      { id: 'nav.back', scope: 'global', keys: 'Alt+ArrowLeft', handler: back },
      { id: 'nav.forward', scope: 'global', keys: 'Alt+ArrowRight', handler: forward }
    ],
    () => resolved
  )
})

let listener: ((e: KeyboardEvent) => void) | null = null
let terminal: HTMLDivElement
const terminalSaw = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 10_000 // past the menu/keys coalesce window of the previous test
  vi.setSystemTime(clock)
  resetScopesForTests()
  // useMagicKeys clears every held key on window blur — no state leaks between tests.
  window.dispatchEvent(new Event('blur'))
  back.mockClear()
  forward.mockClear()
  terminalSaw.mockClear()
  platform.mac = false
  resolved = resolveKeybindings(null, { mac: false })
  terminal = document.createElement('div')
  terminal.addEventListener('keydown', terminalSaw)
  document.body.appendChild(terminal)
})

afterEach(() => {
  if (listener) window.removeEventListener('keydown', listener, true)
  listener = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function installShield(): void {
  listener = createShieldListener(() => resolved)
  window.addEventListener('keydown', listener, true)
}

/** A key press that starts in the "terminal" element, the way xterm receives it. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  terminal.dispatchEvent(e)
  return e
}

const ALT_LEFT = { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }

describe('shield — menu-backed nav off macOS (AC-44)', () => {
  it('keeps Alt+← from the terminal without preventDefault and without dispatching', async () => {
    installShield()
    const e = press(ALT_LEFT)
    await nextTick()
    expect(terminalSaw).not.toHaveBeenCalled()
    // Unhandled, so Electron runs the &Session accelerator; no menu-bar toggle.
    expect(e.defaultPrevented).toBe(false)
    // The renderer does not dispatch: the accelerator does, through `shortcut:fired`.
    expect(back).not.toHaveBeenCalled()
    menuFire?.('nav.back')
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('follows a rebind: the new chord is shielded, the old one reaches the terminal', () => {
    resolved = resolveKeybindings([{ command: 'nav.back', key: 'Alt+H' }], { mac: false })
    installShield()
    press({ key: 'h', code: 'KeyH', altKey: true })
    expect(terminalSaw).toHaveBeenCalledTimes(0)
    press(ALT_LEFT)
    expect(terminalSaw).toHaveBeenCalledTimes(1)
  })

  it('matches the resolved chord exactly: Alt+Shift+← is left to the terminal', () => {
    installShield()
    press({ ...ALT_LEFT, shiftKey: true })
    expect(terminalSaw).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an unbound action', () => {
    resolved = resolveKeybindings([{ command: 'nav.back', key: null }], { mac: false })
    installShield()
    press(ALT_LEFT)
    expect(terminalSaw).toHaveBeenCalledTimes(1)
  })

  it('stands down while a non-global scope (a dialog, the palette) is on top', () => {
    installShield()
    pushScope('modal')
    press(ALT_LEFT)
    popScope('modal')
    expect(terminalSaw).toHaveBeenCalledTimes(1)
  })
})

describe('shield — preventDefault branch (macOS, and every renderer-only shielded action)', () => {
  it('takes ⌘[ from the terminal and dispatches nav.back once', async () => {
    platform.mac = true
    resolved = resolveKeybindings(null, { mac: true })
    installShield()
    const e = press({ key: '[', code: 'BracketLeft', metaKey: true })
    await nextTick()
    expect(e.defaultPrevented).toBe(true)
    expect(terminalSaw).not.toHaveBeenCalled()
    expect(back).toHaveBeenCalledTimes(1)
    // The native accelerator's twin of the same press is coalesced.
    menuFire?.('nav.back')
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('dispatchShortcut honors enabled() and ignores keysGuard', () => {
    const run = vi.fn()
    useShortcuts([
      {
        id: 't.shield.guarded',
        scope: 'global',
        keysGuard: () => false,
        handler: run
      },
      { id: 't.shield.disabled', scope: 'global', enabled: () => false, handler: run }
    ])
    dispatchShortcut('t.shield.guarded', 'shield')
    expect(run).toHaveBeenCalledTimes(1)
    dispatchShortcut('t.shield.disabled', 'shield')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('shielded actions get no useMagicKeys watcher (§7.4 step 4)', () => {
  it('a press the shield did not see does not dispatch nav.back from the renderer', async () => {
    // No shield installed: the key reaches window bubble, where useMagicKeys listens.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true })
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { ...ALT_LEFT }))
    await nextTick()
    await nextTick()
    window.dispatchEvent(new KeyboardEvent('keyup', { ...ALT_LEFT }))
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', code: 'AltLeft' }))
    await nextTick()
    expect(back).not.toHaveBeenCalled()
  })
})

describe('AC-45 — onNavKeydown is gone; the shield is the one capture handler', () => {
  const app = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
  it('App.vue has no onNavKeydown and installs createShieldListener in the capture phase', () => {
    expect(app).not.toContain('onNavKeydown')
    expect(app).toContain('createShieldListener(')
    expect(app).toMatch(/addEventListener\('keydown', onShieldKeydown, true\)/)
    expect(app).toMatch(/removeEventListener\('keydown', onShieldKeydown, true\)/)
  })
  it('the nav registrations read kb() instead of a literal chord', () => {
    expect(app).toMatch(/id: 'nav\.back',[\s\S]*?keys: kb\('nav\.back'\)/)
    expect(app).toMatch(/id: 'nav\.forward',[\s\S]*?keys: kb\('nav\.forward'\)/)
  })
})
