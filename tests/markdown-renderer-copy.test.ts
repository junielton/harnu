// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownRenderer from '../src/renderer/src/components/MarkdownRenderer.vue'
import { i18n } from '@renderer/i18n'

/**
 * T121 — per-code-block copy button, wired in `MarkdownRenderer.vue`'s delegated click
 * handler. `navigator.clipboard` doesn't exist in jsdom, so every case stubs it; nothing
 * here ever performs a real system clipboard write.
 */
const writeText = vi.fn(async () => undefined)

beforeEach(() => {
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  })
  vi.useFakeTimers()
})

function mountSource(source: string) {
  return mount(MarkdownRenderer, {
    props: { source },
    global: { plugins: [i18n] }
  })
}

describe('MarkdownRenderer — code block copy button', () => {
  it('clicking the button copies the RAW fence content, not the rendered node text', async () => {
    const w = mountSource('```\n<div>weird &amp; text</div>\n```')
    const btn = w.find('.md-code-copy-btn')
    expect(btn.exists()).toBe(true)

    await btn.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('<div>weird &amp; text</div>\n')
  })

  it('shows a transient "copied" state that reverts to idle after the timeout', async () => {
    const w = mountSource('```\nhello\n```')
    const btn = w.get('.md-code-copy-btn')

    expect(btn.classes()).not.toContain('is-copied')
    expect(btn.attributes('aria-label')).toBe('Copy code')

    await btn.trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(btn.classes()).toContain('is-copied')
    expect(btn.attributes('aria-label')).toBe('Copied')

    await vi.advanceTimersByTimeAsync(1500)
    expect(btn.classes()).not.toContain('is-copied')
    expect(btn.attributes('aria-label')).toBe('Copy code')
  })

  it('keeps multiple blocks independent — copying one never disturbs another', async () => {
    const w = mountSource('```\nfirst\n```\n\n```\nsecond\n```')
    const btns = w.findAll('.md-code-copy-btn')
    expect(btns).toHaveLength(2)

    await btns[0].trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(writeText).toHaveBeenCalledWith('first\n')
    expect(btns[0].classes()).toContain('is-copied')
    expect(btns[1].classes()).not.toContain('is-copied')

    await btns[1].trigger('click')
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledWith('second\n')
    expect(btns[0].classes()).toContain('is-copied')
    expect(btns[1].classes()).toContain('is-copied')

    // Only block 2's timer should be scheduled at this new base — advancing 1500ms
    // reverts BOTH here since both were clicked back-to-back at ~t=0, but each was
    // scheduled independently (a real per-button WeakMap timer, not a shared one).
    await vi.advanceTimersByTimeAsync(1500)
    expect(btns[0].classes()).not.toContain('is-copied')
    expect(btns[1].classes()).not.toContain('is-copied')
  })

  it('does not copy or throw when the clipboard write rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    const w = mountSource('```\nhello\n```')
    const btn = w.get('.md-code-copy-btn')

    await btn.trigger('click')
    await vi.advanceTimersByTimeAsync(0)

    expect(btn.classes()).not.toContain('is-copied')
    expect(btn.attributes('aria-label')).toBe('Copy code')
  })
})
