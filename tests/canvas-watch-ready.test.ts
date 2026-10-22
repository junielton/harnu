import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/**
 * BUG-210 review — `startCanvasWatch` against a chokidar whose OS watch attaches
 * when the TEST says so. A real watcher attaches in milliseconds, so the slow
 * paths (Windows-style keys, a watch that misses the deadline) can only be
 * driven deterministically with a stand-in.
 */

const fake = vi.hoisted(() => ({
  /** dir → names, exactly what `getWatched()` returns. */
  watched: {} as Record<string, string[]>,
  /** event → handlers the module registered on the watcher. */
  handlers: {} as Record<string, ((...a: unknown[]) => void)[]>
}))

vi.mock('chokidar', () => ({
  default: {
    watch: () => ({
      add: (): void => {},
      unwatch: (): void => {},
      on(ev: string, fn: (...a: unknown[]) => void) {
        ;(fake.handlers[ev] ??= []).push(fn)
        return this
      },
      close: async (): Promise<void> => {},
      getWatched: () => fake.watched
    })
  }
}))

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

import {
  __resetCanvasWatchStateForTests,
  __setWatchReadyTimeoutForTests,
  closeAllCanvasWatchers,
  isCanvasWatched,
  registerCanvasWatchHandlers,
  startCanvasWatch
} from '../src/main/canvas-watch'
import { writeCanvasFile } from '../src/main/canvas-write'

let dir: string
let file: string
let sent: { ch: string; p: unknown }[]

function attach(): void {
  fake.watched = { [dirname(file)]: [basename(file)] }
}

async function eventually(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harnu-canvas-ready-fake-'))
  mkdirSync(join(dir, '.harnu', 'out', 'canvas'), { recursive: true })
  file = join(dir, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
  writeFileSync(file, JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [] }), 'utf8')
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = dir
  fake.watched = {}
  fake.handlers = {}
  sent = []
  __resetCanvasWatchStateForTests()
  __setWatchReadyTimeoutForTests(60)
  registerCanvasWatchHandlers(
    () =>
      ({
        isDestroyed: () => false,
        webContents: { send: (ch: string, p: unknown) => sent.push({ ch, p }) }
      }) as never
  )
})

afterEach(async () => {
  __setWatchReadyTimeoutForTests(undefined)
  await closeAllCanvasWatchers()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('isCanvasWatched', () => {
  it('matches the POSIX key chokidar lists for a file', () => {
    expect(
      isCanvasWatched({ '/r/.harnu/out/canvas': ['b.json'] }, '/r/.harnu/out/canvas/b.json')
    ).toBe(true)
    expect(
      isCanvasWatched({ '/r/.harnu/out/canvas': ['a.json'] }, '/r/.harnu/out/canvas/b.json')
    ).toBe(false)
  })

  it('matches a Windows path against chokidar’s forward-slash key', () => {
    // chokidar normalizes every path it is given to forward slashes, so on
    // Windows `getWatched()` is keyed `C:/…` while `path.resolve` yields `C:\…`.
    expect(
      isCanvasWatched(
        { 'C:/repo/.harnu/out/canvas': ['board.harnucanvas.json'] },
        'C:\\repo\\.harnu\\out\\canvas\\board.harnucanvas.json'
      )
    ).toBe(true)
  })
})

describe('startCanvasWatch when the watch misses the deadline (BUG-210 review)', () => {
  it('resolves at the deadline instead of hanging the pane', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t0 = Date.now()
    await startCanvasWatch(file)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('says so in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startCanvasWatch(file)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not live'))
  })

  it('a write that lands before the late watch attaches still reaches the panes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startCanvasWatch(file)
    // The pane has read the old board; the write makes no event, as with chokidar.
    writeFileSync(file, JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [], x: 1 }))
    attach()
    await eventually(() => sent.length > 0)
    expect(sent).toEqual([{ ch: 'canvas:changed', p: { path: file } }])
  })

  it('nothing is broadcast when the file did not change before the late watch attached', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startCanvasWatch(file)
    attach()
    await new Promise((r) => setTimeout(r, 300))
    expect(sent).toEqual([])
  })

  it('a watch that attaches in time is not re-checked or logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    attach()
    await startCanvasWatch(file)
    expect(warn).not.toHaveBeenCalled()
  })

  it('pinned: on the timeout path a Save before the late watch attaches wins', async () => {
    // Today's behaviour, not a goal: the pane read the board before an outside
    // write, the watch is still not live, and the operator saves. Their Save
    // replaces the outside write on disk (last writer wins), and the late
    // re-check sees the pane's own Save, so nobody is told.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await startCanvasWatch(file, 'pane-a')
    writeFileSync(
      file,
      JSON.stringify({ capycanvas: 1, meta: {}, nodes: [], edges: [], agent: true }),
      'utf8'
    )
    const saved = await writeCanvasFile(
      file,
      { capycanvas: 1, meta: {}, nodes: [], edges: [] },
      { selfWrite: true, writerId: 'pane-a' }
    )
    expect(saved.ok).toBe(true)
    attach()
    await new Promise((r) => setTimeout(r, 300))
    expect(readFileSync(file, 'utf8')).not.toContain('agent')
    expect(sent).toEqual([])
  })
})

describe('a watch the OS refuses (BUG-210 review)', () => {
  it('a watcher error is logged instead of thrown', async () => {
    // chokidar lists the file before fs.watch throws (ENOSPC on Linux) and then
    // emits 'error'; an EventEmitter with no 'error' listener throws.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    attach()
    await startCanvasWatch(file)
    const onError = fake.handlers['error'] ?? []
    expect(onError).toHaveLength(1)
    onError[0](Object.assign(new Error('watch limit'), { code: 'ENOSPC' }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('watcher error'), expect.anything())
  })
})
