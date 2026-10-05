// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ImageLightbox from '../src/renderer/src/components/ImageLightbox.vue'
import type { SessionImage } from '../src/renderer/src/composables/useSessionImages'
import { i18n } from '@renderer/i18n'

/**
 * T186 — the lightbox's index math. `index` is owned by `StatusFooter.vue`, so
 * every navigation here is observed through the `update:index` / `close` events
 * the real parent listens to, not through internal state.
 *
 * The entries watcher matters because the 2s image poll keeps running while the
 * lightbox is open: pruning isn't guaranteed to happen at the END of the list,
 * so the viewed file has to be tracked BY NAME — an index-only guard would
 * silently swap the displayed image when an EARLIER file gets pruned.
 */

const UUID = '11111111-2222-4333-8444-555555555555'

function entries(...names: string[]): SessionImage[] {
  return names.map((name, i) => ({
    name,
    path: `/img/${name}`,
    bytes: 10 * (i + 1),
    mtimeMs: i + 1,
    dataUrl: `data:image/png;base64,${name}`
  }))
}

let mounted: ReturnType<typeof mount>[] = []

function mountAt(list: SessionImage[], index: number) {
  const w = mount(ImageLightbox, {
    props: { entries: list, index, uuid: UUID, folderAlias: 'harnu', canReattach: true },
    global: { plugins: [i18n] }
  })
  mounted.push(w)
  return w
}

// The lightbox teleports to `body`, so its markup never lands inside the
// wrapper — query the real document instead of `wrapper.find`.
function q(selector: string): HTMLElement | null {
  return document.body.querySelector(selector)
}
async function click(selector: string): Promise<void> {
  const el = q(selector)
  if (!el) throw new Error(`no element matched ${selector}`)
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  // Proxy stub: any `window.api.*` these tests don't care about is a no-op.
  ;(window as unknown as { api: unknown }).api = new Proxy(
    { imageCacheCopy: vi.fn(async () => ({ ok: true })) },
    {
      get(t: Record<string, unknown>, k: string) {
        return k in t ? t[k as keyof typeof t] : () => () => {}
      }
    }
  )
})

afterEach(() => {
  // Unmount BEFORE wiping the DOM — the lightbox holds live `window` keydown
  // listeners (Esc / ← / →) that a raw innerHTML reset would leak.
  mounted.forEach((w) => w.unmount())
  mounted = []
  document.body.innerHTML = ''
})

describe('ImageLightbox — prev/next', () => {
  it('steps forward and back within the list', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 1)
    await click('[aria-label="Next image"]')
    expect(w.emitted('update:index')?.at(-1)).toEqual([2])
    await click('[aria-label="Previous image"]')
    expect(w.emitted('update:index')?.at(-1)).toEqual([0])
  })

  it('wraps forward at the end of the list', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 2)
    await click('[aria-label="Next image"]')
    expect(w.emitted('update:index')?.at(-1)).toEqual([0])
  })

  it('wraps backward at the start of the list', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 0)
    await click('[aria-label="Previous image"]')
    expect(w.emitted('update:index')?.at(-1)).toEqual([2])
  })

  it('never navigates (and never emits NaN) on an empty list', async () => {
    const w = mountAt([], 0)
    // Independent signal: with nothing to show, the nav buttons aren't even rendered…
    expect(q('[aria-label="Next image"]')).toBeNull()
    // …and the keyboard path is a no-op rather than emitting NaN.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    await flushPromises()
    expect(w.emitted('update:index')).toBeUndefined()
  })

  it('the filmstrip jumps straight to an arbitrary image', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 0)
    const strip = document.body.querySelectorAll('button[aria-label^="Image "]')
    expect(strip).toHaveLength(3)
    ;(strip[2] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(w.emitted('update:index')?.at(-1)).toEqual([2])
  })

  it('← / → keys drive the same wraparound as the buttons', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))
    await flushPromises()
    expect(w.emitted('update:index')?.at(-1)).toEqual([2])
  })
})

describe('ImageLightbox — entries changing underneath it', () => {
  it('re-points the index when the viewed file merely SHIFTED position', async () => {
    // Viewing 2.png at index 1; a newer 4.png lands at the head of the list.
    const w = mountAt(entries('3.png', '2.png', '1.png'), 1)
    await w.setProps({ entries: entries('4.png', '3.png', '2.png', '1.png') })
    await flushPromises()
    // Independent signals: it followed the FILE, not the slot, and stayed open.
    expect(w.emitted('update:index')?.at(-1)).toEqual([2])
    expect(w.emitted('close')).toBeUndefined()
  })

  it('closes when the viewed file disappears from the list', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 1)
    await w.setProps({ entries: entries('3.png', '1.png') })
    await flushPromises()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('does NOT swap the displayed image when an EARLIER file is pruned', async () => {
    // Viewing 1.png at index 2. Pruning 3.png would leave index 2 out of range
    // and index 1 pointing at a different file — the by-name track must re-point.
    const w = mountAt(entries('3.png', '2.png', '1.png'), 2)
    await w.setProps({ entries: entries('2.png', '1.png') })
    await flushPromises()
    expect(w.emitted('update:index')?.at(-1)).toEqual([1])
    expect(w.emitted('close')).toBeUndefined()
  })

  it('stays put when a poll returns the same list', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 1)
    await w.setProps({ entries: entries('3.png', '2.png', '1.png') })
    await flushPromises()
    expect(w.emitted('update:index')).toBeUndefined()
    expect(w.emitted('close')).toBeUndefined()
  })

  it('tracks the file the PARENT navigated to, not the one it opened on', async () => {
    const w = mountAt(entries('3.png', '2.png', '1.png'), 0)
    // Parent moves to 1.png (index 2), the way `update:index` would drive it…
    await w.setProps({ index: 2 })
    // …then 3.png (the originally-viewed file) is pruned.
    await w.setProps({ entries: entries('2.png', '1.png') })
    await flushPromises()
    // Independent signals: still open, re-pointed at 1.png's new slot.
    expect(w.emitted('close')).toBeUndefined()
    expect(w.emitted('update:index')?.at(-1)).toEqual([1])
  })
})
