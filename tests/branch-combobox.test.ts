// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BranchCombobox from '../src/renderer/src/components/ui/BranchCombobox.vue'
import type { BranchRef } from '../src/main/worktree-core'

const BRANCHES: BranchRef[] = [
  { name: 'main', remote: false, head: 'abc1111' },
  { name: 'feature/login', remote: false, head: 'def2222' },
  { name: 'origin/main', remote: true, head: 'abc1111' },
  { name: 'origin/release', remote: true, head: 'ghi3333' }
]

let mounted: ReturnType<typeof mount>[] = []

function mountCombobox(modelValue = '', loading = false): ReturnType<typeof mount> {
  const w = mount(BranchCombobox, {
    props: {
      modelValue,
      branches: BRANCHES,
      loading,
      placeholder: 'Select a branch…',
      localLabel: 'Local',
      remoteLabel: 'Remote',
      noMatchLabel: 'No branches match',
      searchPlaceholder: 'Search branches…'
    }
  })
  mounted.push(w)
  return w
}

function rowNames(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-branch-combobox-row]')).map((el) =>
    el.getAttribute('data-branch-name')
  )
}

function mockRects(triggerRect: Partial<DOMRect>, panelRect: Partial<DOMRect>): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const source = this.hasAttribute('data-branch-combobox-trigger')
      ? triggerRect
      : this.hasAttribute('data-branch-combobox-panel')
        ? panelRect
        : {}
    return {
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...source
    }
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}

afterEach(() => {
  // Unmount every wrapper this test created BEFORE wiping the DOM — a
  // component left open still holds a live `window` mousedown listener
  // (added by its own `watch(open, …)`); a raw `innerHTML = ''` never runs
  // Vue's unmount lifecycle, so that listener leaks into later tests and
  // fires against DOM nodes this test just deleted.
  mounted.forEach((w) => w.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('BranchCombobox', () => {
  it('shows the placeholder when nothing is selected', () => {
    const w = mountCombobox('')
    expect(w.get('[data-branch-combobox-trigger]').text()).toBe('Select a branch…')
  })

  it('shows the selected branch name in the trigger', () => {
    const w = mountCombobox('feature/login')
    expect(w.get('[data-branch-combobox-trigger]').text()).toBe('feature/login')
  })

  it('opens the panel on trigger click, grouped Local then Remote', async () => {
    const w = mountCombobox()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    expect(document.querySelector('[data-branch-combobox-panel]')).not.toBeNull()
    expect(rowNames()).toEqual(['', 'main', 'feature/login', 'origin/main', 'origin/release'])
  })

  it('filters rows as the search query changes', async () => {
    const w = mountCombobox()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    search.value = 'login'
    search.dispatchEvent(new Event('input'))
    await w.vm.$nextTick()
    expect(rowNames()).toEqual(['feature/login'])
  })

  it('hides a group header when filtering leaves it empty', async () => {
    const w = mountCombobox()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    search.value = 'origin'
    search.dispatchEvent(new Event('input'))
    await w.vm.$nextTick()
    const panel = document.querySelector('[data-branch-combobox-panel]') as HTMLElement
    expect(panel.textContent).not.toContain('Local')
    expect(panel.textContent).toContain('Remote')
  })

  it('shows the no-match row when nothing matches', async () => {
    const w = mountCombobox()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    search.value = 'zzz-does-not-exist'
    search.dispatchEvent(new Event('input'))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-branch-combobox-empty]')?.textContent).toBe(
      'No branches match'
    )
  })

  it('emits the branch name and closes the panel on row click', async () => {
    const w = mountCombobox()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const row = document.querySelector('[data-branch-name="feature/login"]') as HTMLElement
    row.click()
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['feature/login'])
    expect(document.querySelector('[data-branch-combobox-panel]')).toBeNull()
  })

  it('emits an empty string when the placeholder row is clicked', async () => {
    const w = mountCombobox('main')
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const row = document.querySelector('[data-branch-name=""]') as HTMLElement
    row.click()
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')?.[0]).toEqual([''])
  })

  it('does not open when loading is true', async () => {
    const w = mountCombobox('', true)
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    expect(document.querySelector('[data-branch-combobox-panel]')).toBeNull()
  })

  it('ArrowDown then Enter selects the next row', async () => {
    const w = mountCombobox('')
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['main'])
  })

  it('Escape closes the panel without emitting a selection', async () => {
    const w = mountCombobox('main')
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-branch-combobox-panel]')).toBeNull()
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('Escape does not bubble past the search input', async () => {
    const w = mountCombobox('main')
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    let bubbled = false
    document.addEventListener('keydown', () => {
      bubbled = true
    })
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()
    expect(bubbled).toBe(false)
  })

  it('closes on an outside mousedown without changing the selection', async () => {
    const w = mountCombobox('main')
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-branch-combobox-panel]')).toBeNull()
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('stays open on a mousedown inside the panel', async () => {
    const w = mountCombobox('main')
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    search.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(document.querySelector('[data-branch-combobox-panel]')).not.toBeNull()
  })

  it('reseeds the highlight to the current selection when reopening after a stale search', async () => {
    const w = mountCombobox('origin/release')
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const search = document.querySelector('[data-branch-combobox-search]') as HTMLInputElement
    search.value = 'orig'
    search.dispatchEvent(new Event('input'))
    await w.vm.$nextTick()
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await w.vm.$nextTick()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    const reopenedSearch = document.querySelector(
      '[data-branch-combobox-search]'
    ) as HTMLInputElement
    reopenedSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await w.vm.$nextTick()
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['origin/release'])
  })

  it('positions the panel below the trigger when there is room', async () => {
    const restore = mockRects(
      { top: 100, bottom: 132, left: 20, right: 220, width: 200, height: 32 },
      { top: 0, bottom: 200, left: 0, right: 0, width: 200, height: 200 }
    )
    window.innerHeight = 600
    const w = mountCombobox()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    await w.vm.$nextTick()
    const panel = document.querySelector('[data-branch-combobox-panel]') as HTMLElement
    expect(panel.style.top).toBe('136px')
    expect(panel.style.bottom).toBe('auto')
    restore()
  })

  it('flips the panel above the trigger when it would overflow the viewport', async () => {
    const restore = mockRects(
      { top: 550, bottom: 582, left: 20, right: 220, width: 200, height: 32 },
      { top: 0, bottom: 200, left: 0, right: 0, width: 200, height: 200 }
    )
    window.innerHeight = 600
    const w = mountCombobox()
    await w.get('[data-branch-combobox-trigger]').trigger('click')
    await w.vm.$nextTick()
    const panel = document.querySelector('[data-branch-combobox-panel]') as HTMLElement
    expect(panel.style.top).toBe('auto')
    expect(panel.style.bottom).toBe('54px')
    restore()
  })
})
