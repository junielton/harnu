// @vitest-environment jsdom
/**
 * T245 — the review companion against the lifecycle that actually runs.
 *
 * The AC-6 the PRD wrote is deliberately suspicious of the easy proof. Two facts
 * make the obvious test worthless:
 *
 *  1. `HelperPane` DETACHES on unmount, it does not dispose (issue #10). A pane
 *     that leaves the screen keeps its PTY.
 *  2. `showHelperStack` stays true straight through a review → terminal
 *     transition whenever the same worktree also has a session selected — the
 *     common case. The stack never unmounts, so the pane is never even asked to
 *     leave.
 *
 * So a companion left alone would simply keep running as an ordinary helper tab:
 * not disposed, and no longer scoped to anything. The test below reproduces that
 * exact shape — the pane stays MOUNTED across the close, the way it does in the
 * app — and demands `ptyDestroy` anyway.
 *
 * It doubles as the live half of AC-2 (a `claude-new` spawn on a fresh uuid),
 * AC-2b (`readOnly` reaches main) and AC-4 (Harnu never writes to the PTY).
 *
 * **AC-4 AMENDED 2026-08-28 by T247 (T245 U2), with the operator's signature.**
 * U1's AC-4 ("Harnu never sends an initial message") was pinned here as "no
 * `bootOverride`, no `ptyWrite`". T246 then decoupled the reviewed head from the
 * folder's `HEAD`, so a blind companion began GUESSING from `git status` instead
 * of asking — right about the folder, wrong about the review. Blindness only
 * works while the session knows it is blind.
 *
 * The amendment is exactly one thing: Harnu may hand main a fixed,
 * evaluation-free ORIENTATION (`spawn.reviewCorrective`), which main composes
 * into `--append-system-prompt`. Everything AC-4 protected is unchanged and is
 * asserted below, more strictly than before:
 *
 *  - `ptyWrite` is still never called — Harnu speaks in no turn of the
 *    conversation, so the transcript (and therefore the sidebar label) never
 *    carries a word Harnu wrote.
 *  - `bootOverride` is still undefined. The orientation travels through its own
 *    five-scalar field, NOT through the general boot-config door, so it cannot
 *    carry a flag, a permission, or a prompt.
 *  - the orientation's key set is pinned exactly, so nothing on the spec's
 *    normative exclusion list (CI/PR state, counts, the file list, the diff
 *    body, anything from `evidence`) can arrive by being added to an object.
 */
/* eslint-disable @typescript-eslint/no-empty-function -- xterm / ResizeObserver stubs are intentionally no-ops */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'

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
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class {} }))
vi.mock('@renderer/lib/terminalMetrics', () => ({
  ensureTerminalFontLoaded: () => Promise.resolve(),
  measureCells: () => ({ cols: 80, rows: 24 }),
  measureXtermCells: () => ({ cols: 80, rows: 24 })
}))

import Harness from './fixtures/HelperHarness.vue'
import { i18n } from '@renderer/i18n'
import { useHelpersStore } from '@renderer/stores/helpers'
import { useUiStore } from '@renderer/stores/ui'

let ptyCounter = 0
const ptyCreate = vi.fn(async () => `pty-${++ptyCounter}`)
const ptyDestroy = vi.fn()
const ptyWrite = vi.fn()

const WT = '/repos/harnu'

beforeEach(() => {
  ptyCounter = 0
  hoisted.terminals.length = 0
  ptyCreate.mockClear()
  ptyDestroy.mockClear()
  ptyWrite.mockClear()
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  const api = {
    ptyCreate,
    ptyDestroy,
    ptyWrite,
    ptyResize: vi.fn(),
    onPtyData: vi.fn(() => () => {}),
    onPtyExit: vi.fn(() => () => {}),
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn(async () => {})
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, p: string) {
      return p in t ? t[p] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await nextTick()
  }
}

describe('T245 — the companion PTY, from spawn to dispose', () => {
  it('spawns fresh + read-only, says nothing, and dies with the review', async () => {
    const ui = useUiStore()
    const helpers = useHelpersStore()
    ui.openReview(WT, null)
    const paneId = helpers.addReviewCompanionHelper(WT, WT)
    const pane = helpers.byWorktree.get(WT)!.panes.find((p) => p.id === paneId)!

    // The pane is rendered by a host that does NOT unmount it — standing in for
    // `showHelperStack` staying true because the worktree also has a session
    // selected. Any dispose observed below therefore came from the close path,
    // not from a component teardown.
    const wrapper = mount(Harness, {
      props: { panes: [pane], worktreePath: WT },
      attachTo: document.body,
      global: { plugins: [i18n] }
    })
    await settle()

    // ── AC-2 + AC-2b: what main was actually asked to spawn ──────────────────
    expect(ptyCreate).toHaveBeenCalledTimes(1)
    const spawn = ptyCreate.mock.calls[0][0] as Record<string, unknown>
    expect(spawn.kind).toBe('claude-new')
    expect(spawn.readOnly).toBe(true)
    expect(spawn.cwd).toBe(WT)
    // A uuid Harnu minted for `--session-id`, not a session being resumed.
    expect(spawn.claudeSessionId).toBe((pane as unknown as { sessionId: string }).sessionId)
    expect(spawn.claudeSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
    expect(spawn.bootOverride).toBeUndefined()

    // ── AC-4 (amended): orientation may travel; a user turn may not ──────────
    // What main is asked to say, in full: five scalars through a dedicated
    // field. Pinned exactly — a sixth key is how a prompt arrives unnoticed.
    expect(Object.keys(spawn.reviewCorrective as object).sort()).toEqual(
      ['baseSha', 'headSha', 'isRepo', 'prNumber', 'state'].sort()
    )
    // A plain object, not the Pinia reactive Proxy: `ptyCreate` crosses
    // structured-clone IPC, which cannot clone a Proxy, and the failure presents
    // as "Helper failed to start" with a blank pane.
    expect(Object.getPrototypeOf(spawn.reviewCorrective as object)).toBe(Object.prototype)
    // And Harnu still never speaks first: no user turn, in either channel.
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(spawn.prePrompt).toBeUndefined()

    // ── AC-6: the close disposes it, while it is still on screen ─────────────
    const term = hoisted.terminals[0]
    expect(term.element && document.body.contains(term.element)).toBe(true)
    expect(ptyDestroy).not.toHaveBeenCalled()

    ui.closeReview()
    await settle()

    expect(ptyDestroy).toHaveBeenCalledTimes(1)
    expect(ptyDestroy.mock.calls[0][0]).toBe('pty-1')
    expect(term.disposed).toBe(true)
    expect(helpers.byWorktree.get(WT)!.panes).toHaveLength(0)
    // Never resurrected: a transient pane is dropped by `toPersistShape`, so it
    // cannot come back on a later boot as a permanent tab.
    expect(ptyWrite).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})
