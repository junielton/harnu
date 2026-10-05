// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import MarkdownPane, {
  __resetMarkdownDraftCacheForTests
} from '../src/renderer/src/components/MarkdownPane.vue'
import { i18n } from '@renderer/i18n'

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
