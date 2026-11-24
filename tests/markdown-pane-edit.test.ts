// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import MarkdownPane, {
  __resetMarkdownDraftCacheForTests
} from '../src/renderer/src/components/MarkdownPane.vue'
import { i18n } from '@renderer/i18n'
import { __resetUnsavedDraftsForTests, isDraftDirty } from '../src/renderer/src/lib/unsaved-drafts'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useUiStore } from '../src/renderer/src/stores/ui'
import {
  closeRegion,
  resetFocusRegionsForTests
} from '../src/renderer/src/composables/useTerminalFocus'

/**
 * Edit-mode contract for the T74 markdown pane (phase 2): the pane toggles
 * view⇄edit, tracks a dirty draft, saves EXPLICITLY through the confined
 * `markdown:write` IPC, and drops a freshly-created blank file straight into
 * edit. The reusable `MarkdownRenderer` stays read-only — editing lives only in
 * the pane. `window.api` is a Proxy stub so unused calls are harmless no-ops.
 */
const markdownRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, content: 'hello' }))
const markdownWrite = vi.fn(async (p: string, content: string) => ({
  ok: true as const,
  path: p,
  bytes: content.length
}))
/** T121 — stubbed clipboard for the "copy file" toolbar action; jsdom has no real one. */
const clipboardWriteText = vi.fn(async () => undefined)

beforeEach(() => {
  // BUG-22: the pane's draft buffer now lives in a module-level cache keyed by
  // pane id. These tests all reuse `h-md`, so clear it between cases to isolate
  // (production never reuses a pane id).
  __resetMarkdownDraftCacheForTests()
  __resetUnsavedDraftsForTests()
  markdownRead.mockClear()
  markdownWrite.mockClear()
  clipboardWriteText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true
  })
  markdownRead.mockImplementation(async (p: string) => ({ ok: true, path: p, content: 'hello' }))
  const api = {
    markdownRead,
    markdownWrite,
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
  setActivePinia(createPinia())
})

const PANE = { id: 'h-md', type: 'markdown' as const, cwd: '/wt', ratio: 1, filePath: '/wt/doc.md' }

function mountPane() {
  return mount(MarkdownPane, {
    props: { pane: { ...PANE }, worktreePath: '/wt' },
    global: { plugins: [i18n] }
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await nextTick()
  }
}

describe('MarkdownPane — view/edit toggle', () => {
  it('opens an existing file in VIEW mode (prose, no textarea)', async () => {
    const w = mountPane()
    await settle()
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.find('.md-prose').exists()).toBe(true)
  })

  it('toggling to edit shows the textarea seeded with the file content', async () => {
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    const ta = w.find('textarea')
    expect(ta.exists()).toBe(true)
    expect((ta.element as HTMLTextAreaElement).value).toBe('hello')
  })

  it('puts the caret at the end of the file when entering edit mode', async () => {
    const w = mount(MarkdownPane, {
      props: { pane: { ...PANE }, worktreePath: '/wt' },
      attachTo: document.body,
      global: { plugins: [i18n] }
    })
    await settle()
    // jsdom already parks the caret at the end after a value set, so assert the explicit call.
    const spy = vi.spyOn(HTMLTextAreaElement.prototype, 'setSelectionRange')
    await w.get('button[aria-label="Edit"]').trigger('click')
    await settle()
    const ta = w.get('textarea').element as HTMLTextAreaElement
    expect(document.activeElement).toBe(ta)
    expect(spy).toHaveBeenCalledWith('hello'.length, 'hello'.length)
    spy.mockRestore()
    w.unmount()
  })

  it('editing marks the pane dirty and enables Save', async () => {
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    // Clean: no dirty dot, Save disabled.
    expect(w.get('button[aria-label="Save (⌘S)"]').attributes('disabled')).toBeDefined()

    await w.get('textarea').setValue('hello world')
    await nextTick()
    // Dirty: Save enabled.
    expect(w.get('button[aria-label="Save (⌘S)"]').attributes('disabled')).toBeUndefined()
  })

  it('Save writes the draft through the confined markdown:write IPC and clears dirty', async () => {
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('edited body')
    await nextTick()

    await w.get('button[aria-label="Save (⌘S)"]').trigger('click')
    await flushPromises()

    expect(markdownWrite).toHaveBeenCalledWith('/wt/doc.md', 'edited body')
    // Baseline advanced → Save disabled again (no longer dirty).
    expect(w.get('button[aria-label="Save (⌘S)"]').attributes('disabled')).toBeDefined()
  })

  it('a blank (freshly-created) file opens straight in EDIT mode', async () => {
    markdownRead.mockImplementation(async (p: string) => ({ ok: true, path: p, content: '' }))
    const w = mountPane()
    await settle()
    expect(w.find('textarea').exists()).toBe(true)
  })

  it('does not write when there are no edits (Save is a no-op while clean)', async () => {
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('button[aria-label="Save (⌘S)"]').trigger('click')
    await flushPromises()
    expect(markdownWrite).not.toHaveBeenCalled()
  })
})

describe('MarkdownPane — unsaved-draft registry and save() result', () => {
  type PaneVm = { save: () => Promise<boolean> }

  it('registers the pane as dirty while it has unsaved edits and clears it on save', async () => {
    const w = mountPane()
    await settle()
    expect(isDraftDirty('h-md')).toBe(false)
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('edited body')
    await nextTick()
    expect(isDraftDirty('h-md')).toBe(true)

    await w.get('button[aria-label="Save (⌘S)"]').trigger('click')
    await flushPromises()
    expect(isDraftDirty('h-md')).toBe(false)
  })

  it('save() resolves true when the draft was written', async () => {
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('edited body')
    await nextTick()
    await expect((w.vm as unknown as PaneVm).save()).resolves.toBe(true)
  })

  it('save() resolves false and the pane stays dirty when the write is refused', async () => {
    markdownWrite.mockResolvedValueOnce({
      ok: false,
      code: 'write-failed',
      error: 'nope'
    } as never)
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('edited body')
    await nextTick()
    await expect((w.vm as unknown as PaneVm).save()).resolves.toBe(false)
    expect(isDraftDirty('h-md')).toBe(true)
  })

  it('save() resolves false when the write throws', async () => {
    markdownWrite.mockRejectedValueOnce(new Error('ipc down'))
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('edited body')
    await nextTick()
    await expect((w.vm as unknown as PaneVm).save()).resolves.toBe(false)
    expect(isDraftDirty('h-md')).toBe(true)
  })

  it('stays registered across an unmount (the draft cache survives) until the pane closes', async () => {
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('edited body')
    await nextTick()
    w.unmount()
    expect(isDraftDirty('h-md')).toBe(true)
  })
})

describe('MarkdownPane — unsaved-changes dialog on operator close', () => {
  const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]')
  const dialogButton = (label: string): HTMLButtonElement => {
    const btn = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent?.trim() === label
    )
    if (!btn) throw new Error(`no dialog button "${label}"`)
    return btn as HTMLButtonElement
  }
  let wrapper: ReturnType<typeof mountPane> | undefined

  async function dirtyPane(): Promise<ReturnType<typeof mountPane>> {
    wrapper = mountPane()
    await settle()
    await wrapper.get('button[aria-label="Edit"]').trigger('click')
    await wrapper.get('textarea').setValue('edited body')
    await nextTick()
    return wrapper
  }

  beforeEach(() => resetFocusRegionsForTests())
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.innerHTML = ''
  })

  it('a clean pane closes immediately, with no dialog', async () => {
    wrapper = mountPane()
    await settle()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    await wrapper.get('button[aria-label="Close helper"]').trigger('click')
    expect(dialog()).toBeNull()
    expect(remove).toHaveBeenCalledWith('/wt', 'h-md')
  })

  it('a dirty pane asks first, naming the file, and Cancel keeps the pane and its draft', async () => {
    const w = await dirtyPane()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    await w.get('button[aria-label="Close helper"]').trigger('click')
    await nextTick()

    expect(dialog()).not.toBeNull()
    expect(dialog()?.textContent).toContain('doc.md')
    expect(remove).not.toHaveBeenCalled()

    dialogButton('Cancel').click()
    await settle()
    expect(dialog()).toBeNull()
    expect(remove).not.toHaveBeenCalled()
    expect(isDraftDirty('h-md')).toBe(true)
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('edited body')
  })

  it('Esc is Cancel', async () => {
    const w = await dirtyPane()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    await w.get('button[aria-label="Close helper"]').trigger('click')
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()
    expect(dialog()).toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it("Don't save drops the draft and closes the pane without writing", async () => {
    const w = await dirtyPane()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    await w.get('button[aria-label="Close helper"]').trigger('click')
    await nextTick()

    dialogButton("Don't save").click()
    await settle()

    expect(markdownWrite).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith('/wt', 'h-md')
    expect(isDraftDirty('h-md')).toBe(false)
  })

  it('Save writes the draft, then closes the pane', async () => {
    const w = await dirtyPane()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    await w.get('button[aria-label="Close helper"]').trigger('click')
    await nextTick()

    dialogButton('Save').click()
    await settle()

    expect(markdownWrite).toHaveBeenCalledWith('/wt/doc.md', 'edited body')
    expect(remove).toHaveBeenCalledWith('/wt', 'h-md')
    expect(isDraftDirty('h-md')).toBe(false)
    expect(dialog()).toBeNull()
  })

  it('Save that fails keeps the pane and the draft, and surfaces the error toast', async () => {
    markdownWrite.mockResolvedValueOnce({ ok: false, code: 'write-failed', error: 'nope' } as never)
    const w = await dirtyPane()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    const ui = useUiStore()
    await w.get('button[aria-label="Close helper"]').trigger('click')
    await nextTick()

    dialogButton('Save').click()
    await settle()

    expect(remove).not.toHaveBeenCalled()
    expect(isDraftDirty('h-md')).toBe(true)
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('edited body')
    expect(ui.toasts.some((t) => t.kind === 'danger')).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('a save that lands while the operator kept typing keeps the pane open', async () => {
    let release: (v: { ok: true; path: string; bytes: number }) => void = () => {}
    markdownWrite.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release
        }) as never
    )
    const w = await dirtyPane()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    await w.get('button[aria-label="Close helper"]').trigger('click')
    await nextTick()

    dialogButton('Save').click()
    await nextTick()
    // The write is in flight; a keystroke lands before it resolves.
    ;(w.get('textarea').element as HTMLTextAreaElement).value = 'edited body!'
    await w.get('textarea').trigger('input')
    release({ ok: true, path: '/wt/doc.md', bytes: 11 })
    await settle()

    expect(remove).not.toHaveBeenCalled()
    expect(isDraftDirty('h-md')).toBe(true)
    expect((w.get('textarea').element as HTMLTextAreaElement).value).toBe('edited body!')
  })

  it('the pane.close focus-region path shows the same dialog', async () => {
    const w = await dirtyPane()
    const remove = vi.spyOn(useHelpersStore(), 'removeHelper')
    w.unmount()
    wrapper = mount(MarkdownPane, {
      props: { pane: { ...PANE }, worktreePath: '/wt' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await settle()
    expect(closeRegion('h-md')).toBe(true)
    await nextTick()
    expect(dialog()).not.toBeNull()
    expect(remove).not.toHaveBeenCalled()
  })

  it('reload on a dirty pane keeps the non-blocking toast, not the dialog', async () => {
    const w = await dirtyPane()
    const ui = useUiStore()
    await w.get('button[aria-label="Reload file"]').trigger('click')
    await nextTick()
    expect(dialog()).toBeNull()
    expect(ui.toasts.some((t) => t.kind === 'warning')).toBe(true)
  })
})

describe('MarkdownPane — image preview (binary-guard image fast-path)', () => {
  const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

  function mountImagePane() {
    markdownRead.mockImplementation(async (p: string) => ({
      ok: true,
      kind: 'image' as const,
      path: p,
      content: DATA_URL
    }))
    return mount(MarkdownPane, {
      props: {
        pane: { ...PANE, id: 'h-img', filePath: '/wt/brand/harnu-hero.png' },
        worktreePath: '/wt'
      },
      global: { plugins: [i18n] }
    })
  }

  it('renders a kind:"image" read as an inline <img> (src = data URL, alt = filename)', async () => {
    const w = mountImagePane()
    await settle()
    const img = w.find('img.image-view')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe(DATA_URL)
    expect(img.attributes('alt')).toBe('harnu-hero.png')
    // No refusal message, no prose, no editor.
    expect(w.find('.md-prose').exists()).toBe(false)
    expect(w.find('textarea').exists()).toBe(false)
  })

  it('hides the view⇄edit toggle for an image (not editable)', async () => {
    const w = mountImagePane()
    await settle()
    expect(w.find('button[aria-label="Edit"]').exists()).toBe(false)
    expect(w.find('button[aria-label="Save (⌘S)"]').exists()).toBe(false)
  })

  it('keeps the refusal for a non-image binary (deny code "binary")', async () => {
    markdownRead.mockImplementation(async () => ({
      ok: false as const,
      code: 'binary',
      error: 'refusing to open a binary file as text'
    }))
    const w = mountPane()
    await settle()
    expect(w.find('img.image-view').exists()).toBe(false)
    expect(w.text()).toContain("This looks like a binary file — it can't be opened as text.")
  })
})

describe('MarkdownPane — "copy file" toolbar action (T121)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('copies the raw draft buffer, including unsaved edits — never the last-saved text', async () => {
    const w = mountPane()
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('edited body, not yet saved')
    await nextTick()

    await w.get('button[aria-label="Copy file"]').trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(clipboardWriteText).toHaveBeenCalledWith('edited body, not yet saved')
    // Nothing was written to disk — this is a clipboard action, not a save.
    expect(markdownWrite).not.toHaveBeenCalled()
  })

  it('shows a transient copied state that reverts after the timeout', async () => {
    const w = mountPane()
    await settle()
    const btn = w.get('button[aria-label="Copy file"]')

    await btn.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(w.find('.text-green').exists()).toBe(true)

    await vi.advanceTimersByTimeAsync(1500)
    expect(w.find('.text-green').exists()).toBe(false)
  })

  it('is hidden for an image file (nothing text-shaped to copy)', async () => {
    markdownRead.mockImplementation(async (p: string) => ({
      ok: true as const,
      kind: 'image' as const,
      path: p,
      content: 'data:image/png;base64,iVBORw0KGgo='
    }))
    const w = mountPane()
    await settle()
    expect(w.find('button[aria-label="Copy file"]').exists()).toBe(false)
  })
})

describe('MarkdownPane — stale-on-disk banner (T171)', () => {
  let markdownChangedCb: ((p: { path: string }) => void) | undefined

  beforeEach(() => {
    const api = {
      markdownRead,
      markdownWrite,
      markdownWatchStart: vi.fn(async () => {}),
      markdownWatchStop: vi.fn(async () => {}),
      onMarkdownChanged: vi.fn((cb: (p: { path: string }) => void) => {
        markdownChangedCb = cb
        return () => {
          markdownChangedCb = undefined
        }
      }),
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn()
    }
    ;(window as unknown as { api: unknown }).api = new Proxy(api, {
      get(t: Record<string, unknown>, k: string) {
        return k in t ? t[k] : () => () => {}
      }
    })
  })

  it("registers the watcher on mount with the pane's filePath", async () => {
    const wrapper = mountPane()
    await settle()
    expect(wrapper.vm).toBeTruthy() // component mounted
    const api = window.api as unknown as { markdownWatchStart: ReturnType<typeof vi.fn> }
    expect(api.markdownWatchStart).toHaveBeenCalledWith('/wt/doc.md')
  })

  it('a clean pane silently reloads on a change event (no banner)', async () => {
    const wrapper = mountPane()
    await settle()
    markdownRead.mockImplementationOnce(async (p: string) => ({ ok: true, path: p, content: 'v2' }))
    markdownChangedCb?.({ path: '/wt/doc.md' })
    await settle()
    expect(wrapper.find('[data-testid="markdown-stale-banner"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('v2')
  })

  it('a DIRTY pane shows the stale banner instead of reloading', async () => {
    const wrapper = mountPane()
    await settle()
    await wrapper.get('button[aria-label="Edit"]').trigger('click')
    await wrapper.get('textarea').setValue('unsaved change')
    await nextTick()
    markdownChangedCb?.({ path: '/wt/doc.md' })
    await settle()
    expect(wrapper.find('[data-testid="markdown-stale-banner"]').exists()).toBe(true)
  })

  it('unregisters the watcher on unmount', async () => {
    const wrapper = mountPane()
    await settle()
    wrapper.unmount()
    const api = window.api as unknown as { markdownWatchStop: ReturnType<typeof vi.fn> }
    expect(api.markdownWatchStop).toHaveBeenCalledWith('/wt/doc.md')
  })
})
