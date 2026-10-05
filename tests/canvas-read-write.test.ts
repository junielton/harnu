import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readCanvasFile, checkCanvasPathAllowed } from '../src/main/canvas-read'
import { writeCanvasFile } from '../src/main/canvas-write'
import {
  MAX_CANVAS_BYTES,
  canvasExtraKeys,
  serializeCanvasDocument,
  type CanvasDocument
} from '../src/main/canvas-core'
import { __resetCanvasWatchStateForTests } from '../src/main/canvas-watch'

/**
 * T218 U1 — the confined canvas reader + writer against a REAL temp directory.
 * `canvas-{read,write,watch}.ts` import `ipcMain` from electron for their
 * `register*Handlers`, so electron is stubbed exactly as
 * tests/markdown-write-containment.test.ts does; the known-folder roots are
 * stubbed to the temp dir so no real user settings are touched.
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

let dir: string
let canvasDir: string
let file: string

const DOC: CanvasDocument = {
  capycanvas: 1,
  meta: {
    title: 'Daily budget review',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:42:00.000Z'
  },
  nodes: [
    {
      id: 'n-7f3a',
      shape: 'box',
      x: 120,
      y: 64,
      width: 180,
      height: 72,
      label: 'Budget row',
      origin: 'agent',
      zIndex: 3,
      props: {}
    },
    { id: 'n-2b10', shape: 'text', x: 400, y: 64, label: 'Operator note', origin: 'operator' }
  ],
  edges: [
    {
      id: 'e-91cc',
      source: 'n-7f3a',
      target: 'n-2b10',
      label: 'reads',
      origin: 'operator',
      router: 'manhattan'
    }
  ]
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harnu-canvas-'))
  canvasDir = join(dir, '.harnu', 'out', 'canvas')
  file = join(canvasDir, 'board.harnucanvas.json')
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
  __resetCanvasWatchStateForTests()
  vi.restoreAllMocks()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** U1-1 — the round-trip that the whole seam rests on. */
describe('U1-1 read → write → read is byte-identical (§4.3)', () => {
  it('a valid document survives a full round-trip with identical bytes and identical structure', async () => {
    const first = await writeCanvasFile(file, DOC)
    expect(first.ok).toBe(true)
    const bytesA = readFileSync(file)

    const read1 = await readCanvasFile(file)
    expect(read1.ok).toBe(true)
    if (!read1.ok) return
    expect(read1.doc).toEqual(DOC)

    // Write what we read back, to a SECOND path, then compare the raw bytes.
    const other = join(canvasDir, 'again.harnucanvas.json')
    const second = await writeCanvasFile(other, read1.doc)
    expect(second.ok).toBe(true)
    expect(readFileSync(other)).toEqual(bytesA)

    const read2 = await readCanvasFile(other)
    expect(read2.ok).toBe(true)
    if (!read2.ok) return
    expect(read2.doc).toEqual(read1.doc)
  })

  it('re-saving an unchanged document rewrites the same bytes (a repeated Save is an empty diff)', async () => {
    await writeCanvasFile(file, DOC)
    const before = readFileSync(file, 'utf8')
    const read = await readCanvasFile(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    await writeCanvasFile(file, read.doc)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('the writer creates the default .harnu/out/canvas/ directory when it does not exist', async () => {
    expect(await fs.stat(canvasDir).catch(() => null)).toBeNull()
    const r = await writeCanvasFile(file, DOC)
    expect(r.ok).toBe(true)
    expect((await fs.stat(file)).isFile()).toBe(true)
  })
})

/** U1-2 — a path outside the root is REFUSED, never clamped back inside it. */
describe('U1-2 containment (§4.2)', () => {
  it('refuses a `..` traversal out of the root with outside-roots — and writes nothing', async () => {
    const escapee = join(dir, '..', 'escaped.harnucanvas.json')
    const r = await readCanvasFile(escapee)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('outside-roots')

    const w = await writeCanvasFile(escapee, DOC)
    expect(w.ok).toBe(false)
    if (w.ok) return
    expect(w.code).toBe('outside-roots')
    // Never clamped into the root, never created outside it.
    expect(await fs.stat(join(dir, 'escaped.harnucanvas.json')).catch(() => null)).toBeNull()
    expect(await fs.stat(escapee).catch(() => null)).toBeNull()
  })

  it('refuses an absolute path in a different root', async () => {
    const outside = join(tmpdir(), 'harnu-canvas-not-a-root.harnucanvas.json')
    const r = await readCanvasFile(outside)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('outside-roots')
  })

  it('refuses a false-positive sibling prefix (`<root>-secrets/`)', () => {
    const verdict = checkCanvasPathAllowed(`${dir}-secrets/board.harnucanvas.json`, [dir])
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.code).toBe('outside-roots')
  })

  it('a malicious `base` cannot escape: the FINAL resolved path is what gets confined', async () => {
    // canvasDir is <root>/.harnu/out/canvas — four levels up lands OUTSIDE <root>.
    const r = await readCanvasFile('../../../../escaped.harnucanvas.json', canvasDir)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('outside-roots')
  })

  it('refuses a non-canvas suffix with invalid-path, even inside the root', async () => {
    const plain = join(dir, 'package.json')
    writeFileSync(plain, '{}', 'utf8')
    const r = await readCanvasFile(plain)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('invalid-path')

    const w = await writeCanvasFile(plain, DOC)
    expect(w.ok).toBe(false)
    if (w.ok) return
    expect(w.code).toBe('invalid-path')
    expect(readFileSync(plain, 'utf8')).toBe('{}') // untouched
  })

  it('accepts a canvas saved into the repo (docs/canvas/) — the reader does not gate the directory', async () => {
    const tracked = join(dir, 'docs', 'canvas', 'architecture.harnucanvas.json')
    const w = await writeCanvasFile(tracked, DOC)
    expect(w.ok).toBe(true)
    const r = await readCanvasFile(tracked)
    expect(r.ok).toBe(true)
  })
})

/** U1-3 — the size cap, on both sides of the seam. */
describe('U1-3 size cap (§4.7)', () => {
  it('the reader refuses a file over 2 MB with too-large, without reading it', async () => {
    await fs.mkdir(canvasDir, { recursive: true })
    writeFileSync(file, 'x'.repeat(MAX_CANVAS_BYTES + 1), 'utf8')
    const r = await readCanvasFile(file)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('too-large')
    // `too-large`, NOT `parse-failed`: the cap must be checked before the bytes.
  })

  it('the writer refuses an over-cap document and leaves the previous file intact', async () => {
    await writeCanvasFile(file, DOC)
    const before = readFileSync(file, 'utf8')

    const huge: CanvasDocument = {
      ...DOC,
      nodes: Array.from({ length: 1500 }, (_, i) => ({
        id: `n-${i}`,
        shape: 'box',
        x: i,
        y: i,
        label: 'y'.repeat(1800),
        origin: 'agent' as const
      })),
      edges: []
    }
    expect(Buffer.byteLength(serializeCanvasDocument(huge), 'utf8')).toBeGreaterThan(
      MAX_CANVAS_BYTES
    )

    const w = await writeCanvasFile(file, huge)
    expect(w.ok).toBe(false)
    if (w.ok) return
    expect(w.code).toBe('too-large')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('the writer refuses over-count documents and writes nothing', async () => {
    const tooManyNodes = {
      ...DOC,
      nodes: Array.from({ length: 2001 }, (_, i) => ({
        id: `n-${i}`,
        shape: 'box',
        x: 0,
        y: 0,
        origin: 'agent' as const
      })),
      edges: []
    }
    const a = await writeCanvasFile(file, tooManyNodes)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.code).toBe('too-many-nodes')

    const tooManyEdges = {
      ...DOC,
      nodes: [{ id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' as const }],
      edges: Array.from({ length: 2001 }, (_, i) => ({
        id: `e-${i}`,
        source: 'a',
        target: 'a',
        origin: 'agent' as const
      }))
    }
    const b = await writeCanvasFile(file, tooManyEdges)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.code).toBe('too-many-edges')

    expect(await fs.stat(file).catch(() => null)).toBeNull()
  })
})

describe('the reader surfaces validation refusals, never a half-understood document', () => {
  async function writeRaw(body: string): Promise<void> {
    await fs.mkdir(canvasDir, { recursive: true })
    writeFileSync(file, body, 'utf8')
  }

  it('U1-7: an unknown major refuses with schema-unsupported', async () => {
    await writeRaw(JSON.stringify({ capycanvas: 99, meta: {}, nodes: [], edges: [] }))
    const r = await readCanvasFile(file)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('schema-unsupported')
  })

  it('U1-5: a node without an origin refuses with missing-origin', async () => {
    await writeRaw(
      JSON.stringify({
        capycanvas: 1,
        meta: {},
        nodes: [{ id: 'a', shape: 'box', x: 0, y: 0 }],
        edges: []
      })
    )
    const r = await readCanvasFile(file)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing-origin')
  })

  it('U1-6: a dangling edge refuses with dangling-edge', async () => {
    await writeRaw(
      JSON.stringify({
        capycanvas: 1,
        meta: {},
        nodes: [{ id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' }],
        edges: [{ id: 'e', source: 'a', target: 'ghost', origin: 'agent' }]
      })
    )
    const r = await readCanvasFile(file)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('dangling-edge')
  })

  it('U1-4: a file carrying BOTH stale and fresh label paths reads back the fresh one', async () => {
    await writeRaw(
      JSON.stringify({
        capycanvas: 1,
        meta: {},
        nodes: [
          {
            id: 'a',
            shape: 'box',
            x: 0,
            y: 0,
            origin: 'operator',
            attrs: { text: { text: 'Browser' }, label: { text: 'Chrome (renamed by hand)' } }
          }
        ],
        edges: []
      })
    )
    const r = await readCanvasFile(file)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.nodes[0].label).toBe('Chrome (renamed by hand)')
  })

  it('a missing file refuses with not-found; malformed JSON with parse-failed', async () => {
    const missing = await readCanvasFile(file)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('not-found')

    await writeRaw('{ nope')
    const bad = await readCanvasFile(file)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('parse-failed')
  })

  it('an empty or non-string path refuses with invalid-path', async () => {
    for (const bad of ['', undefined, null, 42]) {
      const r = await readCanvasFile(bad as unknown as string)
      expect(r.ok).toBe(false)
      if (r.ok) continue
      expect(r.code).toBe('invalid-path')
    }
  })

  it('a directory that happens to be named *.harnucanvas.json refuses with not-found', async () => {
    await fs.mkdir(file, { recursive: true })
    const r = await readCanvasFile(file)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('not-found')
  })
})

/** U1-9 — atomicity. The property under test is that a FAILED write leaves the
 *  previous file byte-for-byte intact and leaks no temp file. */
describe('U1-9 the writer is atomic (§7.2)', () => {
  it('an interrupted write leaves the previous file completely intact', async () => {
    await writeCanvasFile(file, DOC)
    const before = readFileSync(file, 'utf8')

    // Fail at the LAST step — the rename. Everything before it (validate,
    // serialize, write the temp sibling) already succeeded, so this is exactly
    // the "crashed mid-write" case: the target must still hold the old document.
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('EIO: simulated crash'))

    const changed: CanvasDocument = { ...DOC, meta: { ...DOC.meta, title: 'NEVER LANDS' } }
    const r = await writeCanvasFile(file, changed)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('write-failed')

    rename.mockRestore()

    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readFileSync(file, 'utf8')).not.toContain('NEVER LANDS')
    const again = await readCanvasFile(file)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.doc).toEqual(DOC)
  })

  it('a failed write leaves no temp file behind in the directory', async () => {
    await writeCanvasFile(file, DOC)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('EIO: simulated crash'))
    await writeCanvasFile(file, DOC)
    rename.mockRestore()
    expect(await fs.readdir(canvasDir)).toEqual(['board.harnucanvas.json'])
  })

  it('a successful write leaves no temp file behind either', async () => {
    await writeCanvasFile(file, DOC)
    expect(await fs.readdir(canvasDir)).toEqual(['board.harnucanvas.json'])
  })

  it('a concurrent reader never observes a partial document', async () => {
    await writeCanvasFile(file, DOC)
    const bigger: CanvasDocument = {
      ...DOC,
      nodes: Array.from({ length: 400 }, (_, i) => ({
        id: `n-${i}`,
        shape: 'box',
        x: i,
        y: i,
        label: `node ${i}`,
        origin: 'agent' as const
      })),
      edges: []
    }
    const writing = writeCanvasFile(file, bigger)
    const reads = await Promise.all(
      Array.from({ length: 20 }, () => fs.readFile(file, 'utf8').catch(() => null))
    )
    await writing
    for (const text of reads) {
      if (text === null) continue // ENOENT mid-rename is acceptable; a truncated parse is not
      expect(() => JSON.parse(text)).not.toThrow()
    }
  })

  it('a document that fails validation is never written at all (§7.2)', async () => {
    const invalid = {
      capycanvas: 1,
      meta: {},
      nodes: [{ id: 'a', shape: 'box', x: 0, y: 0 }],
      edges: []
    }
    const r = await writeCanvasFile(file, invalid)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('missing-origin')
    expect(await fs.stat(file).catch(() => null)).toBeNull()
  })
})

/** U1-10, end to end through the filesystem rather than only in the pure core. */
describe('U1-10 unknown top-level keys survive a real read → write → read (§4.3)', () => {
  it('a key written by a newer Harnu is still there after an older build re-saves', async () => {
    await fs.mkdir(canvasDir, { recursive: true })
    writeFileSync(
      file,
      JSON.stringify(
        {
          capycanvas: 1,
          meta: { title: 'T' },
          nodes: [],
          edges: [],
          futureFeature: { pages: ['a', 'b'] }
        },
        null,
        2
      ),
      'utf8'
    )
    const read = await readCanvasFile(file)
    expect(read.ok).toBe(true)
    if (!read.ok) return

    const w = await writeCanvasFile(file, read.doc)
    expect(w.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).futureFeature).toEqual({ pages: ['a', 'b'] })

    const again = await readCanvasFile(file)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.doc.futureFeature).toEqual({ pages: ['a', 'b'] })
    expect(canvasExtraKeys(again.doc)).toEqual(['futureFeature'])
  })
})
