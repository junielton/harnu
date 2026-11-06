// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
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
import { waitFor } from './helpers/canvas-pane-harness'

installJsdomSvgShim()

/**
 * BUG-210 — a write that lands while the pane is still opening.
 *
 * `canvas:watchStart` used to resolve before chokidar had the file registered,
 * and the pane read the file without waiting for it. A write landing after that
 * read but before the watch went live produced no `change` event anywhere: the
 * pane showed the old board as clean and the operator's next Save reverted the
 * write. The pane must not read until the watch is live, so a write in the gap
 * is either in the read or seen by the watcher.
 *
 * The interleaving is forced, not slept into: the stand-in `canvasWatchStart`
 * is held on a deferred promise (the watch "not ready yet"), the write is made
 * while it is held, and the watcher stand-in — like chokidar — delivers no
 * event for a change that landed before it was live.
 *
 * BUG-242 — nothing here waits a fixed time either. The pane's open crosses real file
 * I/O and X6's time-sliced render, so each step waits for the state it causes
 * (`waitFor`): the held watch having been asked for, the board being drawn, the Save
 * having landed. The one negative assertion (a closed pane never reads) needs no
 * wait at all beyond draining microtasks — the pane would call `canvasRead`
 * synchronously on resuming.
 */

const drawCanvasHandler = WIRED_TOOLS.find((t) => t.op === 'draw_canvas')!.handler!

type Changed = { path: string; writerId?: string }

let folder: string
let canvasPath: string
const changedCbs = new Set<(p: Changed) => void>()
/** Resolves the held `canvasWatchStart` — "chokidar is now watching the file". */
let watchLive: (() => void) | null = null
let holdWatch = false
let reads = 0
let failWatch = false
/** Panes a test left mounted, so `afterEach` unmounts them even when an assertion threw. */
const mountedPanes = new Set<VueWrapper>()

const ctxFor = (): Parameters<typeof drawCanvasHandler>[1] =>
  ({ folder, folders: [], denyFolders: [], bridge: undefined }) as Parameters<
    typeof drawCanvasHandler
  >[1]

async function agentDraws(ops: unknown[]): Promise<void> {
  const res = await drawCanvasHandler({ folder, ops }, ctxFor())
  expect(res.isError).toBeFalsy()
}

async function fileLabels(): Promise<string[]> {
  const read = await readCanvasFile(canvasPath)
  if (!read.ok) throw new Error('canvas unreadable')
  return read.doc.nodes.map((n) => n.label ?? '').sort()
}

/** Drain the microtasks and Vue's flush: enough to see a SYNCHRONOUS effect in the DOM. */
async function flush(): Promise<void> {
  await flushPromises()
  await nextTick()
}

const shows = (root: Element, text: string): boolean => (root.textContent ?? '').includes(text)
const RENAME = '[data-testid="diagram-rename-input"]'

function mountPane(): VueWrapper {
  const w = mount(DiagramPane, {
    props: {
      pane: { id: 'pane-a', type: 'canvas' as const, cwd: folder, ratio: 1, filePath: canvasPath },
      worktreeId: undefined,
      worktreePath: folder
    },
    global: { plugins: [i18n] },
    attachTo: document.body
  })
  const unmount = w.unmount.bind(w)
  w.unmount = () => {
    mountedPanes.delete(w)
    unmount()
  }
  mountedPanes.add(w)
  return w
}

/** The pane's open is blocked on the held `canvasWatchStart`: it has asked for the watch. */
async function paneWaitsForWatch(): Promise<void> {
  await waitFor('the pane is waiting for the watch to go live', () => watchLive !== null)
}

/** Wait until the pane has read the file and drawn `label`. */
async function paneShows(w: VueWrapper, label: string): Promise<void> {
  await waitFor(`the pane shows ${label}`, () => shows(w.element, label))
}

async function operatorDrawsBox(root: Element, name: string): Promise<void> {
  const tool = root.querySelector<HTMLButtonElement>('[data-testid="canvas-tool-rectangle"]')!
  tool.click()
  await waitFor('the rectangle tool is armed', () => tool.getAttribute('aria-pressed') === 'true')
  const svg = root.querySelector('[data-testid="diagram-canvas-host"] svg')!
  svg.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 600, clientY: 400 })
  )
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 720, clientY: 470 }))
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: 720, clientY: 470 }))
  await waitFor('the new box asks for its name', () => root.querySelector(RENAME) !== null)
  const input = root.querySelector<HTMLInputElement>(RENAME)!
  input.value = name
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(
    `${name} is on the board and unsaved`,
    () =>
      shows(root, name) &&
      root.querySelector('[data-testid="diagram-dirty-dot"]') !== null &&
      root.querySelector(RENAME) === null
  )
}

/** Press Save and wait until the write landed (the pane clears its dirty dot only then). */
async function operatorSaves(root: Element): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-testid="diagram-save"]')!.click()
  await waitFor(
    'the Save landed',
    () => root.querySelector('[data-testid="diagram-dirty-dot"]') === null
  )
}

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bug210-'))
  ;(globalThis as Record<string, unknown>).__TEST_ROOT__ = folder
  canvasPath = path.join(folder, '.harnu', 'out', 'canvas', 'board.harnucanvas.json')
  mkdirSync(path.dirname(canvasPath), { recursive: true })
  __resetCanvasWatchStateForTests()
  changedCbs.clear()
  watchLive = null
  holdWatch = false
  reads = 0
  failWatch = false

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
    canvasRead: (p: string) => {
      reads++
      return readCanvasFile(p)
    },
    canvasWrite: (p: string, doc: unknown, writerId?: string) =>
      writeCanvasFile(p, doc, { selfWrite: true, writerId }),
    // The contract of the real handler: resolves once the file is being watched.
    canvasWatchStart: async (p: string) => {
      if (holdWatch) await new Promise<void>((r) => (watchLive = r))
      if (failWatch) throw new Error('watch unavailable')
      addCanvasRef(p)
    },
    canvasWatchStop: async (p: string) => {
      removeCanvasRef(p)
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
  for (const w of [...mountedPanes]) w.unmount()
  await fs.rm(folder, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>).__TEST_ROOT__
})

describe('BUG-210 — a write while the pane is still opening', () => {
  it('AC-1 — a write before the watch is live reaches a pane that opens clean', async () => {
    holdWatch = true
    const pane = mountPane()
    await paneWaitsForWatch() // the pane is opening; the watch is not live yet

    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'AgentGap' }])
    watchLive!() // chokidar is ready — it saw nothing: the write landed before it was live
    await paneShows(pane, 'AgentGap')

    expect(pane.element.textContent).toContain('AgentGap')
    expect(pane.find('[data-testid="diagram-stale-banner"]').exists()).toBe(false)
    pane.unmount()
  })

  it('AC-2 — the operator’s next Save keeps that write', async () => {
    holdWatch = true
    const pane = mountPane()
    await paneWaitsForWatch()
    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'AgentGap' }])
    watchLive!()
    await paneShows(pane, 'AgentGap')

    await operatorDrawsBox(pane.element, 'FromOperator')
    await operatorSaves(pane.element)

    expect(await fileLabels()).toEqual(['AgentGap', 'FromOperator', 'Main', 'Renderer'])
    pane.unmount()
  })

  it('a write after the watch is live still arrives as an event (the BUG-202 path)', async () => {
    const pane = mountPane()
    await paneShows(pane, 'Renderer') // open and watching
    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'AgentLater' }])
    await notifyCanvasChanged(canvasPath)
    await paneShows(pane, 'AgentLater')
    expect(pane.element.textContent).toContain('AgentLater')
    pane.unmount()
  })

  it('a pane closed while it waits for the watch does not go on to load', async () => {
    holdWatch = true
    const pane = mountPane()
    await paneWaitsForWatch()
    pane.unmount()
    watchLive!()
    // The pane would call `canvasRead` synchronously on resuming from the watch, so
    // once the microtask queue is drained a read that was going to happen has happened.
    await flush()
    expect(reads).toBe(0)
  })

  it('a watch that cannot start does not stop the pane from showing the board', async () => {
    failWatch = true
    const pane = mountPane()
    await paneShows(pane, 'Renderer')
    expect(pane.element.textContent).toContain('Renderer')
    pane.unmount()
  })
})
