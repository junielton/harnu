// @vitest-environment jsdom
/**
 * Reproduction harness for the "split-pane terminal vanishes on worktree
 * switch" bug. Mounts the REAL `HelperPane` (xterm + pty mocked at the leaves)
 * and drives the exact round-trip the user reported:
 *
 *   worktree A (1 helper)  →  worktree B (2 helpers)  →  back to worktree A
 *
 * Expectation (issue #10's "detach, don't dispose" contract):
 *   - leaving A detaches A's terminal but keeps the PTY alive (no ptyDestroy)
 *   - returning to A RE-ATTACHES the SAME terminal (no fresh ptyCreate)
 *
 * If the bug is real, returning to A either spawns a new PTY (cache miss) or
 * the original terminal is gone from the DOM (instance reuse / disposal).
 */
/* eslint-disable @typescript-eslint/no-empty-function -- xterm / ResizeObserver stubs are intentionally no-ops */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'

// ── Leaf mocks (hoisted so the vi.mock factory can see the registry) ─────────
const hoisted = vi.hoisted(() => {
  const terminals: Array<{ element: HTMLElement | null; disposed: boolean }> = []
  class FakeTerminal {
    options: Record<string, unknown>
    cols = 80
    rows = 24
    element: HTMLElement | null = null
    disposed = false
    constructor(opts: Record<string, unknown>) {
      this.options = opts ?? {}
      terminals.push(this)
    }
    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    open(host: HTMLElement): void {
      this.element = document.createElement('div')
      this.element.className = 'xterm-fake'
      host.appendChild(this.element)
    }
    onData(): { dispose(): void } {
      return { dispose() {} }
    }
    onResize(): { dispose(): void } {
      return { dispose() {} }
    }
    write(): void {}
    resize(c: number, r: number): void {
      this.cols = c
      this.rows = r
    }
    focus(): void {}
    refresh(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose() {} }
    }
    dispose(): void {
      this.disposed = true
    }
  }
  return { terminals, FakeTerminal }
})

vi.mock('@xterm/xterm', () => ({ Terminal: hoisted.FakeTerminal }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@renderer/lib/terminalMetrics', () => ({
  ensureTerminalFontLoaded: () => Promise.resolve(),
  measureCells: () => ({ cols: 80, rows: 24 }),
  measureXtermCells: () => ({ cols: 80, rows: 24 })
}))

import Harness from './fixtures/HelperHarness.vue'
import { i18n } from '@renderer/i18n'

let ptyCounter = 0
const ptyCreate = vi.fn(async () => `pty-${++ptyCounter}`)
const ptyDestroy = vi.fn()

beforeEach(() => {
  ptyCounter = 0
  hoisted.terminals.length = 0
  ptyCreate.mockClear()
  ptyDestroy.mockClear()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const api = {
    ptyCreate,
    ptyDestroy,
    ptyWrite: vi.fn(),
    ptyResize: vi.fn(),
    onPtyData: vi.fn(() => () => {}),
    onPtyExit: vi.fn(() => () => {}),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => {})
  }
  // Proxy so any other window.api.* a store touches at setup is a harmless no-op
  // (subscriptions return a disposer fn).
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, p: string) {
      return p in t ? t[p] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

/** Flush microtasks + the Vue scheduler a few times so the async onMounted
 * create path (font load → ptyCreate → wire) fully settles. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await nextTick()
  }
}

const P1 = { id: 'h-P1', type: 'shell', cwd: '/wtA', ratio: 1 } as const
const P2a = { id: 'h-P2a', type: 'shell', cwd: '/wtB', ratio: 0.5 } as const
const P2b = { id: 'h-P2b', type: 'shell', cwd: '/wtB', ratio: 0.5 } as const

function mountHarness(): VueWrapper {
  return mount(Harness, {
    props: { panes: [{ ...P1 }], worktreePath: '/wtA' },
    attachTo: document.body,
    global: { plugins: [i18n] }
  })
}

describe('helper pane persistence across worktree switch', () => {
  it('re-attaches the same terminal when returning to a worktree (does not recreate)', async () => {
    const wrapper = mountHarness()
    await settle()

    // Worktree A mounted: exactly one PTY, its terminal element on screen.
    expect(ptyCreate).toHaveBeenCalledTimes(1)
    const tA = hoisted.terminals[0]
    expect(tA.element && document.body.contains(tA.element)).toBe(true)

    // → Switch to worktree B (two helper panes).
    await wrapper.setProps({ panes: [{ ...P2a }, { ...P2b }], worktreePath: '/wtB' })
    await settle()
    expect(ptyCreate).toHaveBeenCalledTimes(3) // A's one + B's two
    expect(ptyDestroy).not.toHaveBeenCalled() // navigation must NOT kill PTYs
    expect(tA.disposed).toBe(false)
    expect(tA.element && document.body.contains(tA.element)).toBe(false) // detached

    // → Switch back to worktree A.
    await wrapper.setProps({ panes: [{ ...P1 }], worktreePath: '/wtA' })
    await settle()

    // THE CRUX — these are what "the ls -la vanished" would violate:
    expect(ptyDestroy).not.toHaveBeenCalled()
    expect(ptyCreate).toHaveBeenCalledTimes(3) // no 4th spawn → reattached, not recreated
    expect(tA.disposed).toBe(false)
    expect(tA.element && document.body.contains(tA.element)).toBe(true) // ORIGINAL terminal back

    wrapper.unmount()
  })
})
