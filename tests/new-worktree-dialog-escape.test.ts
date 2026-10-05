// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import NewWorktreeDialog from '../src/renderer/src/components/NewWorktreeDialog.vue'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { i18n } from '@renderer/i18n'
import type { BranchRef } from '../src/main/worktree-core'

/**
 * Regression for the Escape-key capture-phase bug: `NewWorktreeDialog`'s own
 * Escape handler is registered on `window` in the CAPTURE phase
 * (`addEventListener('keydown', onKeydown, true)`), so it fires before the
 * event ever reaches the `BranchCombobox` search input's own bubble-phase
 * Escape handler. Before the fix, pressing Escape while the base-ref combobox
 * panel is open closed the WHOLE dialog (discarding the operator's typed
 * branch/base), instead of just the combobox panel. The fix guards the
 * dialog's `onKeydown` to no-op when `e.target` is inside a
 * `[data-branch-combobox-panel]` — letting the combobox's own handler run.
 *
 * This test mounts the REAL dialog + REAL BranchCombobox and dispatches a
 * genuine `KeyboardEvent` on the search input (bubbles: true), so jsdom walks
 * the actual capture → target → bubble path — the same race the bug report
 * describes — rather than asserting on the guard logic in isolation.
 */

const BRANCHES: BranchRef[] = [
  { name: 'main', remote: false, head: 'abc1111' },
  { name: 'develop', remote: false, head: 'def2222' }
]

let mounted: ReturnType<typeof mount>[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  const api = {
    worktreeBranches: vi.fn(async () => BRANCHES),
    worktreePlan: vi.fn(async () => ({ error: 'invalid-request' as const, reason: 'n/a' })),
    worktreeInheritOffer: vi.fn(async () => false),
    onWorktreeProgress: vi.fn(() => () => {}),
    worktreeCreate: vi.fn(async () => {})
  }
  // Proxy stub (same pattern as tests/markdown-pane-edit.test.ts): any
  // `window.api.*` call this test doesn't care about is a harmless no-op.
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k as keyof typeof t] : () => () => {}
    }
  })
})

afterEach(() => {
  // Unmount every wrapper BEFORE wiping the DOM — the dialog holds a live
  // capture-phase `window` keydown listener (and BranchCombobox its own);
  // a raw `innerHTML = ''` never runs Vue's unmount lifecycle, so those
  // listeners would leak into later tests.
  mounted.forEach((w) => w.unmount())
  mounted = []
  document.body.innerHTML = ''
})

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await nextTick()
  }
}

async function mountDialog(): Promise<{
  w: ReturnType<typeof mount>
  ui: ReturnType<typeof useUiStore>
}> {
  const ui = useUiStore()
  // Mount CLOSED, then open it — the dialog's `watch(isOpen, ...)` (which is
  // what actually calls `window.addEventListener('keydown', onKeydown, true)`)
  // only fires on a CHANGE, not on the initial value. Setting `ui.dialog`
  // before mount would leave that listener never registered and the test
  // would pass for the wrong reason (no capture listener == no bug to catch).
  ui.newWorktreePath = '/repo/project'
  const w = mount(NewWorktreeDialog, { global: { plugins: [i18n] }, attachTo: document.body })
  mounted.push(w)
  ui.dialog = 'newWorktree'
  await nextTick()
  return { w, ui }
}

describe('NewWorktreeDialog — Escape while a BranchCombobox panel is open', () => {
  it('closes only the combobox panel, and keeps the dialog itself open', async () => {
    const { ui } = await mountDialog()
    await settle()

    // Open the base-ref BranchCombobox (mode defaults to "new").
    const trigger = document.querySelector('[data-branch-combobox-trigger]') as HTMLElement | null
    expect(trigger).not.toBeNull()
    trigger!.click()
    await nextTick()

    const search = document.querySelector(
      '[data-branch-combobox-search]'
    ) as HTMLInputElement | null
    expect(search).not.toBeNull()
    expect(document.querySelector('[data-branch-combobox-panel]')).not.toBeNull()
    search!.focus()

    // A genuine dispatch on the search input — walks the real
    // capture(window) → target(input) → bubble path.
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    search!.dispatchEvent(escape)
    await nextTick()

    // The combobox panel closes (its own Escape handling)...
    expect(document.querySelector('[data-branch-combobox-panel]')).toBeNull()
    // ...but the New worktree dialog itself must stay open. Pre-fix, the
    // dialog's capture-phase handler fired first, called stopPropagation(),
    // and closed the entire dialog (ui.dialog → null) before the combobox's
    // own handler ever ran.
    expect(ui.dialog).toBe('newWorktree')
  })
})
