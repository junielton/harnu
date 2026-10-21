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
 * BUG-209 — one canvas file open in TWO panes.
 *
 * Pane A's Save used to be swallowed as "our own write" for the whole PATH, so
 * pane B never heard about it, stayed stale, and B's next Save silently wrote
 * the old board over A's. The echo of a Save must be swallowed only for the pane
 * that wrote it; every other pane on the file reloads (clean) or raises the
 * stale banner (dirty).
 *
 * Same stand-ins as `canvas-agent-write-live.test.ts`: the IPC hop is a direct
 * call into the main-process function and the chokidar event is
 * `notifyCanvasChanged(file)`. Both panes are real mounted `DiagramPane`s.
 */

const drawCanvasHandler = WIRED_TOOLS.find((t) => t.op === 'draw_canvas')!.handler!

type Changed = { path: string; writerId?: string }

let folder: string
let canvasPath: string
/** Every mounted pane's `onCanvasChanged` subscription — the window broadcast fans out to all. */
const changedCbs = new Set<(p: Changed) => void>()
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

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 15))
    await flushPromises()
    await nextTick()
  }
}

function mountPane(id: string) {
  return mount(DiagramPane, {
    props: {
      pane: { id, type: 'canvas' as const, cwd: folder, ratio: 1, filePath: canvasPath },
      worktreeId: undefined,
      worktreePath: folder
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
}

async function operatorDrawsBox(root: Element, name: string, at = 600): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-testid="canvas-tool-rectangle"]')!.click()
  await settle()
  const svg = root.querySelector('[data-testid="diagram-canvas-host"] svg')!
  svg.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: at, clientY: 400 })
  )
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: at + 120, clientY: 470 }))
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: at + 120, clientY: 470 }))
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
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bug209-'))
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = folder
  canvasPath = path.join(folder, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
  mkdirSync(path.dirname(canvasPath), { recursive: true })
  __resetCanvasWatchStateForTests()
  readCalls = 0
  changedCbs.clear()

  registerCanvasWatchHandlers(
    () =>
      ({
        isDestroyed: () => false,
        webContents: {
          send: (ch: string, p: Changed) => {
            if (ch === 'canvas:changed') for (const cb of [...changedCbs]) cb(p)
          }
        }
      }) as never
  )

  const api = {
    canvasRead: async (p: string) => {
      readCalls++
      return readCanvasFile(p)
    },
    // The real `canvas:write` handler body: the pane's own write, tagged with its writer id.
    canvasWrite: (p: string, doc: unknown, writerId?: string) =>
      writeCanvasFile(p, doc, { selfWrite: true, writerId }),
    // The real `canvas:watchStart` / `canvas:watchStop` handler bodies, pane id included.
    canvasWatchStart: async (p: string, paneId?: string) => {
      addCanvasRef(p, paneId)
    },
    canvasWatchStop: async (p: string, paneId?: string) => {
      removeCanvasRef(p, paneId)
    },
    onCanvasChanged: (cb: (p: Changed) => void) => {
      changedCbs.add(cb)
      return () => {
        changedCbs.delete(cb)
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

describe('BUG-209 — the same canvas open in two panes', () => {
  it('AC-1 — A saves: a clean pane B reloads A’s version and keeps its viewport', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    const zoomBefore = b.find('[data-testid="diagram-zoom"]').text()
    await operatorDrawsBox(a.element, 'FromA')
    const readsBefore = readCalls

    await operatorSaves(a.element)
    await watcherSees()

    expect(readCalls).toBeGreaterThan(readsBefore)
    expect(b.element.textContent).toContain('FromA')
    expect(dirtyDot(b.element)).toBe(false)
    expect(staleBanner(b.element)).toBe(false)
    expect(b.find('[data-testid="diagram-zoom"]').text()).toBe(zoomBefore)
    a.unmount()
    b.unmount()
  })

  it('AC-1 — A saves: a dirty pane B shows the stale banner and keeps its unsaved work', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    await operatorDrawsBox(a.element, 'FromA')
    await operatorDrawsBox(b.element, 'FromB', 300)
    expect(dirtyDot(b.element)).toBe(true)

    await operatorSaves(a.element)
    await watcherSees()

    expect(staleBanner(b.element)).toBe(true)
    expect(dirtyDot(b.element)).toBe(true)
    expect(b.element.textContent).toContain('FromB')
    expect(b.element.textContent).not.toContain('FromA')
    a.unmount()
    b.unmount()
  })

  it('AC-2 — pane A neither reloads nor flags its own Save', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    await operatorDrawsBox(a.element, 'FromA')

    await operatorSaves(a.element)
    const bReloadsOnly = readCalls
    await watcherSees()

    // Exactly one pane (B) re-read the file; A did not.
    expect(readCalls - bReloadsOnly).toBe(1)
    expect(staleBanner(a.element)).toBe(false)
    expect(dirtyDot(a.element)).toBe(false)
    a.unmount()
    b.unmount()
  })

  it('AC-3 — after hearing A’s Save, B’s next Save keeps A’s change', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    await watcherSees()

    await operatorDrawsBox(b.element, 'FromB', 300)
    await operatorSaves(b.element)

    expect(await fileLabels()).toEqual(['FromA', 'FromB', 'Main', 'Renderer'])
    a.unmount()
    b.unmount()
  })

  it('AC-3 — the other way round: B saves first, and A’s next Save keeps B’s change', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    await operatorDrawsBox(b.element, 'FromB', 300)
    await operatorSaves(b.element)
    await watcherSees()
    expect(a.element.textContent).toContain('FromB')

    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)

    expect(await fileLabels()).toEqual(['FromA', 'FromB', 'Main', 'Renderer'])
    a.unmount()
    b.unmount()
  })

  it('A saves and closes before the echo arrives: B still hears the Save', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    // The ref count drops 2 → 1 between the Save and the watcher's event.
    a.unmount()
    await settle()

    await watcherSees()

    expect(b.element.textContent).toContain('FromA')
    await operatorDrawsBox(b.element, 'FromB', 300)
    await operatorSaves(b.element)
    expect(await fileLabels()).toEqual(['FromA', 'FromB', 'Main', 'Renderer'])
    b.unmount()
  })

  it('three panes: a Save in A reaches both B and C, and A stays quiet', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    const c = mountPane('pane-c')
    await settle()
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    const readsBefore = readCalls

    await watcherSees()

    expect(readCalls - readsBefore).toBe(2)
    expect(b.element.textContent).toContain('FromA')
    expect(c.element.textContent).toContain('FromA')
    expect(staleBanner(a.element)).toBe(false)
    a.unmount()
    b.unmount()
    c.unmount()
  })

  it('an agent write with two panes open reaches both, even right after a pane Save', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    await watcherSees()

    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Agent' }])
    await watcherSees()

    expect(a.element.textContent).toContain('Agent')
    expect(b.element.textContent).toContain('Agent')
    a.unmount()
    b.unmount()
  })

  it('the Save echo is swallowed outright once the other pane closes', async () => {
    const a = mountPane('pane-a')
    const b = mountPane('pane-b')
    await settle()
    b.unmount()
    await settle()
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    const readsBefore = readCalls

    await watcherSees()

    expect(readCalls).toBe(readsBefore)
    expect(staleBanner(a.element)).toBe(false)
    a.unmount()
  })
})
