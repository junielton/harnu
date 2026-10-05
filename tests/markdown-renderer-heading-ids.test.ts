// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownRenderer from '../src/renderer/src/components/MarkdownRenderer.vue'
import { i18n } from '@renderer/i18n'

/**
 * BUG-119 defect 3 — two blocks rendering the same source must not emit the same
 * element ids, and the `#anchor` scroll must keep working once they don't.
 *
 * The seam deduplicates WITHIN a render; the component adds a per-instance
 * prefix, which is what covers "the same document rendered twice on one page"
 * (a folder view listing card bodies, a memory pane beside a card modal). Both
 * halves are exercised here because either alone leaves a real collision.
 */
/**
 * jsdom ships no `CSS` object at all, so the component's `CSS.escape(id)` — which
 * the real Electron renderer has — throws here and swallows the click. Stub it,
 * the way the copy-button suite stubs `navigator.clipboard`: escaping the two
 * characters that could break out of an `[id="…"]` selector is enough for the
 * ids in play, and keeps the assertion about the LOOKUP, not about jsdom.
 */
beforeAll(() => {
  if (!(globalThis as { CSS?: unknown }).CSS) {
    Object.defineProperty(globalThis, 'CSS', {
      value: { escape: (value: string) => value.replace(/["\\]/g, '\\$&') },
      configurable: true
    })
  }
})

function mountSource(source: string) {
  return mount(MarkdownRenderer, { props: { source }, global: { plugins: [i18n] } })
}

const SOURCE = '# Report\n\n## Findings\n\n## Findings\n\n[jump](#findings)'

describe('MarkdownRenderer — heading ids are unique per instance', () => {
  it('two instances of the same source share no id', () => {
    const a = mountSource(SOURCE)
    const b = mountSource(SOURCE)
    const ids = (w: ReturnType<typeof mountSource>): string[] =>
      [...w.element.querySelectorAll('[id]')].map((n) => n.id)

    expect(ids(a)).toHaveLength(3)
    expect(ids(a)).toEqual(expect.arrayContaining([expect.stringMatching(/^md\d+-report$/)]))
    expect(ids(a).some((id) => ids(b).includes(id))).toBe(false)
    // Unique inside each instance too — the repeated `## Findings` is suffixed.
    expect(new Set(ids(a)).size).toBe(3)
  })

  it('an #anchor click still scrolls to its heading, prefix and all', async () => {
    const w = mountSource(SOURCE)
    const scrollIntoView = vi.fn()
    const heading = [...w.element.querySelectorAll('h2')][0] as HTMLElement
    heading.scrollIntoView = scrollIntoView

    // The author wrote `#findings`; the heading's real id is `md<n>-findings`.
    expect(heading.id).toMatch(/^md\d+-findings$/)
    await w.get('a[href="#findings"]').trigger('click')

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('resolves nothing — and does not throw — for an anchor with no heading', async () => {
    const w = mountSource('[nowhere](#missing)\n\n## Present')
    await expect(w.get('a[href="#missing"]').trigger('click')).resolves.toBeUndefined()
  })
})
