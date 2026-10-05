import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import {
  applyCanvasOps,
  canvasAssetsDir,
  canvasShapeCatalogAck,
  canvasShapeNames,
  canvasVerbCode,
  defaultCanvasPath,
  planCanvasAssets,
  resolveCanvasWritePath,
  CANVAS_OP_NAMES,
  CANVAS_WRITE_DIRS,
  MAX_CANVAS_IMAGES_PER_CALL,
  MAX_CANVAS_OPS_PER_CALL,
  type CanvasIdMinter
} from '../src/main/mcp/canvas-ops'
import {
  CANVAS_SHAPE_CATALOG,
  canvasShapeSpec,
  CANVAS_HTML_SHAPES,
  LEGACY_CANVAS_SHAPE_NAMES
} from '../src/main/mcp/canvas-shapes'
import {
  MAX_CANVAS_LABEL_CHARS,
  emptyCanvasDocument,
  serializeCanvasDocument,
  type CanvasDocument
} from '../src/main/canvas-core'
import { DEFAULT_SIZE_BY_SHAPE } from '../src/renderer/src/components/canvas/canvas-cells'
import { readCanvasFile } from '../src/main/canvas-read'
import { writeCanvasFile } from '../src/main/canvas-write'
import { __resetCanvasWatchStateForTests } from '../src/main/canvas-watch'

/**
 * T218 U5 — the `draw_canvas` verb's PURE half (spec §8): path containment,
 * the seven ops, and every validation rule of §8.3.
 *
 * The last block runs the SHELL's exact composition (read → apply → write)
 * against a real temp directory, because U5-2's "no partial apply" is a claim
 * about BYTES ON DISK: a batch whose 17th op is invalid must leave the file
 * byte-identical, not 16 ops applied. Asserting only that an error came back
 * would not catch a writer that had already committed. Electron is stubbed the
 * same way `tests/canvas-read-write.test.ts` stubs it.
 */

vi.mock('electron', () => ({
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

vi.mock('../src/main/markdown-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/markdown-read')>()
  return {
    ...actual,
    markdownKnownRoots: async () => [(globalThis as Record<string, unknown>).__TEST_ROOT__]
  }
})

/** Deterministic id minter: `n-0`, `n-1`, … so assertions can name ids. */
function counterMinter(): CanvasIdMinter {
  const seen = { n: 0, e: 0 }
  return (prefix) => `${prefix}-${seen[prefix]++}`
}

const NOW = '2026-08-24T12:00:00.000Z'

function docWith(
  nodes: CanvasDocument['nodes'] = [],
  edges: CanvasDocument['edges'] = []
): CanvasDocument {
  return { ...emptyCanvasDocument(NOW), nodes, edges }
}

// ---------------------------------------------------------------- shapes ----

describe('shape manifest (§5.2)', () => {
  it('the catalog carries every built-in kind plus the registered HTML shape', () => {
    expect(canvasShapeNames()).toEqual(['box', 'text', 'image', 'harnu/mockup-card'])
  })

  it('every registered HTML shape is namespaced `harnu/` so it can never collide with a built-in', () => {
    for (const s of CANVAS_HTML_SHAPES) expect(s.name.startsWith('harnu/')).toBe(true)
  })

  it('the ACK catalog is name + one-line description + defaultSize, nothing else', () => {
    const ack = canvasShapeCatalogAck()
    expect(ack).toHaveLength(CANVAS_SHAPE_CATALOG.length)
    for (const entry of ack) {
      expect(Object.keys(entry).sort()).toEqual(['defaultSize', 'description', 'name'])
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.defaultSize.width).toBeGreaterThan(0)
      expect(entry.defaultSize.height).toBeGreaterThan(0)
    }
  })

  it('DRIFT VALVE: the manifest default sizes equal the pane fallbacks in canvas-cells.ts', () => {
    // The manifest lives in `src/main` (composite-tsconfig boundary — see its
    // module doc); this pins the duplication so a node the verb sizes and a node
    // the pane sizes can never come out different.
    //
    // It walks the WHOLE catalog rather than naming shapes one at a time (T218
    // U7): the two-shape version passed while `image` (240×160 in the manifest,
    // 132×52 in the pane) and later `harnu/mockup-card` were both already
    // drifting — a test that only checks what it was written for is a test that
    // goes quiet exactly when a shape is added.
    for (const spec of CANVAS_SHAPE_CATALOG) {
      expect(DEFAULT_SIZE_BY_SHAPE[spec.name], `no pane fallback for shape "${spec.name}"`).toEqual(
        { ...spec.defaultSize }
      )
    }
    // …and nothing in the pane's map that the manifest has never heard of: an
    // orphan entry is the same drift pointing the other way.
    // The pane also keeps the pre-rename `capy/<name>` aliases so old boards render.
    const withoutLegacy = Object.keys(DEFAULT_SIZE_BY_SHAPE).filter(
      (n) => !(n in LEGACY_CANVAS_SHAPE_NAMES)
    )
    expect(withoutLegacy.sort()).toEqual(canvasShapeNames().sort())
    for (const [legacy, current] of Object.entries(LEGACY_CANVAS_SHAPE_NAMES)) {
      expect(DEFAULT_SIZE_BY_SHAPE[legacy]).toEqual(DEFAULT_SIZE_BY_SHAPE[current])
    }
  })
})

// ------------------------------------------------ rule 2: path containment ---

describe('§8.3 rule 2 — path containment', () => {
  const FOLDER = '/repo'

  it('defaults to the folder board under .harnu/out/canvas/', () => {
    const res = resolveCanvasWritePath(FOLDER)
    expect(res).toMatchObject({ ok: true, path: defaultCanvasPath(FOLDER), name: 'board' })
  })

  it('accepts both allowed directories, relative or absolute', () => {
    for (const dir of CANVAS_WRITE_DIRS) {
      const rel = resolveCanvasWritePath(FOLDER, `${dir}/plan.harnucanvas.json`)
      expect(rel.ok, `${dir} (relative)`).toBe(true)
      const abs = resolveCanvasWritePath(FOLDER, `${FOLDER}/${dir}/plan.harnucanvas.json`)
      expect(abs.ok, `${dir} (absolute)`).toBe(true)
    }
  })

  it('writes new boards as *.harnucanvas.json under .harnu/out/canvas/ (AC-3)', () => {
    expect(defaultCanvasPath(FOLDER)).toBe('/repo/.harnu/out/canvas/board.harnucanvas.json')
    expect(CANVAS_WRITE_DIRS).toEqual(['.harnu/out/canvas', 'docs/canvas'])
  })

  it('still accepts the legacy .capycanvas.json suffix under both allowed directories (AC-3)', () => {
    for (const dir of CANVAS_WRITE_DIRS) {
      const res = resolveCanvasWritePath(FOLDER, `${dir}/old-plan.capycanvas.json`)
      expect(res, `${dir}`).toMatchObject({ ok: true, name: 'old-plan' })
    }
  })

  it('does not accept the legacy .capy/out/canvas/ directory as a write target (AC-3)', () => {
    expect(resolveCanvasWritePath(FOLDER, '.capy/out/canvas/b.capycanvas.json')).toMatchObject({
      ok: false,
      code: 'PATH_NOT_ALLOWED'
    })
  })

  it('derives the asset filename stem from the basename, without the double extension', () => {
    const res = resolveCanvasWritePath(FOLDER, 'docs/canvas/service-map.harnucanvas.json')
    expect(res).toMatchObject({ ok: true, name: 'service-map' })
  })

  it('refuses a path outside the two allowed directories with PATH_NOT_ALLOWED', () => {
    const res = resolveCanvasWritePath(FOLDER, 'src/board.harnucanvas.json')
    expect(res).toMatchObject({ ok: false, code: 'PATH_NOT_ALLOWED' })
    // Never clamped into an allowed dir — the refusal names what it wanted.
    if (!res.ok) expect(res.error).toContain('.harnu/out/canvas')
  })

  it('refuses a traversal escape and an absolute re-root', () => {
    expect(
      resolveCanvasWritePath(FOLDER, '../elsewhere/.harnu/out/canvas/b.harnucanvas.json')
    ).toMatchObject({ ok: false, code: 'PATH_NOT_ALLOWED' })
    expect(
      resolveCanvasWritePath(FOLDER, '/etc/.harnu/out/canvas/b.harnucanvas.json')
    ).toMatchObject({ ok: false, code: 'PATH_NOT_ALLOWED' })
  })

  it('refuses a file that is not a canvas (suffix, not extname)', () => {
    expect(resolveCanvasWritePath(FOLDER, '.harnu/out/canvas/board.json')).toMatchObject({
      ok: false,
      code: 'PATH_NOT_ALLOWED'
    })
  })

  it('refuses a directory prefix that only LOOKS allowed', () => {
    expect(
      resolveCanvasWritePath(FOLDER, '.harnu/out/canvas-secrets/b.harnucanvas.json')
    ).toMatchObject({ ok: false, code: 'PATH_NOT_ALLOWED' })
  })

  it('the assets dir is the canvas file sibling', () => {
    expect(canvasAssetsDir('/repo/.harnu/out/canvas/board.harnucanvas.json')).toBe(
      '/repo/.harnu/out/canvas/assets'
    )
  })
})

// --------------------------------------------- U5-1: the seven ops in order ---

describe('U5-1 — each of the seven ops applies correctly and in order (§8.2)', () => {
  it('covers all seven op names', () => {
    expect([...CANVAS_OP_NAMES].sort()).toEqual(
      [
        'add_edge',
        'add_node',
        'clear',
        'remove_edge',
        'remove_node',
        'update_edge',
        'update_node'
      ].sort()
    )
  })

  it('add_node assigns an id, stamps origin agent, and fills the shape default size', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'box', x: 10, y: 20, label: 'Reader' }],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.applied).toEqual([{ op: 'add_node', id: 'n-0' }])
    expect(res.doc.nodes[0]).toEqual({
      id: 'n-0',
      shape: 'box',
      x: 10,
      y: 20,
      width: canvasShapeSpec('box')?.defaultSize.width,
      height: canvasShapeSpec('box')?.defaultSize.height,
      label: 'Reader',
      origin: 'agent'
    })
  })

  it('an explicit width/height beats the shape default', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, width: 300, height: 90 }],
      mintId: counterMinter()
    })
    expect(res.ok && res.doc.nodes[0]).toMatchObject({ width: 300, height: 90 })
  })

  it('add_edge binds two nodes added EARLIER IN THE SAME CALL (rule 8, mid-batch)', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'A' },
        { op: 'add_node', shape: 'box', x: 200, y: 0, label: 'B' },
        { op: 'add_edge', source: 'n-0', target: 'n-1', label: 'reads', router: 'manhattan' }
      ],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.edges).toEqual([
      {
        id: 'e-0',
        source: 'n-0',
        target: 'n-1',
        label: 'reads',
        origin: 'agent',
        router: 'manhattan'
      }
    ])
    expect(res.applied.map((a) => a.op)).toEqual(['add_node', 'add_node', 'add_edge'])
  })

  it('update_node changes only the named fields and leaves origin alone', () => {
    const doc = docWith([
      {
        id: 'n-1',
        shape: 'box',
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        label: 'old',
        origin: 'operator'
      }
    ])
    const res = applyCanvasOps({
      doc,
      ops: [{ op: 'update_node', id: 'n-1', x: 500, label: 'new' }],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.nodes[0]).toEqual({
      id: 'n-1',
      shape: 'box',
      x: 500,
      y: 0,
      width: 100,
      height: 40,
      label: 'new',
      // §4.4: the stamp is CREATION provenance, not ownership — the agent may
      // move the operator's node without laundering it into its own.
      origin: 'operator'
    })
  })

  it('update_edge changes label and router only', () => {
    const doc = docWith(
      [
        { id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' },
        { id: 'b', shape: 'box', x: 9, y: 9, origin: 'agent' }
      ],
      [{ id: 'e1', source: 'a', target: 'b', label: 'was', origin: 'agent' }]
    )
    const res = applyCanvasOps({
      doc,
      ops: [{ op: 'update_edge', id: 'e1', label: 'is', router: 'orth' }],
      mintId: counterMinter()
    })
    expect(res.ok && res.doc.edges[0]).toMatchObject({ label: 'is', router: 'orth', source: 'a' })
  })

  it('remove_edge removes exactly one edge', () => {
    const doc = docWith(
      [
        { id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' },
        { id: 'b', shape: 'box', x: 9, y: 9, origin: 'agent' }
      ],
      [
        { id: 'e1', source: 'a', target: 'b', origin: 'agent' },
        { id: 'e2', source: 'b', target: 'a', origin: 'agent' }
      ]
    )
    const res = applyCanvasOps({
      doc,
      ops: [{ op: 'remove_edge', id: 'e1' }],
      mintId: counterMinter()
    })
    expect(res.ok && res.doc.edges.map((e) => e.id)).toEqual(['e2'])
  })

  it('ops are applied IN ORDER — a later op sees the earlier one', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'first' },
        { op: 'update_node', id: 'n-0', label: 'second' },
        { op: 'update_node', id: 'n-0', label: 'third' }
      ],
      mintId: counterMinter()
    })
    expect(res.ok && res.doc.nodes[0].label).toBe('third')
  })

  it('a remove earlier in the batch makes a later reference UNKNOWN_ID', () => {
    const doc = docWith([{ id: 'n-1', shape: 'box', x: 0, y: 0, origin: 'agent' }])
    const res = applyCanvasOps({
      doc,
      ops: [
        { op: 'remove_node', id: 'n-1' },
        { op: 'update_node', id: 'n-1', label: 'ghost' }
      ],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_ID' })
  })

  it('the input document is never mutated, even on success', () => {
    const doc = docWith([{ id: 'n-1', shape: 'box', x: 0, y: 0, origin: 'operator' }])
    const before = JSON.stringify(doc)
    applyCanvasOps({
      doc,
      ops: [{ op: 'update_node', id: 'n-1', x: 999 }],
      mintId: counterMinter()
    })
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('mints a fresh id when the first candidate collides with an existing one', () => {
    const doc = docWith([{ id: 'n-0', shape: 'box', x: 0, y: 0, origin: 'operator' }])
    const res = applyCanvasOps({
      doc,
      ops: [{ op: 'add_node', shape: 'box', x: 1, y: 1 }],
      mintId: counterMinter()
    })
    expect(res.ok && res.doc.nodes.map((n) => n.id)).toEqual(['n-0', 'n-1'])
  })
})

// ------------------------------------- U5-6: remove_node cascades to edges ---

describe('U5-6 — remove_node cascades to every edge touching it', () => {
  const doc = (): CanvasDocument =>
    docWith(
      [
        { id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' },
        { id: 'b', shape: 'box', x: 200, y: 0, origin: 'agent' },
        { id: 'c', shape: 'box', x: 400, y: 0, origin: 'operator' }
      ],
      [
        { id: 'e-in', source: 'c', target: 'b', origin: 'operator' },
        { id: 'e-out', source: 'b', target: 'a', origin: 'agent' },
        { id: 'e-self', source: 'b', target: 'b', origin: 'agent' },
        { id: 'e-far', source: 'a', target: 'c', origin: 'agent' }
      ]
    )

  it('removes incoming, outgoing and self edges, whatever their origin', () => {
    const res = applyCanvasOps({
      doc: doc(),
      ops: [{ op: 'remove_node', id: 'b' }],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.nodes.map((n) => n.id)).toEqual(['a', 'c'])
    expect(res.doc.edges.map((e) => e.id)).toEqual(['e-far'])
    expect(res.applied).toEqual([
      { op: 'remove_node', id: 'b', cascadedEdges: ['e-in', 'e-out', 'e-self'] }
    ])
  })

  it('leaves a valid document — the cascade is what prevents a dangling edge', () => {
    const res = applyCanvasOps({
      doc: doc(),
      ops: [{ op: 'remove_node', id: 'b' }],
      mintId: counterMinter()
    })
    // `applyCanvasOps` runs U1's `validateCanvasDocument` as its final gate, so
    // reaching ok:true IS the proof the result has no dangling edge.
    expect(res.ok).toBe(true)
  })
})

// ----------------------------------------------- U5-4: clear is agent-only ---

describe('U5-4 — clear removes only origin "agent" elements', () => {
  const mixed = (): CanvasDocument =>
    docWith(
      [
        { id: 'agent-1', shape: 'box', x: 0, y: 0, label: 'drawn', origin: 'agent' },
        { id: 'agent-2', shape: 'box', x: 100, y: 0, origin: 'agent' },
        { id: 'human-1', shape: 'text', x: 0, y: 200, label: 'my note', origin: 'operator' },
        { id: 'human-2', shape: 'box', x: 200, y: 200, label: 'my box', origin: 'operator' }
      ],
      [
        { id: 'e-agent', source: 'agent-1', target: 'agent-2', origin: 'agent' },
        { id: 'e-human', source: 'human-1', target: 'human-2', origin: 'operator' }
      ]
    )

  it('the operator’s nodes and their edge survive; the agent’s are gone', () => {
    const res = applyCanvasOps({ doc: mixed(), ops: [{ op: 'clear' }], mintId: counterMinter() })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.nodes.map((n) => n.id)).toEqual(['human-1', 'human-2'])
    expect(res.doc.nodes.map((n) => n.label)).toEqual(['my note', 'my box'])
    expect(res.doc.edges.map((e) => e.id)).toEqual(['e-human'])
    expect(res.applied).toEqual([{ op: 'clear', removedNodes: 2, removedEdges: 1 }])
  })

  it('an operator edge whose ENDPOINT was an agent node cannot outlive it', () => {
    // Not a loophole in "agent-only": a dangling edge is a validation failure
    // (§4.3), so the schema offers no way to keep it. The cascade is the only
    // outcome that leaves a valid document.
    const doc = docWith(
      [
        { id: 'agent-1', shape: 'box', x: 0, y: 0, origin: 'agent' },
        { id: 'human-1', shape: 'box', x: 100, y: 0, origin: 'operator' }
      ],
      [{ id: 'e-cross', source: 'human-1', target: 'agent-1', origin: 'operator' }]
    )
    const res = applyCanvasOps({ doc, ops: [{ op: 'clear' }], mintId: counterMinter() })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.nodes.map((n) => n.id)).toEqual(['human-1'])
    expect(res.doc.edges).toEqual([])
  })

  it('clear on an all-operator canvas removes nothing at all', () => {
    const doc = docWith([{ id: 'h', shape: 'box', x: 0, y: 0, origin: 'operator' }])
    const res = applyCanvasOps({ doc, ops: [{ op: 'clear' }], mintId: counterMinter() })
    expect(res.ok && res.doc.nodes).toHaveLength(1)
    expect(res.ok && res.applied[0]).toEqual({ op: 'clear', removedNodes: 0, removedEdges: 0 })
  })

  it('clear then draw is the "redraw my diagram" flow, in one call', () => {
    const res = applyCanvasOps({
      doc: mixed(),
      ops: [{ op: 'clear' }, { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'fresh' }],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.doc.nodes.map((n) => n.label)).toEqual(['my note', 'my box', 'fresh'])
  })
})

// ------------------------------------------ U5-3: caller-supplied origin ----

describe('U5-3 — a caller-supplied origin is REFUSED, not overwritten (§8.3 rule 9)', () => {
  it.each(['operator', 'agent'])('refuses origin "%s" on add_node', (origin) => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, origin }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'ORIGIN_NOT_ALLOWED' })
  })

  it('refuses origin on add_edge', () => {
    const doc = docWith([
      { id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' },
      { id: 'b', shape: 'box', x: 1, y: 1, origin: 'agent' }
    ])
    const res = applyCanvasOps({
      doc,
      ops: [{ op: 'add_edge', source: 'a', target: 'b', origin: 'operator' }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'ORIGIN_NOT_ALLOWED' })
  })

  it('refuses origin on an UPDATE too — relabelling cannot launder provenance', () => {
    const doc = docWith([{ id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' }])
    const res = applyCanvasOps({
      doc,
      ops: [{ op: 'update_node', id: 'a', origin: 'operator' }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'ORIGIN_NOT_ALLOWED' })
  })

  it('refuses even origin:"agent" — the server stamps it, the caller never asserts it', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'clear', origin: 'agent' }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'ORIGIN_NOT_ALLOWED' })
  })

  it('a refused origin means NOTHING from the batch is applied', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'ok' },
        { op: 'add_node', shape: 'box', x: 9, y: 9, origin: 'operator' }
      ],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(false)
  })
})

// ----------------------------------------------- U5-5: the shape catalog -----

describe('U5-5 — the ACK carries the catalog; an unknown shape is refused listing it', () => {
  it('refuses an unknown shape by name, listing every valid one', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'diamond', x: 0, y: 0 }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_SHAPE' })
    if (res.ok) return
    expect(res.error).toContain('"diamond"')
    for (const name of canvasShapeNames()) expect(res.error).toContain(name)
  })

  it('refuses an unregistered harnu/ shape — a namespace is not a licence', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'harnu/not-a-thing', x: 0, y: 0 }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_SHAPE' })
  })

  it('still READS the legacy capy/mockup-card shape name, and the catalog never advertises it (AC-3)', () => {
    expect(canvasShapeNames()).not.toContain('capy/mockup-card')
    expect(canvasShapeSpec('capy/mockup-card')).toBe(canvasShapeSpec('harnu/mockup-card'))
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'capy/mockup-card', x: 0, y: 0 }],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(true)
    expect(LEGACY_CANVAS_SHAPE_NAMES).toEqual({ 'capy/mockup-card': 'harnu/mockup-card' })
  })

  it('accepts every name the catalog advertises', () => {
    for (const name of canvasShapeNames()) {
      const res = applyCanvasOps({
        doc: docWith(),
        ops: [{ op: 'add_node', shape: name, x: 0, y: 0 }],
        mintId: counterMinter()
      })
      expect(res.ok, `shape ${name}`).toBe(true)
    }
  })
})

// -------------------------------------- U5-2: every §8.3 rule, no partial ----

describe('U5-2 — §8.3 rules refuse with their documented code', () => {
  it('rule 4 — an empty ops array is BAD_ARGS', () => {
    expect(applyCanvasOps({ doc: docWith(), ops: [], mintId: counterMinter() })).toMatchObject({
      ok: false,
      code: 'BAD_ARGS'
    })
  })

  it(`rule 4 — more than ${MAX_CANVAS_OPS_PER_CALL} ops is BAD_ARGS`, () => {
    const ops = Array.from({ length: MAX_CANVAS_OPS_PER_CALL + 1 }, () => ({
      op: 'add_node',
      shape: 'box',
      x: 0,
      y: 0
    }))
    expect(applyCanvasOps({ doc: docWith(), ops, mintId: counterMinter() })).toMatchObject({
      ok: false,
      code: 'BAD_ARGS'
    })
  })

  it(`rule 4 — exactly ${MAX_CANVAS_OPS_PER_CALL} ops is accepted`, () => {
    const ops = Array.from({ length: MAX_CANVAS_OPS_PER_CALL }, (_, i) => ({
      op: 'add_node',
      shape: 'box',
      x: i,
      y: 0
    }))
    expect(applyCanvasOps({ doc: docWith(), ops, mintId: counterMinter() }).ok).toBe(true)
  })

  it('rule 4 — a non-array ops payload is BAD_ARGS', () => {
    expect(
      applyCanvasOps({ doc: docWith(), ops: { op: 'clear' }, mintId: counterMinter() })
    ).toMatchObject({ ok: false, code: 'BAD_ARGS' })
  })

  it('an unknown op name is BAD_ARGS and lists the seven', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_frame' }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGS' })
    if (!res.ok) for (const name of CANVAS_OP_NAMES) expect(res.error).toContain(name)
  })

  it('an undeclared key on an op is BAD_ARGS — a typo is never silently ignored', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, colour: 'red' }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGS' })
    if (!res.ok) expect(res.error).toContain('"colour"')
  })

  it('rule 6 — a prop the shape does not declare is BAD_PROPS, listing what it reads', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [
        { op: 'add_node', shape: 'image', x: 0, y: 0, props: { src: 'assets/a.png', href: 'x' } }
      ],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'BAD_PROPS' })
    if (!res.ok) {
      expect(res.error).toContain('"href"')
      expect(res.error).toContain('src')
    }
  })

  it('rule 6 — a declared prop is stored', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'image', x: 0, y: 0, props: { src: 'assets/a.png' } }],
      mintId: counterMinter()
    })
    expect(res.ok && res.doc.nodes[0].props).toEqual({ src: 'assets/a.png' })
  })

  it('rule 6 — a shape that declares no props refuses any prop at all', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, props: { src: 'x' } }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'BAD_PROPS' })
  })

  it('rule 6 — non-object props are BAD_PROPS', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, props: 'nope' }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'BAD_PROPS' })
  })

  it('rule 6 — update_node validates props against the node’s OWN shape', () => {
    const doc = docWith([{ id: 'i', shape: 'image', x: 0, y: 0, origin: 'agent' }])
    expect(
      applyCanvasOps({
        doc,
        ops: [{ op: 'update_node', id: 'i', props: { src: 'assets/b.png' } }],
        mintId: counterMinter()
      }).ok
    ).toBe(true)
    expect(
      applyCanvasOps({
        doc,
        ops: [{ op: 'update_node', id: 'i', props: { title: 'x' } }],
        mintId: counterMinter()
      })
    ).toMatchObject({ ok: false, code: 'BAD_PROPS' })
  })

  it.each([
    ['x', Number.NaN],
    ['y', Number.POSITIVE_INFINITY],
    ['x', '10'],
    ['width', 0],
    ['height', -40],
    ['width', Number.NaN]
  ])('rule 7 — %s = %p is BAD_GEOMETRY', (field, value) => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, [field]: value }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'BAD_GEOMETRY' })
  })

  it('rule 7 — geometry is checked on update_node too', () => {
    const doc = docWith([{ id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' }])
    expect(
      applyCanvasOps({
        doc,
        ops: [{ op: 'update_node', id: 'a', width: -1 }],
        mintId: counterMinter()
      })
    ).toMatchObject({ ok: false, code: 'BAD_GEOMETRY' })
  })

  it('rule 8 — add_edge to a node that does not exist is UNKNOWN_ID', () => {
    const doc = docWith([{ id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' }])
    expect(
      applyCanvasOps({
        doc,
        ops: [{ op: 'add_edge', source: 'a', target: 'ghost' }],
        mintId: counterMinter()
      })
    ).toMatchObject({ ok: false, code: 'UNKNOWN_ID' })
  })

  it.each(['update_node', 'remove_node'])('rule 8 — %s on an unknown id is UNKNOWN_ID', (op) => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op, id: 'nope', ...(op === 'update_node' ? { label: 'x' } : {}) }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_ID' })
  })

  it.each(['update_edge', 'remove_edge'])('rule 8 — %s on an unknown id is UNKNOWN_ID', (op) => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [{ op, id: 'nope', ...(op === 'update_edge' ? { label: 'x' } : {}) }],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_ID' })
  })

  it('rule 8 — an edge id is not a node id (the two namespaces do not cross)', () => {
    const doc = docWith(
      [
        { id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' },
        { id: 'b', shape: 'box', x: 1, y: 1, origin: 'agent' }
      ],
      [{ id: 'e1', source: 'a', target: 'b', origin: 'agent' }]
    )
    expect(
      applyCanvasOps({ doc, ops: [{ op: 'remove_node', id: 'e1' }], mintId: counterMinter() })
    ).toMatchObject({ ok: false, code: 'UNKNOWN_ID' })
  })

  it('rule 10 — a label over the cap is LABEL_TOO_LONG (U1’s rule, mapped)', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'x'.repeat(MAX_CANVAS_LABEL_CHARS + 1) }
      ],
      mintId: counterMinter()
    })
    expect(res).toMatchObject({ ok: false, code: 'LABEL_TOO_LONG' })
  })

  it('rule 10 — a label exactly at the cap is accepted', () => {
    const res = applyCanvasOps({
      doc: docWith(),
      ops: [
        { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'x'.repeat(MAX_CANVAS_LABEL_CHARS) }
      ],
      mintId: counterMinter()
    })
    expect(res.ok).toBe(true)
  })

  it('an update needs at least one field to change', () => {
    const doc = docWith([{ id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' }])
    expect(
      applyCanvasOps({ doc, ops: [{ op: 'update_node', id: 'a' }], mintId: counterMinter() })
    ).toMatchObject({ ok: false, code: 'BAD_ARGS' })
  })

  it('every core deny code maps to a verb code (no unmapped refusal)', () => {
    const codes = [
      'invalid-path',
      'outside-roots',
      'not-found',
      'too-large',
      'read-failed',
      'write-failed',
      'parse-failed',
      'schema-unsupported',
      'invalid-document',
      'missing-origin',
      'invalid-origin',
      'duplicate-id',
      'dangling-edge',
      'too-many-nodes',
      'too-many-edges',
      'label-too-long'
    ] as const
    for (const c of codes) expect(typeof canvasVerbCode(c)).toBe('string')
    expect(canvasVerbCode('schema-unsupported')).toBe('SCHEMA_UNSUPPORTED')
  })
})

// ------------------------------------------------- rule 11: image sources ----

describe('§8.3 rule 11 — image sources use the board’s jail verbatim', () => {
  const FOLDER = '/repo'

  it('accepts a source inside the folder and names the destination server-side', () => {
    const res = planCanvasAssets('board', [`${FOLDER}/shot.png`], homedir(), FOLDER)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.assets[0]).toMatchObject({ filename: 'board-1.png', ext: '.png' })
  })

  it('accepts a source under ~/.claude/image-cache/', () => {
    const res = planCanvasAssets(
      'board',
      [join(homedir(), '.claude', 'image-cache', 'abc', 'x.png')],
      homedir(),
      FOLDER
    )
    expect(res.ok).toBe(true)
  })

  it('refuses a source elsewhere on the machine (SOURCE_NOT_ALLOWED)', () => {
    expect(planCanvasAssets('board', ['/etc/ssh/id_rsa.png'], homedir(), FOLDER)).toMatchObject({
      ok: false,
      code: 'SOURCE_NOT_ALLOWED'
    })
  })

  it('refuses a non-image extension (SOURCE_NOT_IMAGE)', () => {
    expect(planCanvasAssets('board', [`${FOLDER}/secrets.env`], homedir(), FOLDER)).toMatchObject({
      ok: false,
      code: 'SOURCE_NOT_IMAGE'
    })
  })

  it(`refuses more than ${MAX_CANVAS_IMAGES_PER_CALL} per call`, () => {
    const many = Array.from(
      { length: MAX_CANVAS_IMAGES_PER_CALL + 1 },
      (_, i) => `${FOLDER}/s${i}.png`
    )
    expect(planCanvasAssets('board', many, homedir(), FOLDER)).toMatchObject({
      ok: false,
      code: 'BAD_ARGS'
    })
  })

  it('validates ALL sources before returning any — one bad source rejects the batch', () => {
    const res = planCanvasAssets(
      'board',
      [`${FOLDER}/ok.png`, '/etc/passwd.png'],
      homedir(),
      FOLDER
    )
    expect(res.ok).toBe(false)
  })

  it('numbers destinations from 1, in call order', () => {
    const res = planCanvasAssets('plan', [`${FOLDER}/a.png`, `${FOLDER}/b.jpg`], homedir(), FOLDER)
    expect(res.ok && res.assets.map((a) => a.filename)).toEqual(['plan-1.png', 'plan-2.jpg'])
  })
})

// ----------------------------- U5-2: NO PARTIAL APPLY, proven against disk ---

describe('U5-2 — no partial apply: the FILE is byte-identical after a rejected batch', () => {
  let dir: string
  let canvasPath: string

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

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harnu-draw-canvas-'))
    ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
    const resolved = resolveCanvasWritePath(dir)
    if (!resolved.ok) throw new Error('fixture path refused')
    canvasPath = resolved.path
    mkdirSync(join(dir, '.harnu', 'out', 'canvas'), { recursive: true })
    writeFileSync(canvasPath, serializeCanvasDocument(SEED), 'utf8')
    __resetCanvasWatchStateForTests()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete (globalThis as Record<string, unknown>).__TEST_ROOT__
  })

  /** The shell's exact sequence: read → apply → write. */
  async function drawCanvas(
    ops: unknown[]
  ): Promise<{ ok: boolean; code?: string; nodeCount?: number }> {
    const read = await readCanvasFile(canvasPath)
    if (!read.ok) return { ok: false, code: canvasVerbCode(read.code) }
    const applied = applyCanvasOps({ doc: read.doc, ops, mintId: counterMinter() })
    if (!applied.ok) return { ok: false, code: applied.code }
    const written = await writeCanvasFile(canvasPath, applied.doc)
    if (!written.ok) return { ok: false, code: canvasVerbCode(written.code) }
    return { ok: true, nodeCount: applied.doc.nodes.length }
  }

  it('20 ops with an invalid 17th leave the file EXACTLY as it was', async () => {
    const before = readFileSync(canvasPath)
    const ops: unknown[] = Array.from({ length: 20 }, (_, i) => ({
      op: 'add_node',
      shape: 'box',
      x: i * 10,
      y: 0,
      label: `n${i}`
    }))
    // op 17 (index 16) names a shape that does not exist.
    ops[16] = { op: 'add_node', shape: 'diamond', x: 0, y: 0 }

    const res = await drawCanvas(ops)
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_SHAPE' })
    // Not "16 ops applied" — nothing applied. Bytes, not a count.
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('a rejected batch never touches the operator’s node', async () => {
    const before = readFileSync(canvasPath)
    const res = await drawCanvas([
      { op: 'update_node', id: 'human-1', label: 'renamed by the agent' },
      { op: 'remove_node', id: 'does-not-exist' }
    ])
    expect(res).toMatchObject({ ok: false, code: 'UNKNOWN_ID' })
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('a caller-supplied origin mid-batch leaves the file untouched', async () => {
    const before = readFileSync(canvasPath)
    const res = await drawCanvas([
      { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'fine' },
      { op: 'add_node', shape: 'box', x: 50, y: 0, origin: 'operator' }
    ])
    expect(res).toMatchObject({ ok: false, code: 'ORIGIN_NOT_ALLOWED' })
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('a VALID batch does write, and stamps every new element origin "agent"', async () => {
    const res = await drawCanvas([
      { op: 'add_node', shape: 'box', x: 0, y: 100, label: 'Reader' },
      { op: 'add_node', shape: 'box', x: 200, y: 100, label: 'Writer' },
      { op: 'add_edge', source: 'n-0', target: 'n-1', label: 'writes' }
    ])
    expect(res.ok).toBe(true)
    const after = JSON.parse(readFileSync(canvasPath, 'utf8')) as CanvasDocument
    expect(after.nodes.map((n) => n.origin)).toEqual(['operator', 'agent', 'agent'])
    expect(after.edges).toHaveLength(1)
    expect(after.edges[0].origin).toBe('agent')
  })

  it('clear on the real file keeps the operator node and drops the agent ones', async () => {
    await drawCanvas([
      { op: 'add_node', shape: 'box', x: 0, y: 100, label: 'A' },
      { op: 'add_node', shape: 'box', x: 90, y: 100, label: 'B' }
    ])
    const res = await drawCanvas([{ op: 'clear' }])
    expect(res.ok).toBe(true)
    const after = JSON.parse(readFileSync(canvasPath, 'utf8')) as CanvasDocument
    expect(after.nodes.map((n) => n.id)).toEqual(['human-1'])
  })

  it('rule 3 — an unknown schema major refuses with SCHEMA_UNSUPPORTED and writes nothing', async () => {
    writeFileSync(canvasPath, JSON.stringify({ capycanvas: 99, nodes: [], edges: [] }), 'utf8')
    const before = readFileSync(canvasPath)
    const res = await drawCanvas([{ op: 'add_node', shape: 'box', x: 0, y: 0 }])
    expect(res).toMatchObject({ ok: false, code: 'SCHEMA_UNSUPPORTED' })
    expect(readFileSync(canvasPath).equals(before)).toBe(true)
  })

  it('rule 2 — the confined writer refuses a path outside the known roots', async () => {
    const outside = join(tmpdir(), 'not-a-known-root.harnucanvas.json')
    const res = await writeCanvasFile(outside, emptyCanvasDocument(NOW))
    expect(res).toMatchObject({ ok: false, code: 'outside-roots' })
  })

  it('repeated identical writes produce byte-identical files (a Save is a minimal diff)', async () => {
    await drawCanvas([{ op: 'add_node', shape: 'box', x: 0, y: 0, label: 'once' }])
    const first = readFileSync(canvasPath)
    const read = await readCanvasFile(canvasPath)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    await writeCanvasFile(canvasPath, read.doc)
    expect(readFileSync(canvasPath).equals(first)).toBe(true)
  })
})
