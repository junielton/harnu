// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * T486 U5a carry-over — a renderer binding fires only when the HELD modifier
 * set equals the chord's, Shift included. Found live in U4a: `F7` bound to
 * `view.activity` also opened on Shift+F7.
 *
 * The cause: the exact-match check read `useMagicKeys`' modifier refs, which
 * drift from the real keyboard whenever a modifier's own keydown / keyup never
 * reached `window` (a field that stops it, a lost keyup, a synthesized key
 * event). The press itself carries the truth in `shiftKey` / `ctrlKey` / … —
 * the check now reads those.
 *
 * The REAL `useMagicKeys` runs here; events go to `window` like a key press
 * with nothing focused.
 */

vi.mock('vue', async (orig) => ({
  ...(await orig<typeof import('vue')>()),
  onBeforeUnmount: () => {}
}))

vi.mock('../src/renderer/src/lib/platform', () => ({
  isMac: false,
  macWindowControlsInset: 0
}))

import { useShortcuts, resetScopesForTests } from '../src/renderer/src/composables/useShortcuts'

const f6 = vi.fn()
const shiftF6 = vi.fn()
const ctrlK = vi.fn()
const ctrlShiftK = vi.fn()

beforeAll(() => {
  useShortcuts([
    { id: 't.mod.f6', scope: 'global', keys: 'F6', handler: f6 },
    { id: 't.mod.shiftF6', scope: 'global', keys: 'Shift+F6', handler: shiftF6 },
    { id: 't.mod.ctrlK', scope: 'global', keys: 'Ctrl+K', handler: ctrlK },
    { id: 't.mod.ctrlShiftK', scope: 'global', keys: 'Ctrl+Shift+K', handler: ctrlShiftK }
  ])
})

let clock = Date.parse('2026-10-20T00:00:00Z')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 10_000
  vi.setSystemTime(clock)
  resetScopesForTests()
  window.dispatchEvent(new Event('blur')) // useMagicKeys forgets every held key
  for (const fn of [f6, shiftF6, ctrlK, ctrlShiftK]) fn.mockClear()
})

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
}

const SHIFT = { key: 'Shift', code: 'ShiftLeft' }
const CTRL = { key: 'Control', code: 'ControlLeft' }
const F6 = { key: 'F6', code: 'F6' }
const K = { key: 'k', code: 'KeyK' }

describe('F6 vs Shift+F6', () => {
  it('F6 fires F6 only', async () => {
    key('keydown', F6)
    await flush()
    key('keyup', F6)
    await flush()
    expect(f6).toHaveBeenCalledTimes(1)
    expect(shiftF6).not.toHaveBeenCalled()
  })

  it('Shift+F6 fires Shift+F6 only', async () => {
    key('keydown', { ...SHIFT, shiftKey: true })
    key('keydown', { ...F6, shiftKey: true })
    await flush()
    key('keyup', { ...F6, shiftKey: true })
    key('keyup', SHIFT)
    await flush()
    expect(shiftF6).toHaveBeenCalledTimes(1)
    expect(f6).not.toHaveBeenCalled()
  })

  it('the F6 binding does not fire on Shift+F6 when the Shift keydown never reached window', async () => {
    // A field that stops Shift, or a synthesized key event: only the F6 press
    // says Shift is held. This is the live U4a repro (F7 → Shift+F7).
    key('keydown', { ...F6, shiftKey: true })
    await flush()
    key('keyup', { ...F6, shiftKey: true })
    await flush()
    expect(f6).not.toHaveBeenCalled()
  })

  it('the Shift+F6 binding does not fire on F6 after a lost Shift keyup', async () => {
    key('keydown', { ...SHIFT, shiftKey: true })
    await flush()
    // The Shift keyup never reaches window; the next F6 press has no Shift.
    key('keydown', F6)
    await flush()
    key('keyup', F6)
    await flush()
    expect(shiftF6).not.toHaveBeenCalled()
    expect(f6).toHaveBeenCalledTimes(1)
  })
})

describe('Ctrl+K vs Ctrl+Shift+K', () => {
  it('Ctrl+K fires Ctrl+K only', async () => {
    key('keydown', { ...CTRL, ctrlKey: true })
    key('keydown', { ...K, ctrlKey: true })
    await flush()
    key('keyup', { ...K, ctrlKey: true })
    key('keyup', CTRL)
    await flush()
    expect(ctrlK).toHaveBeenCalledTimes(1)
    expect(ctrlShiftK).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+K fires Ctrl+Shift+K only', async () => {
    key('keydown', { ...CTRL, ctrlKey: true })
    key('keydown', { ...SHIFT, ctrlKey: true, shiftKey: true })
    key('keydown', { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })
    await flush()
    key('keyup', { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })
    key('keyup', SHIFT)
    key('keyup', CTRL)
    await flush()
    expect(ctrlShiftK).toHaveBeenCalledTimes(1)
    expect(ctrlK).not.toHaveBeenCalled()
  })

  it('Ctrl+K does not fire on Ctrl+Shift+K when the Shift keydown never reached window', async () => {
    key('keydown', { ...CTRL, ctrlKey: true })
    key('keydown', { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })
    await flush()
    key('keyup', { key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true })
    key('keyup', CTRL)
    await flush()
    expect(ctrlK).not.toHaveBeenCalled()
  })
})
