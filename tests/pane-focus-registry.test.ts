// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import {
  registerFocusRegion,
  focusedRegionId,
  focusRegion,
  closeRegion,
  resetFocusRegionsForTests
} from '../src/renderer/src/composables/useTerminalFocus'
import MarkdownPane, {
  __resetMarkdownDraftCacheForTests
} from '../src/renderer/src/components/MarkdownPane.vue'
import MemoryPane from '../src/renderer/src/components/MemoryPane.vue'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { i18n } from '@renderer/i18n'

/**
 * T486 U5b — the pane-focus registry (`useTerminalFocus.ts`, spec §8.1). Every
 * focus region registers `{ id, el, focus(), close?() }` and carries
 * `data-focus-region="<id>"` on its root; the region holding
 * `document.activeElement` is the current one.
 *
 * AC-27 is checked end to end on the real MarkdownPane: `pane.close` reaches the
 * pane's OWN close path, so a dirty draft keeps its discard guard.
 */

function region(id: string): HTMLDivElement {
  const el = document.createElement('div')
  el.setAttribute('data-focus-region', id)
  const inner = document.createElement('textarea')
  el.appendChild(inner)
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  resetFocusRegionsForTests()
  document.body.innerHTML = ''
})

describe('registry', () => {
  it('the current region is the registered one containing document.activeElement', () => {
    const a = region('a')
    const b = region('b')
    registerFocusRegion({ id: 'a', el: a, focus: () => a.querySelector('textarea')!.focus() })
    registerFocusRegion({ id: 'b', el: b, focus: () => b.querySelector('textarea')!.focus() })
    expect(focusedRegionId()).toBeNull()
    expect(focusRegion('b')).toBe(true)
    expect(focusedRegionId()).toBe('b')
    focusRegion('a')
    expect(focusedRegionId()).toBe('a')
  })

  it('an element outside every region, or in an unregistered one, is no region', () => {
    const stray = region('stray')
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    expect(focusedRegionId()).toBeNull()
    stray.querySelector('textarea')!.focus()
    expect(focusedRegionId()).toBeNull()
  })

  it('closeRegion runs the region close() and reports whether it had one', () => {
    const close = vi.fn()
    registerFocusRegion({ id: 'x', el: region('x'), focus: () => {}, close })
    registerFocusRegion({ id: 'main', el: region('main'), focus: () => {} })
    expect(closeRegion('x')).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
    expect(closeRegion('main')).toBe(false)
    expect(closeRegion('nope')).toBe(false)
    expect(focusRegion('nope')).toBe(false)
  })

  it('a disposer only removes its own registration (a remount under the same id wins)', () => {
    const first = registerFocusRegion({ id: 'p', el: region('p'), focus: () => {} })
    const secondFocus = vi.fn()
    registerFocusRegion({ id: 'p', el: region('p'), focus: secondFocus })
    first()
    expect(focusRegion('p')).toBe(true)
    expect(secondFocus).toHaveBeenCalled()
  })
})

describe('non-xterm panes register themselves (AC-25, AC-27)', () => {
  const markdownRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, content: 'hi' }))

  beforeEach(() => {
    __resetMarkdownDraftCacheForTests()
    const api = {
      markdownRead,
      helpersGet: vi.fn(async () => null),
      helpersSet: vi.fn(),
      memoryRead: vi.fn(async () => ({ ok: true, pages: [] }))
    }
    ;(window as unknown as { api: unknown }).api = new Proxy(api, {
      get(t: Record<string, unknown>, k: string) {
        return k in t ? t[k] : () => () => {}
      }
    })
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await flushPromises()
      await nextTick()
    }
  }

  const MD = { id: 'h-md', type: 'markdown' as const, cwd: '/wt', ratio: 1, filePath: '/wt/a.md' }

  it('MarkdownPane: a focusable root carrying data-focus-region, focused through the registry', async () => {
    const w = mount(MarkdownPane, {
      props: { pane: { ...MD }, worktreePath: '/wt' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await settle()
    const root = w.get('[data-focus-region="h-md"]')
    expect(root.attributes('tabindex')).toBe('-1')
    expect(focusRegion('h-md')).toBe(true)
    expect(focusedRegionId()).toBe('h-md')
    w.unmount()
    expect(focusRegion('h-md')).toBe(false)
  })

  it('MarkdownPane: a dirty draft keeps its discard guard on pane.close', async () => {
    const helpers = useHelpersStore()
    const remove = vi.spyOn(helpers, 'removeHelper').mockImplementation(() => {})
    const w = mount(MarkdownPane, {
      props: { pane: { ...MD }, worktreePath: '/wt' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await settle()
    await w.get('button[aria-label="Edit"]').trigger('click')
    await w.get('textarea').setValue('unsaved change')
    await nextTick()
    expect(closeRegion('h-md')).toBe(true)
    // Held by the guard: the discard toast decides, not the chord.
    expect(remove).not.toHaveBeenCalled()
    w.unmount()
  })

  it('MarkdownPane: a clean pane closes through removeHelper', async () => {
    const helpers = useHelpersStore()
    const remove = vi.spyOn(helpers, 'removeHelper').mockImplementation(() => {})
    const w = mount(MarkdownPane, {
      props: { pane: { ...MD }, worktreePath: '/wt' },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await settle()
    expect(closeRegion('h-md')).toBe(true)
    expect(remove).toHaveBeenCalledWith('/wt', 'h-md')
    w.unmount()
  })

  it('MemoryPane registers a focusable root', async () => {
    const w = mount(MemoryPane, {
      props: {
        pane: { id: 'h-mem', type: 'memory' as const, cwd: '/wt', ratio: 1, folder: '/wt' },
        worktreePath: '/wt'
      },
      global: { plugins: [i18n] },
      attachTo: document.body
    })
    await settle()
    expect(w.get('[data-focus-region="h-mem"]').attributes('tabindex')).toBe('-1')
    expect(focusRegion('h-mem')).toBe(true)
    expect(focusedRegionId()).toBe('h-mem')
    w.unmount()
  })
})

/**
 * AC-25's indicator is a visual check, but its contract is a class on the root:
 * a 1px accent-line outline while focus is inside (design.md §6 "Pane focus").
 */
describe('focus indicator classes (AC-25)', () => {
  it('every non-xterm pane root carries the focus-within outline, xterm panes do not', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const read = (f: string): string =>
      readFileSync(resolve(__dirname, '../src/renderer/src/components', f), 'utf8')
    const INDICATOR = 'focus-within:outline-accent-line'
    for (const f of ['MarkdownPane.vue', 'MemoryPane.vue', 'ExplorerPane.vue', 'DiagramPane.vue']) {
      // The global :focus-visible ring sits outside the box (clipped by the stack)
      // and would win over the layered utility, so the root opts out of it.
      const rootClass = /class="([^"]*focus-within:outline-accent-line[^"]*)"/.exec(read(f))?.[1]
      expect(rootClass, f).toContain('no-default-ring')
      expect(rootClass, f).toContain('focus-within:-outline-offset-1')
    }
    for (const f of ['HelperPane.vue', 'TerminalPane.vue']) {
      expect(read(f), f).not.toContain(INDICATOR)
    }
  })

  it('all six focus regions register through useFocusRegion and mark their root', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    for (const f of [
      'TerminalPane.vue',
      'HelperPane.vue',
      'MarkdownPane.vue',
      'MemoryPane.vue',
      'ExplorerPane.vue',
      'DiagramPane.vue'
    ]) {
      const src = readFileSync(resolve(__dirname, '../src/renderer/src/components', f), 'utf8')
      expect(src, f).toContain('useFocusRegion(')
      expect(src, f).toContain(':data-focus-region=')
    }
  })
})
