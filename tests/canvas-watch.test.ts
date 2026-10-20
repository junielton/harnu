import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canvasRefCount,
  addCanvasRef,
  removeCanvasRef,
  recordCanvasSelfWrite,
  consumeCanvasSuppression,
  __resetCanvasWatchStateForTests,
  registerCanvasWatchHandlers,
  notifyCanvasChanged,
  closeAllCanvasWatchers
} from '../src/main/canvas-watch'
import { writeCanvasFile } from '../src/main/canvas-write'
import type { CanvasDocument } from '../src/main/canvas-core'

/**
 * T218 U1 — the canvas watcher. Mirrors tests/markdown-watch.test.ts: the ref
 * counting and suppression bookkeeping are pure and tested directly; the
 * broadcast path is exercised against a real temp directory with a stubbed
 * BrowserWindow.
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

beforeEach(() => {
  __resetCanvasWatchStateForTests()
})

describe('canvas-watch ref counting', () => {
  it('addCanvasRef on a fresh path returns "first" and the count becomes 1', () => {
    expect(addCanvasRef('/repo/a.harnucanvas.json')).toBe('first')
    expect(canvasRefCount('/repo/a.harnucanvas.json')).toBe(1)
  })

  it('a second ref returns "more"; releasing down to zero returns "last"', () => {
    addCanvasRef('/repo/a.harnucanvas.json')
    expect(addCanvasRef('/repo/a.harnucanvas.json')).toBe('more')
    expect(removeCanvasRef('/repo/a.harnucanvas.json')).toBe('more')
    expect(removeCanvasRef('/repo/a.harnucanvas.json')).toBe('last')
    expect(canvasRefCount('/repo/a.harnucanvas.json')).toBe(0)
  })

  it('never goes negative — an unknown or exhausted path returns "none"', () => {
    expect(removeCanvasRef('/repo/never-added.harnucanvas.json')).toBe('none')
    addCanvasRef('/repo/a.harnucanvas.json')
    removeCanvasRef('/repo/a.harnucanvas.json')
    expect(removeCanvasRef('/repo/a.harnucanvas.json')).toBe('none')
  })

  it('the canvas ref map is SEPARATE from the markdown one', async () => {
    const markdown = await import('../src/main/markdown-watch')
    markdown.__resetMarkdownWatchStateForTests()
    addCanvasRef('/repo/shared-path')
    expect(markdown.refCount('/repo/shared-path')).toBe(0)
    markdown.removeRef('/repo/shared-path')
    expect(canvasRefCount('/repo/shared-path')).toBe(1)
  })
})

describe('canvas-watch self-write suppression', () => {
  const A = '/repo/a.harnucanvas.json'
  const bytes = (t: string): Buffer => Buffer.from(t, 'utf8')

  it('is false until the pane records a write', () => {
    expect(consumeCanvasSuppression(A, bytes('x'))).toBe(false)
  })

  it('swallows an event whose file is exactly what the pane wrote', () => {
    recordCanvasSelfWrite(A, 'saved')
    expect(consumeCanvasSuppression(A, bytes('saved'))).toBe(true)
  })

  it('does NOT swallow an event whose file differs — and forgets the old write', () => {
    recordCanvasSelfWrite(A, 'saved')
    expect(consumeCanvasSuppression(A, bytes('agent wrote this'))).toBe(false)
    // Once somebody else has changed the file, the pane's write is history.
    expect(consumeCanvasSuppression(A, bytes('saved'))).toBe(false)
  })

  it('treats a vanished file as somebody else’s change', () => {
    recordCanvasSelfWrite(A, 'saved')
    expect(consumeCanvasSuppression(A, null)).toBe(false)
  })

  it('is scoped per path', () => {
    recordCanvasSelfWrite(A, 'saved')
    expect(consumeCanvasSuppression('/repo/b.harnucanvas.json', bytes('saved'))).toBe(false)
    expect(consumeCanvasSuppression(A, bytes('saved'))).toBe(true)
  })
})

/** U1-8 — an external change emits a watch event carrying the path. */
describe('U1-8 change notification (§4, §7.3)', () => {
  let dir: string
  let file: string
  let sent: unknown[]

  const DOC: CanvasDocument = {
    capycanvas: 1,
    meta: {},
    nodes: [{ id: 'a', shape: 'box', x: 0, y: 0, origin: 'agent' }],
    edges: []
  }

  function win(): void {
    registerCanvasWatchHandlers(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: (ch: string, p: unknown) => sent.push({ ch, p }) }
        }) as never
    )
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnu-canvas-watch-'))
    mkdirSync(join(dir, '.harnu', 'out', 'canvas'), { recursive: true })
    file = join(dir, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
    writeFileSync(file, JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [] }), 'utf8')
    ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
    sent = []
    __resetCanvasWatchStateForTests()
  })

  afterEach(async () => {
    await closeAllCanvasWatchers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('an external change on an OPEN canvas broadcasts canvas:changed carrying the path', async () => {
    win()
    addCanvasRef(file)
    const result = await notifyCanvasChanged(file)
    expect(result).toBe('ok')
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file } }])
  })

  it('a change on a canvas nobody has open returns "not-open" and broadcasts nothing', async () => {
    win()
    expect(await notifyCanvasChanged(file)).toBe('not-open')
    expect(sent).toHaveLength(0)
  })

  it('a change outside the known roots returns "outside-roots"', async () => {
    win()
    const outside = join(tmpdir(), 'harnu-canvas-outside.harnucanvas.json')
    writeFileSync(outside, '{}', 'utf8')
    addCanvasRef(outside)
    expect(await notifyCanvasChanged(outside)).toBe('outside-roots')
    expect(sent).toHaveLength(0)
    rmSync(outside, { force: true })
  })

  it('a non-canvas path returns "invalid-path"', async () => {
    win()
    const plain = join(dir, 'notes.md')
    writeFileSync(plain, 'x', 'utf8')
    addCanvasRef(plain)
    expect(await notifyCanvasChanged(plain)).toBe('invalid-path')
    expect(sent).toHaveLength(0)
  })

  it('our OWN Save is swallowed — the pane that just saved gets no false "changed on disk"', async () => {
    win()
    addCanvasRef(file)
    const w = await writeCanvasFile(file, DOC, { selfWrite: true })
    expect(w.ok).toBe(true)
    // The writer recorded what it wrote before its rename; the event the rename
    // fires must not loop back to the pane.
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toHaveLength(0)
    // …and it only covers that write: once the file changes, the NEXT event notifies.
    writeFileSync(file, JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [] }), 'utf8')
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file } }])
  })

  it('BUG-202 — a write that is NOT the pane’s own Save (an agent’s draw_canvas) is never swallowed', async () => {
    win()
    addCanvasRef(file)
    expect((await writeCanvasFile(file, DOC)).ok).toBe(true)
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file } }])
  })

  it('closeAllCanvasWatchers clears every ref', async () => {
    win()
    addCanvasRef(file)
    await closeAllCanvasWatchers()
    expect(canvasRefCount(file)).toBe(0)
  })
})
