// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { nextTick, ref, type Ref } from 'vue'

/**
 * T486 §9.1 / AC-52 — `enabled()` is context only; `keysGuard` is focus
 * conflicts only, and `dispatch` consults it ONLY for a `'keys'` dispatch. So a
 * guarded action does nothing on a key press in a text field, yet still runs
 * from the native menu (`shortcut:fired`), the shield and the palette.
 *
 * `useMagicKeys` is mocked the same way as `use-shortcuts-keys.test.ts`; the
 * menu leg is driven through a stubbed `window.api.onShortcut`.
 */

vi.mock('vue', async (orig) => ({
  ...(await orig<typeof import('vue')>()),
  onBeforeUnmount: () => {}
}))

vi.mock('../src/renderer/src/lib/platform', () => ({
  isMac: false,
  macWindowControlsInset: 0
}))

const MOD_ALIAS: Record<string, string> = {
  cmd: 'control',
  ctrl: 'control',
  mod: 'control',
  shift: 'shift',
  alt: 'alt'
}

function canon(name: string): string {
  return name
    .toLowerCase()
    .split('+')
    .map((t) => MOD_ALIAS[t] ?? t)
    .sort()
    .join('+')
}

const keyRefs = new Map<string, Ref<boolean>>()
function magicRef(name: string): Ref<boolean> {
  const k = canon(name)
  let r = keyRefs.get(k)
  if (!r) {
    r = ref(false)
    keyRefs.set(k, r)
  }
  return r
}

vi.mock('@vueuse/core', () => ({
  useMagicKeys: () =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'current') return new Set<string>()
          return magicRef(String(prop))
        }
      }
    )
}))

import {
  useShortcuts,
  resetScopesForTests,
  dispatchForTests
} from '../src/renderer/src/composables/useShortcuts'
import { notInTextEntry, isTextEntryTarget } from '../src/renderer/src/lib/text-entry'

let menuFire: ((id: string) => void) | null = null

async function press(combo: string): Promise<void> {
  const mods = combo
    .toLowerCase()
    .split('+')
    .filter((t) => t in MOD_ALIAS)
    .map((t) => MOD_ALIAS[t])
  for (const m of mods) magicRef(m).value = true
  magicRef(combo).value = true
  await nextTick()
  await nextTick()
  magicRef(combo).value = false
  for (const m of mods) magicRef(m).value = false
  await nextTick()
}

function focusInput(): HTMLInputElement {
  const input = document.createElement('input')
  document.body.appendChild(input)
  input.focus()
  return input
}

beforeAll(() => {
  ;(window as unknown as { api: unknown }).api = {
    onShortcut: (cb: (id: string) => void) => {
      menuFire = cb
      return () => {}
    }
  }
})

beforeEach(() => {
  resetScopesForTests()
  for (const r of keyRefs.values()) r.value = false
})

afterEach(() => {
  ;(document.activeElement as HTMLElement | null)?.blur()
  document.body.innerHTML = ''
})

/** Register one guarded binding under a fresh id (the coalesce map is per id). */
let seq = 0
function guarded(keys = 'Cmd+Enter'): { id: string; handler: ReturnType<typeof vi.fn> } {
  const id = `t486.guarded.${++seq}`
  const handler = vi.fn()
  useShortcuts([{ id, scope: 'global', keys, keysGuard: notInTextEntry, handler }])
  return { id, handler }
}

describe('lib/text-entry', () => {
  it('treats inputs, textareas and contenteditable as text entry', () => {
    focusInput()
    expect(isTextEntryTarget()).toBe(true)
    expect(notInTextEntry()).toBe(false)
  })

  it("does NOT treat xterm's hidden textarea as text entry", () => {
    const host = document.createElement('div')
    host.className = 'xterm'
    const ta = document.createElement('textarea')
    host.appendChild(ta)
    document.body.appendChild(host)
    ta.focus()
    expect(isTextEntryTarget()).toBe(false)
  })
})

describe('AC-52 — keysGuard blocks only key presses', () => {
  it('a key press in a text field does nothing', async () => {
    const { handler } = guarded()
    focusInput()
    await press('Cmd+Enter')
    expect(handler).not.toHaveBeenCalled()
  })

  it('the same key press outside a text field runs the action', async () => {
    const { handler } = guarded()
    await press('Cmd+Enter')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('the native menu runs it from a text field', () => {
    const { id, handler } = guarded()
    focusInput()
    expect(menuFire).not.toBeNull()
    menuFire!(id)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('the shield and the palette run it from a text field', () => {
    const shield = guarded()
    const palette = guarded()
    focusInput()
    dispatchForTests(shield.id, 'shield')
    dispatchForTests(palette.id, 'palette')
    expect(shield.handler).toHaveBeenCalledTimes(1)
    expect(palette.handler).toHaveBeenCalledTimes(1)
  })

  it('enabled() still gates every source', () => {
    const id = `t486.disabled.${++seq}`
    const handler = vi.fn()
    useShortcuts([{ id, scope: 'global', enabled: () => false, handler }])
    menuFire!(id)
    dispatchForTests(id, 'shield')
    dispatchForTests(id, 'palette')
    expect(handler).not.toHaveBeenCalled()
  })
})
