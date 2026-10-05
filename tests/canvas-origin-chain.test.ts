import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync, mkdirSync } from 'node:fs'
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

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { readCanvasFile } from '../src/main/canvas-read'
import { writeCanvasFile } from '../src/main/canvas-write'
import { attachCanvasAssets } from '../src/main/canvas-assets'
import { __resetCanvasWatchStateForTests } from '../src/main/canvas-watch'
import {
  buildCanvasDocumentFromCells,
  operatorImageNode,
  operatorNode
} from '../src/renderer/src/components/canvas/canvas-edit'
import type { CanvasDocument, CanvasNode } from '../src/main/canvas-core'

/**
 * T218 U6-7 — the origin chain, end to end, through the SHIPPED pieces.
 *
 * U1 makes a missing stamp a validation failure, U3 stamps `operator` on the
 * pane's creation paths, U5 stamps `agent` and refuses a caller-supplied value.
 * Each unit tested its own link. THIS file asks the only question the operator
 * actually has: after a real session — the agent draws, the human edits, pastes
 * a screenshot and saves — can the agent read the file back and say which
 * elements are whose?
 *
 * It is the automated companion to the manual AC. The manual one exists because
 * "an agent correctly separates them" is a claim about a model reading a file;
 * this one pins the property that claim depends on — that the file still
 * carries the truthful stamps after the round trip.
 */
const drawCanvasHandler = WIRED_TOOLS.find((t) => t.op === 'draw_canvas')!.handler!

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

let folder: string
let canvasPath: string

const ctxFor = (): Parameters<typeof drawCanvasHandler>[1] =>
  ({ folder, folders: [], denyFolders: [], bridge: undefined }) as Parameters<
    typeof drawCanvasHandler
  >[1]

/** The plain-JSON cells `graph.toJSON()` yields, including the `props` bag an
 *  image node's `src` rides in — hand-built so the assertion does not need a
 *  DOM (the real graph round-trip is covered by `canvas-edit.test.ts`). */
function cellsFor(nodes: readonly CanvasNode[], edges: CanvasDocument['edges']): unknown[] {
  return [
    ...nodes.map((n) => ({
      id: n.id,
      shape: n.shape === 'image' ? 'image' : 'rect',
      position: { x: n.x, y: n.y },
      size: { width: n.width, height: n.height },
      attrs: { text: { text: n.label ?? '' }, label: { text: n.label ?? '' } },
      data: { origin: n.origin, kind: n.shape, ...(n.props ? { props: n.props } : {}) }
    })),
    ...edges.map((e) => ({
      id: e.id,
      shape: 'edge',
      source: { cell: e.source, port: 'right' },
      target: { cell: e.target, port: 'left' },
      data: { origin: e.origin }
    }))
  ]
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-origin-chain-'))
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = folder
  canvasPath = path.join(folder, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
  mkdirSync(path.dirname(canvasPath), { recursive: true })
  __resetCanvasWatchStateForTests()
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>).__TEST_ROOT__
})

describe('U6-7 — the agent can separate its own work from the human’s', () => {
  it('survives draw → operator edit → paste → Save → re-read', async () => {
    // ── 1. The agent draws. U5 stamps `agent`; a caller-supplied origin is
    //       refused, so this is the only value these nodes can carry.
    const drawn = await drawCanvasHandler(
      {
        folder,
        ops: [
          { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'Renderer' },
          { op: 'add_node', shape: 'box', x: 260, y: 0, label: 'Main' },
          { op: 'add_node', shape: 'box', x: 520, y: 0, label: 'PTY' }
        ]
      },
      ctxFor()
    )
    expect(drawn.isError).toBeFalsy()
    const seeded = await readCanvasFile(canvasPath)
    if (!seeded.ok) throw new Error('the agent first draw did not land')
    const wired = await drawCanvasHandler(
      {
        folder,
        ops: [
          {
            op: 'add_edge',
            source: seeded.doc.nodes[0].id,
            target: seeded.doc.nodes[1].id,
            label: 'IPC'
          }
        ]
      },
      ctxFor()
    )
    expect(wired.isError).toBeFalsy()

    const afterAgent = await readCanvasFile(canvasPath)
    expect(afterAgent.ok).toBe(true)
    if (!afterAgent.ok) return
    expect(afterAgent.doc.nodes.map((n) => n.origin)).toEqual(['agent', 'agent', 'agent'])
    const pty = afterAgent.doc.nodes.find((n) => n.label === 'PTY')!

    // ── 2. The operator works on the board: deletes one of the agent's nodes,
    //       renames and moves another, draws one of their own, and pastes a
    //       screenshot — which is externalised into `assets/` immediately.
    const attached = await attachCanvasAssets(canvasPath, [
      { kind: 'bytes', mime: 'image/png', bytes: new Uint8Array(PNG), name: 'flow.png' }
    ])
    expect(attached.ok).toBe(true)
    if (!attached.ok) return

    const taken = new Set(afterAgent.doc.nodes.map((n) => n.id))
    const mine = operatorNode({ x: 0, y: 200, width: 132, height: 52 }, taken, 'My note')
    taken.add(mine.id)
    const shot = operatorImageNode(
      attached.srcs[0],
      { x: 260, y: 200 },
      { width: 180, height: 120 },
      taken,
      'flow.png'
    )

    const kept = afterAgent.doc.nodes
      .filter((n) => n.id !== pty.id) // the human deleted one of the agent's boxes
      .map((n) => (n.label === 'Main' ? { ...n, label: 'Main process', x: n.x + 40 } : n))

    const draft = buildCanvasDocumentFromCells(
      cellsFor([...kept, mine, shot], afterAgent.doc.edges),
      afterAgent.doc,
      '2026-08-24T13:00:00.000Z'
    )
    const saved = await writeCanvasFile(canvasPath, draft)
    expect(saved.ok).toBe(true)

    // ── 3. The agent re-reads the file. This is the whole feature.
    const reread = await readCanvasFile(canvasPath)
    expect(reread.ok).toBe(true)
    if (!reread.ok) return

    const byOrigin = (o: string): string[] =>
      reread.doc.nodes.filter((n) => n.origin === o).map((n) => n.label ?? '')
    expect(byOrigin('agent').sort()).toEqual(['Main process', 'Renderer'])
    expect(byOrigin('operator').sort()).toEqual(['My note', 'flow.png'])

    // The stamp is CREATION provenance, not ownership (§4.4): the operator
    // renamed and moved `Main`, and it is still the agent's node. A last-writer
    // stamp would have flipped it here and erased the answer.
    const main = reread.doc.nodes.find((n) => n.label === 'Main process')!
    expect(main.origin).toBe('agent')
    expect(main.x).toBe(300)

    // The deletion is visible as an absence, and the agent's edge survived with
    // its own stamp.
    expect(reread.doc.nodes.some((n) => n.label === 'PTY')).toBe(false)
    expect(reread.doc.edges.map((e) => e.origin)).toEqual(['agent'])

    // The pasted screenshot is a POINTER, and it is the human's.
    const image = reread.doc.nodes.find((n) => n.shape === 'image')!
    expect(image.origin).toBe('operator')
    expect(image.props?.src).toBe('assets/board-1.png')
    expect(readFileSync(canvasPath, 'utf8')).not.toContain('data:')
    expect((await fs.stat(path.join(path.dirname(canvasPath), 'assets', 'board-1.png'))).size).toBe(
      PNG.byteLength
    )
  })

  it('a node that reaches the writer without a stamp is refused, not defaulted', async () => {
    // The chain is only trustworthy because the missing case FAILS. If a
    // stampless node were quietly defaulted to `operator`, every assertion
    // above would still pass and the answer would be a lie.
    const doc = {
      capycanvas: 1,
      meta: { title: 'x' },
      nodes: [{ id: 'n-1', shape: 'box', x: 0, y: 0, label: 'unstamped' }],
      edges: []
    }
    const res = await writeCanvasFile(canvasPath, doc)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('missing-origin')
    await expect(fs.stat(canvasPath)).rejects.toThrow()
  })
})
