import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  looksBinary,
  isProseExt,
  isCanvasPath,
  classifyFileKind,
  imageMimeType,
  MAX_MARKDOWN_BYTES,
  BINARY_SNIFF_BYTES,
  CANVAS_SUFFIX
} from '../src/main/markdown-core'
import { CANVAS_SUFFIX as CANVAS_CORE_SUFFIX } from '../src/main/canvas-core'
import { CANVAS_SUFFIX as RENDERER_CANVAS_SUFFIX } from '../src/renderer/src/lib/canvas-suffix'

/**
 * Cluster G ("open/edit ANY file"): the pure binary sniff (`looksBinary`) that
 * replaced the `.md`/`.markdown`/`.txt` extension allowlist as the admission
 * gate, plus an end-to-end pass through the confined reader (`readMarkdownFile`)
 * proving the sniff + size cap are actually wired up: a `.ts`/`.json`/`.yml`
 * file now reads successfully, a file with a NUL byte is refused as `binary`,
 * the 2MB cap still applies to ANY file (not just markdown), and `.md` keeps
 * its existing prose-extension classification.
 */
describe('looksBinary — pure NUL-byte sniff', () => {
  it('is false for plain text content', () => {
    expect(looksBinary(Buffer.from('export const x = 1\n', 'utf8'))).toBe(false)
    expect(looksBinary(Buffer.from('{"a": 1}', 'utf8'))).toBe(false)
    expect(looksBinary(Buffer.from('# Title\n\nbody', 'utf8'))).toBe(false)
  })

  it('is true when a NUL byte is present', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))).toBe(true)
    expect(
      looksBinary(Buffer.concat([Buffer.from('hello'), Buffer.from([0x00]), Buffer.from('x')]))
    ).toBe(true)
  })

  it('is false for an empty buffer', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false)
  })
})

describe('imageMimeType — image extension → MIME (image preview fast-path)', () => {
  it('maps the common raster extensions', () => {
    expect(imageMimeType('/a/photo.png')).toBe('image/png')
    expect(imageMimeType('/a/photo.jpg')).toBe('image/jpeg')
    expect(imageMimeType('/a/photo.jpeg')).toBe('image/jpeg')
    expect(imageMimeType('/a/anim.gif')).toBe('image/gif')
    expect(imageMimeType('/a/photo.webp')).toBe('image/webp')
    expect(imageMimeType('/a/legacy.bmp')).toBe('image/bmp')
    expect(imageMimeType('/a/favicon.ico')).toBe('image/x-icon')
  })

  it('maps .svg (rendered via <img>, never inlined — scripts are neutered there)', () => {
    expect(imageMimeType('/a/logo.svg')).toBe('image/svg+xml')
  })

  it('is case-insensitive', () => {
    expect(imageMimeType('/a/PHOTO.PNG')).toBe('image/png')
    expect(imageMimeType('/a/Logo.SVG')).toBe('image/svg+xml')
  })

  it('is null for everything that is not an image', () => {
    expect(imageMimeType('/a/README.md')).toBeNull()
    expect(imageMimeType('/a/app.exe')).toBeNull()
    expect(imageMimeType('/a/font.woff2')).toBeNull()
    expect(imageMimeType('/a/archive.zip')).toBeNull()
    expect(imageMimeType('/a/no-extension')).toBeNull()
  })
})

describe('classifyFileKind — image fast-path over the NUL-byte sniff', () => {
  const NUL_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
  const TEXT_BYTES = Buffer.from('plain text', 'utf8')

  it("classifies 'photo.png' as image (even though its bytes sniff binary)", () => {
    expect(classifyFileKind('/a/photo.png', NUL_BYTES)).toBe('image')
  })

  it("classifies 'app.exe' as binary (no image extension, NUL byte present)", () => {
    expect(classifyFileKind('/a/app.exe', NUL_BYTES)).toBe('binary')
  })

  it('classifies an .svg as image without needing binary-looking bytes', () => {
    expect(classifyFileKind('/a/logo.svg', Buffer.from('<svg/>', 'utf8'))).toBe('image')
  })

  it('classifies NUL-free non-image content as text', () => {
    expect(classifyFileKind('/a/notes.md', TEXT_BYTES)).toBe('text')
    expect(classifyFileKind('/a/app.ts', TEXT_BYTES)).toBe('text')
  })

  it('keeps refusing non-image binaries (fonts, archives) — no relaxation of the guard', () => {
    expect(classifyFileKind('/a/font.woff2', NUL_BYTES)).toBe('binary')
    expect(classifyFileKind('/a/bundle.zip', NUL_BYTES)).toBe('binary')
  })
})

/**
 * T218 U4 — the canvas routing kind, and the trap it exists to avoid.
 *
 * `path.extname('board.harnucanvas.json')` returns `.json`, NOT
 * `.harnucanvas.json`. An `extname`-based check would therefore route every
 * ordinary JSON file in a repo to the canvas pane, which is why the
 * classification matches the full SUFFIX. Both directions are pinned below:
 * a canvas file classifies `canvas`, AND a plain `.json` still classifies
 * `text` (U4 AC-2).
 */
describe('isCanvasPath — full-suffix match, never extname (T218 §4.1)', () => {
  it('is true for a canvas document', () => {
    expect(isCanvasPath('/repo/.harnu/out/canvas/board.harnucanvas.json')).toBe(true)
    expect(isCanvasPath('/repo/docs/canvas/architecture.harnucanvas.json')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isCanvasPath('/repo/Board.HarnuCanvas.JSON')).toBe(true)
    expect(isCanvasPath('/repo/BOARD.HARNUCANVAS.JSON')).toBe(true)
  })

  it('still recognises the legacy .capycanvas.json suffix (AC-3)', () => {
    expect(isCanvasPath('/repo/.capy/out/canvas/board.capycanvas.json')).toBe(true)
    expect(isCanvasPath('/repo/Board.CapyCanvas.JSON')).toBe(true)
  })

  it('is false for every ordinary JSON file — the extname trap', () => {
    expect(isCanvasPath('/repo/package.json')).toBe(false)
    expect(isCanvasPath('/repo/tsconfig.json')).toBe(false)
    expect(isCanvasPath('/repo/.harnu/memory/helpers.json')).toBe(false)
    // `extname` would say `.json` for BOTH of these; only the suffix separates them.
    expect(path.extname('/repo/board.harnucanvas.json')).toBe('.json')
    expect(path.extname('/repo/package.json')).toBe('.json')
  })

  it('is false for a near-miss name that only CONTAINS the words', () => {
    // No separating dot: `capycanvas.json` is a plain JSON file called
    // "capycanvas", not `<name>.harnucanvas.json`.
    expect(isCanvasPath('/repo/capycanvas.json')).toBe(false)
    expect(isCanvasPath('/repo/board.harnucanvas.json.bak')).toBe(false)
    expect(isCanvasPath('/repo/board.capycanvas.yaml')).toBe(false)
    expect(isCanvasPath('/repo/mycapycanvas.json')).toBe(false)
  })

  it('mirrors the canvas core AND the renderer copy — the three cannot drift', () => {
    // `markdown-core.ts` cannot import `canvas-core.ts` (that module reads
    // MAX_MARKDOWN_BYTES from markdown-core at evaluation time, so the cycle
    // would be a TDZ crash), and the sandboxed renderer cannot value-import
    // either. This assertion is what keeps the three copies honest.
    expect(CANVAS_SUFFIX).toBe(CANVAS_CORE_SUFFIX)
    expect(RENDERER_CANVAS_SUFFIX).toBe(CANVAS_CORE_SUFFIX)
    expect(CANVAS_SUFFIX).toBe('.harnucanvas.json')
  })
})

describe('classifyFileKind — canvas routing kind (T218 U4)', () => {
  const NUL_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
  const CANVAS_JSON = Buffer.from('{"capycanvas":1,"nodes":[],"edges":[]}', 'utf8')
  const PLAIN_JSON = Buffer.from('{"name":"harnu"}', 'utf8')

  it("U4-2 — a '*.harnucanvas.json' classifies 'canvas'", () => {
    expect(classifyFileKind('/repo/.harnu/out/canvas/board.harnucanvas.json', CANVAS_JSON)).toBe(
      'canvas'
    )
  })

  it('U4-2 — a plain .json still classifies text (it must keep opening as monospace)', () => {
    expect(classifyFileKind('/repo/package.json', PLAIN_JSON)).toBe('text')
    expect(classifyFileKind('/repo/tsconfig.json', PLAIN_JSON)).toBe('text')
    expect(classifyFileKind('/repo/capycanvas.json', PLAIN_JSON)).toBe('text')
  })

  it('U4-2 — the canvas match is case-insensitive', () => {
    expect(classifyFileKind('/repo/Board.CapyCanvas.JSON', CANVAS_JSON)).toBe('canvas')
  })

  it('U4-2 — a MALFORMED canvas file still classifies canvas (the pane owns admission)', () => {
    // The classifier routes by NAME; the schema check lives in `canvas:read`.
    // If a broken board fell back to `text` here it would open in the wrong
    // pane, which is exactly what U4-4 forbids.
    expect(
      classifyFileKind('/repo/broken.harnucanvas.json', Buffer.from('{ not json', 'utf8'))
    ).toBe('canvas')
    expect(classifyFileKind('/repo/empty.harnucanvas.json', Buffer.alloc(0))).toBe('canvas')
  })

  it('the binary refusal is NOT weakened by the canvas suffix', () => {
    // A binary that borrowed the name is still binary: the NUL sniff runs
    // before the canvas match, so nothing can smuggle bytes past the guard by
    // renaming itself.
    expect(classifyFileKind('/repo/trojan.harnucanvas.json', NUL_BYTES)).toBe('binary')
  })
})

/**
 * U4-3 — this classifier is a SHARED seam every pane's open path runs through,
 * so the pre-existing behaviours are re-pinned here rather than assumed intact.
 */
describe('classifyFileKind — U4-3 regression guard on the shared seam', () => {
  const NUL_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
  const TEXT_BYTES = Buffer.from('# Title\n\nbody', 'utf8')

  it('.md still opens as prose (text kind + prose rendering)', () => {
    expect(classifyFileKind('/repo/README.md', TEXT_BYTES)).toBe('text')
    expect(isProseExt('/repo/README.md')).toBe(true)
    expect(classifyFileKind('/repo/notes.markdown', TEXT_BYTES)).toBe('text')
    expect(isProseExt('/repo/notes.markdown')).toBe(true)
  })

  it('an image still opens inline', () => {
    expect(classifyFileKind('/repo/shot.png', NUL_BYTES)).toBe('image')
    expect(classifyFileKind('/repo/logo.svg', Buffer.from('<svg/>', 'utf8'))).toBe('image')
    expect(imageMimeType('/repo/shot.png')).toBe('image/png')
  })

  it('a binary is still refused', () => {
    expect(classifyFileKind('/repo/app.exe', NUL_BYTES)).toBe('binary')
    expect(classifyFileKind('/repo/font.woff2', NUL_BYTES)).toBe('binary')
    expect(classifyFileKind('/repo/bundle.zip', NUL_BYTES)).toBe('binary')
  })

  it('an ordinary source file still opens as monospace text', () => {
    expect(classifyFileKind('/repo/app.ts', TEXT_BYTES)).toBe('text')
    expect(isProseExt('/repo/app.ts')).toBe(false)
    expect(classifyFileKind('/repo/config.yml', TEXT_BYTES)).toBe('text')
  })
})

describe('isProseExt — rendering split (Cluster G no longer an admission gate)', () => {
  it('is true only for .md / .markdown', () => {
    expect(isProseExt('/a/README.md')).toBe(true)
    expect(isProseExt('/a/NOTES.MARKDOWN')).toBe(true)
  })

  it('is false for every other extension, including .txt', () => {
    expect(isProseExt('/a/log.txt')).toBe(false)
    expect(isProseExt('/a/app.ts')).toBe(false)
    expect(isProseExt('/a/config.yml')).toBe(false)
  })
})

// ── End-to-end through the confined reader ──────────────────────────────────
const h = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
vi.mock('../src/main/user-projects', () => ({
  readUserProjects: async (): Promise<{ projects: { path: string }[] }> => ({
    projects: [{ path: h.root }]
  })
}))
vi.mock('../src/main/claude-reader', () => ({
  scanFolders: async (): Promise<unknown[]> => []
}))

import { readMarkdownFile, checkMarkdownReadAllowed } from '../src/main/markdown-read'

beforeEach(async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mdcore-'))
})
afterEach(async () => {
  await fs.rm(h.root, { recursive: true, force: true }).catch(() => {})
})

describe('readMarkdownFile — Cluster G admission (any text file, binary refused)', () => {
  it('reads a .ts file successfully (no longer gated by extension)', async () => {
    const target = path.join(h.root, 'index.ts')
    await fs.writeFile(target, 'export const x = 1\n', 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: true, content: 'export const x = 1\n' })
  })

  it('reads a .json file successfully', async () => {
    const target = path.join(h.root, 'data.json')
    await fs.writeFile(target, '{"a":1}', 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: true, content: '{"a":1}' })
  })

  it('reads a .yml file successfully', async () => {
    const target = path.join(h.root, 'config.yml')
    await fs.writeFile(target, 'a: 1\n', 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: true, content: 'a: 1\n' })
  })

  it('keeps .md behavior unchanged (still reads, still prose-classified)', async () => {
    const target = path.join(h.root, 'README.md')
    await fs.writeFile(target, '# Hello\n', 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: true, content: '# Hello\n' })
    expect(isProseExt(target)).toBe(true)
  })

  it('refuses a non-image binary file (NUL byte) with code "binary"', async () => {
    const target = path.join(h.root, 'app.exe')
    await fs.writeFile(target, Buffer.from([0x4d, 0x5a, 0x00, 0x0d, 0x0a]))
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: false, code: 'binary' })
  })

  it('reads a .png as kind "image" with a data: URL instead of the binary refusal', async () => {
    const target = path.join(h.root, 'sprite.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a])
    await fs.writeFile(target, bytes)
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({
      ok: true,
      kind: 'image',
      content: `data:image/png;base64,${bytes.toString('base64')}`
    })
  })

  it('reads an .svg as kind "image" (data: URL — <img> neuters scripts; never inlined)', async () => {
    const target = path.join(h.root, 'logo.svg')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    await fs.writeFile(target, svg, 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({
      ok: true,
      kind: 'image',
      content: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
    })
  })

  it('still enforces the 2MB cap for an image', async () => {
    const target = path.join(h.root, 'huge.png')
    await fs.writeFile(target, Buffer.alloc(MAX_MARKDOWN_BYTES + 1))
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: false, code: 'too-large' })
  })

  it('reads text files as kind "text"', async () => {
    const target = path.join(h.root, 'notes.md')
    await fs.writeFile(target, '# hi\n', 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: true, kind: 'text', content: '# hi\n' })
  })

  it('T218 U4 — a canvas file still reads as kind "text" through this reader', async () => {
    // The `canvas` classification is a ROUTING kind. This envelope reports the
    // ENCODING the renderer must decode, so it stays `text` — a canvas file
    // that reaches the text reader (an explicit read; routing sends it to
    // `canvas:read` first) must not start failing or claim a kind the envelope
    // never had.
    const target = path.join(h.root, 'board.harnucanvas.json')
    const doc = '{"capycanvas":1,"nodes":[],"edges":[]}'
    await fs.writeFile(target, doc, 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: true, kind: 'text', content: doc })
  })

  it('T218 U4 — the DEFAULT canvas location is reachable despite being gitignored', async () => {
    // Spec §4.2 puts the default board at `.harnu/out/canvas/`, and `.harnu/` is
    // gitignored — which is why the Explorer pane (it skips ignored entries)
    // cannot offer it. `open_file` is the route that reaches it, and its only
    // main-side gate is ROOT CONTAINMENT, which is pure path-prefix arithmetic
    // with no gitignore involvement. Pinned here rather than assumed.
    const dir = path.join(h.root, '.harnu', 'out', 'canvas')
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, 'board.harnucanvas.json')
    const doc = '{"capycanvas":1,"nodes":[],"edges":[]}'
    await fs.writeFile(target, doc, 'utf8')

    expect(checkMarkdownReadAllowed(target, [h.root])).toEqual({ ok: true })
    expect(classifyFileKind(target, Buffer.from(doc, 'utf8'))).toBe('canvas')
    await expect(readMarkdownFile(target)).resolves.toMatchObject({ ok: true })
  })

  it('T218 U4 — a binary that borrowed the canvas suffix is still refused', async () => {
    const target = path.join(h.root, 'trojan.harnucanvas.json')
    await fs.writeFile(target, Buffer.from([0x4d, 0x5a, 0x00, 0x0d, 0x0a]))
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: false, code: 'binary' })
  })

  it('still enforces the 2MB cap for a non-markdown file', async () => {
    const target = path.join(h.root, 'huge.log')
    await fs.writeFile(target, 'a'.repeat(MAX_MARKDOWN_BYTES + 1), 'utf8')
    const res = await readMarkdownFile(target)
    expect(res).toMatchObject({ ok: false, code: 'too-large' })
  })

  it('sniffs only the first BINARY_SNIFF_BYTES — a NUL far past that window is not caught', async () => {
    // Documents the heuristic's known limit (matches git/grep --binary-files):
    // cheap and sufficient for real binaries (which front-load their magic
    // bytes), not a full-file scan.
    const target = path.join(h.root, 'mostly-text.dat')
    const prefix = 'a'.repeat(BINARY_SNIFF_BYTES + 100)
    await fs.writeFile(target, prefix + '\x00', 'binary')
    const res = await readMarkdownFile(target)
    expect(res.ok).toBe(true)
  })
})
