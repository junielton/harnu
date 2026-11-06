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
 *
 * BUG-242 — no step here waits a fixed time. A pane's load, Save and reload cross
 * real file I/O and X6's time-sliced render, so how long they take depends on how
 * loaded the runner is; every helper waits for the state its action causes
 * (`waitFor`). What can be asserted straight after `notifyCanvasChanged` resolves
 * is only each pane's DECISION (reload, stale banner, swallow): the broadcast
 * reaches every pane synchronously before the promise settles.
 */

const drawCanvasHandler = WIRED_TOOLS.find((t) => t.op === 'draw_canvas')!.handler!

type Changed = { path: string; writerId?: string }

let folder: string
let canvasPath: string
/** Every mounted pane's `onCanvasChanged` subscription — the window broadcast fans out to all. */
const changedCbs = new Set<(p: Changed) => void>()
let readCalls = 0
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

/**
 * What chokidar's `change` handler would do after the write settled. When it
 * resolves every open pane has already made its decision (reload, stale banner or
 * swallow) — the broadcast is delivered synchronously — but a reload it started is
 * still reading and drawing: wait for what the test expects with `waitFor`.
 */
async function watcherSees(): Promise<void> {
  await notifyCanvasChanged(canvasPath)
  await flush()
}

async function fileLabels(): Promise<string[]> {
  const read = await readCanvasFile(canvasPath)
  if (!read.ok) throw new Error('canvas unreadable')
  return read.doc.nodes.map((n) => n.label ?? '').sort()
}

/** Drain the microtasks and Vue's flush: enough to see a SYNCHRONOUS decision in the DOM. */
async function flush(): Promise<void> {
  await flushPromises()
  await nextTick()
}

const shows = (root: Element, text: string): boolean => (root.textContent ?? '').includes(text)

/** Mount a pane and wait until it has loaded the file and drawn the seeded board. */
async function openPane(id: string): Promise<VueWrapper> {
  const w = mount(DiagramPane, {
    props: {
      pane: { id, type: 'canvas' as const, cwd: folder, ratio: 1, filePath: canvasPath },
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
  await waitFor(
    `${id} has loaded and drawn the board`,
    () =>
      w.element.querySelector('[data-testid="diagram-canvas-host"] svg') !== null &&
      shows(w.element, 'Renderer') &&
      shows(w.element, 'Main')
  )
  return w
}

async function operatorDrawsBox(root: Element, name: string, at = 600): Promise<void> {
  const tool = root.querySelector<HTMLButtonElement>('[data-testid="canvas-tool-rectangle"]')!
  tool.click()
  await waitFor('the rectangle tool is armed', () => tool.getAttribute('aria-pressed') === 'true')
  const svg = root.querySelector('[data-testid="diagram-canvas-host"] svg')!
  svg.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: at, clientY: 400 })
  )
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: at + 120, clientY: 470 }))
  window.dispatchEvent(new MouseEvent('mouseup', { clientX: at + 120, clientY: 470 }))
  const input = await renameInput(root)
  input.value = name
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await waitFor(
    `${name} is on the board and unsaved`,
    () => shows(root, name) && dirtyDot(root) && root.querySelector(RENAME) === null
  )
}

const RENAME = '[data-testid="diagram-rename-input"]'
async function renameInput(root: Element): Promise<HTMLInputElement> {
  await waitFor('the new box asks for its name', () => root.querySelector(RENAME) !== null)
  return root.querySelector<HTMLInputElement>(RENAME)!
}

/** Press Save and wait until the write landed (the pane clears its dirty dot only then). */
async function operatorSaves(root: Element): Promise<void> {
  root.querySelector<HTMLButtonElement>('[data-testid="diagram-save"]')!.click()
  await waitFor('the Save landed', () => !dirtyDot(root))
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
  for (const w of [...mountedPanes]) w.unmount()
  await fs.rm(folder, { recursive: true, force: true })
  delete (globalThis as Record<string, unknown>).__TEST_ROOT__
})

describe('BUG-209 — the same canvas open in two panes', () => {
  it('AC-1 — A saves: a clean pane B reloads A’s version and keeps its viewport', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    const zoomBefore = b.find('[data-testid="diagram-zoom"]').text()
    await operatorDrawsBox(a.element, 'FromA')
    const readsBefore = readCalls

    await operatorSaves(a.element)
    await watcherSees()
    await waitFor('B reloads A’s version', () => shows(b.element, 'FromA'))

    expect(readCalls).toBeGreaterThan(readsBefore)
    expect(b.element.textContent).toContain('FromA')
    expect(dirtyDot(b.element)).toBe(false)
    expect(staleBanner(b.element)).toBe(false)
    expect(b.find('[data-testid="diagram-zoom"]').text()).toBe(zoomBefore)
    a.unmount()
    b.unmount()
  })

  it('AC-1 — A saves: a dirty pane B shows the stale banner and keeps its unsaved work', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
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
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    await operatorDrawsBox(a.element, 'FromA')

    await operatorSaves(a.element)
    const readsBeforeEcho = readCalls
    await watcherSees()

    // Exactly one pane (B) re-read the file; A did not. Both decisions were made
    // synchronously by the broadcast, so the count is exact before B finishes drawing.
    expect(readCalls - readsBeforeEcho).toBe(1)
    await waitFor('B reloads A’s version', () => shows(b.element, 'FromA'))
    expect(staleBanner(a.element)).toBe(false)
    expect(dirtyDot(a.element)).toBe(false)
    a.unmount()
    b.unmount()
  })

  it('AC-3 — after hearing A’s Save, B’s next Save keeps A’s change', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    await watcherSees()
    await waitFor('B reloads A’s version', () => shows(b.element, 'FromA'))

    await operatorDrawsBox(b.element, 'FromB', 300)
    await operatorSaves(b.element)

    expect(await fileLabels()).toEqual(['FromA', 'FromB', 'Main', 'Renderer'])
    a.unmount()
    b.unmount()
  })

  it('AC-3 — the other way round: B saves first, and A’s next Save keeps B’s change', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    await operatorDrawsBox(b.element, 'FromB', 300)
    await operatorSaves(b.element)
    await watcherSees()
    await waitFor('A reloads B’s version', () => shows(a.element, 'FromB'))
    expect(a.element.textContent).toContain('FromB')

    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)

    expect(await fileLabels()).toEqual(['FromA', 'FromB', 'Main', 'Renderer'])
    a.unmount()
    b.unmount()
  })

  it('A saves and closes before the echo arrives: B still hears the Save', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    // The ref count drops 2 → 1 between the Save and the watcher's event.
    a.unmount()
    await flush()

    await watcherSees()
    await waitFor('B hears the Save', () => shows(b.element, 'FromA'))

    expect(b.element.textContent).toContain('FromA')
    await operatorDrawsBox(b.element, 'FromB', 300)
    await operatorSaves(b.element)
    expect(await fileLabels()).toEqual(['FromA', 'FromB', 'Main', 'Renderer'])
    b.unmount()
  })

  it('three panes: a Save in A reaches both B and C, and A stays quiet', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    const c = await openPane('pane-c')
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    const readsBefore = readCalls

    await watcherSees()

    expect(readCalls - readsBefore).toBe(2)
    await waitFor(
      'B and C reload A’s version',
      () => shows(b.element, 'FromA') && shows(c.element, 'FromA')
    )
    expect(b.element.textContent).toContain('FromA')
    expect(c.element.textContent).toContain('FromA')
    expect(staleBanner(a.element)).toBe(false)
    a.unmount()
    b.unmount()
    c.unmount()
  })

  it('an agent write with two panes open reaches both, even right after a pane Save', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    await watcherSees()
    // B's reload of A's Save must be done before the agent writes: two overlapping
    // reloads can finish out of order.
    await waitFor('B reloads A’s version', () => shows(b.element, 'FromA'))

    await agentDraws([{ op: 'add_node', shape: 'box', x: 520, y: 0, label: 'Agent' }])
    await watcherSees()
    await waitFor(
      'both panes show the agent’s box',
      () => shows(a.element, 'Agent') && shows(b.element, 'Agent')
    )

    expect(a.element.textContent).toContain('Agent')
    expect(b.element.textContent).toContain('Agent')
    a.unmount()
    b.unmount()
  })

  it('pinned: two Saves inside one settle window — the later Save wins', async () => {
    // The two-pane form of BUG-202's residual window. B saves before A's echo is
    // delivered (the watcher's ~100–250 ms settle time), so B never heard A's
    // Save and writes its own board over it. The fingerprint now names B, the one
    // merged event is tagged B, and a clean A reloads B's bytes: last writer wins.
    // Not closed here on purpose. What IS guaranteed is that both panes and the
    // file agree afterwards, with no banner and no unsaved edits left behind.
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    await operatorDrawsBox(a.element, 'FromA')
    await operatorDrawsBox(b.element, 'FromB', 300)
    await operatorSaves(a.element)
    await operatorSaves(b.element) // no event delivered in between
    const readsBefore = readCalls

    await watcherSees() // the one merged event

    expect(await fileLabels()).toEqual(['FromB', 'Main', 'Renderer'])
    expect(readCalls - readsBefore).toBe(1) // A reloads; B drops its own echo
    await waitFor(
      'A shows B’s board and not its own',
      () => shows(a.element, 'FromB') && !shows(a.element, 'FromA')
    )
    expect(a.element.textContent).toContain('FromB')
    expect(a.element.textContent).not.toContain('FromA')
    for (const root of [a.element, b.element]) {
      expect(staleBanner(root)).toBe(false)
      expect(dirtyDot(root)).toBe(false)
    }
    a.unmount()
    b.unmount()
  })

  it('the Save echo is swallowed outright once the other pane closes', async () => {
    const a = await openPane('pane-a')
    const b = await openPane('pane-b')
    b.unmount()
    await flush()
    await operatorDrawsBox(a.element, 'FromA')
    await operatorSaves(a.element)
    const readsBefore = readCalls

    await watcherSees()

    expect(readCalls).toBe(readsBefore)
    expect(staleBanner(a.element)).toBe(false)
    a.unmount()
  })
})
