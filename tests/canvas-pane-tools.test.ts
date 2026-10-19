// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import DiagramPane from '../src/renderer/src/components/DiagramPane.vue'
import {
  DEFAULT_ELLIPSE_SIZE,
  DEFAULT_NODE_SIZE
} from '../src/renderer/src/components/canvas/canvas-cells'
import { validateCanvasDocument, type CanvasDocument } from '../src/main/canvas-core'
import { i18n } from '@renderer/i18n'
import { installJsdomSvgShim } from './helpers/jsdom-svg'
import { useThemeStore } from '../src/renderer/src/stores/theme'

installJsdomSvgShim()

/**
 * T536 U1 — the canvas pane's tool modes, driven through the mounted pane.
 *
 * jsdom limit (spec §9.2): X6 swallows the drag's `mouseup` at `document` in
 * the real app. These tests prove the pane's routing — which tool owns which
 * gesture, what each creation writes, and the keyboard rules — and the live
 * second-instance check proves the gestures themselves.
 *
 * Under the jsdom SVG shim every screen CTM is the identity, so a client point
 * IS the graph-local point: a click at (300, 300) lands at world (300, 300).
 */

const DOC: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Board', createdAt: '2026-08-01T00:00:00.000Z' },
  nodes: [
    {
      id: 'n-a',
      shape: 'box',
      x: 40,
      y: 40,
      width: 132,
      height: 52,
      label: 'Browser',
      origin: 'agent'
    },
    {
      id: 'n-b',
      shape: 'box',
      x: 320,
      y: 200,
      width: 132,
      height: 52,
      label: 'Main',
      origin: 'agent'
    },
    {
      id: 'n-c',
      shape: 'text',
      x: 40,
      y: 220,
      width: 160,
      height: 24,
      label: 'note',
      origin: 'operator'
    }
  ],
  edges: [{ id: 'e-1', source: 'n-a', target: 'n-b', label: 'IPC', origin: 'agent' }]
}
const SEEDED = ['n-a', 'n-b', 'n-c']

const canvasRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, doc: DOC }))
const canvasWrite = vi.fn(async (p: string) => ({ ok: true as const, path: p, bytes: 1 }))

beforeEach(() => {
  canvasRead.mockClear()
  canvasWrite.mockClear()
  const api = {
    canvasRead,
    canvasWrite,
    markdownRead: vi.fn(async () => ({ ok: false as const, code: 'not-found', error: 'x' })),
    canvasWatchStart: vi.fn(async () => undefined),
    canvasWatchStop: vi.fn(async () => undefined),
    onCanvasChanged: () => () => {},
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

// jsdom lacks `document.elementFromPoint`, which X6 calls on a node's
// `mouseup`; "nothing under the pointer" is the honest jsdom answer.
if (!('elementFromPoint' in document)) {
  ;(document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null
}

const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  document.body.innerHTML = ''
})

function mountPane(id = 'h-canvas', file = '/wt/board.harnucanvas.json'): VueWrapper {
  const w = mount(DiagramPane, {
    props: {
      pane: { id, type: 'canvas' as const, cwd: '/wt', ratio: 1, filePath: file },
      worktreePath: '/wt'
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  mounted.push(w)
  return w
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await nextTick()
  }
}

/**
 * Settle until `done()` holds, bounded by wall time rather than by a tick count. A reload
 * from disk clears the board and re-renders it across several macrotasks (re-read, image
 * resolution, draw), and how many it takes depends on how busy the run is — a fixed
 * number of `settle()`s flaked about one full-file run in four. The caller's own
 * assertions report a condition that never came true.
 */
async function settleUntil(done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await settle()
}

/**
 * A reload from disk has LANDED: node `id`, which the reloaded document keeps, is rendered
 * again by a new view (`before` is its element from before the reload). Right after the
 * watcher fires the board is mid-redraw and `id` has no view at all.
 */
function reloadLanded(w: VueWrapper, id: string, before: Element | null): () => boolean {
  return () => {
    const now = w.element.querySelector(`[data-cell-id="${id}"]`)
    return now !== null && now !== before
  }
}

function svgOf(w: VueWrapper): Element {
  return w.element.querySelector('[data-testid="diagram-canvas-host"] svg')!
}
function bodyOf(w: VueWrapper): HTMLElement {
  return w.element.querySelector('[data-testid="diagram-canvas-host"]')!
    .parentElement as HTMLElement
}
function nodeEl(w: VueWrapper, id: string): Element {
  return w.element.querySelector(`[data-cell-id="${id}"]`)!
}

/** Focus inside the pane — every shortcut is gated on it. */
function focusPane(w: VueWrapper): void {
  bodyOf(w).focus()
}
function key(k: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
}
function keyUp(k: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }))
}

function down(el: Element, at: [number, number], init: MouseEventInit = {}): void {
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
function move(at: [number, number], init: MouseEventInit = {}): void {
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
function up(at: [number, number], init: MouseEventInit = {}): void {
  document.dispatchEvent(
    new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: at[0], clientY: at[1], ...init })
  )
}

/** A blank drag: press on the board, move and release through `document`. */
function dragOnBlankCanvas(w: VueWrapper, from: [number, number], to: [number, number]): void {
  down(svgOf(w), from)
  move(to)
  up(to)
}
/** A click on empty board: press and release on the same point. */
function clickBlank(w: VueWrapper, at: [number, number]): void {
  down(svgOf(w), at)
  up(at)
}

function pressed(w: VueWrapper): string[] {
  return w
    .findAll('[data-testid^="canvas-tool-"][aria-pressed="true"]')
    .map((b) => b.attributes('data-testid')!.replace('canvas-tool-', ''))
    .filter((id) => id !== 'lock')
}

async function saveAndRead(w: VueWrapper): Promise<CanvasDocument> {
  await w.find('[data-testid="diagram-save"]').trigger('click')
  await settle()
  const calls = canvasWrite.mock.calls as unknown as [string, CanvasDocument][]
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][1]
}

const created = (doc: CanvasDocument): CanvasDocument['nodes'] =>
  doc.nodes.filter((n) => !SEEDED.includes(n.id))

describe('DiagramPane tools — Select is the default (T536 U1)', () => {
  it('a fresh pane is on Select, and a blank drag creates nothing', async () => {
    const w = mountPane()
    await settle()
    expect(pressed(w)).toEqual(['select'])

    dragOnBlankCanvas(w, [200, 200], [400, 320])
    await settle()

    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(false)
    // No node was added: nothing is dirty, so Save has nothing to write.
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()
    expect(canvasWrite).not.toHaveBeenCalled()
  })

  it('clicking a toolbar button switches the tool', async () => {
    const w = mountPane()
    await settle()
    await w.find('[data-testid="canvas-tool-rectangle"]').trigger('click')
    expect(pressed(w)).toEqual(['rectangle'])
  })
})

describe('DiagramPane tools — toolbar placement (design.md §6 Narrow panes)', () => {
  it('caps the toolbar at the pane width minus its inset, so it wraps rather than clips', async () => {
    const w = mountPane()
    await settle()
    const place = w.get('[data-testid="canvas-toolbar"]').element.parentElement as HTMLElement
    // The cap is the pane minus the bar's 12px left inset (`left-3`, a spacing token), so
    // the full 225px bar still fits on one row down to ≈237px (design.md §6).
    expect(place.className).toContain('max-w-[calc(100%-var(--spacing)*3)]')
  })
})

describe('DiagramPane tools — Rectangle', () => {
  it('r, then a blank drag: one operator box, and the tool is back on Select', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('r')
    await settle()
    expect(pressed(w)).toEqual(['rectangle'])

    dragOnBlankCanvas(w, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(pressed(w)).toEqual(['select'])

    const doc = await saveAndRead(w)
    const boxes = created(doc)
    expect(boxes).toHaveLength(1)
    expect(boxes[0]).toMatchObject({ shape: 'box', origin: 'operator', width: 200, height: 120 })
    expect(validateCanvasDocument(doc).ok).toBe(true)
  })

  it('q then r keeps Rectangle armed across two drags', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('q')
    key('r')
    await settle()

    dragOnBlankCanvas(w, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    dragOnBlankCanvas(w, [500, 400], [620, 480])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(pressed(w)).toEqual(['rectangle'])
    const doc = await saveAndRead(w)
    expect(created(doc).map((n) => n.shape)).toEqual(['box', 'box'])
  })

  it('r, then a short click: one default-size box centred on the click', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('r')
    clickBlank(w, [300, 300])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    const [box] = created(await saveAndRead(w))
    expect(box).toMatchObject({
      shape: 'box',
      origin: 'operator',
      width: DEFAULT_NODE_SIZE.width,
      height: DEFAULT_NODE_SIZE.height
    })
    expect(box.x! + box.width! / 2).toBe(300)
    expect(box.y! + box.height! / 2).toBe(300)
  })
})

describe('DiagramPane tools — Diamond and Ellipse (T536 U2)', () => {
  it('d, then a blank drag: one operator diamond, and the tool is back on Select', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('d')
    await settle()
    expect(pressed(w)).toEqual(['diamond'])

    dragOnBlankCanvas(w, [200, 200], [400, 320])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(pressed(w)).toEqual(['select'])

    const doc = await saveAndRead(w)
    const shapes = created(doc)
    expect(shapes).toHaveLength(1)
    expect(shapes[0]).toMatchObject({
      shape: 'diamond',
      origin: 'operator',
      width: 200,
      height: 120
    })
    expect(validateCanvasDocument(doc).ok).toBe(true)
  })

  it('o, then a short click: one default-size ellipse centred on the click', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('o')
    await settle()
    expect(pressed(w)).toEqual(['ellipse'])
    clickBlank(w, [300, 300])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    const shapes = created(await saveAndRead(w))
    expect(shapes).toHaveLength(1)
    const [ell] = shapes
    expect(ell).toMatchObject({
      shape: 'ellipse',
      origin: 'operator',
      width: DEFAULT_ELLIPSE_SIZE.width,
      height: DEFAULT_ELLIPSE_SIZE.height
    })
    expect(ell.x! + ell.width! / 2).toBe(300)
    expect(ell.y! + ell.height! / 2).toBe(300)
  })

  it('the digit keys 3 and 4 arm Diamond and Ellipse', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('3')
    await settle()
    expect(pressed(w)).toEqual(['diamond'])
    key('4')
    await settle()
    expect(pressed(w)).toEqual(['ellipse'])
  })

  it('q then d keeps Diamond armed across two clicks', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('q')
    key('d')
    await settle()
    clickBlank(w, [300, 300])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    clickBlank(w, [600, 400])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(pressed(w)).toEqual(['diamond'])
    expect(created(await saveAndRead(w)).map((n) => n.shape)).toEqual(['diamond', 'diamond'])
  })
})

describe('DiagramPane tools — Text', () => {
  it('t, click, type, Enter: a text node; an empty commit adds nothing', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('t')
    clickBlank(w, [300, 300])
    await settle()
    const input = w.find('[data-testid="diagram-rename-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('note')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()

    const first = await saveAndRead(w)
    const texts = created(first)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ shape: 'text', label: 'note', origin: 'operator' })

    focusPane(w)
    key('t')
    clickBlank(w, [500, 420])
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)
    // The empty text was removed again; nothing new reaches the file.
    expect(created(await saveAndRead(w))).toHaveLength(1)
  })

  it('pressing an existing text node edits it instead of adding one', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('t')
    down(nodeEl(w, 'n-c'), [60, 230])
    up([60, 230])
    await settle()
    const input = w.find('[data-testid="diagram-rename-input"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('note')
    await input.setValue('edited')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()

    const doc = await saveAndRead(w)
    expect(created(doc)).toHaveLength(0)
    expect(doc.nodes.find((n) => n.id === 'n-c')?.label).toBe('edited')
  })

  it('double-click on blank board in Select places a text node', async () => {
    const w = mountPane()
    await settle()
    svgOf(w).dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, button: 0, clientX: 300, clientY: 300 })
    )
    await settle()
    const input = w.find('[data-testid="diagram-rename-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('hi')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()
    expect(created(await saveAndRead(w))).toMatchObject([{ shape: 'text', label: 'hi' }])
  })
})

describe('DiagramPane tools — Escape and node double-click', () => {
  it('Esc leaves a tool for Select, and a second Esc clears the selection', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('a', { ctrlKey: true })
    key('t')
    await settle()
    expect(pressed(w)).toEqual(['text'])
    key('Escape')
    await settle()
    expect(pressed(w)).toEqual(['select'])
    key('Escape')
    key('Delete')
    await settle()
    // The selection was cleared, so Delete had nothing to remove.
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('the first Esc does not clear the selection', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('a', { ctrlKey: true })
    key('t')
    key('Escape')
    key('Delete')
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(true)
  })

  // In Rectangle and Text the press itself creates a shape, so a bare double-click is not a
  // rename there (design.md §6); Eraser deletes on the first press.
  it.each([
    ['v', 'Select', true],
    ['h', 'Hand', true],
    ['a', 'Arrow', true],
    ['r', 'Rectangle', false],
    ['t', 'Text', false],
    ['e', 'Eraser', false]
  ] as const)('double-click on a node with %s (%s) renames: %s', async (k, _name, renames) => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key(k)
    nodeEl(w, 'n-a').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, button: 0, clientX: 60, clientY: 60 })
    )
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(renames)
  })
})

describe('DiagramPane tools — Review Focus 1-4', () => {
  it('RF1: a letter typed outside the pane never switches the tool', async () => {
    const w = mountPane()
    await settle()
    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    textarea.focus()
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    key('r')
    await settle()
    expect(pressed(w)).toEqual(['select'])
  })

  it('RF1: a letter typed into the rename input never switches the tool', async () => {
    const w = mountPane()
    await settle()
    nodeEl(w, 'n-a').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, button: 0, clientX: 60, clientY: 60 })
    )
    await settle()
    const input = w.find('[data-testid="diagram-rename-input"]')
    expect(input.exists()).toBe(true)
    ;(input.element as HTMLInputElement).focus()
    input.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    key('r')
    await settle()
    expect(pressed(w)).toEqual(['select'])
  })

  it('RF2: switching tool mid-draw cancels it and leaves no preview', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('r')
    down(svgOf(w), [200, 200])
    move([400, 320])
    await settle()
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(true)

    key('e')
    await settle()
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(false)
    up([400, 320])
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('RF3: the window losing focus while Space is held releases the Hand', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key(' ')
    await settle()
    expect(bodyOf(w).style.cursor).toBe('grab')
    window.dispatchEvent(new Event('blur'))
    await settle()
    expect(bodyOf(w).style.cursor).toBe('default')
    expect(pressed(w)).toEqual(['select'])
  })

  it('tool keys are ignored while Space is held', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key(' ')
    key('r')
    keyUp(' ')
    await settle()
    expect(pressed(w)).toEqual(['select'])
    expect(bodyOf(w).style.cursor).toBe('default')
  })

  it('Space on a focused toolbar button activates it and never starts a pan', async () => {
    const w = mountPane()
    await settle()
    const btn = w.get('[data-testid="canvas-tool-rectangle"]').element as HTMLButtonElement
    btn.focus()
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    window.dispatchEvent(ev)
    await settle()
    expect(ev.defaultPrevented).toBe(false)
    expect(bodyOf(w).style.cursor).toBe('default')
    expect(pressed(w)).toEqual(['select'])
  })

  it('Space is ignored while the rename input is open', async () => {
    const w = mountPane()
    await settle()
    nodeEl(w, 'n-a').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, button: 0, clientX: 60, clientY: 60 })
    )
    await settle()
    ;(w.find('[data-testid="diagram-rename-input"]').element as HTMLInputElement).focus()
    key(' ')
    await settle()
    expect(bodyOf(w).style.cursor).toBe('default')
  })

  it('RF4: two panes keep independent tools', async () => {
    const first = mountPane('h-one', '/wt/one.harnucanvas.json')
    const second = mountPane('h-two', '/wt/two.harnucanvas.json')
    await settle()
    focusPane(first)
    key('r')
    await settle()
    expect(pressed(first)).toEqual(['rectangle'])
    expect(pressed(second)).toEqual(['select'])
  })
})

describe('DiagramPane tools — undo, Esc and blur (fix round 1)', () => {
  async function placeText(w: VueWrapper, at: [number, number], label: string): Promise<void> {
    focusPane(w)
    key('t')
    clickBlank(w, at)
    await settle()
    const input = w.find('[data-testid="diagram-rename-input"]')
    expect(input.exists()).toBe(true)
    if (label) await input.setValue(label)
    await input.trigger('keydown', { key: 'Enter' })
    await settle()
  }

  it('an empty text placement is ONE undo step: ⌘Z leaves no invisible text behind', async () => {
    const w = mountPane()
    await settle()
    await placeText(w, [300, 300], '')
    key('z', { ctrlKey: true })
    await settle()

    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(SEEDED)
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('a labelled text placement is ONE undo step: one ⌘Z removes the node, not just its label', async () => {
    const w = mountPane()
    await settle()
    await placeText(w, [300, 300], 'note')
    key('z', { ctrlKey: true })
    await settle()

    const doc = await saveAndRead(w)
    expect(created(doc)).toHaveLength(0)
  })

  it('a placed box stays selected through X6 own release handling (Delete removes it)', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('r')
    // Released ON the board, as a real click is: only then does X6 run its own
    // `blank:click` (which clears the selection) after the pane created the box.
    down(svgOf(w), [300, 300])
    svgOf(w).dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 300, clientY: 300 })
    )
    await settle()
    await w.find('[data-testid="diagram-rename-input"]').trigger('keydown', { key: 'Enter' })
    await settle()
    key('Delete')
    await settle()

    const doc = await saveAndRead(w)
    expect(created(doc)).toHaveLength(0)
  })

  it('Esc in the rename input cancels the rename only: a locked tool stays armed', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('q')
    key('r')
    clickBlank(w, [300, 300])
    await settle()
    const input = w.find('[data-testid="diagram-rename-input"]')
    expect(input.exists()).toBe(true)
    input.element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)
    expect(pressed(w)).toEqual(['rectangle'])
  })

  it('the window losing focus mid-draw cancels the draw and its preview', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('r')
    down(svgOf(w), [200, 200])
    move([400, 320])
    await settle()
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(true)

    window.dispatchEvent(new Event('blur'))
    await settle()
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(false)
    up([400, 320])
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })
})

describe('DiagramPane tools — Select with shift', () => {
  /**
   * jsdom does no layout, so the rubberband element X6 sizes through inline
   * style has a zero `getBoundingClientRect`. Read the rect back from that
   * style — the geometry X6 itself wrote — for the rubberband element only.
   */
  let restore: (() => void) | null = null
  beforeEach(() => {
    const proto = HTMLElement.prototype
    const original = proto.getBoundingClientRect
    proto.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.classList.contains('x6-widget-selection-rubberband')) {
        const n = (v: string): number => parseFloat(v) || 0
        const left = n(this.style.left)
        const top = n(this.style.top)
        const width = n(this.style.width)
        const height = n(this.style.height)
        return {
          x: left,
          y: top,
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
          toJSON: () => ({})
        } as DOMRect
      }
      return original.call(this)
    }
    restore = () => {
      proto.getBoundingClientRect = original
    }
  })
  afterEach(() => restore?.())

  /**
   * X6's rubberband maps its page rect to the graph through the VIEWPORT
   * matrix (`pageToLocal`), not the shimmed screen CTM — and the first-open
   * fit leaves a non-identity viewport under jsdom. Project a world point to
   * the client point that matrix maps back onto it.
   */
  function toClient(w: VueWrapper, at: [number, number]): [number, number] {
    const vp = w.element.querySelector('.x6-graph-svg-viewport')!
    const m = /matrix\(([^)]+)\)/.exec(vp.getAttribute('transform') ?? '')
    const [a, , , d, e, f] = m ? m[1].split(/[\s,]+/).map(Number) : [1, 0, 0, 1, 0, 0]
    return [at[0] * a + e, at[1] * d + f]
  }

  it('shift+drag adds the rubberband catch to the current selection', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    // Select n-a with a plain click.
    down(nodeEl(w, 'n-a'), [60, 60])
    up([60, 60])
    await settle()

    // Shift+drag a band around n-b only (world 320,200 → 452,252).
    down(svgOf(w), toClient(w, [300, 180]), { shiftKey: true })
    move(toClient(w, [400, 230]), { shiftKey: true })
    move(toClient(w, [480, 280]), { shiftKey: true })
    up(toClient(w, [480, 280]), { shiftKey: true })
    await settle()

    key('Delete')
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(['n-c'])
  })

  it('a plain drag still replaces the selection', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    down(nodeEl(w, 'n-a'), [60, 60])
    up([60, 60])
    await settle()

    down(svgOf(w), toClient(w, [300, 180]))
    move(toClient(w, [400, 230]))
    move(toClient(w, [480, 280]))
    up(toClient(w, [480, 280]))
    await settle()

    key('Delete')
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(['n-a', 'n-c'])
  })
})

describe('DiagramPane tools — Arrow', () => {
  // World points inside each seeded node (the jsdom CTM is the identity).
  const IN_A: [number, number] = [60, 60]
  const IN_B: [number, number] = [340, 220]
  const IN_C: [number, number] = [60, 230]

  const newEdges = (doc: CanvasDocument): CanvasDocument['edges'] =>
    doc.edges.filter((e) => e.id !== 'e-1')
  const preview = (w: VueWrapper): boolean =>
    w.find('[data-testid="diagram-arrow-preview"]').exists()

  /** Press on `from`'s node, move through the midpoint, release on `to`'s element. */
  function dragArrow(
    w: VueWrapper,
    fromId: string,
    from: [number, number],
    to: [number, number],
    toEl?: Element
  ): void {
    down(nodeEl(w, fromId), from)
    move([(from[0] + to[0]) / 2, (from[1] + to[1]) / 2])
    move(to)
    const target = toEl ?? document
    target.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: to[0], clientY: to[1] })
    )
  }

  /**
   * jsdom does no layout, so the body's rect is all zeros and every release
   * would read as "outside the pane". Pin the pane's body to 0,0 → right,bottom.
   */
  function pinBody(w: VueWrapper, right: number, bottom: number): void {
    bodyOf(w).getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right,
        bottom,
        width: right,
        height: bottom,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect
  }

  async function armArrow(w: VueWrapper): Promise<void> {
    pinBody(w, 1000, 800)
    focusPane(w)
    key('a')
    await settle()
    expect(pressed(w)).toEqual(['arrow'])
  }

  it('a, drag n-a → n-c: ONE operator edge n-a → n-c, and the tool is back on Select', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    dragArrow(w, 'n-a', IN_A, IN_C, nodeEl(w, 'n-c'))
    await settle()
    expect(pressed(w)).toEqual(['select'])

    const doc = await saveAndRead(w)
    const edges = newEdges(doc)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'n-a', target: 'n-c', origin: 'operator' })
    // Nothing else changed: no node was added on the way.
    expect(created(doc)).toHaveLength(0)
    expect(validateCanvasDocument(doc).ok).toBe(true)
  })

  it('the reverse of an existing edge (n-b → n-a) is a new edge', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    dragArrow(w, 'n-b', IN_B, IN_A, nodeEl(w, 'n-a'))
    await settle()
    expect(newEdges(await saveAndRead(w))).toMatchObject([
      { source: 'n-b', target: 'n-a', origin: 'operator' }
    ])
  })

  it('n-a → n-b again (already connected that way) creates nothing', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    dragArrow(w, 'n-a', IN_A, IN_B, nodeEl(w, 'n-b'))
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
    // No creation: the tool stays armed.
    expect(pressed(w)).toEqual(['arrow'])
  })

  it('n-a → blank board creates nothing', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    dragArrow(w, 'n-a', IN_A, [600, 500], svgOf(w))
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
    expect(pressed(w)).toEqual(['arrow'])
  })

  it('n-a → n-a (released on its own source) creates nothing', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    dragArrow(w, 'n-a', IN_A, [100, 70], nodeEl(w, 'n-a'))
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('the preview line is shown mid-drag, from the source centre, and gone after the release', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move([200, 150])
    await settle()
    const line = w.find('[data-testid="diagram-arrow-preview"] line')
    expect(line.exists()).toBe(true)
    // n-a is 40,40 132×52 → centre (106, 66); the pointer is at (200, 150).
    // The body sits at the jsdom origin, so body coordinates are client ones.
    expect(Number(line.attributes('x1'))).toBeCloseTo(106)
    expect(Number(line.attributes('y1'))).toBeCloseTo(66)
    expect(Number(line.attributes('x2'))).toBeCloseTo(200)
    expect(Number(line.attributes('y2'))).toBeCloseTo(150)
    // An overlay, never a cell: nothing entered the graph, so nothing is dirty.
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)

    up([200, 150])
    await settle()
    expect(preview(w)).toBe(false)
  })

  it('Esc mid-drag cancels: no preview, and the later release creates nothing', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_C)
    await settle()
    expect(preview(w)).toBe(true)
    key('Escape')
    await settle()
    expect(preview(w)).toBe(false)
    // The gesture was cancelled, not the tool: Esc's first job is the gesture.
    expect(pressed(w)).toEqual(['arrow'])
    nodeEl(w, 'n-c').dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: IN_C[0], clientY: IN_C[1] })
    )
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('a window blur mid-drag cancels the arrow and its preview', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_C)
    await settle()
    window.dispatchEvent(new Event('blur'))
    await settle()
    expect(preview(w)).toBe(false)
    up(IN_C)
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('a tool switch mid-drag cancels the arrow and its preview', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_C)
    await settle()
    key('v')
    await settle()
    expect(preview(w)).toBe(false)
    up(IN_C)
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('a release outside the pane body cancels, even over a node in world space', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    // A pane only 200px tall: n-c (world 40,220 → 200,244, not yet connected
    // to n-a) lies past its bottom edge, so the operator cannot see the node
    // the release lands on.
    pinBody(w, 500, 200)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_C)
    nodeEl(w, 'n-c').dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: IN_C[0], clientY: IN_C[1] })
    )
    await settle()
    expect(preview(w)).toBe(false)
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('a reload that removes the source mid-drag: the release on a live node creates no edge', async () => {
    const changed = captureCanvasChanged()
    const w = mountPane()
    await settle()
    await armArrow(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_C)
    await settle()
    expect(preview(w)).toBe(true)
    // An agent's write lands on a clean board: n-a (and e-1, which needs it) is gone.
    canvasRead.mockResolvedValueOnce({
      ok: true as const,
      path: '/wt/board.harnucanvas.json',
      doc: { ...DOC, nodes: DOC.nodes.filter((n) => n.id !== 'n-a'), edges: [] }
    })
    const viewBefore = w.element.querySelector('[data-cell-id="n-c"]')
    changed()!({ path: '/wt/board.harnucanvas.json' })
    // The reload re-reads, resolves images and re-renders: wait until it lands.
    const landed = reloadLanded(w, 'n-c', viewBefore)
    await settleUntil(() => landed() && !w.element.querySelector('[data-cell-id="n-a"]'))
    expect(w.element.querySelector('[data-cell-id="n-c"]')).not.toBeNull()
    expect(w.element.querySelector('[data-cell-id="n-a"]')).toBeNull()
    // jsdom reports an exception thrown by a listener as a window `error` event, never
    // to the test: trap it, or a release handler that crashes on the missing source
    // would pass below as "no edge was made".
    const thrown: unknown[] = []
    const trap = (e: ErrorEvent): void => void thrown.push(e.error ?? e.message)
    window.addEventListener('error', trap)
    try {
      nodeEl(w, 'n-c').dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: IN_C[0], clientY: IN_C[1] })
      )
      await settle()
    } finally {
      window.removeEventListener('error', trap)
    }
    expect(thrown).toEqual([])
    expect(preview(w)).toBe(false)
    // No edge at all: one from the missing n-a would be a dangling edge.
    expect(w.element.querySelectorAll('g.x6-edge')).toHaveLength(0)
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('a press on blank board in Arrow shows nothing and creates nothing', async () => {
    const w = mountPane()
    await settle()
    await armArrow(w)
    down(svgOf(w), [600, 500])
    move([340, 220])
    await settle()
    expect(preview(w)).toBe(false)
    up([340, 220])
    await settle()
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
  })

  it('a press on an EDGE in Arrow does nothing: the edge is not selected', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    // Select n-c in Select first.
    down(nodeEl(w, 'n-c'), IN_C)
    up(IN_C)
    await settle()
    await armArrow(w)
    const edge = nodeEl(w, 'e-1')
    expect(edge).toBeTruthy()
    down(edge, [250, 150])
    edge.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: 250, clientY: 150 })
    )
    edge.dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0, clientX: 250, clientY: 150 })
    )
    await settle()
    expect(preview(w)).toBe(false)
    // Delete removes whatever is selected: still n-c, never the edge.
    key('Delete')
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(['n-a', 'n-b'])
    expect(doc.edges.map((e) => e.id)).toEqual(['e-1'])
  })

  it('a selected node shows resize handles in Select only; Arrow hides them', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    const handles = (): number => w.element.querySelectorAll('.x6-widget-transform').length
    // A real click is mousedown + mouseup + click; X6 opens the handles on `click`.
    const clickNode = (id: string, at: [number, number]): void => {
      down(nodeEl(w, id), at)
      nodeEl(w, id).dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: at[0], clientY: at[1] })
      )
      nodeEl(w, id).dispatchEvent(
        new MouseEvent('click', { bubbles: true, button: 0, clientX: at[0], clientY: at[1] })
      )
    }
    clickNode('n-a', IN_A)
    await settle()
    expect(handles()).toBe(1)

    await armArrow(w)
    expect(handles()).toBe(0)
    // A click on a node in Arrow (an arrow onto itself) does not bring them back.
    clickNode('n-b', IN_B)
    await settle()
    expect(handles()).toBe(0)
  })
})

/** Capture the pane's file-watch callback before mounting; call it to simulate a clean reload. */
function captureCanvasChanged(): () => ((p: { path: string }) => void) | null {
  let changed: ((p: { path: string }) => void) | null = null
  ;(window as unknown as { api: Record<string, unknown> }).api.onCanvasChanged = (
    cb: (p: { path: string }) => void
  ) => {
    changed = cb
    return () => {}
  }
  return () => changed
}

describe('DiagramPane tools — gestures across a reload from disk (fix round 2)', () => {
  it('a Rectangle drag in flight survives a clean reload: preview kept, release creates the box', async () => {
    const changed = captureCanvasChanged()
    const w = mountPane()
    await settle()
    focusPane(w)
    key('r')
    await settle()
    down(svgOf(w), [600, 500])
    move([700, 600])
    await settle()
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(true)
    // An agent's write (or the echo of a Save) reloads a clean board, keeping
    // the viewport (`fit=false`), so the draw is still valid.
    const viewBefore = nodeEl(w, 'n-c')
    changed()!({ path: '/wt/board.harnucanvas.json' })
    await settleUntil(reloadLanded(w, 'n-c', viewBefore))
    expect(w.find('[data-testid="diagram-draw-preview"]').exists()).toBe(true)
    move([800, 640])
    up([800, 640])
    await settle()
    expect(created(await saveAndRead(w))).toHaveLength(1)
  })

  it('a Hand pan in flight survives a clean reload: still grabbing, and the pan goes on', async () => {
    const changed = captureCanvasChanged()
    const w = mountPane()
    await settle()
    focusPane(w)
    key('h')
    await settle()
    down(svgOf(w), [600, 500])
    move([620, 510])
    await settle()
    expect(bodyOf(w).style.cursor).toBe('grabbing')
    const viewBefore = nodeEl(w, 'n-c')
    changed()!({ path: '/wt/board.harnucanvas.json' })
    await settleUntil(reloadLanded(w, 'n-c', viewBefore))
    expect(bodyOf(w).style.cursor).toBe('grabbing')
    up([640, 520])
    await settle()
    expect(bodyOf(w).style.cursor).toBe('grab')
  })
})

describe('DiagramPane tools — Eraser', () => {
  const IN_A: [number, number] = [60, 60]
  const IN_B: [number, number] = [340, 220]
  const IN_C: [number, number] = [60, 230]

  const marks = (w: VueWrapper): string[] =>
    [...w.element.querySelectorAll('.canvas-erase-mark')].map(
      (el) => el.getAttribute('data-cell-id') ?? '?'
    )
  const isDirty = (w: VueWrapper): boolean => w.find('[data-testid="diagram-dirty-dot"]').exists()

  function pinBody(w: VueWrapper, right: number, bottom: number): void {
    bodyOf(w).getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right,
        bottom,
        width: right,
        height: bottom,
        x: 0,
        y: 0,
        toJSON: () => ({})
      }) as DOMRect
  }

  async function armEraser(w: VueWrapper): Promise<void> {
    pinBody(w, 1000, 800)
    focusPane(w)
    key('e')
    await settle()
    expect(pressed(w)).toEqual(['eraser'])
  }

  /** Release on the board's SVG, as a real click does: X6's own release handling runs. */
  function upOnSvg(w: VueWrapper, at: [number, number]): void {
    svgOf(w).dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: at[0], clientY: at[1] })
    )
  }

  /**
   * A point on e-1's rendered path: the middle of its longest straight run,
   * read off the `d` X6 wrote, and which way that run goes.
   */
  function pointOnEdge(w: VueWrapper): { p: [number, number]; horizontal: boolean } {
    const path = w.element.querySelector('[data-cell-id="e-1"] path[d]')!
    const nums = (path.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)!.map(Number)
    const pts: [number, number][] = []
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]])
    let best = 0
    let bestLen = -1
    for (let i = 0; i + 1 < pts.length; i++) {
      const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
      if (len > bestLen) {
        bestLen = len
        best = i
      }
    }
    const [a, b] = [pts[best], pts[best + 1]]
    return {
      p: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      horizontal: Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0])
    }
  }

  it('e, drag across n-a and n-b: both gone with their edge; ONE ⌘Z brings all back', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move([200, 140])
    move(IN_B)
    await settle()
    // Marked mid-stroke, as a class on the VIEW: no edit, no dirty dot yet.
    expect(marks(w)).toEqual(expect.arrayContaining(['n-a', 'n-b']))
    expect(isDirty(w)).toBe(false)
    upOnSvg(w, IN_B)
    await settle()
    expect(marks(w)).toEqual([])
    // Erasing is not a creation: the tool stays on Eraser.
    expect(pressed(w)).toEqual(['eraser'])

    let doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(['n-c'])
    expect(doc.edges).toEqual([])

    key('z', { ctrlKey: true })
    await settle()
    doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(['n-a', 'n-b', 'n-c'])
    expect(doc.edges.map((e) => e.id)).toEqual(['e-1'])
  })

  it('a stroke from blank board across n-a and n-b is ONE undo step too', async () => {
    // A press on a node runs inside X6's own per-gesture batch, which would
    // hide a missing erase batch; a stroke that starts on blank board has none.
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(svgOf(w), [20, 20])
    move(IN_A)
    move(IN_B)
    move([480, 300])
    await settle()
    expect(marks(w)).toEqual(expect.arrayContaining(['n-a', 'n-b']))
    upOnSvg(w, [480, 300])
    await settle()
    expect((await saveAndRead(w)).nodes.map((n) => n.id)).toEqual(['n-c'])
    key('z', { ctrlKey: true })
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(SEEDED)
    expect(doc.edges.map((e) => e.id)).toEqual(['e-1'])
  })

  it('Esc mid-drag clears the marks and erases nothing; the pane stays clean', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move([200, 140])
    await settle()
    expect(marks(w)).toContain('n-a')
    key('Escape')
    await settle()
    expect(marks(w)).toEqual([])
    // Esc's first job is the gesture, not the tool.
    expect(pressed(w)).toEqual(['eraser'])
    move(IN_B)
    upOnSvg(w, IN_B)
    await settle()
    expect(marks(w)).toEqual([])
    expect(w.element.querySelectorAll('.canvas-erase-mark')).toHaveLength(0)
    expect(isDirty(w)).toBe(false)
    expect(SEEDED.every((id) => w.element.querySelector(`[data-cell-id="${id}"]`))).toBe(true)
  })

  it('a window blur mid-drag clears the marks and erases nothing', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_B)
    await settle()
    expect(marks(w).length).toBeGreaterThan(0)
    window.dispatchEvent(new Event('blur'))
    await settle()
    expect(marks(w)).toEqual([])
    up(IN_B)
    await settle()
    expect(isDirty(w)).toBe(false)
  })

  it('a tool switch mid-drag clears the marks and erases nothing', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_B)
    await settle()
    expect(marks(w).length).toBeGreaterThan(0)
    key('v')
    await settle()
    expect(marks(w)).toEqual([])
    up(IN_B)
    await settle()
    expect(isDirty(w)).toBe(false)
  })

  it('a plain press on a node erases just it', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-c'), IN_C)
    nodeEl(w, 'n-c').dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: IN_C[0], clientY: IN_C[1] })
    )
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(['n-a', 'n-b'])
    expect(doc.edges.map((e) => e.id)).toEqual(['e-1'])
  })

  it('a plain press on an EDGE erases just that edge', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    const { p } = pointOnEdge(w)
    const edge = nodeEl(w, 'e-1')
    down(edge, p)
    edge.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: p[0], clientY: p[1] })
    )
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(SEEDED)
    expect(doc.edges).toEqual([])
  })

  it('a blank stroke across an edge erases the edge and leaves the nodes', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    const { p, horizontal } = pointOnEdge(w)
    // Cross the run at right angles, from 20px on one side to 20px on the other.
    const from: [number, number] = horizontal ? [p[0], p[1] - 20] : [p[0] - 20, p[1]]
    const to: [number, number] = horizontal ? [p[0], p[1] + 20] : [p[0] + 20, p[1]]
    down(svgOf(w), from)
    move(to)
    await settle()
    expect(marks(w)).toEqual(['e-1'])
    upOnSvg(w, to)
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id)).toEqual(SEEDED)
    expect(doc.edges).toEqual([])
  })

  it('a blank stroke that passes far from the edge erases nothing', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(svgOf(w), [600, 600])
    move([700, 700])
    upOnSvg(w, [700, 700])
    await settle()
    expect(isDirty(w)).toBe(false)
  })

  it('a theme switch mid-stroke re-renders the board: the stroke is cancelled, nothing erased', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_B)
    await settle()
    expect(marks(w)).toContain('n-a')
    // The re-render recreates every view, dropping the dimming: the operator
    // now sees an undimmed board, so the release must not erase anything.
    const theme = useThemeStore()
    theme.set('light')
    try {
      await settle()
      upOnSvg(w, IN_B)
      await settle()
      expect(marks(w)).toEqual([])
      expect(isDirty(w)).toBe(false)
      expect(SEEDED.every((id) => w.element.querySelector(`[data-cell-id="${id}"]`))).toBe(true)
    } finally {
      // The store persists the choice; leave the next test on the default.
      theme.set('default-dark')
    }
  })

  it('a reload from disk mid-stroke cancels the stroke: nothing erased', async () => {
    const changed = captureCanvasChanged()
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_B)
    await settle()
    expect(marks(w)).toContain('n-a')
    const viewBefore = nodeEl(w, 'n-c')
    changed()!({ path: '/wt/board.harnucanvas.json' })
    await settleUntil(reloadLanded(w, 'n-c', viewBefore))
    upOnSvg(w, IN_B)
    await settle()
    expect(marks(w)).toEqual([])
    expect(isDirty(w)).toBe(false)
    expect(SEEDED.every((id) => w.element.querySelector(`[data-cell-id="${id}"]`))).toBe(true)
  })

  it('a move with no button held (the release was lost) cancels the stroke', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move([200, 140])
    await settle()
    expect(marks(w)).toContain('n-a')
    // The button came up somewhere the pane never heard about.
    move(IN_B, { buttons: 0 })
    await settle()
    expect(marks(w)).toEqual([])
    // A later release is not the end of a stroke any more.
    upOnSvg(w, IN_B)
    await settle()
    expect(isDirty(w)).toBe(false)
  })

  it('a right-button release mid-stroke does not end it; the left release does', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_B)
    await settle()
    expect(marks(w)).toEqual(expect.arrayContaining(['n-a', 'n-b']))
    up(IN_B, { button: 2 })
    await settle()
    // Still mid-stroke: nothing erased, the marks still shown.
    expect(isDirty(w)).toBe(false)
    expect(marks(w)).toEqual(expect.arrayContaining(['n-a', 'n-b']))
    upOnSvg(w, IN_B)
    await settle()
    expect((await saveAndRead(w)).nodes.map((n) => n.id)).toEqual(['n-c'])
  })

  it('a new press while a stroke is still open (left release lost) leaves no marks behind', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    move(IN_B)
    await settle()
    expect(marks(w)).toEqual(expect.arrayContaining(['n-a', 'n-b']))
    // X6 ignores presses until it sees a release, so the way back into
    // `beginGesture` mid-stroke is a right-button release: X6 ends its drag on
    // it, the Eraser deliberately does not. The left release is then lost
    // (no move arrives to notice it), and a new left press starts a gesture.
    up(IN_B, { button: 2 })
    await settle()
    expect(marks(w)).toEqual(expect.arrayContaining(['n-a', 'n-b']))
    down(svgOf(w), [600, 500])
    await settle()
    expect(marks(w)).toEqual([])
    upOnSvg(w, [600, 500])
    await settle()
    expect(isDirty(w)).toBe(false)
    expect(w.element.querySelectorAll('.canvas-erase-mark')).toHaveLength(0)
  })

  it('a click on blank board erases nothing', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    down(svgOf(w), [600, 500])
    upOnSvg(w, [600, 500])
    await settle()
    expect(isDirty(w)).toBe(false)
    expect(marks(w)).toEqual([])
  })

  it('a release outside the pane ends the stroke: no stuck marks, nothing off-pane marked', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    // A pane only 300px wide: n-b (world x 320 → 452) lies past its right edge.
    pinBody(w, 300, 400)
    down(nodeEl(w, 'n-a'), IN_A)
    move([200, 140])
    move(IN_B)
    await settle()
    expect(marks(w)).toContain('n-a')
    expect(marks(w)).not.toContain('n-b')
    up(IN_B)
    await settle()
    expect(marks(w)).toEqual([])
    const doc = await saveAndRead(w)
    // n-a went, and e-1 with it; n-b lay only under the off-pane part.
    expect(doc.nodes.map((n) => n.id)).toEqual(['n-b', 'n-c'])
    expect(doc.edges).toEqual([])
  })

  it('the selection never holds an erased cell: Delete afterwards takes only what is left', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    // Everything selected, then n-a erased out from under the selection.
    key('a', { ctrlKey: true })
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-a'), IN_A)
    nodeEl(w, 'n-a').dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: IN_A[0], clientY: IN_A[1] })
    )
    await settle()
    key('v')
    await settle()
    key('Delete')
    await settle()
    expect((await saveAndRead(w)).nodes).toEqual([])
    // ONE undo takes back the Delete only: n-b and n-c return, n-a (and e-1,
    // which went with it) stay erased. Had the selection still held the
    // erased cells, the Delete would have re-removed them inside its own step.
    key('z', { ctrlKey: true })
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(['n-b', 'n-c'])
    expect(doc.edges).toEqual([])
  })

  it('an erase right after a placed text is its own undo step', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('t')
    clickBlank(w, [600, 500])
    await settle()
    const input = w.find('[data-testid="diagram-rename-input"]')
    await input.setValue('kept')
    await input.trigger('keydown', { key: 'Enter' })
    await settle()
    await armEraser(w)
    down(nodeEl(w, 'n-b'), IN_B)
    upOnSvg(w, IN_B)
    await settle()
    expect((await saveAndRead(w)).nodes.map((n) => n.id)).not.toContain('n-b')
    key('z', { ctrlKey: true })
    await settle()
    const doc = await saveAndRead(w)
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(['n-1', 'n-a', 'n-b', 'n-c'])
    expect(doc.nodes.find((n) => n.id === 'n-1')?.label).toBe('kept')
  })

  it('resize handles hide in Eraser, and a press on a node erases rather than resizes', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    const handles = (): number => w.element.querySelectorAll('.x6-widget-transform').length
    down(nodeEl(w, 'n-b'), IN_B)
    nodeEl(w, 'n-b').dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: IN_B[0], clientY: IN_B[1] })
    )
    nodeEl(w, 'n-b').dispatchEvent(
      new MouseEvent('click', { bubbles: true, button: 0, clientX: IN_B[0], clientY: IN_B[1] })
    )
    await settle()
    expect(handles()).toBe(1)
    await armEraser(w)
    expect(handles()).toBe(0)
  })

  it('a double-click on a node in Eraser opens no rename', async () => {
    const w = mountPane()
    await settle()
    await armEraser(w)
    nodeEl(w, 'n-c').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, clientX: IN_C[0], clientY: IN_C[1] })
    )
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)
  })
})
