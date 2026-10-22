import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  canvasRefCount,
  addCanvasRef,
  removeCanvasRef,
  recordCanvasSelfWrite,
  settleCanvasSelfWrite,
  consumeCanvasSuppression,
  consumeCanvasSelfWrite,
  canvasSuppressionSnapshot,
  __resetCanvasWatchStateForTests,
  registerCanvasWatchHandlers,
  notifyCanvasChanged,
  startCanvasWatch,
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

  // BUG-214 — two Saves in quick succession. `canvas-write` records Save #2's hash BEFORE
  // its rename, so the delayed echo of Save #1 (chokidar's `awaitWriteFinish` holds an event
  // back ~100 ms) can be handled while the file still holds Save #1's bytes. That used to
  // read as somebody else's write: the pane got a false "changed on disk" and, being clean,
  // redrew the whole board and lost the operator's selection.
  it('swallows the stale echo of the previous Save while the next Save is in flight', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-a') // Save #2 recorded, its rename not landed yet
    expect(consumeCanvasSuppression(A, bytes('save one'))).toBe(true)
    // …and the file is still the pane's own once Save #2 lands.
    expect(consumeCanvasSuppression(A, bytes('save two'))).toBe(true)
  })

  it('swallows Save #2’s echo, but no longer Save #1’s, after Save #2 has settled', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-a')
    settleCanvasSelfWrite(A, true)
    // Save #2 is on disk: an event that finds Save #1's bytes is not an echo any more.
    expect(consumeCanvasSuppression(A, bytes('save two'))).toBe(true)
    expect(consumeCanvasSuppression(A, bytes('save one'))).toBe(false)
  })

  it('does not let the previous Save’s bytes mask a foreign write once nothing is in flight', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-a')
    settleCanvasSelfWrite(A, true)
    // An agent restores Save #1's exact bytes: that is a real change the pane must hear about.
    expect(consumeCanvasSuppression(A, bytes('save one'))).toBe(false)
  })

  it('a foreign write during the in-flight window still arrives', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-a')
    expect(consumeCanvasSuppression(A, bytes('agent wrote this'))).toBe(false)
  })

  it('a Save that fails goes back to the previous Save as the pane’s own write', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-b')
    settleCanvasSelfWrite(A, false) // the rename never landed: the file still holds 'save one'
    expect(consumeCanvasSelfWrite(A, bytes('save one'))).toEqual({ writerId: 'pane-a' })
  })

  it('names the writer of the Save it matched, not the newest one in flight', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-b')
    expect(consumeCanvasSelfWrite(A, bytes('save one'))).toEqual({ writerId: 'pane-a' })
    expect(consumeCanvasSelfWrite(A, bytes('save two'))).toEqual({ writerId: 'pane-b' })
  })

  // The watcher's read is async: it can open the file while Save #2 is in flight (and get
  // Save #1's bytes) yet finish only after Save #2 has landed and settled. Judged against
  // the state at the END of the read, that is a foreign write — the BUG-214 reload again.
  it('a read that began while Save #2 was in flight still swallows Save #1’s echo after Save #2 settles', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-b')
    const atReadStart = canvasSuppressionSnapshot(A)
    settleCanvasSelfWrite(A, true)
    // …and it is Save #1's writer, as the snapshot saw it, that the echo is tagged with.
    expect(consumeCanvasSelfWrite(A, bytes('save one'), atReadStart)).toEqual({
      writerId: 'pane-a'
    })
    // …and the newest Save is still the pane's own afterwards.
    expect(consumeCanvasSuppression(A, bytes('save two'))).toBe(true)
  })

  it('a read that began with nothing in flight never treats the previous Save as an echo', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-a')
    settleCanvasSelfWrite(A, true)
    const atReadStart = canvasSuppressionSnapshot(A)
    expect(consumeCanvasSuppression(A, bytes('save one'), atReadStart)).toBe(false)
  })

  it('a snapshot taken before a foreign write cleared the record does not revive it', () => {
    recordCanvasSelfWrite(A, 'save one', 'pane-a')
    settleCanvasSelfWrite(A, true)
    recordCanvasSelfWrite(A, 'save two', 'pane-a')
    const atReadStart = canvasSuppressionSnapshot(A)
    expect(consumeCanvasSuppression(A, bytes('agent wrote this'))).toBe(false) // record cleared
    recordCanvasSelfWrite(A, 'save three', 'pane-a')
    expect(consumeCanvasSuppression(A, bytes('save one'), atReadStart)).toBe(false)
  })

  it('forgets the pane’s write once the last pane on the path closes', () => {
    // Pane Saves, closes, the file changes while nothing watches it, the pane
    // reopens on the new content — then something restores exactly the old
    // bytes (`git checkout`). That event is NOT the pane's echo and must arrive.
    addCanvasRef(A)
    recordCanvasSelfWrite(A, 'saved')
    expect(removeCanvasRef(A)).toBe('last')
    addCanvasRef(A)
    expect(consumeCanvasSuppression(A, bytes('saved'))).toBe(false)
  })

  it('keeps the pane’s write while another pane still has the path open', () => {
    addCanvasRef(A)
    addCanvasRef(A)
    recordCanvasSelfWrite(A, 'saved')
    expect(removeCanvasRef(A)).toBe('more')
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

  it('BUG-214 — the stale echo of Save #1, handled while Save #2 is in flight, is swallowed', async () => {
    win()
    addCanvasRef(file)
    expect((await writeCanvasFile(file, DOC, { selfWrite: true })).ok).toBe(true) // Save #1 landed
    // Save #2 has been recorded but its rename has not landed: the file still holds Save #1.
    recordCanvasSelfWrite(file, 'the bytes of save two')
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toHaveLength(0)
  })

  it('BUG-214 — with a second pane on the file, Save #1’s stale echo is tagged with Save #1’s writer', async () => {
    win()
    addCanvasRef(file, 'pane-a')
    addCanvasRef(file, 'pane-b')
    expect((await writeCanvasFile(file, DOC, { selfWrite: true, writerId: 'pane-a' })).ok).toBe(
      true
    )
    // pane-b's Save is recorded, its rename not landed: the file still holds pane-a's Save.
    recordCanvasSelfWrite(file, 'the bytes of pane-b’s save', 'pane-b')
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file, writerId: 'pane-a' } }])
  })

  it('BUG-214 — an agent restoring the previous Save’s exact bytes is heard once nothing is in flight', async () => {
    win()
    addCanvasRef(file)
    const DOC2: CanvasDocument = {
      ...DOC,
      nodes: [...DOC.nodes, { id: 'b', shape: 'box', x: 9, y: 9, origin: 'agent' }]
    }
    expect((await writeCanvasFile(file, DOC, { selfWrite: true })).ok).toBe(true) // Save #1
    expect((await writeCanvasFile(file, DOC2, { selfWrite: true })).ok).toBe(true) // Save #2
    expect(await notifyCanvasChanged(file)).toBe('ok') // Save #2's echo: the pane's own
    expect(sent).toHaveLength(0)
    expect((await writeCanvasFile(file, DOC)).ok).toBe(true) // an agent writes Save #1's bytes
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

  it('BUG-209 — with a second pane on the file, a Save echo is broadcast tagged with the writer', async () => {
    win()
    addCanvasRef(file)
    addCanvasRef(file)
    expect((await writeCanvasFile(file, DOC, { selfWrite: true, writerId: 'pane-a' })).ok).toBe(
      true
    )
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file, writerId: 'pane-a' } }])
  })

  it('BUG-209 — a lone pane still swallows its own Save, writer id or not', async () => {
    win()
    addCanvasRef(file)
    expect((await writeCanvasFile(file, DOC, { selfWrite: true, writerId: 'pane-a' })).ok).toBe(
      true
    )
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toHaveLength(0)
  })

  it('BUG-209 — a writer that closed before its echo leaves the other pane told', async () => {
    win()
    addCanvasRef(file, 'pane-a')
    addCanvasRef(file, 'pane-b')
    expect((await writeCanvasFile(file, DOC, { selfWrite: true, writerId: 'pane-a' })).ok).toBe(
      true
    )
    expect(removeCanvasRef(file, 'pane-a')).toBe('more')
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file, writerId: 'pane-a' } }])
  })

  it('BUG-209 — the writer holding two refs on the file is still alone', async () => {
    win()
    addCanvasRef(file, 'pane-a')
    addCanvasRef(file, 'pane-a')
    expect((await writeCanvasFile(file, DOC, { selfWrite: true, writerId: 'pane-a' })).ok).toBe(
      true
    )
    expect(await notifyCanvasChanged(file)).toBe('ok')
    expect(sent).toHaveLength(0)
  })

  it('closeAllCanvasWatchers clears every ref', async () => {
    win()
    addCanvasRef(file)
    await closeAllCanvasWatchers()
    expect(canvasRefCount(file)).toBe(0)
  })
})

/** BUG-210 — `startCanvasWatch` resolves only once chokidar really watches the file. */
describe('startCanvasWatch readiness (BUG-210)', () => {
  let dir: string
  let file: string
  let sent: { ch: string; p: unknown }[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harnu-canvas-ready-'))
    mkdirSync(join(dir, '.harnu', 'out', 'canvas'), { recursive: true })
    file = join(dir, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
    writeFileSync(file, JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [] }), 'utf8')
    ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
    sent = []
    __resetCanvasWatchStateForTests()
    registerCanvasWatchHandlers(
      () =>
        ({
          isDestroyed: () => false,
          webContents: { send: (ch: string, p: unknown) => sent.push({ ch, p }) }
        }) as never
    )
  })

  afterEach(async () => {
    await closeAllCanvasWatchers()
    rmSync(dir, { recursive: true, force: true })
  })

  async function eventually(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50))
  }

  it('a write made the instant it resolves is seen by the real watcher', async () => {
    await startCanvasWatch(file)
    writeFileSync(file, JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [], x: 1 }))
    await eventually(() => sent.length > 0)
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file } }])
  })

  it('a second pane on the same file also resolves once it is watched', async () => {
    await startCanvasWatch(file)
    await startCanvasWatch(file)
    expect(canvasRefCount(file)).toBe(2)
  })

  it('a file that does not exist resolves at once instead of waiting out the timeout', async () => {
    const t0 = Date.now()
    await startCanvasWatch(join(dir, '.harnu', 'out', 'canvas', 'missing.harnucanvas.json'))
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('a path outside the known roots is refused without registering a ref', async () => {
    const outside = join(tmpdir(), 'harnu-canvas-outside-ready.harnucanvas.json')
    await startCanvasWatch(outside)
    expect(canvasRefCount(outside)).toBe(0)
  })
})
