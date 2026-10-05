import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

vi.mock('../src/main/markdown-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/markdown-read')>()
  return {
    ...actual,
    markdownKnownRoots: async () => [(globalThis as Record<string, unknown>).__TEST_ROOT__]
  }
})

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { CommandBridge } from '../src/main/command-bridge'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { serializeCanvasDocument, type CanvasDocument } from '../src/main/canvas-core'
import { __resetCanvasWatchStateForTests } from '../src/main/canvas-watch'

/**
 * T218 U5 — `draw_canvas` driven through the REAL wired handler.
 *
 * WHY THIS FILE EXISTS, and why the pure-side tests are not enough. U5-2's "no
 * partial apply" is a claim about the SHIPPED SHELL: that when a batch is
 * refused, nothing reaches disk. `tests/mcp-canvas-ops.test.ts` asserts the
 * bytes too, but through a test-local read→apply→write helper — a
 * reimplementation of the shell that writes only on success BY CONSTRUCTION.
 * Its `Buffer.equals` can therefore never fail on its own; it only runs after
 * the code assertion already passed. A mutation that made the real handler
 * return the documented refusal AND write the longest valid prefix — exactly
 * the corruption the AC exists to prevent — survived that suite untouched.
 *
 * These tests call `drawCanvasHandler` itself, so the assertion is load-bearing
 * against the code that actually ships. The harness (electron stub + WIRED_TOOLS
 * lookup) is the one `tests/mcp-submit-manifest-handler.test.ts` established.
 */
const drawCanvasHandler = WIRED_TOOLS.find((t) => t.op === 'draw_canvas')!.handler!

const NOW = '2026-08-24T12:00:00.000Z'

/** One operator-drawn node, so every refusal test also proves the human's work
 *  is untouched — not merely that the file did not change size. */
const SEED: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Seed', createdAt: NOW, updatedAt: NOW },
  nodes: [
    {
      id: 'human-1',
      shape: 'box',
      x: 0,
      y: 0,
      width: 120,
      height: 40,
      label: 'mine',
      origin: 'operator'
    }
  ],
  edges: []
}

let folder: string
let canvasPath: string

function payload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return JSON.parse(first.text)
}

/** `isError` results carry a bare `CODE: message` string, not JSON. */
function errorText(res: CallToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return first.text
}

const ctxFor = (extra: Record<string, unknown> = {}): Parameters<typeof drawCanvasHandler>[1] =>
  ({
    folder,
    folders: [],
    denyFolders: [],
    bridge: undefined,
    ...extra
  }) as Parameters<typeof drawCanvasHandler>[1]

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-draw-canvas-handler-'))
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = folder
  canvasPath = path.join(folder, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
  mkdirSync(path.dirname(canvasPath), { recursive: true })
  writeFileSync(canvasPath, serializeCanvasDocument(SEED), 'utf8')
  __resetCanvasWatchStateForTests()
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>).__TEST_ROOT__
})

describe('drawCanvasHandler — U5-2: a refused batch writes NOTHING', () => {
  it('20 ops with an invalid 17th: the file is byte-identical afterwards', async () => {
    const before = readFileSync(canvasPath)
    const ops: unknown[] = Array.from({ length: 20 }, (_, i) => ({
      op: 'add_node',
      shape: 'box',
      x: i * 10,
      y: 0,
      label: `n${i}`
    }))
    ops[16] = { op: 'add_node', shape: 'diamond', x: 0, y: 0 }

    const res = await drawCanvasHandler({ folder, ops }, ctxFor())

    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('UNKNOWN_SHAPE')
    // The point: not "16 ops applied". Bytes, from the shipped handler.
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it.each([
    [
      'UNKNOWN_ID',
      [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'a' },
        { op: 'add_node', shape: 'box', x: 40, y: 0, label: 'b' },
        { op: 'remove_node', id: 'does-not-exist' }
      ]
    ],
    [
      'ORIGIN_NOT_ALLOWED',
      [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'a' },
        { op: 'add_node', shape: 'box', x: 40, y: 0, origin: 'operator' }
      ]
    ],
    [
      'BAD_GEOMETRY',
      [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'a' },
        { op: 'add_node', shape: 'box', x: 0, y: 0, width: -1 }
      ]
    ],
    [
      'BAD_PROPS',
      [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'a' },
        { op: 'add_node', shape: 'box', x: 0, y: 0, props: { nope: 1 } }
      ]
    ],
    [
      'LABEL_TOO_LONG',
      [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'a' },
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'x'.repeat(2001) }
      ]
    ]
  ])('a batch refused with %s leaves the file byte-identical', async (code, ops) => {
    const before = readFileSync(canvasPath)
    const res = await drawCanvasHandler({ folder, ops }, ctxFor())
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain(code)
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('a batch that would rename the operator’s node but fails later never renames it', async () => {
    const before = readFileSync(canvasPath)
    const res = await drawCanvasHandler(
      {
        folder,
        ops: [
          { op: 'update_node', id: 'human-1', label: 'renamed by the agent' },
          { op: 'remove_node', id: 'human-1' },
          { op: 'update_node', id: 'human-1', label: 'ghost' }
        ]
      },
      ctxFor()
    )
    expect(res.isError).toBe(true)
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
    expect(readFileSync(canvasPath, 'utf8')).toContain('"mine"')
  })

  it('an unknown schema major refuses and writes nothing', async () => {
    writeFileSync(canvasPath, JSON.stringify({ capycanvas: 99, nodes: [], edges: [] }), 'utf8')
    const before = readFileSync(canvasPath)
    const res = await drawCanvasHandler(
      { folder, ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }] },
      ctxFor()
    )
    expect(errorText(res)).toContain('SCHEMA_UNSUPPORTED')
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('a path outside the two allowed directories refuses and creates no file', async () => {
    const res = await drawCanvasHandler(
      {
        folder,
        path: 'src/sneaky.harnucanvas.json',
        ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }]
      },
      ctxFor()
    )
    expect(errorText(res)).toContain('PATH_NOT_ALLOWED')
    await expect(fs.access(path.join(folder, 'src', 'sneaky.harnucanvas.json'))).rejects.toThrow()
  })

  it('a path escaping the folder refuses and creates no file', async () => {
    const outside = path.join(os.tmpdir(), 'harnu-escape-target')
    await fs.rm(outside, { recursive: true, force: true })
    const res = await drawCanvasHandler(
      {
        folder,
        path: path.join(outside, '.harnu/out/canvas/board.harnucanvas.json'),
        ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }]
      },
      ctxFor()
    )
    expect(errorText(res)).toContain('PATH_NOT_ALLOWED')
    await expect(fs.access(outside)).rejects.toThrow()
  })
})

describe('drawCanvasHandler — the ACK, and what DOES land', () => {
  it('a valid batch writes, stamps origin "agent", and returns the minted ids + catalog', async () => {
    const res = await drawCanvasHandler(
      {
        folder,
        ops: [
          { op: 'add_node', shape: 'box', x: 0, y: 100, label: 'Reader' },
          { op: 'add_node', shape: 'box', x: 200, y: 100, label: 'Store' }
        ]
      },
      ctxFor()
    )
    expect(res.isError).toBeFalsy()
    const ack = payload(res)
    expect(ack.ok).toBe(true)
    expect(ack.op).toBe('draw_canvas')
    expect(ack.path).toBe(canvasPath)
    expect(ack.nodeCount).toBe(3)
    expect(ack.edgeCount).toBe(0)

    const applied = ack.applied as { op: string; id: string }[]
    expect(applied.map((a) => a.op)).toEqual(['add_node', 'add_node'])
    for (const a of applied) expect(a.id).toMatch(/^n-[0-9a-f]{4}$/)

    // §8.1: the ACK teaches the vocabulary on the FIRST call.
    const shapes = ack.shapes as { name: string }[]
    expect(shapes.map((s) => s.name)).toContain('harnu/mockup-card')

    const onDisk = JSON.parse(readFileSync(canvasPath, 'utf8')) as CanvasDocument
    expect(onDisk.nodes.map((n) => n.origin)).toEqual(['operator', 'agent', 'agent'])
    expect(onDisk.meta.updatedAt).not.toBe(NOW)
    expect(onDisk.meta.createdAt).toBe(NOW)
  })

  it('an edge can bind two nodes minted in the SAME call', async () => {
    const res = await drawCanvasHandler(
      {
        folder,
        ops: [
          { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'A' },
          { op: 'add_node', shape: 'box', x: 200, y: 0, label: 'B' }
        ]
      },
      ctxFor()
    )
    const ids = (payload(res).applied as { id: string }[]).map((a) => a.id)
    const res2 = await drawCanvasHandler(
      { folder, ops: [{ op: 'add_edge', source: ids[0], target: ids[1], label: 'reads' }] },
      ctxFor()
    )
    expect(payload(res2).edgeCount).toBe(1)
    const onDisk = JSON.parse(readFileSync(canvasPath, 'utf8')) as CanvasDocument
    expect(onDisk.edges[0]).toMatchObject({ label: 'reads', origin: 'agent' })
  })

  it('U5-4 end to end: clear drops the agent’s work and keeps the operator’s', async () => {
    await drawCanvasHandler(
      {
        folder,
        ops: [
          { op: 'add_node', shape: 'box', x: 0, y: 100, label: 'A' },
          { op: 'add_node', shape: 'box', x: 90, y: 100, label: 'B' }
        ]
      },
      ctxFor()
    )
    const res = await drawCanvasHandler({ folder, ops: [{ op: 'clear' }] }, ctxFor())
    expect(payload(res).nodeCount).toBe(1)
    const onDisk = JSON.parse(readFileSync(canvasPath, 'utf8')) as CanvasDocument
    expect(onDisk.nodes.map((n) => n.id)).toEqual(['human-1'])
    expect(onDisk.nodes[0].label).toBe('mine')
  })

  it('the first call on a fresh worktree CREATES the board rather than refusing', async () => {
    await fs.rm(path.join(folder, '.harnu'), { recursive: true, force: true })
    const res = await drawCanvasHandler(
      { folder, ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, label: 'first' }] },
      ctxFor()
    )
    expect(res.isError).toBeFalsy()
    const onDisk = JSON.parse(readFileSync(canvasPath, 'utf8')) as CanvasDocument
    expect(onDisk.nodes).toHaveLength(1)
    expect(onDisk.nodes[0].origin).toBe('agent')
  })

  it('writes into docs/canvas/ too — the tracked home for a deliverable diagram', async () => {
    const tracked = path.join(folder, 'docs', 'canvas', 'service-map.harnucanvas.json')
    const res = await drawCanvasHandler(
      {
        folder,
        path: 'docs/canvas/service-map.harnucanvas.json',
        ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, label: 'Gateway' }]
      },
      ctxFor()
    )
    expect(payload(res).path).toBe(tracked)
    expect(readFileSync(tracked, 'utf8')).toContain('Gateway')
  })
})

describe('drawCanvasHandler — opening the pane', () => {
  const knownFolderCtx = (dispatch: ReturnType<typeof vi.fn>) =>
    ctxFor({
      folders: [{ path: folder, sessions: [] }],
      bridge: { dispatch } as unknown as CommandBridge
    })

  it('opens the pane by default, in the CALLER’s folder, with the canvas path', async () => {
    const dispatch = vi.fn().mockResolvedValue({ paneId: 'p1' })
    const res = await drawCanvasHandler(
      { folder, ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }] },
      knownFolderCtx(dispatch)
    )
    expect(dispatch).toHaveBeenCalledWith('pane.openMarkdown', {
      worktreePath: folder,
      filePath: canvasPath
    })
    expect(payload(res).opened).toBe(true)
  })

  it('open:false draws without opening anything', async () => {
    const dispatch = vi.fn().mockResolvedValue({ paneId: 'p1' })
    const res = await drawCanvasHandler(
      { folder, open: false, ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }] },
      knownFolderCtx(dispatch)
    )
    expect(dispatch).not.toHaveBeenCalled()
    expect(payload(res).opened).toBe(false)
  })

  it('a drawing that LANDED is never reported as failed because no window was up', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('no window'))
    const res = await drawCanvasHandler(
      { folder, ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, label: 'drawn' }] },
      knownFolderCtx(dispatch)
    )
    expect(res.isError).toBeFalsy()
    expect(payload(res).ok).toBe(true)
    expect(payload(res).opened).toBe(false)
    expect(readFileSync(canvasPath, 'utf8')).toContain('drawn')
  })
})

describe('drawCanvasHandler — images (§4.6 / §8.3 rule 11)', () => {
  it('externalises a source inside the folder and returns its relative src', async () => {
    const src = path.join(folder, 'shot.png')
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const res = await drawCanvasHandler(
      { folder, images: [src], ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }] },
      ctxFor()
    )
    expect(payload(res).assets).toEqual(['assets/board-1.png'])
    const copied = path.join(folder, '.harnu', 'out', 'canvas', 'assets', 'board-1.png')
    expect(readFileSync(copied).length).toBe(4)
    // Bytes live beside the canvas, NEVER inside it.
    expect(readFileSync(canvasPath, 'utf8')).not.toContain('data:image')
  })

  it('refuses a source outside the jail, copies nothing, and writes nothing', async () => {
    const before = readFileSync(canvasPath)
    const outside = path.join(os.tmpdir(), `harnu-outside-${process.pid}.png`)
    writeFileSync(outside, Buffer.from([0x89, 0x50]))
    try {
      const res = await drawCanvasHandler(
        { folder, images: [outside], ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }] },
        ctxFor()
      )
      expect(errorText(res)).toContain('SOURCE_NOT_ALLOWED')
      expect(readFileSync(canvasPath).equals(before)).toBe(true)
      await expect(
        fs.access(path.join(folder, '.harnu', 'out', 'canvas', 'assets'))
      ).rejects.toThrow()
    } finally {
      await fs.rm(outside, { force: true })
    }
  })

  it('refuses a non-image extension — the jail is not just about location', async () => {
    const src = path.join(folder, 'secrets.env')
    writeFileSync(src, 'TOKEN=1')
    const res = await drawCanvasHandler(
      { folder, images: [src], ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }] },
      ctxFor()
    )
    expect(errorText(res)).toContain('SOURCE_NOT_IMAGE')
  })

  it('validates EVERY source before copying ANY — one bad source copies nothing', async () => {
    const good = path.join(folder, 'good.png')
    writeFileSync(good, Buffer.from([0x89]))
    const res = await drawCanvasHandler(
      {
        folder,
        images: [good, path.join(folder, 'missing.png')],
        ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }]
      },
      ctxFor()
    )
    expect(errorText(res)).toContain('SOURCE_NOT_FOUND')
    await expect(
      fs.access(path.join(folder, '.harnu', 'out', 'canvas', 'assets'))
    ).rejects.toThrow()
  })

  it('a second attach never overwrites the first', async () => {
    const a = path.join(folder, 'a.png')
    writeFileSync(a, Buffer.from([1, 2, 3]))
    await drawCanvasHandler(
      { folder, images: [a], ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0 }] },
      ctxFor()
    )
    const b = path.join(folder, 'b.png')
    writeFileSync(b, Buffer.from([9, 9]))
    const res = await drawCanvasHandler(
      { folder, images: [b], ops: [{ op: 'add_node', shape: 'box', x: 9, y: 9 }] },
      ctxFor()
    )
    expect(payload(res).assets).toEqual(['assets/board-2.png'])
    const dir = path.join(folder, '.harnu', 'out', 'canvas', 'assets')
    expect(readFileSync(path.join(dir, 'board-1.png')).length).toBe(3)
    expect(readFileSync(path.join(dir, 'board-2.png')).length).toBe(2)
  })
})

// ---------------------------------------------------------------- T218 U7 ---

/**
 * U7-4 — **the canvas file cannot carry agent-authored markup.**
 *
 * §5.2's security argument is not "we escape it": it is that there is no field
 * to put it in. An HTML node is a registered component referenced BY NAME, so
 * what reaches disk is a shape string plus plain-JSON `props` the renderer
 * interprets. These assertions are on the BYTES the shipped handler wrote,
 * because that is the only place the claim can be true or false — the renderer
 * half (a `<script>` in a prop string staying characters) lives in
 * `canvas-mockup-card.test.ts`.
 */
describe('drawCanvasHandler — U7-4: the file holds a shape NAME and plain JSON', () => {
  const CARD = {
    op: 'add_node',
    shape: 'harnu/mockup-card',
    x: 120,
    y: 80,
    label: 'Deliverable',
    props: {
      title: 'Sidebar redesign',
      subtitle: 'Two zones',
      status: 'ready',
      body: 'Pinned folders on top, Active elsewhere below.'
    }
  }

  it('writes shape + props and nothing else — no markup anywhere in the bytes', async () => {
    const res = await drawCanvasHandler({ folder, ops: [CARD] }, ctxFor())
    expect(res.isError).toBeFalsy()

    const raw = readFileSync(canvasPath, 'utf8')
    // No angle bracket, no `html` key, no `script` — in the WHOLE file, not
    // just in the node we can see.
    expect(raw).not.toContain('<')
    expect(raw).not.toContain('script')
    expect(raw.toLowerCase()).not.toContain('"html"')

    const doc = JSON.parse(raw) as CanvasDocument
    const card = doc.nodes.find((n) => n.shape === 'harnu/mockup-card')
    expect(card, 'the card was not written').toBeDefined()
    // The node's keys are the schema's, with no extra channel bolted on.
    expect(Object.keys(card!).sort()).toEqual(
      ['height', 'id', 'label', 'origin', 'props', 'shape', 'width', 'x', 'y'].sort()
    )
    expect(card!.origin).toBe('agent')
    expect(card!.props).toEqual(CARD.props)
    // …and every prop value is a JSON primitive, so there is nothing for a
    // renderer to `innerHTML` even by accident.
    for (const value of Object.values(card!.props!)) expect(typeof value).toBe('string')
    // The manifest's footprint, applied server-side (the drift valve pins the
    // pane's fallback to the same numbers).
    expect({ width: card!.width, height: card!.height }).toEqual({ width: 260, height: 160 })
  })

  it('an `html` prop is REFUSED by name and the file is byte-identical', async () => {
    const before = readFileSync(canvasPath)
    const res = await drawCanvasHandler(
      {
        folder,
        ops: [{ ...CARD, props: { title: 'ok', html: '<script>alert(1)</script>' } }]
      },
      ctxFor()
    )
    expect(res.isError).toBe(true)
    // Rule 6: a key the shape does not declare is a refusal, not silent junk.
    expect(errorText(res)).toContain('BAD_PROPS')
    expect(errorText(res)).toContain('html')
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('a top-level `html` field on the op is refused, not stored', async () => {
    const before = readFileSync(canvasPath)
    const res = await drawCanvasHandler(
      { folder, ops: [{ ...CARD, html: '<div>hi</div>' }] },
      ctxFor()
    )
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('BAD_ARGS')
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('a prop value that would not survive JSON is refused, and nothing is written', async () => {
    // The last gate is U1's document validator, which walks `props` for
    // anything `JSON.stringify` would not survive — the same check that keeps
    // `graph.toJSON()` from throwing (spike trap 2). `NaN` is the reachable
    // case: it is a real JS value the handler can be handed in-process, and it
    // serializes to `null`, so without the gate the file would silently gain a
    // prop the caller never wrote.
    const before = readFileSync(canvasPath)
    const res = await drawCanvasHandler(
      { folder, ops: [{ ...CARD, props: { title: 'ok', body: Number.NaN } }] },
      ctxFor()
    )
    expect(res.isError).toBe(true)
    expect(errorText(res)).toContain('INVALID_DOCUMENT')
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('markup INSIDE a prop string is stored verbatim — and is only ever text', async () => {
    // `body` is prose; "wrap it in a <div>" is a legitimate sentence, so the
    // verb does not sanitize it. That is safe precisely because the renderer
    // sets it with `textContent` (asserted in `canvas-mockup-card.test.ts`):
    // the file holds characters, and characters are all that ever render.
    const res = await drawCanvasHandler(
      { folder, ops: [{ ...CARD, props: { title: 'ok', body: 'wrap it in a <div>' } }] },
      ctxFor()
    )
    expect(res.isError).toBeFalsy()
    const doc = JSON.parse(readFileSync(canvasPath, 'utf8')) as CanvasDocument
    const card = doc.nodes.find((n) => n.shape === 'harnu/mockup-card')
    expect(card!.props!.body).toBe('wrap it in a <div>')
    // Still no `html` key, and still nothing but props.
    expect(card).not.toHaveProperty('html')
  })

  it('the ACK advertises the shape so the agent never has to guess the name', async () => {
    const res = await drawCanvasHandler({ folder, ops: [CARD] }, ctxFor())
    const shapes = payload(res).shapes as Array<{ name: string }>
    expect(shapes.map((s) => s.name)).toContain('harnu/mockup-card')
  })
})

/**
 * U7-1 — a generated PNG becomes an image NODE, end to end through the shipped
 * handler: `images` externalises the bytes, the ACK hands back the relative
 * `src`, and a following `add_node` puts it on the board.
 *
 * The AC is marked manual because "it appears on the canvas" is a claim about
 * pixels. What is machine-checkable is everything up to the pixels, and this
 * asserts that: the bytes are beside the canvas, the node points at them by
 * relative path, and the image never enters the canvas file (§4.6).
 */
describe('drawCanvasHandler — U7-1: a generated image lands as an image node', () => {
  it('two calls: attach the bytes, then reference the src the ACK returned', async () => {
    const png = path.join(folder, 'mockup.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    writeFileSync(png, bytes)

    const attach = await drawCanvasHandler(
      { folder, images: [png], ops: [{ op: 'add_node', shape: 'text', x: 0, y: 0, label: 'v1' }] },
      ctxFor()
    )
    expect(attach.isError).toBeFalsy()
    const srcs = payload(attach).assets as string[]
    expect(srcs).toEqual(['assets/board-1.png'])

    const place = await drawCanvasHandler(
      {
        folder,
        ops: [
          {
            op: 'add_node',
            shape: 'image',
            x: 200,
            y: 120,
            label: 'Sidebar mockup',
            props: { src: srcs[0] }
          }
        ]
      },
      ctxFor()
    )
    expect(place.isError).toBeFalsy()

    const raw = readFileSync(canvasPath, 'utf8')
    const doc = JSON.parse(raw) as CanvasDocument
    const image = doc.nodes.find((n) => n.shape === 'image')
    expect(image!.props).toEqual({ src: 'assets/board-1.png' })
    expect(image!.origin).toBe('agent')
    expect(image!.label).toBe('Sidebar mockup')

    // The bytes are on disk NEXT TO the canvas, byte-for-byte…
    const asset = path.join(folder, '.harnu', 'out', 'canvas', 'assets', 'board-1.png')
    expect(readFileSync(asset).equals(bytes)).toBe(true)
    // …and NOT in the canvas file. §4.6 exists because every Save rewrites the
    // whole document, so an inlined data URI is paid for on every write.
    expect(raw).not.toContain('data:image')
    expect(raw).not.toContain('base64')
    expect(raw.length).toBeLessThan(2000)
  })
})
