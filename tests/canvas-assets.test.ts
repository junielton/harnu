import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  attachCanvasAssets,
  copyCanvasAssets,
  imageExtForMime,
  CANVAS_ASSET_MAX_BYTES
} from '../src/main/canvas-assets'
import { imageMimeType } from '../src/main/markdown-core'
import { writeCanvasFile } from '../src/main/canvas-write'
import { readCanvasFile } from '../src/main/canvas-read'
import { __resetCanvasWatchStateForTests } from '../src/main/canvas-watch'
import type { CanvasDocument } from '../src/main/canvas-core'

/**
 * T218 U6 — asset externalisation, against a REAL temp directory.
 *
 * Every claim here is about BYTES ON DISK, deliberately. "The call returned
 * `ok`" is not the claim U6-1 makes: the claim is that the saved canvas file
 * contains no `data:` anywhere and that the node's `src` is a relative path
 * that actually resolves — a test that only asserted a node has a `src` would
 * pass against the data URI U6 exists to remove. Likewise U6-5 reads the
 * `assets/` directory back after a refused batch, the way U1's atomicity test
 * reads the previous file back.
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
let assetsDir: string
let canvas: string

/** A minimal but REAL PNG — 1×1, transparent. Bytes, not a fixture path, so a
 *  paste can be simulated exactly as the clipboard delivers it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)

function bytes(mime = 'image/png', name = 'shot.png', payload: Buffer = PNG) {
  return { kind: 'bytes' as const, mime, bytes: new Uint8Array(payload), name }
}

async function lsAssets(): Promise<string[]> {
  try {
    return (await fs.readdir(assetsDir)).sort()
  } catch {
    return []
  }
}

const BASE_DOC: CanvasDocument = {
  capycanvas: 1,
  meta: { title: 'Board', createdAt: '2026-08-24T10:00:00.000Z' },
  nodes: [],
  edges: []
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'harnu-canvas-assets-'))
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
  canvasDir = join(dir, '.harnu', 'out', 'canvas')
  assetsDir = join(canvasDir, 'assets')
  canvas = join(canvasDir, 'board.harnucanvas.json')
  await fs.mkdir(canvasDir, { recursive: true })
  __resetCanvasWatchStateForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ── U6-1 — the file contents, not the return value ────────────────────────
describe('U6-1 — a pasted image is externalised; the canvas file holds no data URI', () => {
  it('writes the bytes to assets/ and stores a relative path that resolves', async () => {
    const res = await attachCanvasAssets(canvas, [bytes()])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.srcs).toEqual(['assets/board-1.png'])

    // The bytes landed, byte-for-byte.
    const written = await fs.readFile(join(assetsDir, 'board-1.png'))
    expect(written.equals(PNG)).toBe(true)

    const doc: CanvasDocument = {
      ...BASE_DOC,
      nodes: [
        {
          id: 'n-1',
          shape: 'image',
          x: 40,
          y: 40,
          width: 132,
          height: 52,
          label: 'shot.png',
          origin: 'operator',
          props: { src: res.srcs[0] }
        }
      ]
    }
    const saved = await writeCanvasFile(canvas, doc)
    expect(saved.ok).toBe(true)

    // THE claim: no data URI anywhere in the saved bytes.
    const text = await fs.readFile(canvas, 'utf8')
    expect(text).not.toContain('data:')
    expect(text).not.toContain('base64')

    // …and the `src` the node carries is RELATIVE and resolves to a real file
    // next to the canvas. A `src` that merely exists would pass against a data
    // URI; this cannot.
    const read = await readCanvasFile(canvas)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const src = read.doc.nodes[0].props?.src as string
    expect(src).toBe('assets/board-1.png')
    expect(src.startsWith('/')).toBe(false)
    expect(src.includes('data:')).toBe(false)
    const stat = await fs.stat(join(canvasDir, src))
    expect(stat.isFile()).toBe(true)
  })

  it('the destination filename comes from the CANVAS, never from the caller', async () => {
    const res = await attachCanvasAssets(canvas, [
      bytes('image/png', '../../../../etc/evil.png'),
      bytes('image/jpeg', 'holiday.jpeg')
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.srcs).toEqual(['assets/board-1.png', 'assets/board-2.jpg'])
    expect(await lsAssets()).toEqual(['board-1.png', 'board-2.jpg'])
  })
})

// ── U6-3 — the source jail ────────────────────────────────────────────────
describe('U6-3 — the source jail refuses a path outside the two roots', () => {
  it('refuses an absolute path elsewhere on the machine, and writes nothing', async () => {
    const outside = join(tmpdir(), 'harnu-not-a-root-secret.png')
    await fs.writeFile(outside, PNG)
    try {
      const res = await attachCanvasAssets(canvas, [{ kind: 'path', path: outside }])
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.code).toBe('SOURCE_NOT_ALLOWED')
      expect(await lsAssets()).toEqual([])
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('accepts a path INSIDE the folder root that owns the canvas', async () => {
    const inside = join(dir, 'shot.png')
    await fs.writeFile(inside, PNG)
    const res = await attachCanvasAssets(canvas, [{ kind: 'path', path: inside }])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.srcs).toEqual(['assets/board-1.png'])
  })

  it('refuses a non-image extension and a non-image MIME alike', async () => {
    const key = join(dir, 'id_rsa')
    await fs.writeFile(key, 'PRIVATE KEY')
    const viaPath = await attachCanvasAssets(canvas, [{ kind: 'path', path: key }])
    expect(viaPath.ok).toBe(false)
    if (!viaPath.ok) expect(viaPath.code).toBe('SOURCE_NOT_IMAGE')

    const viaBytes = await attachCanvasAssets(canvas, [bytes('text/plain', 'notes.txt')])
    expect(viaBytes.ok).toBe(false)
    if (!viaBytes.ok) expect(viaBytes.code).toBe('SOURCE_NOT_IMAGE')
    expect(await lsAssets()).toEqual([])
  })

  it('refuses a canvas path outside the known Harnu folders', async () => {
    const res = await attachCanvasAssets(join(tmpdir(), 'elsewhere', 'board.harnucanvas.json'), [
      bytes()
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('outside-roots')
  })
})

// ── U6-4 — a second attach never overwrites the first ─────────────────────
describe('U6-4 — server-generated names, exclusive creates', () => {
  it('a second attach of the same image lands beside the first, not on top of it', async () => {
    const first = await attachCanvasAssets(canvas, [bytes()])
    expect(first.ok && first.srcs).toEqual(['assets/board-1.png'])

    // A DIFFERENT payload under the same would-be name — if the exclusive
    // create were dropped, this is the call that would silently replace the
    // first image with the second everywhere it is referenced.
    const other = Buffer.concat([PNG, Buffer.from([0, 1, 2, 3])])
    const second = await attachCanvasAssets(canvas, [bytes('image/png', 'shot.png', other)])
    expect(second.ok && second.srcs).toEqual(['assets/board-2.png'])

    expect(await lsAssets()).toEqual(['board-1.png', 'board-2.png'])
    expect((await fs.readFile(join(assetsDir, 'board-1.png'))).equals(PNG)).toBe(true)
    expect((await fs.readFile(join(assetsDir, 'board-2.png'))).equals(other)).toBe(true)
  })

  it('the index keeps climbing past a pre-existing file the pane never wrote', async () => {
    await fs.mkdir(assetsDir, { recursive: true })
    await fs.writeFile(join(assetsDir, 'board-1.png'), 'squatter')
    const res = await attachCanvasAssets(canvas, [bytes()])
    expect(res.ok && res.srcs).toEqual(['assets/board-2.png'])
    expect(await fs.readFile(join(assetsDir, 'board-1.png'), 'utf8')).toBe('squatter')
  })
})

// ── U6-5 — all sources validated before ANY is copied ─────────────────────
describe('U6-5 — a refused batch leaves nothing on disk', () => {
  it('one bad image in a batch means no partial attach, verified by reading assets/', async () => {
    const before = await lsAssets()
    expect(before).toEqual([])

    const res = await attachCanvasAssets(canvas, [
      bytes('image/png', 'good-1.png'),
      bytes('image/png', 'good-2.png'),
      bytes('application/pdf', 'report.pdf')
    ])
    expect(res.ok).toBe(false)

    // THE claim: the directory is exactly as it was. Not "the call errored".
    expect(await lsAssets()).toEqual(before)
  })

  it('an over-cap image refuses the whole batch before a byte is written', async () => {
    const huge = Buffer.alloc(CANVAS_ASSET_MAX_BYTES + 1, 7)
    const res = await attachCanvasAssets(canvas, [
      bytes('image/png', 'small.png'),
      bytes('image/png', 'huge.png', huge)
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('IMAGE_TOO_LARGE')
    expect(await lsAssets()).toEqual([])
  })

  it('a missing PATH source refuses the batch, and the good sibling is not copied', async () => {
    const inside = join(dir, 'real.png')
    await fs.writeFile(inside, PNG)
    const res = await attachCanvasAssets(canvas, [
      { kind: 'path', path: inside },
      { kind: 'path', path: join(dir, 'ghost.png') }
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('SOURCE_NOT_FOUND')
    expect(await lsAssets()).toEqual([])
  })

  it('exceeding the per-call cap is a refusal, never a truncated batch', async () => {
    const res = await attachCanvasAssets(
      canvas,
      Array.from({ length: 7 }, (_, i) => bytes('image/png', `s${i}.png`))
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('BAD_ARGS')
    expect(await lsAssets()).toEqual([])
  })
})

// ── U6-6 — three screenshots, and the canvas file stays tiny ──────────────
describe('U6-6 — three pasted screenshots keep the canvas file well under 2 MB', () => {
  it('the megabytes land in assets/, the canvas keeps kilobytes of pointers', async () => {
    // 1.5 MB each — a realistic screenshot, and three of them are 4.5 MB, which
    // as data URIs would be ~6 MB of base64 INSIDE a file capped at 2 MB. The
    // spike's measurement in miniature: one 1,486-byte paste cost ~4.5 KB of
    // canvas file, so three real screenshots do not merely bloat it, they make
    // the document impossible to write at all.
    const shot = Buffer.alloc(1_500_000, 9)
    const res = await attachCanvasAssets(canvas, [
      bytes('image/png', 'a.png', shot),
      bytes('image/png', 'b.png', shot),
      bytes('image/png', 'c.png', shot)
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const doc: CanvasDocument = {
      ...BASE_DOC,
      nodes: res.srcs.map((src, i) => ({
        id: `n-${i + 1}`,
        shape: 'image' as const,
        x: i * 200,
        y: 0,
        width: 180,
        height: 120,
        label: `screenshot ${i + 1}`,
        origin: 'operator' as const,
        props: { src }
      }))
    }
    const saved = await writeCanvasFile(canvas, doc)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return

    const canvasBytes = (await fs.stat(canvas)).size
    // "Well under 2 MB" with three megabyte screenshots on the board means
    // KILOBYTES — pin it tight enough that a regression to inlining fails here
    // rather than at 1.9 MB.
    expect(canvasBytes).toBeLessThan(4096)
    expect(saved.bytes).toBe(canvasBytes)

    // And the bytes really are somewhere — this is not passing because nothing
    // was attached.
    const total = (
      await Promise.all(
        (await lsAssets()).map(async (f) => (await fs.stat(join(assetsDir, f))).size)
      )
    ).reduce((a, b) => a + b, 0)
    expect(total).toBe(4_500_000)
    expect(await fs.readFile(canvas, 'utf8')).not.toContain('data:')
  })
})

// ── The MIME↔extension inversion cannot drift ─────────────────────────────
describe('clipboard MIME → extension', () => {
  it('every extension it produces maps back through imageMimeType', () => {
    for (const mime of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/svg+xml',
      'image/webp',
      'image/bmp',
      'image/x-icon'
    ]) {
      const ext = imageExtForMime(mime)
      expect(ext).not.toBeNull()
      expect(imageMimeType(`x${ext}`)).toBe(mime)
    }
  })

  it('tolerates a parameterized or upper-case clipboard type, refuses anything else', () => {
    expect(imageExtForMime('IMAGE/PNG; charset=binary')).toBe('.png')
    expect(imageExtForMime('application/pdf')).toBeNull()
    expect(imageExtForMime(undefined)).toBeNull()
    expect(imageExtForMime('')).toBeNull()
  })
})

// ── The shared copier is the SAME one the verb uses ───────────────────────
describe('copyCanvasAssets — one implementation, two callers', () => {
  it('places a path source and a byte payload under the same naming rule', async () => {
    const inside = join(dir, 'from-disk.png')
    await fs.writeFile(inside, PNG)
    const res = await copyCanvasAssets(assetsDir, 'board', [
      { source: inside, ext: '.png', raw: inside },
      { bytes: new Uint8Array(PNG), ext: '.png', raw: 'pasted image 1' }
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.srcs).toEqual(['assets/board-1.png', 'assets/board-2.png'])
  })

  // BUG-149 — a source the jail accepted under the Claude tmp images root is
  // realpath-confirmed before it is read.
  describe('tmpRoot sources', () => {
    const UUID = '11111111-2222-4333-8444-555555555555'
    let tmpRoot: string
    let imagesDir: string
    beforeEach(async () => {
      tmpRoot = join(dir, 'claude-1000')
      imagesDir = join(tmpRoot, '-slug', UUID, 'images')
      await fs.mkdir(imagesDir, { recursive: true })
    })

    it('copies a genuine tmp image', async () => {
      const src = join(imagesDir, '1.png')
      await fs.writeFile(src, PNG)
      const res = await copyCanvasAssets(assetsDir, 'board', [
        { source: src, tmpRoot, ext: '.png', raw: src }
      ])
      expect(res).toEqual({ ok: true, srcs: ['assets/board-1.png'] })
      expect((await fs.readFile(join(assetsDir, 'board-1.png'))).equals(PNG)).toBe(true)
    })

    it('refuses a symlink pointing outside and writes nothing', async () => {
      const secret = join(dir, 'secret.png')
      await fs.writeFile(secret, PNG)
      const link = join(imagesDir, '2.png')
      await fs.symlink(secret, link)
      const res = await copyCanvasAssets(assetsDir, 'board', [
        { source: link, tmpRoot, ext: '.png', raw: link }
      ])
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('SOURCE_NOT_ALLOWED')
      await expect(fs.readdir(assetsDir)).rejects.toThrow()
    })
  })
})
