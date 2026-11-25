// @vitest-environment jsdom
/**
 * Mission dropdown · BUG-295 — a state glyph's tooltip never outlives a scroll.
 *
 * The tooltip is teleported to `body` with `position: fixed` and placed once, so a wheel scroll that moves the
 * glyph under a still pointer (Chromium sends `mouseleave` only on the next pointer move) used to leave it
 * floating over unrelated rows. design.md §6 "Mission dropdown" → "Dots and glyphs".
 *
 *  - AC-1  any scroll of an ancestor scroller, or of the window, hides an open tooltip at once, and the capture
 *          listener lives only while the tooltip shows.
 *  - AC-2  a tooltip shown by row focus hides on scroll and shows again, at the new position, when focus moves to
 *          another row by keyboard. A scroll the focus move itself caused (`focus()` scrolls the row into view)
 *          does not leave the tooltip off.
 *  - AC-3  the tooltip is never drawn when its glyph is outside the scroller's visible area.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { i18n } from '../src/renderer/src/i18n'
import MissionDot from '../src/renderer/src/components/MissionDot.vue'

let wrapper: VueWrapper | null = null

const q = (sel: string): HTMLElement | null => document.body.querySelector<HTMLElement>(sel)
const tip = (): HTMLElement | null => q('[role="tooltip"]')

interface Box {
  top: number
  height?: number
}
const rect = (top: number, height = 12, width = 12, left = 100): DOMRect =>
  ({
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({})
  }) as DOMRect

/** Where each glyph (keyed by its row's `data-row`) and the scroller sit; the tooltip is 64×20. */
const geometry: { scroller: Box; dots: Record<string, Box> } = {
  scroller: { top: 100, height: 200 },
  dots: { a: { top: 150 }, b: { top: 180 } }
}

function mockGeometry(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.getAttribute('role') === 'tooltip') return rect(0, 20, 64, 0)
    if (this.dataset.scroller) return rect(geometry.scroller.top, geometry.scroller.height, 420, 0)
    if (this.getAttribute('role') === 'img') {
      const row = this.closest<HTMLElement>('[data-row]')?.dataset.row ?? 'a'
      return rect(geometry.dots[row]?.top ?? 0)
    }
    return rect(0)
  })
}

/** A scroller (`overflow-y: auto`) holding two rows, each a `treeitem` with one glyph. */
function mountList(): HTMLElement {
  i18n.global.locale.value = 'en'
  const Host = defineComponent({
    render: () =>
      h(
        'div',
        { 'data-scroller': 'yes', 'data-test': 'scroller', style: 'overflow-y: auto' },
        ['a', 'b'].map((id, i) =>
          h('div', { role: 'treeitem', tabindex: i === 0 ? 0 : -1, 'data-row': id }, [
            h(MissionDot, { kind: 'step', state: i === 0 ? 'done' : 'running' })
          ])
        )
      )
  })
  wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body })
  return q('[data-test="scroller"]') as HTMLElement
}

const dotOf = (row: string): HTMLElement => q(`[data-row="${row}"] [role="img"]`) as HTMLElement
const rowOf = (row: string): HTMLElement => q(`[data-row="${row}"]`) as HTMLElement

const hover = async (row: string): Promise<void> => {
  dotOf(row).dispatchEvent(new MouseEvent('mouseenter'))
  await nextTick()
}
const focusRow = async (row: string): Promise<void> => {
  rowOf(row).dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  await nextTick()
}
const blurRow = async (row: string): Promise<void> => {
  rowOf(row).dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await nextTick()
}

/** Run the queued animation frames by hand: the test owns the frame clock. */
let frames: FrameRequestCallback[] = []
const runFrame = async (): Promise<void> => {
  const batch = frames
  frames = []
  batch.forEach((cb) => cb(0))
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  geometry.scroller = { top: 100, height: 200 }
  geometry.dots = { a: { top: 150 }, b: { top: 180 } }
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb)
    return frames.length
  })
  mockGeometry()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AC-1 — a scroll hides an open tooltip at once', () => {
  it('hides when the scroller that holds the glyph scrolls', async () => {
    const scroller = mountList()
    await hover('a')
    expect(tip()?.textContent?.trim()).toBe('Done')
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(tip()).toBeNull()
    expect(dotOf('a').getAttribute('aria-describedby')).toBeNull()
  })

  it('hides when the window (the document) scrolls', async () => {
    mountList()
    await hover('a')
    expect(tip()).not.toBeNull()
    document.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(tip()).toBeNull()
  })

  it('does not hide for a scroller that does not hold the glyph', async () => {
    mountList()
    const other = document.createElement('div')
    document.body.appendChild(other)
    await hover('a')
    other.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(tip()).not.toBeNull()
  })

  it('shows again on the next hover, placed at the glyph where it is now', async () => {
    const scroller = mountList()
    await hover('a')
    const before = tip()!.style.top
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    geometry.dots.a = { top: 250 }
    await hover('a')
    expect(tip()).not.toBeNull()
    expect(tip()!.style.top).not.toBe(before)
    expect(tip()!.style.top).toBe('224px') // 250 - 20 - 6
  })

  it('listens for scroll (capture) only while the tooltip shows', async () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const scrollCalls = (spy: typeof add): unknown[][] =>
      spy.mock.calls.filter((c) => c[0] === 'scroll')
    mountList()
    expect(scrollCalls(add)).toHaveLength(0)
    await hover('a')
    expect(scrollCalls(add)).toHaveLength(1)
    expect(scrollCalls(add)[0]![2]).toBe(true)
    dotOf('a').dispatchEvent(new MouseEvent('mouseleave'))
    await nextTick()
    expect(scrollCalls(remove)).toHaveLength(1)
    expect(scrollCalls(remove)[0]![1]).toBe(scrollCalls(add)[0]![1])
  })

  it('removes the listener when the glyph unmounts while the tooltip shows', async () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    mountList()
    await hover('a')
    wrapper?.unmount()
    wrapper = null
    expect(remove.mock.calls.filter((c) => c[0] === 'scroll')).toHaveLength(1)
  })
})

describe('AC-2 — a tooltip shown by row focus', () => {
  it('hides on scroll, and the focused row shows its own again when focus moves by keyboard', async () => {
    const scroller = mountList()
    await focusRow('a')
    await runFrame() // the focus is settled: what follows is the operator scrolling
    expect(tip()?.textContent?.trim()).toBe('Done')

    scroller.dispatchEvent(new Event('scroll'))
    await runFrame() // a later frame: nothing brings it back on its own
    expect(tip()).toBeNull()

    // ArrowDown: row a loses focus, row b takes it.
    await blurRow('a')
    geometry.dots.b = { top: 220 }
    await focusRow('b')
    expect(tip()?.textContent?.trim()).toBe('Running')
    expect(tip()!.style.top).toBe('194px') // 220 - 20 - 6: the glyph's new position
  })

  it('keeps the tooltip of a row whose own focus() scrolled it into view', async () => {
    const scroller = mountList()
    await focusRow('b')
    // The browser dispatches the scroll `focus()` caused in the same frame, before animation frames run.
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(tip()).toBeNull()
    await runFrame()
    expect(tip()?.textContent?.trim()).toBe('Running')
  })

  it('a scroll after that frame hides it for good', async () => {
    const scroller = mountList()
    await focusRow('b')
    await runFrame()
    scroller.dispatchEvent(new Event('scroll'))
    await runFrame()
    expect(tip()).toBeNull()
  })
})

describe('AC-3 — never drawn outside the scroller’s visible area', () => {
  it('draws nothing for a glyph scrolled above the visible area', async () => {
    mountList()
    geometry.dots.a = { top: 60 } // the scroller starts at 100
    await hover('a')
    expect(tip()).toBeNull()
    expect(dotOf('a').getAttribute('aria-describedby')).toBeNull()
  })

  it('draws nothing for a glyph scrolled below the visible area', async () => {
    mountList()
    geometry.dots.a = { top: 320 } // the scroller ends at 300
    await hover('a')
    expect(tip()).toBeNull()
  })

  it('draws nothing for a focused row whose glyph is out of view', async () => {
    mountList()
    geometry.dots.b = { top: 400 }
    await focusRow('b')
    expect(tip()).toBeNull()
  })

  it('draws it for a glyph inside the visible area', async () => {
    mountList()
    await hover('a')
    expect(tip()).not.toBeNull()
  })
})
