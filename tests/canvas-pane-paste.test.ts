// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import DiagramPane from '../src/renderer/src/components/DiagramPane.vue'
import { i18n } from '@renderer/i18n'
import type { CanvasDocument } from '../src/main/canvas-core'
import { installJsdomSvgShim, svgHost } from './helpers/jsdom-svg'
import {
  IMAGE_NODE_MAX_EXTENT,
  IMAGE_NODE_MIN_EXTENT,
  imageNodeSize,
  operatorImageNode
} from '../src/renderer/src/components/canvas/canvas-edit'
import { validateCanvasDocument } from '../src/main/canvas-core'

installJsdomSvgShim()

/**
 * T218 U6 — the PANE half of asset externalisation (spec §4.6, §4.4).
 *
 * These tests answer the question the main-side suite cannot: does the paste
 * gesture actually go down the externalising path? The load-bearing assertion
 * is on the payload the pane hands the confined WRITER — the very bytes a Save
 * would put on disk — because a node that merely has a `src` would pass against
 * the data URI U3 shipped and U6 removes.
 */

const host = svgHost

const EMPTY: CanvasDocument = { capycanvas: 1, meta: { title: 'Board' }, nodes: [], edges: [] }

const canvasRead = vi.fn(async (p: string) => ({ ok: true as const, path: p, doc: EMPTY }))
const canvasWrite = vi.fn(async () => ({
  ok: true as const,
  path: '/wt/board.harnucanvas.json',
  bytes: 1
}))
const canvasAttachAssets = vi.fn(async () => ({ ok: true as const, srcs: ['assets/board-1.png'] }))
const markdownRead = vi.fn(async () => ({
  ok: true as const,
  kind: 'image' as const,
  content: 'data:image/png;base64,AAAA'
}))

const PANE = {
  id: 'h-canvas',
  type: 'canvas' as const,
  cwd: '/wt',
  ratio: 1,
  filePath: '/wt/board.harnucanvas.json'
}

/** A real `File` carrying real bytes — what a clipboard hands the pane. */
function pngFile(name = 'shot.png', type = 'image/png'): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type })
}

beforeEach(() => {
  for (const m of [canvasRead, canvasWrite, canvasAttachAssets, markdownRead]) m.mockClear()
  canvasRead.mockImplementation(async (p: string) => ({ ok: true, path: p, doc: EMPTY }))
  canvasAttachAssets.mockImplementation(async () => ({ ok: true, srcs: ['assets/board-1.png'] }))
  const api = {
    canvasRead,
    canvasWrite,
    canvasAttachAssets,
    markdownRead,
    canvasWatchStart: vi.fn(async () => undefined),
    canvasWatchStop: vi.fn(async () => undefined),
    onCanvasChanged: () => () => {},
    helpersGet: vi.fn(async () => null),
    helpersSet: vi.fn()
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get: (t: Record<string, unknown>, k: string) => (k in t ? t[k] : () => () => {})
  })
  setActivePinia(createPinia())
})

function mountPane() {
  return mount(DiagramPane, {
    props: { pane: { ...PANE }, worktreePath: '/wt' },
    global: { plugins: [i18n] },
    attachTo: host()
  })
}

async function settle(): Promise<void> {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

/** Fire a paste carrying `files`. jsdom has no `ClipboardEvent` with a usable
 *  `clipboardData`, so the payload is attached to the dispatched event the same
 *  way the browser would present it. */
async function paste(w: ReturnType<typeof mountPane>, files: File[]): Promise<void> {
  await w.find('[data-testid="diagram-pane"] .relative.min-h-0').trigger('paste', {
    clipboardData: { files }
  })
  await settle()
}

async function drop(w: ReturnType<typeof mountPane>, files: File[]): Promise<void> {
  await w.find('[data-testid="diagram-pane"] .relative.min-h-0').trigger('drop', {
    dataTransfer: { files },
    clientX: 100,
    clientY: 80
  })
  await settle()
}

describe('U6-1 — pasting an image externalises it; the pane never holds a data URI', () => {
  it('sends BYTES to main and stores the relative path it hands back', async () => {
    const w = mountPane()
    await settle()
    await paste(w, [pngFile()])

    expect(canvasAttachAssets).toHaveBeenCalledTimes(1)
    const [path, images] = canvasAttachAssets.mock.calls[0] as unknown as [
      string,
      { kind: string; mime: string; bytes: Uint8Array; name?: string }[]
    ]
    expect(path).toBe('/wt/board.harnucanvas.json')
    expect(images).toHaveLength(1)
    expect(images[0].kind).toBe('bytes')
    expect(images[0].mime).toBe('image/png')
    expect(images[0].bytes).toBeInstanceOf(Uint8Array)
    expect(images[0].bytes.byteLength).toBe(8)
    w.unmount()
  })

  it('the SAVE payload carries a relative src and an operator stamp — no data URI', async () => {
    const w = mountPane()
    await settle()
    await paste(w, [pngFile()])

    // The dirty dot is the operator-visible half of "this is unsaved working
    // state" (§7.1): the asset bytes are already on disk, the NODE is not.
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(true)

    await w.find('[data-testid="diagram-save"]').trigger('click')
    await settle()
    expect(canvasWrite).toHaveBeenCalledTimes(1)
    const [, doc] = canvasWrite.mock.calls[0] as unknown as [string, CanvasDocument]
    const image = doc.nodes.find((n) => n.shape === 'image')
    expect(image).toBeDefined()
    expect(image?.props?.src).toBe('assets/board-1.png')
    expect(image?.origin).toBe('operator')
    // The whole point, asserted against the bytes a Save would write.
    expect(JSON.stringify(doc)).not.toContain('data:')
    w.unmount()
  })

  it('renders the new asset through the SAME confined reader a load uses', async () => {
    const w = mountPane()
    await settle()
    markdownRead.mockClear()
    await paste(w, [pngFile()])
    expect(markdownRead).toHaveBeenCalledWith('assets/board-1.png', '/wt')
    w.unmount()
  })
})

describe('U6-2 — drag-and-drop is the same path as paste', () => {
  it('a dropped file is externalised exactly as a pasted one is', async () => {
    const w = mountPane()
    await settle()
    await drop(w, [pngFile('dropped.png')])

    expect(canvasAttachAssets).toHaveBeenCalledTimes(1)
    const [, images] = canvasAttachAssets.mock.calls[0] as unknown as [
      string,
      { kind: string; mime: string }[]
    ]
    // BYTES, not a filesystem path — the drop never asks main to read a file
    // the pane could not read itself.
    expect(images[0].kind).toBe('bytes')
    expect(images[0].mime).toBe('image/png')
    w.unmount()
  })

  it('a drop of something that is not an image is ignored, not attached', async () => {
    const w = mountPane()
    await settle()
    await drop(w, [new File(['x'], 'notes.txt', { type: 'text/plain' })])
    expect(canvasAttachAssets).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('a refused attach adds nothing to the board', () => {
  it('surfaces the refusal and leaves the document as it was', async () => {
    canvasAttachAssets.mockImplementation(async () => ({
      ok: false as const,
      code: 'SOURCE_NOT_ALLOWED',
      error: 'nope'
    }))
    const w = mountPane()
    await settle()
    await paste(w, [pngFile()])
    // No node was created, so there is nothing unsaved to warn about.
    expect(w.find('[data-testid="diagram-dirty-dot"]').exists()).toBe(false)
    expect(canvasWrite).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('the image node itself', () => {
  it('clamps a screenshot to a card the operator can still see around it', () => {
    // A 3840×2160 screenshot at 1:1 would be a wall the operator has to zoom
    // out of before they can find the rest of the board.
    const big = imageNodeSize(3840, 2160)
    expect(Math.max(big.width, big.height)).toBe(IMAGE_NODE_MAX_EXTENT)
    expect(big.width / big.height).toBeCloseTo(3840 / 2160, 1)

    // A small image keeps its own size rather than being blown up.
    expect(imageNodeSize(120, 90)).toEqual({ width: 120, height: 90 })
    // …but never smaller than something you can grab.
    expect(imageNodeSize(4000, 8).height).toBe(IMAGE_NODE_MIN_EXTENT)
  })

  it('falls back to the default footprint when the size cannot be decoded', () => {
    // `createImageBitmap` is absent in jsdom and rejects on a corrupt payload;
    // neither is a reason to refuse an image main already accepted.
    for (const bad of [
      [0, 0],
      [-4, 10],
      [Number.NaN, 100]
    ] as const) {
      expect(imageNodeSize(bad[0], bad[1])).toEqual({ width: 132, height: 52 })
    }
  })

  it('is a stamped, valid document node carrying a relative src', () => {
    const node = operatorImageNode(
      'assets/board-1.png',
      { x: 10.4, y: 20.6 },
      { width: 180, height: 120 },
      new Set(['n-1']),
      'shot.png'
    )
    expect(node.id).toBe('n-2')
    expect(node.shape).toBe('image')
    expect(node.origin).toBe('operator')
    expect(node.props).toEqual({ src: 'assets/board-1.png' })
    expect([node.x, node.y]).toEqual([10, 21])
    // The writer is the authority on what a document is — so ask it.
    expect(validateCanvasDocument({ capycanvas: 1, meta: {}, nodes: [node], edges: [] }).ok).toBe(
      true
    )
  })
})
