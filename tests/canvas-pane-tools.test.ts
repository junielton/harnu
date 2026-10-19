// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import DiagramPane from '../src/renderer/src/components/DiagramPane.vue'
import { DEFAULT_NODE_SIZE } from '../src/renderer/src/components/canvas/canvas-cells'
import { validateCanvasDocument, type CanvasDocument } from '../src/main/canvas-core'
import { i18n } from '@renderer/i18n'
import { installJsdomSvgShim } from './helpers/jsdom-svg'

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
  document.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true, clientX: at[0], clientY: at[1], ...init })
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

  it('double-click renames in every tool but Eraser', async () => {
    const w = mountPane()
    await settle()
    focusPane(w)
    key('e')
    nodeEl(w, 'n-a').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, button: 0, clientX: 60, clientY: 60 })
    )
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(false)

    focusPane(w)
    key('v')
    nodeEl(w, 'n-a').dispatchEvent(
      new MouseEvent('dblclick', { bubbles: true, button: 0, clientX: 60, clientY: 60 })
    )
    await settle()
    expect(w.find('[data-testid="diagram-rename-input"]').exists()).toBe(true)
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
