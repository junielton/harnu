// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { nextTick } from 'vue'
import { promises as fs, mkdirSync } from 'node:fs'
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

import DiagramPane from '../src/renderer/src/components/DiagramPane.vue'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { readCanvasFile } from '../src/main/canvas-read'
import { writeCanvasFile } from '../src/main/canvas-write'
import {
  __resetCanvasWatchStateForTests,
  addCanvasRef,
  notifyCanvasChanged,
  registerCanvasWatchHandlers,
  removeCanvasRef
} from '../src/main/canvas-watch'
import { i18n } from '@renderer/i18n'
import { installJsdomSvgShim } from './helpers/jsdom-svg'

installJsdomSvgShim()

/**
 * BUG-202 — an agent's `draw_canvas` write to a canvas that is already open.
 *
 * Every test here goes through the SHIPPED pieces end to end: the real
 * `draw_canvas` handler writes the file, the real watcher bookkeeping decides
 * whether the open pane hears about it, and a real mounted `DiagramPane`
 * reloads (or raises the stale banner) and then Saves through the real
 * `canvas:write` path. Only two things are stood in for: the Electron IPC hop
 * (a direct call into the main-process function) and the chokidar event
 * (`notifyCanvasChanged(file)`, which is exactly what chokidar's handler calls).
 *
 * The failure this pins is a SILENT DATA LOSS, not a missing redraw: the agent's
 * write was swallowed as if it were the pane's own Save, the pane kept a stale
 * `doc`, and the operator's next Save wrote that stale state over the agent's
 * change with no warning on either side.
 */

const drawCanvasHandler = WIRED_TOOLS.find((t) => t.op === 'draw_canvas')!.handler!

let folder: string
let canvasPath: string
let changedCb: ((p: { path: string }) => void) | null = null
let readCalls = 0

const ctxFor = (): Parameters<typeof drawCanvasHandler>[1] =>
  ({ folder, folders: [], denyFolders: [], bridge: undefined }) as Parameters<
    typeof drawCanvasHandler
  >[1]

async function agentDraws(ops: unknown[]): Promise<void> {
  const res = await drawCanvasHandler({ folder, ops }, ctxFor())
  expect(res.isError).toBeFalsy()
}

/** What chokidar's `change` handler would do after the write settled. */
async function watcherSees(): Promise<void> {
  await notifyCanvasChanged(canvasPath)
  await settle()
}

async function fileLabels(): Promise<string[]> {
  const read = await readCanvasFile(canvasPath)
  if (!read.ok) throw new Error('canvas unreadable')
  return read.doc.nodes.map((n) => n.label ?? '').sort()
}

/** The reads and writes here hit a real disk, so give them real time to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 15))
    await flushPromises()
    await nextTick()
  }
}

function mountPane() {
  return mount(DiagramPane, {
    props: {
      pane: {
        id: 'h-canvas',
        type: 'canvas' as const,
        cwd: folder,
        ratio: 1,
        filePath: canvasPath
      },
      worktreePath: folder
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
}

/** The operator draws a box and names it — an unsaved edit, dirty dot on. */
async function operatorDrawsBox(root: Element, name: string): Promise<void> {
  const svg = root.querySelector('[data-testid="diagram-canvas-host"] svg')!
  svg.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 600, clientY: 400 })
  )
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 720, clientY: 470 }))
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: 720, clientY: 470 }))
  await settle()
  const input = root.querySelector<HTMLInputElement>('[data-testid="diagram-rename-input"]')!
  input.value = name
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
}

async function operatorSaves(root: Element): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-testid="diagram-save"]')!.click()
  await settle()
}

const dirtyDot = (root: Element): boolean =>
  root.querySelector('[data-testid="diagram-dirty-dot"]') !== null
const staleBanner = (root: Element): boolean =>
  root.querySelector('[data-testid="diagram-stale-banner"]') !== null

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bug202-'))
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = folder
  canvasPath = path.join(folder, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
  mkdirSync(path.dirname(canvasPath), { recursive: true })
  __resetCanvasWatchStateForTests()
  readCalls = 0
  changedCb = null

  // The window the main process broadcasts through, wired straight to the pane's
  // `onCanvasChanged` subscription.
  registerCanvasWatchHandlers(
    () =>
      ({
        isDestroyed: () => false,
        webContents: {
          send: (ch: string, p: { path: string }) => {
            if (ch === 'canvas:changed') changedCb?.(p)
          }
        }
      }) as never
  )

  const api = {
    canvasRead: async (p: string) => {
      readCalls++
      return readCanvasFile(p)
    },
    // The pane's Save: the real `canvas:write` handler body — the pane's own write.
    canvasWrite: (p: string, doc: unknown) => writeCanvasFile(p, doc, { selfWrite: true }),
    canvasWatchStart: async (p: string) => {
      addCanvasRef(p)
    },
    canvasWatchStop: async (p: string) => {
      removeCanvasRef(p)
    },
    onCanvasChanged: (cb: (p: { path: string }) => void) => {
      changedCb = cb
      return () => {
        changedCb = null
      }
    },
    markdownRead: async () => ({ ok: false as const, code: 'not-found', error: 'x' }),
    helpersGet: async () => null,
    helpersSet: () => undefined
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k] : () => () => {}
    }
  })
  setActivePinia(createPinia())

  await agentDraws([
    { op: 'add_node', shape: 'box', x: 0, y: 0, label: 'Renderer' },
    { op: 'add_node', shape: 'box', x: 260, y: 0, label: 'Main' }
  ])
})

afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>).__TEST_ROOT__
})

describe('BUG-202 — an agent write to an open canvas pane', () => {
  it('AC-1 — a clean pane redraws to the agent’s version without a Reload, and the view does not move', async () => {
    const w = mountPane()
    await settle()
    const zoomBefore = w.find('[data-testid="diagram-zoom"]').text()
    const readsBefore = readCalls
    expect(w.element.textContent).not.toContain('Cache')

    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Cache' }])
    await watcherSees()

    expect(readCalls).toBeGreaterThan(readsBefore)
    expect(w.element.textContent).toContain('Cache')
    expect(dirtyDot(w.element)).toBe(false)
    expect(staleBanner(w.element)).toBe(false)
    expect(w.find('[data-testid="diagram-zoom"]').text()).toBe(zoomBefore)
    w.unmount()
  })

  it('AC-2 — a pane with unsaved edits raises the stale banner and keeps the operator’s work', async () => {
    const w = mountPane()
    await settle()
    await operatorDrawsBox(w.element, 'Mine')
    expect(dirtyDot(w.element)).toBe(true)
    const readsBefore = readCalls

    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Cache' }])
    await watcherSees()

    expect(staleBanner(w.element)).toBe(true)
    expect(dirtyDot(w.element)).toBe(true)
    expect(readCalls).toBe(readsBefore) // no silent reload over unsaved work
    expect(w.element.textContent).toContain('Mine')
    expect(w.element.textContent).not.toContain('Cache')
    w.unmount()
  })

  it('AC-3 — agent write to a clean pane, then the operator edits and Saves: the file keeps the agent’s change', async () => {
    const w = mountPane()
    await settle()

    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Cache' }])
    await watcherSees()

    await operatorDrawsBox(w.element, 'Mine')
    await operatorSaves(w.element)

    expect(dirtyDot(w.element)).toBe(false)
    expect(await fileLabels()).toEqual(['Cache', 'Main', 'Mine', 'Renderer'])
    w.unmount()
  })

  it('AC-3 — the same holds for an edge the agent adds and for a label it changes', async () => {
    const w = mountPane()
    await settle()
    const seeded = await readCanvasFile(canvasPath)
    if (!seeded.ok) throw new Error('seed unreadable')
    const [a, b] = seeded.doc.nodes

    await agentDraws([
      { op: 'add_edge', source: a.id, target: b.id, label: 'IPC' },
      { op: 'update_node', id: b.id, label: 'Main process' }
    ])
    await watcherSees()

    await operatorDrawsBox(w.element, 'Mine')
    await operatorSaves(w.element)

    const after = await readCanvasFile(canvasPath)
    if (!after.ok) throw new Error('canvas unreadable')
    expect(after.doc.edges.map((e) => e.label)).toEqual(['IPC'])
    expect(after.doc.nodes.map((n) => n.label).sort()).toEqual(['Main process', 'Mine', 'Renderer'])
    w.unmount()
  })

  it('AC-4 — the pane’s own Save neither reloads the pane nor raises the stale banner', async () => {
    const w = mountPane()
    await settle()
    await operatorDrawsBox(w.element, 'Mine')
    const readsBefore = readCalls

    await operatorSaves(w.element)
    await watcherSees() // the event the Save's own rename fires

    expect(readCalls).toBe(readsBefore)
    expect(staleBanner(w.element)).toBe(false)
    expect(dirtyDot(w.element)).toBe(false)
    w.unmount()
  })

  it('AC-4 — and it swallows only its own Save: the next external change still arrives', async () => {
    const w = mountPane()
    await settle()
    await operatorDrawsBox(w.element, 'Mine')
    await operatorSaves(w.element)
    await watcherSees()
    const readsBefore = readCalls

    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Cache' }])
    await watcherSees()

    expect(readCalls).toBeGreaterThan(readsBefore)
    expect(w.element.textContent).toContain('Cache')
    w.unmount()
  })

  it('AC-5 — an agent write that lands inside the Save’s settle window still reaches the pane', async () => {
    // chokidar's `awaitWriteFinish` (100 ms) folds a Save and an agent write that
    // land inside one window into a SINGLE change event. A one-shot "my own
    // Save" flag swallows that event and the agent's write is lost; deciding by
    // what is on disk (is it the bytes the pane just wrote?) does not.
    const w = mountPane()
    await settle()
    await operatorDrawsBox(w.element, 'Mine')
    await operatorSaves(w.element)
    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Cache' }])
    const readsBefore = readCalls

    await watcherSees() // ONE merged event for both writes

    expect(readCalls).toBeGreaterThan(readsBefore)
    expect(w.element.textContent).toContain('Cache')
    expect(dirtyDot(w.element)).toBe(false)
    w.unmount()
  })

  it('AC-5 — pinned: a Save that lands after an agent write the pane has not heard yet wins', async () => {
    // The mirror image cannot be closed from the main process: the pane saves its
    // own state, so a Save issued before the agent's event arrives overwrites the
    // agent's write — last writer wins, the same rule as spec §7.3 case C. The
    // window is the watcher's settle time (~100 ms). What IS guaranteed is that
    // the pane and the file agree afterwards, so nothing is left half-reverted
    // and no spurious reload or banner follows.
    const w = mountPane()
    await settle()
    await operatorDrawsBox(w.element, 'Mine')
    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Cache' }])
    await operatorSaves(w.element) // no event delivered in between
    const readsBefore = readCalls

    await watcherSees() // the one merged event

    expect(await fileLabels()).toEqual(['Main', 'Mine', 'Renderer'])
    expect(readCalls).toBe(readsBefore)
    expect(staleBanner(w.element)).toBe(false)
    expect(dirtyDot(w.element)).toBe(false)
    w.unmount()
  })
})
