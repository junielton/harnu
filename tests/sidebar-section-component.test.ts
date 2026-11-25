// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@renderer/i18n'
import SidebarSection from '../src/renderer/src/components/SidebarSection.vue'
import { resetSidebarSectionsForTests } from '../src/renderer/src/composables/useSidebarSections'

let wrapper: VueWrapper | null = null

/** A column like the sidebar: a list island above the section, both inside one parent. */
function mountSection(props: Record<string, unknown> = {}): VueWrapper {
  const host = document.createElement('div')
  document.body.appendChild(host)
  wrapper = mount(SidebarSection, {
    attachTo: host,
    global: { plugins: [i18n] },
    props: { id: 'demo', label: 'Demo', ...props },
    attrs: { 'data-island': 'sidebar-demo' },
    slots: { eyebrow: '<span>Demo · 3</span>', default: '<p data-testid="row">a row</p>' }
  })
  // VTU mounts into its own container; the list island must be the section's sibling, as in the aside
  const list = document.createElement('div')
  list.setAttribute('data-island', 'sidebar-list')
  wrapper.element.parentElement?.insertBefore(list, wrapper.element)
  return wrapper
}

/** jsdom has no layout: give the wrapper and the list the heights the drag reads. */
function fakeLayout(w: VueWrapper, section: number, list: number): void {
  Object.defineProperty(w.element, 'offsetHeight', { configurable: true, get: () => section })
  const listEl = w.element.parentElement?.querySelector('[data-island="sidebar-list"]')
  Object.defineProperty(listEl, 'offsetHeight', { configurable: true, get: () => list })
}

function move(y: number): void {
  document.dispatchEvent(new MouseEvent('mousemove', { clientY: y }))
}

beforeEach(() => {
  localStorage.clear()
  resetSidebarSectionsForTests()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SidebarSection', () => {
  it('puts the section attributes on the island and keeps the shell free of section logic', () => {
    const w = mountSection()
    expect(w.find('[data-island="sidebar-demo"]').exists()).toBe(true)
    expect(w.get('[data-section-body]').text()).toContain('a row')
    expect(w.text()).toContain('Demo · 3')
  })

  it('is content-sized and capped until it is dragged', () => {
    const w = mountSection({ autoMaxHeight: 'min(380px, 45vh)' })
    const style = (w.element as HTMLElement).style
    expect(style.maxHeight).toBe('min(380px, 45vh)')
    expect(style.height).toBe('')
  })

  it('the chevron collapses to the eyebrow and expands again, with aria-expanded and labels', async () => {
    const w = mountSection()
    const btn = w.get('[data-section-toggle]')
    expect(btn.attributes('aria-expanded')).toBe('true')
    expect(btn.attributes('aria-label')).toBe('Collapse Demo')
    expect(btn.attributes('aria-controls')).toBe(w.get('[data-section-body]').attributes('id'))
    expect(w.find('[role="separator"]').exists()).toBe(true)

    await btn.trigger('click')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(btn.attributes('aria-label')).toBe('Expand Demo')
    expect((w.get('[data-section-body]').element as HTMLElement).style.display).toBe('none')
    // the eyebrow (title and the chevron) stays; there is nothing to resize while collapsed
    expect(w.text()).toContain('Demo · 3')
    expect(w.find('[role="separator"]').exists()).toBe(false)

    await btn.trigger('click')
    expect(btn.attributes('aria-expanded')).toBe('true')
    expect(w.find('[role="separator"]').exists()).toBe(true)
  })

  it('the chevron is a real button, so Enter and Space operate it', () => {
    const w = mountSection()
    expect(w.get('[data-section-toggle]').element.tagName).toBe('BUTTON')
    expect(w.get('[data-section-toggle]').attributes('type')).toBe('button')
  })

  it('the handle is a horizontal separator with a row-resize cursor', () => {
    const w = mountSection()
    const h = w.get('[data-section-handle]')
    expect(h.attributes('role')).toBe('separator')
    expect(h.attributes('aria-orientation')).toBe('horizontal')
    expect(h.attributes('aria-label')).toBe('Resize Demo')
    expect(h.classes()).toContain('cursor-row-resize')
    expect(h.classes()).toContain('h-1.5')
  })

  it('dragging up grows the section 1:1 and persists it; dragging down shrinks it', async () => {
    const w = mountSection()
    fakeLayout(w, 200, 600)
    await w.get('[data-section-handle]').trigger('mousedown', { clientY: 500 })
    move(450)
    await w.vm.$nextTick()
    expect((w.element as HTMLElement).style.height).toBe('250px')
    move(530)
    await w.vm.$nextTick()
    expect((w.element as HTMLElement).style.height).toBe('170px')
    document.dispatchEvent(new MouseEvent('mouseup'))
    // the listeners are gone after mouseup
    move(0)
    await w.vm.$nextTick()
    expect((w.element as HTMLElement).style.height).toBe('170px')
    expect(JSON.parse(localStorage.getItem('om2tab.sidebarSection.demo') as string).height).toBe(
      170
    )
  })

  it('never shrinks below the floor and never takes the folder list below its minimum', async () => {
    const w = mountSection({ minHeight: 88, maxHeight: 640 })
    // list is 260px tall, its minimum is min(160, 40% of the window) — the window is 768 tall in jsdom
    fakeLayout(w, 200, 260)
    await w.get('[data-section-handle]').trigger('mousedown', { clientY: 500 })
    move(0) // a huge pull up: only the list's 100px of spare room is available
    await w.vm.$nextTick()
    expect((w.element as HTMLElement).style.height).toBe('300px')
    move(2000) // a huge pull down: the floor
    await w.vm.$nextTick()
    expect((w.element as HTMLElement).style.height).toBe('88px')
    document.dispatchEvent(new MouseEvent('mouseup'))
  })

  it('double-click on the handle goes back to the default height', async () => {
    const w = mountSection({ autoMaxHeight: '168px' })
    fakeLayout(w, 200, 600)
    await w.get('[data-section-handle]').trigger('mousedown', { clientY: 500 })
    move(400)
    document.dispatchEvent(new MouseEvent('mouseup'))
    await w.vm.$nextTick()
    expect((w.element as HTMLElement).style.height).toBe('300px')
    await w.get('[data-section-handle]').trigger('dblclick')
    expect((w.element as HTMLElement).style.height).toBe('')
    expect((w.element as HTMLElement).style.maxHeight).toBe('168px')
  })

  it('keeps size and collapsed state when the section unmounts and mounts again (zone hides when empty)', async () => {
    const first = mountSection()
    fakeLayout(first, 200, 600)
    await first.get('[data-section-handle]').trigger('mousedown', { clientY: 500 })
    move(440)
    document.dispatchEvent(new MouseEvent('mouseup'))
    await first.get('[data-section-toggle]').trigger('click')
    first.unmount()
    wrapper = null
    document.body.innerHTML = ''

    const second = mountSection()
    expect(second.get('[data-section-toggle]').attributes('aria-expanded')).toBe('false')
    await second.get('[data-section-toggle]').trigger('click')
    expect((second.element as HTMLElement).style.height).toBe('260px')
  })

  it('a warning tone paints the eyebrow in --color-warning, the default in --text-4', () => {
    expect(mountSection({ tone: 'warning' }).find('.text-warning').exists()).toBe(true)
    wrapper?.unmount()
    document.body.innerHTML = ''
    expect(mountSection().find('.text-text-4').exists()).toBe(true)
  })
})
