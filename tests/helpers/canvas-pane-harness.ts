import { expect, type Mock } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import DiagramPane from '../../src/renderer/src/components/DiagramPane.vue'
import { i18n } from '@renderer/i18n'
import type { CanvasDocument } from '../../src/main/canvas-core'

/**
 * Shared harness for the tests that mount the real `DiagramPane` under jsdom.
 * Each test file still owns its `window.api` mock (the documents and the spies
 * differ per file); what lives here is the mounting, the settling and the input
 * primitives every pane test drives the board with.
 *
 * Under the jsdom SVG shim (`jsdom-svg.ts`) every screen CTM is the identity, so
 * a client point IS the graph-local point.
 */

/** The pane every canvas test mounts unless it says otherwise. */
export const CANVAS_PANE = {
  id: 'h-canvas',
  type: 'canvas' as const,
  cwd: '/wt',
  ratio: 1,
  filePath: '/wt/board.harnucanvas.json'
}
export type CanvasPaneProps = typeof CANVAS_PANE

const mounted = new Set<VueWrapper>()

/**
 * Mount a canvas pane. Tracked, so {@link unmountPanes} (in an `afterEach`) tears
 * down whatever a test left mounted; a test that unmounts on its own is dropped
 * from the set first, so nothing is unmounted twice.
 */
export function mountPane(
  pane: Partial<CanvasPaneProps> = {},
  opts: { attachTo?: Element } = {}
): VueWrapper {
  const w = mount(DiagramPane, {
    props: { pane: { ...CANVAS_PANE, ...pane }, worktreePath: '/wt' },
    global: { plugins: [i18n] },
    attachTo: opts.attachTo ?? document.body
  })
  const unmount = w.unmount.bind(w)
  w.unmount = () => {
    mounted.delete(w)
    unmount()
  }
  mounted.add(w)
  return w
}

/** Unmount every pane {@link mountPane} mounted and the test did not unmount itself. */
export function unmountPanes(): void {
  for (const w of [...mounted]) w.unmount()
}

/** Let the load, the draw and X6's time-sliced render land. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await nextTick()
  }
}

/**
 * Press Save and return the document the pane handed the confined writer — the
 * very bytes a Save would put on disk. Reads the `canvasWrite` spy off
 * `window.api`, which every pane test's mock defines.
 */
export async function saveAndRead(w: VueWrapper): Promise<CanvasDocument> {
  await w.find('[data-testid="diagram-save"]').trigger('click')
  await settle()
  const write = (window as unknown as { api: { canvasWrite: Mock } }).api.canvasWrite
  const calls = write.mock.calls as unknown as [string, CanvasDocument][]
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][1]
}

// ── DOM handles ─────────────────────────────────────────────────────────────
export function svgOf(w: VueWrapper): Element {
  return w.element.querySelector('[data-testid="diagram-canvas-host"] svg')!
}
export function bodyOf(w: VueWrapper): HTMLElement {
  return w.element.querySelector('[data-testid="diagram-canvas-host"]')!
    .parentElement as HTMLElement
}
export function nodeEl(w: VueWrapper, id: string): Element {
  return w.element.querySelector(`[data-cell-id="${id}"]`)!
}

// ── Input ───────────────────────────────────────────────────────────────────
/** Focus inside the pane — every shortcut is gated on it. */
export function focusPane(w: VueWrapper): void {
  bodyOf(w).focus()
}
export function key(k: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
}
export function keyUp(k: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }))
}

export function down(el: Element, at: [number, number], init: MouseEventInit = {}): void {
  el.dispatchEvent(
    new MouseEvent('mousedown', {
      bubbles: true,
      button: 0,
      clientX: at[0],
      clientY: at[1],
      ...init
    })
  )
}
/**
 * Moves and the release go to `document`, as in the real app: X6 listens there
 * for the rest of a drag (and stops listening for the NEXT press until it sees
 * the release), while the pane's capture-phase `window` listener sees the same
 * event first on its way down.
 */
export function move(at: [number, number], init: MouseEventInit = {}): void {
  // `buttons: 1`: a drag holds the primary button down. A move with no button
  // held means the release was lost, and the Eraser cancels on it.
  document.dispatchEvent(
    new MouseEvent('mousemove', {
      bubbles: true,
      buttons: 1,
      clientX: at[0],
      clientY: at[1],
      ...init
    })
  )
}
export function up(at: [number, number], init: MouseEventInit = {}): void {
  document.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: at[0], clientY: at[1], ...init })
  )
}
