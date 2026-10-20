import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { launchApp } from './fixtures/launch-app'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * T536 U1 + U2 + U3 — every canvas tool, driven with REAL mouse input in the BUILT app (spec
 * §9.3, items 1–9). The toolbar holds eight tools — Hand, Select, Rectangle, Diamond,
 * Ellipse, Arrow, Text, Eraser — and step 8 (U2) covers the two shape tools added after
 * U1: Ellipse (`o`/`4`) and Diamond (`d`/`3`). Step 9 (U3) sets every node style from the
 * properties panel and from the agent (`draw_canvas` `style`). Step 10 (U4) restacks nodes
 * from the panel's Layers group and from the agent (`zIndex`), reading the REAL paint order
 * from X6's DOM (`paintOrder()`), which jsdom cannot prove. Step 11 (U5) styles an arrow
 * from the panel and from the agent (`draw_canvas` `add_edge`/`update_edge` `style`),
 * selecting it with a real click on its drawn line.
 *
 * jsdom cannot reproduce X6's gesture handling: X6 listens for the release on `document`,
 * takes its own `mousedown` listener away until it sees one, and hit-tests through
 * `elementFromPoint`. So this spec launches the built app, opens a seeded board through the
 * same path an agent uses, and drives each tool with `page.mouse` (CDP input events).
 *
 * How the canvas is opened: the MCP control server is switched on through the preload
 * bridge, exactly as `app-boot-mcp.spec.ts` does. The spec then speaks MCP over the loopback
 * HTTP server with the token from `harnu.mcp.json`: `adopt_folder` pins a temp folder and
 * `draw_canvas` seeds four boxes into its default board. `draw_canvas` opens the canvas pane
 * HEADLESSLY (it never selects the folder, so it cannot steal focus); the spec then clicks
 * the folder's sidebar row so the pane is on screen.
 *
 * The folder also gets a one-line Claude transcript under `~/.claude/projects/` before
 * launch. That is the verb's real precondition, not a shortcut: `draw_canvas` resolves the
 * pane's folder from the folders that have session history (`scanFolders`), because the
 * caller is always a session running in one. A pinned folder with no session history gets
 * its board written but `opened: false`.
 *
 * Every result is read back from the saved `.harnucanvas.json` on disk after Ctrl+S, plus UI
 * state (`aria-pressed` on the toolbar, X6's DOM). The steps share one board and run in
 * order, each starting from what the previous one left.
 *
 * Requires `npm run build` first. NO `--remote-debugging-port`: on a built app that flips
 * `is.dev` and sends the renderer to the dev URL (docs/dev/live-verify-second-instance.md).
 *
 * The app is launched with the Wayland hints (`XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`) removed
 * from its environment. On a Wayland workstation Electron otherwise connects to the
 * session's `wayland-0` even under `xvfb-run`, so the window opens on the operator's real
 * desktop: the real pointer then lands in it (measured: clicks that zoomed the board and
 * erased nodes mid-run), and the hidden-until-ready window never paints, so it is never
 * shown. With the hints gone it renders on the X display `xvfb-run` provides, as in CI.
 */

const WIDTH = 1280
const HEIGHT = 800
/**
 * Waits that cover Electron START-UP (window shown, renderer mounted, fleet scanned, pane
 * loaded) get this, not the 5s default: a cold CI runner can take longer than that just to
 * boot. Gesture assertions keep the default — they react to input that was just sent.
 */
const STARTUP_TIMEOUT = 30_000

/** Seeded boxes in world units. No edges, so any A→B pair is free for the Arrow step. */
const SEED = [
  { key: 'A', x: 40, y: 40 },
  { key: 'B', x: 340, y: 40 },
  { key: 'C', x: 40, y: 280 },
  { key: 'D', x: 340, y: 280 }
] as const
const BOX_W = 132
const BOX_H = 52

interface SavedNode {
  id: string
  shape: string
  x: number
  y: number
  width?: number
  height?: number
  label?: string
  origin: string
  zIndex?: number
  props?: { style?: Record<string, unknown> } & Record<string, unknown>
}
interface SavedEdge {
  id: string
  source: string
  target: string
  origin: string
  zIndex?: number
  props?: { style?: Record<string, unknown> } & Record<string, unknown>
}
interface SavedDoc {
  nodes: SavedNode[]
  edges: SavedEdge[]
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}
const centre = (b: Box): { x: number; y: number } => ({
  x: b.x + b.width / 2,
  y: b.y + b.height / 2
})

// ── MCP over loopback HTTP ────────────────────────────────────────────────────

interface McpClient {
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>
  /** A call the server is expected to REFUSE: returns the refusal text (`CODE: message`). */
  callRefused(name: string, args: Record<string, unknown>): Promise<string>
}

/** A streamable-HTTP response is either plain JSON or an SSE stream of `data:` lines. */
function parseRpc(text: string): { result?: unknown; error?: unknown } {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed)
  const data = trimmed
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean)
  return JSON.parse(data[data.length - 1] ?? '{}')
}

async function connectMcp(port: number, token: string): Promise<McpClient> {
  const url = `http://127.0.0.1:${port}/mcp`
  const base = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`
  }
  const init = await fetch(url, {
    method: 'POST',
    headers: base,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-canvas-tools', version: '0' }
      }
    })
  })
  expect(init.ok, `MCP initialize answered ${init.status}`).toBe(true)
  await init.text()
  const sid = init.headers.get('mcp-session-id')
  const headers: Record<string, string> = sid ? { ...base, 'mcp-session-id': sid } : base
  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }).then((r) => r.text())

  let id = 1
  const send = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{ isError: boolean; text: string }> => {
    id += 1
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
    const rpc = parseRpc(await res.text()) as {
      result?: { isError?: boolean; content?: { type: string; text: string }[] }
      error?: unknown
    }
    expect(rpc.error, `${name} RPC error`).toBeUndefined()
    return { isError: !!rpc.result?.isError, text: rpc.result?.content?.[0]?.text ?? '' }
  }
  return {
    async call(name, args) {
      const { isError, text } = await send(name, args)
      expect(isError, `${name} refused: ${text}`).toBe(false)
      return JSON.parse(text) as Record<string, unknown>
    },
    async callRefused(name, args) {
      const { isError, text } = await send(name, args)
      expect(isError, `${name} was expected to be refused, answered: ${text}`).toBe(true)
      return text
    }
  }
}

// ── The spec ──────────────────────────────────────────────────────────────────

let app: ElectronApplication
let page: Page
let userData: string
let folder: string
let boardPath: string
let mcp: McpClient
const idOf: Record<string, string> = {}

test.describe('canvas tools in the built app (T536 U1 + U2 + U3 + U4, spec §9.3)', () => {
  test.beforeAll(async () => {
    userData = mkdtempSync(join(tmpdir(), 'harnu-ci-canvas-'))
    folder = mkdtempSync(join(tmpdir(), 'harnu-ci-board-'))
    seedTranscript(userData, folder)
    app = await launchApp({ userData })
    await app
      .context()
      .tracing.start({ screenshots: true, snapshots: true })
      .catch(() => {})
    page = await app.firstWindow()
  })

  test.afterAll(async () => {
    await app?.close()
    if (userData) rmSync(userData, { recursive: true, force: true })
    if (folder) rmSync(folder, { recursive: true, force: true })
  })

  test('every U1 tool does what its gesture contract says', async () => {
    const testInfo = test.info()
    let failed = false
    try {
      await openSeededBoard()

      const pane = page.getByTestId('diagram-pane')
      const body = pane.getByTestId('diagram-canvas-host')
      const tool = (id: string): Locator => pane.getByTestId(`canvas-tool-${id}`)
      const nodes = pane.locator('g.x6-node')
      const edges = pane.locator('g.x6-edge')
      const selected = pane.locator('.x6-widget-selection-box')
      const rename = pane.getByTestId('diagram-rename-input')

      await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')
      await expect(nodes).toHaveCount(4)
      const zoom = await viewScale()

      /**
       * A point of the pane body, as fractions of its size, that must be EMPTY board: no
       * cell, no overlay, no toolbar under it. Checked rather than assumed, so a layout
       * change fails here with a clear message instead of as a puzzling gesture result.
       */
      const blankAt = async (fx: number, fy: number): Promise<{ x: number; y: number }> => {
        const r = (await body.boundingBox()) as Box
        const p = { x: r.x + r.width * fx, y: r.y + r.height * fy }
        const what = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y)
          if (!el?.closest('[data-testid="diagram-canvas-host"]')) return 'outside the board'
          return el.closest('g.x6-cell') ? 'a cell' : 'blank'
        }, p)
        expect(what, `(${fx}, ${fy}) of the pane is empty board`).toBe('blank')
        return p
      }

      /**
       * The top-left corner (screen px) of a `w`×`h` px rectangle of the pane body that is
       * EMPTY board all over — sampled on a 4×4 lattice, so no cell, overlay, toast or toolbar
       * is under it. Scanned top-left first, away from the bottom-right where toasts stack.
       * Used where a step needs real room (the board is small in a narrow pane).
       */
      const blankRect = async (w: number, h: number): Promise<{ x: number; y: number }> => {
        const r = (await body.boundingBox()) as Box
        const found = await page.evaluate(
          ({ r, w, h }) => {
            const isBlank = (x: number, y: number): boolean => {
              const el = document.elementFromPoint(x, y)
              return (
                !!el?.closest('[data-testid="diagram-canvas-host"]') && !el.closest('g.x6-cell')
              )
            }
            for (let y = r.y + 4; y + h < r.y + r.height; y += 8) {
              for (let x = r.x + 4; x + w < r.x + r.width; x += 8) {
                let ok = true
                for (let i = 0; i <= 3 && ok; i++)
                  for (let j = 0; j <= 3 && ok; j++) ok = isBlank(x + (w * i) / 3, y + (h * j) / 3)
                if (ok) return { x, y }
              }
            }
            return null
          },
          { r, w, h }
        )
        expect(found, `a ${w}x${h} px empty patch of the board`).not.toBeNull()
        return found as { x: number; y: number }
      }

      await test.step('1. Select: click blank creates nothing; drag blank rubberbands', async () => {
        const blank = await blankAt(0.85, 0.85)
        await page.mouse.click(blank.x, blank.y)
        await expectSavedBoardIsSeed('after a Select click on blank')
        await expect(nodes).toHaveCount(4)
        await expect(rename).toHaveCount(0)
        await expect(pane.getByTestId('diagram-dirty-dot')).toHaveCount(0)

        // A band from above-left of A to below-right of B, starting and ending on blank.
        const a = await nodeBox(idOf.A)
        const b = await nodeBox(idOf.B)
        const from = { x: a.x - 12 * zoom, y: a.y - 12 * zoom }
        const to = { x: b.x + b.width + 12 * zoom, y: b.y + b.height + 12 * zoom }
        await drag(from, to)
        await expectSavedBoardIsSeed('after a Select drag on blank')
        await expect(nodes).toHaveCount(4)
        await expect(selected).toHaveCount(2)
        expect(await selectedIds()).toEqual([idOf.A, idOf.B].sort())
        await expect(pane.getByTestId('diagram-dirty-dot')).toHaveCount(0)
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        await page.mouse.click(blank.x, blank.y)
        await expect(selected).toHaveCount(0)

        // The first Save of a board nobody has restacked: a plain move of D, Save, and the
        // file gains no `zIndex` at all (the file is as hand-written as the agent left it).
        const seedD = readFileSync(boardPath, 'utf8')
        const d = centre(await nodeBox(idOf.D))
        await drag(d, { x: d.x + 24, y: d.y })
        const movedDoc = await saveAndRead()
        expect(readFileSync(boardPath, 'utf8'), 'the move was saved').not.toBe(seedD)
        expect(
          movedDoc.nodes.filter((n) => 'zIndex' in n).map((n) => n.id),
          'the first Save of an untouched board writes no zIndex'
        ).toEqual([])
      })

      await test.step('2. Rectangle: drag draws a box of that size, then back to Select', async () => {
        await tool('rectangle').click()
        await expect(tool('rectangle')).toHaveAttribute('aria-pressed', 'true')
        const from = await blankAt(0.1, 0.72)
        const to = await blankAt(0.6, 0.84)
        await drag(from, to)
        await expect(rename).toBeFocused()
        await rename.fill('Drawn')
        await rename.press('Enter')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')
        await expect(nodes).toHaveCount(5)

        const doc = await saveAndRead()
        const drawn = doc.nodes.filter((n) => n.label === 'Drawn')
        expect(drawn).toHaveLength(1)
        expect(drawn[0]).toMatchObject({ shape: 'box', origin: 'operator' })
        expect(Math.abs((drawn[0].width ?? 0) - (to.x - from.x) / zoom)).toBeLessThanOrEqual(2)
        expect(Math.abs((drawn[0].height ?? 0) - (to.y - from.y) / zoom)).toBeLessThanOrEqual(2)
      })

      await test.step('3. Arrow: A→B makes one edge; A→blank makes none', async () => {
        await tool('arrow').click()
        await expect(tool('arrow')).toHaveAttribute('aria-pressed', 'true')
        await drag(centre(await nodeBox(idOf.A)), centre(await nodeBox(idOf.B)))
        await expect(edges).toHaveCount(1)
        await expect(pane.getByTestId('diagram-arrow-preview')).toHaveCount(0)
        // A created edge is a creation: the tool drops back to Select (not locked).
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        await tool('arrow').click()
        await expect(tool('arrow')).toHaveAttribute('aria-pressed', 'true')
        await drag(centre(await nodeBox(idOf.A)), await blankAt(0.85, 0.3))
        await expect(pane.getByTestId('diagram-arrow-preview')).toHaveCount(0)
        await expect(edges).toHaveCount(1)
        // Nothing was created, so the tool stays armed.
        await expect(tool('arrow')).toHaveAttribute('aria-pressed', 'true')

        const doc = await saveAndRead()
        expect(doc.edges).toHaveLength(1)
        expect(doc.edges[0]).toMatchObject({
          source: idOf.A,
          target: idOf.B,
          origin: 'operator'
        })
        await page.keyboard.press('Escape')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')
      })

      await test.step('4. Text: a click places a text node with the typed label', async () => {
        await tool('text').click()
        await expect(tool('text')).toHaveAttribute('aria-pressed', 'true')
        const at = await blankAt(0.5, 0.93)
        await page.mouse.click(at.x, at.y)
        await expect(rename).toBeFocused()
        await rename.fill('hello')
        await rename.press('Enter')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        const doc = await saveAndRead()
        const texts = doc.nodes.filter((n) => n.shape === 'text')
        expect(texts).toHaveLength(1)
        expect(texts[0]).toMatchObject({ label: 'hello', origin: 'operator' })
      })

      await test.step('5. Eraser: a stroke across C and D removes both; Ctrl+Z restores them', async () => {
        await tool('eraser').click()
        await expect(tool('eraser')).toHaveAttribute('aria-pressed', 'true')
        const c = await nodeBox(idOf.C)
        const d = await nodeBox(idOf.D)
        const y = c.y + c.height / 2
        await drag({ x: c.x - 16 * zoom, y }, { x: d.x + d.width + 16 * zoom, y })
        await expect(nodes).toHaveCount(6 - 2)
        let doc = await saveAndRead()
        expect(doc.nodes.map((n) => n.id)).not.toContain(idOf.C)
        expect(doc.nodes.map((n) => n.id)).not.toContain(idOf.D)
        expect(doc.nodes.map((n) => n.id)).toContain(idOf.A)
        expect(doc.nodes.map((n) => n.id)).toContain(idOf.B)

        await page.keyboard.press('Control+z')
        await expect(nodes).toHaveCount(6)
        doc = await saveAndRead()
        expect(doc.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([idOf.C, idOf.D]))
        expect(doc.nodes).toHaveLength(6)
        await page.keyboard.press('v')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')
      })

      await test.step('6. Hand: a drag moves the viewport and no node', async () => {
        await tool('hand').click()
        await expect(tool('hand')).toHaveAttribute('aria-pressed', 'true')
        const onDisk = readFileSync(boardPath, 'utf8')
        await expect(nodes).toHaveCount(6)
        await expectStableGeometry(idOf.A)
        const before = await allNodeBoxes()
        // Start ON node A: in Hand that pans too, and must not move the node.
        const start = centre(await nodeBox(idOf.A))
        const delta = { x: 80, y: -40 }
        await drag(start, { x: start.x + delta.x, y: start.y + delta.y })

        const after = await allNodeBoxes()
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
        for (const id of Object.keys(before)) {
          expect(Math.abs(after[id].x - before[id].x - delta.x), `${id} x`).toBeLessThanOrEqual(1)
          expect(Math.abs(after[id].y - before[id].y - delta.y), `${id} y`).toBeLessThanOrEqual(1)
        }
        // No model edit at all: nothing dirty, the file untouched.
        await expect(pane.getByTestId('diagram-dirty-dot')).toHaveCount(0)
        expect(readFileSync(boardPath, 'utf8')).toBe(onDisk)
        await expect(tool('hand')).toHaveAttribute('aria-pressed', 'true')
      })

      await test.step('7. Shortcuts: r + drag draws a box; Escape returns to Select', async () => {
        await page.keyboard.press('r')
        await expect(tool('rectangle')).toHaveAttribute('aria-pressed', 'true')
        const from = await blankAt(0.1, 0.24)
        const to = await blankAt(0.55, 0.32)
        await drag(from, to)
        await expect(rename).toBeFocused()
        await rename.fill('Keyed')
        await rename.press('Enter')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        await page.keyboard.press('r')
        await expect(tool('rectangle')).toHaveAttribute('aria-pressed', 'true')
        await page.keyboard.press('Escape')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        const doc = await saveAndRead()
        const keyed = doc.nodes.filter((n) => n.label === 'Keyed')
        expect(keyed).toHaveLength(1)
        expect(keyed[0]).toMatchObject({ shape: 'box', origin: 'operator' })
        expect(Math.abs((keyed[0].width ?? 0) - (to.x - from.x) / zoom)).toBeLessThanOrEqual(2)
        expect(Math.abs((keyed[0].height ?? 0) - (to.y - from.y) / zoom)).toBeLessThanOrEqual(2)
      })

      await test.step('8. Diamond and Ellipse: the toolbar order, o + drag, d + click, Ctrl+D', async () => {
        const order = await pane
          .getByTestId('canvas-toolbar')
          .locator('button[data-testid^="canvas-tool-"]:not([data-testid="canvas-tool-lock"])')
          .evaluateAll((els) =>
            els.map((el) => (el.getAttribute('data-testid') ?? '').replace('canvas-tool-', ''))
          )
        expect(order).toEqual([
          'hand',
          'select',
          'rectangle',
          'diamond',
          'ellipse',
          'arrow',
          'text',
          'eraser'
        ])

        // The number-row shortcuts reach the new tools too; Escape goes back to Select.
        await page.keyboard.press('3')
        await expect(tool('diamond')).toHaveAttribute('aria-pressed', 'true')
        await page.keyboard.press('4')
        await expect(tool('ellipse')).toHaveAttribute('aria-pressed', 'true')
        await page.keyboard.press('Escape')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        // Ellipse: the `o` key, then a drag draws an ellipse of the dragged footprint.
        await page.keyboard.press('o')
        await expect(tool('ellipse')).toHaveAttribute('aria-pressed', 'true')
        const patch = await blankRect(90, 50)
        const from = { x: patch.x, y: patch.y }
        const to = { x: patch.x + 90, y: patch.y + 50 }
        await drag(from, to)
        await expect(rename).toBeFocused()
        await rename.fill('Oval')
        await rename.press('Enter')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        let doc = await saveAndRead()
        const ovals = doc.nodes.filter((n) => n.label === 'Oval')
        expect(ovals).toHaveLength(1)
        expect(ovals[0]).toMatchObject({ shape: 'ellipse', origin: 'operator' })
        expect(Math.abs((ovals[0].width ?? 0) - (to.x - from.x) / zoom)).toBeLessThanOrEqual(2)
        expect(Math.abs((ovals[0].height ?? 0) - (to.y - from.y) / zoom)).toBeLessThanOrEqual(2)

        // Diamond: the `d` key, then a click places the default 132x80 centred on the click.
        const before = doc.nodes.length
        await page.keyboard.press('d')
        await expect(tool('diamond')).toHaveAttribute('aria-pressed', 'true')
        const room = await blankRect(132 * zoom + 8, 80 * zoom + 8)
        const at = { x: room.x + (132 * zoom + 8) / 2, y: room.y + (80 * zoom + 8) / 2 }
        await page.mouse.click(at.x, at.y)
        await expect(rename).toBeFocused()
        await rename.fill('Choice')
        await rename.press('Enter')
        // A created shape drops the tool back to Select (Lock is off).
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        doc = await saveAndRead()
        expect(doc.nodes).toHaveLength(before + 1)
        const choices = doc.nodes.filter((n) => n.label === 'Choice')
        expect(choices).toHaveLength(1)
        expect(choices[0]).toMatchObject({ shape: 'diamond', origin: 'operator' })
        expect(choices[0].width).toBe(132)
        expect(choices[0].height).toBe(80)
        // Centred on the click: its rendered box is centred on the click point, to within
        // one grid step (placement snaps).
        const placed = centre(await nodeBox(choices[0].id))
        expect(Math.abs(placed.x - at.x), 'diamond centred on the click (x)').toBeLessThanOrEqual(
          10 * zoom
        )
        expect(Math.abs(placed.y - at.y), 'diamond centred on the click (y)').toBeLessThanOrEqual(
          10 * zoom
        )

        // Ctrl+D with a diamond selected duplicates it, and the copy is the operator's.
        await page.mouse.click(placed.x, placed.y)
        expect(await selectedIds()).toEqual([choices[0].id])
        await page.keyboard.press('Control+d')
        doc = await saveAndRead()
        const diamonds = doc.nodes.filter((n) => n.shape === 'diamond')
        expect(diamonds).toHaveLength(2)
        expect(diamonds.every((n) => n.origin === 'operator')).toBe(true)
        expect(diamonds.every((n) => n.width === 132 && n.height === 80)).toBe(true)
      })

      await test.step('9. Node styles: panel and agent', async () => {
        const undo = pane.getByTestId('diagram-undo')
        const redo = pane.getByTestId('diagram-redo')
        const option = (key: string, value: string): Locator =>
          pane.getByTestId(`canvas-prop-${key}-${value}`)
        /** Click a panel option, opening the collapsed panel first when it is folded away. */
        const pick = async (key: string, value: string): Promise<void> => {
          const opt = option(key, value)
          if (!(await opt.isVisible())) await pane.getByTestId('canvas-properties-toggle').click()
          await opt.click()
          await expect(opt).toHaveAttribute('aria-checked', 'true')
        }
        const transformHandles = pane.locator('.x6-widget-transform-resize')
        const handlesFor = async (id: string, when: string): Promise<void> => {
          await expect(selected, `${when}: one selection box`).toHaveCount(1)
          // Polled: a count of one can still be the previous pick's box for a frame, and
          // the handles are drawn a beat after the box. The exact selection is still the
          // only value that passes.
          await expect.poll(selectedIds, `${when}: the box is A's`).toEqual([id])
          await expect(
            pane.locator('.x6-widget-transform'),
            `${when}: the transform widget`
          ).toHaveCount(1)
          await expect
            .poll(() => transformHandles.count(), `${when}: resize handles`)
            .toBeGreaterThan(0)
        }

        // Select A (Select is the armed tool) and pick every style once. The previous step
        // left a diamond selected and the panel may be re-laying the pane out, so aim at A
        // only once its box has stopped moving.
        await expectStableGeometry(idOf.A)
        await page.mouse.click(...xy(centre(await nodeBox(idOf.A))))
        await handlesFor(idOf.A, 'A selected, before any pick')
        const handleCount = await transformHandles.count()
        // The body's own size, not the stroke attribute: a repaint that dropped the shape's
        // sizing attrs collapsed the box to 0×0 while every style attribute still read right.
        const bodyBefore = await bodySize(idOf.A)
        expect(bodyBefore.width, "A's body has a width").toBeGreaterThan(0)
        expect(bodyBefore.height, "A's body has a height").toBeGreaterThan(0)
        const sameBody = async (when: string): Promise<void> => {
          expect(await bodySize(idOf.A), `A's body size ${when}`).toEqual(bodyBefore)
        }

        await pick('tone', 'green')
        await handlesFor(idOf.A, 'after the first pick')
        await sameBody('after the first pick')
        expect(await transformHandles.count(), 'resize handle count after a pick').toBe(handleCount)
        for (const [key, value] of [
          ['stroke', 'dashed'],
          ['strokeWidth', 'bold'],
          ['corners', 'sharp'],
          ['fontSize', 'l'],
          ['align', 'left'],
          ['opacity', '50']
        ] as const) {
          await pick(key, value)
          await sameBody(`after picking ${key} ${value}`)
        }
        await handlesFor(idOf.A, 'after the last pick')

        const styleOf = (doc: SavedDoc, id: string): Record<string, unknown> | undefined =>
          doc.nodes.find((n) => n.id === id)?.props?.style
        const all = {
          tone: 'green',
          stroke: 'dashed',
          strokeWidth: 'bold',
          corners: 'sharp',
          fontSize: 'l',
          align: 'left',
          opacity: 50
        }
        let doc = await saveAndRead()
        expect(styleOf(doc, idOf.A)).toEqual(all)
        const rootVar = (name: string): Promise<string> =>
          page.evaluate(
            (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
            name
          )
        const green = await rootVar('--color-green')
        expect(green, '--color-green resolves').not.toBe('')
        expect(await bodyStroke(idOf.A), "A's outline is the green tone").toBe(green)

        // One undo step per panel change: a single Ctrl+Z takes back only the last pick.
        await page.keyboard.press('Control+z')
        await handlesFor(idOf.A, 'after Ctrl+Z')
        await sameBody('after Ctrl+Z')
        doc = await saveAndRead()
        const { opacity: _taken, ...withoutOpacity } = all
        expect(styleOf(doc, idOf.A)).toEqual(withoutOpacity)
        await page.keyboard.press('Control+y')
        await handlesFor(idOf.A, 'after Ctrl+Y')
        await page.keyboard.press('Control+z')
        await handlesFor(idOf.A, 'after Ctrl+Z again')
        doc = await saveAndRead()
        expect(styleOf(doc, idOf.A)).toEqual(withoutOpacity)

        // The agent: `style` merges per key; null removes one. The file is the contract.
        const red = await rootVar('--color-red')
        await mcp.call('draw_canvas', {
          folder,
          ops: [{ op: 'update_node', id: idOf.A, style: { tone: 'red', stroke: null } }]
        })
        const { stroke: _removed, ...agentStyle } = withoutOpacity
        doc = JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
        expect(styleOf(doc, idOf.A)).toEqual({ ...agentStyle, tone: 'red' })

        // Close the pane and reopen the board (as `open_file` does for an agent): the
        // reopened pane loads the file and draws A's outline in the new tone.
        await page.getByRole('button', { name: 'Close helper', exact: true }).click()
        await expect(pane).toHaveCount(0)
        await mcp.call('open_file', { folder, path: boardPath })
        await expect(pane).toBeVisible({ timeout: STARTUP_TIMEOUT })
        await expect(nodes).not.toHaveCount(0, { timeout: STARTUP_TIMEOUT })
        await expectStableGeometry(idOf.A)
        await expect.poll(() => bodyStroke(idOf.A)).toBe(red)

        // Hovering is not an edit: a reopened board has a fresh history, and sweeping the
        // pointer across every node adds no undo step and dirties nothing.
        await expect(undo, 'a reopened board has nothing to undo').toBeDisabled()
        for (const n of await allNodeBoxes().then(Object.values)) {
          await page.mouse.move(...xy(centre(n)), { steps: 4 })
        }
        await expect(undo, 'hovering added no undo step').toBeDisabled()
        await expect(redo).toBeDisabled()
        await expect(pane.getByTestId('diagram-dirty-dot')).toHaveCount(0)

        // A style the shape does not take, or one in the wrong place, is refused and
        // changes nothing on disk.
        const before = readFileSync(boardPath, 'utf8')
        const refusal = await mcp.callRefused('draw_canvas', {
          folder,
          ops: [
            {
              op: 'add_node',
              shape: 'box',
              x: 700,
              y: 40,
              props: { style: { tone: 'red' } }
            }
          ]
        })
        expect(refusal).toMatch(/^BAD_PROPS/)
        expect(readFileSync(boardPath, 'utf8'), 'a refused call leaves the file alone').toBe(before)

        // A mixed selection offers only the groups every selected node takes.
        const text = doc.nodes.find((n) => n.shape === 'text')
        expect(text, 'the text node from step 4').toBeDefined()
        await page.mouse.click(...xy(centre(await nodeBox(idOf.A))))
        await expect(selected).toHaveCount(1)
        const textAt = centre(await nodeBox((text as SavedNode).id))
        await page.keyboard.down('Shift')
        await page.mouse.click(...xy(textAt))
        await page.keyboard.up('Shift')
        await expect(selected).toHaveCount(2)
        if (!(await option('tone', 'green').isVisible()))
          await pane.getByTestId('canvas-properties-toggle').click()
        await expect(option('tone', 'green')).toBeVisible()
        await expect(option('corners', 'sharp')).toHaveCount(0)
        await expect(option('stroke', 'dashed')).toHaveCount(0)
      })

      await test.step('10. Layers: panel and agent', async () => {
        const L = { L1: '', L2: '', L3: '' }
        const ids = (): string[] => [L.L1, L.L2, L.L3]
        /** The three boxes' relative paint order, bottom → top. */
        const stack = async (): Promise<string[]> =>
          (await paintOrder()).filter((id) => ids().includes(id))
        const layer = async (move: 'back' | 'backward' | 'forward' | 'front'): Promise<void> => {
          const btn = pane.getByTestId(`canvas-layer-${move}`)
          if (!(await btn.isVisible())) await pane.getByTestId('canvas-properties-toggle').click()
          await btn.click()
        }
        /** A screen point `dx`,`dy` world units inside a node's box (zoom from its width). */
        const inside = async (id: string, dx: number, dy: number, w = BOX_W) => {
          const b = await nodeBox(id)
          const s = b.width / w
          return { x: b.x + dx * s, y: b.y + dy * s, s }
        }
        /** The centre of the screen rectangle the three boxes share. */
        const sharedCentre = async (): Promise<{ x: number; y: number }> => {
          const boxes = await Promise.all(ids().map((id) => nodeBox(id)))
          const left = Math.max(...boxes.map((b) => b.x))
          const top = Math.max(...boxes.map((b) => b.y))
          const right = Math.min(...boxes.map((b) => b.x + b.width))
          const bottom = Math.min(...boxes.map((b) => b.y + b.height))
          expect(right - left, 'the three boxes share some width').toBeGreaterThan(4)
          expect(bottom - top, 'the three boxes share some height').toBeGreaterThan(4)
          return { x: (left + right) / 2, y: (top + bottom) / 2 }
        }

        /**
         * Mark every node element now on screen, then wait until none of the marked ones is
         * left: X6 drew every node view again. A DOM-order assertion that was already true
         * before a redraw proves nothing, so each redraw below is awaited this way first.
         */
        const tagNodes = (): Promise<void> =>
          page.evaluate(() =>
            document
              .querySelectorAll('[data-testid="diagram-pane"] g.x6-node')
              .forEach((el) => el.setAttribute('data-pre-redraw', '1'))
          )
        const expectRedrawn = async (what: string): Promise<void> => {
          await expect(
            pane.locator('g.x6-node[data-pre-redraw]'),
            `${what}: every node view was drawn again`
          ).toHaveCount(0, { timeout: STARTUP_TIMEOUT })
        }
        /** Switch the app theme through its store, and wait for the pane to redraw. */
        const setTheme = async (name: string): Promise<void> => {
          await tagNodes()
          await page.evaluate((t) => {
            const app = (
              document.querySelector('#app') as unknown as {
                __vue_app__: {
                  config: { globalProperties: { $pinia: { _s: Map<string, unknown> } } }
                }
              }
            ).__vue_app__
            ;(app.config.globalProperties.$pinia._s.get('theme') as { set(t: string): void }).set(t)
          }, name)
          await expect(page.locator('html')).toHaveAttribute('data-theme', name)
          await expectRedrawn(`theme ${name}`)
        }
        /**
         * Show the board as it is on disk, through the operator's Reload button. (Live
         * propagation of an agent's write into a clean open pane is a known pre-existing gap:
         * `writeCanvasFile` arms the pane's one-shot self-write suppression, so the watcher
         * swallows the change. It is not covered here.) The viewport is kept by a reload, so
         * Fit brings the new boxes into view.
         */
        const reloadBoard = async (): Promise<SavedDoc> => {
          const onDisk = JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
          await tagNodes()
          await pane.getByRole('button', { name: 'Reload canvas', exact: true }).click()
          await expectRedrawn('Reload')
          await expect(nodes).toHaveCount(onDisk.nodes.length, { timeout: STARTUP_TIMEOUT })
          await pane.getByRole('button', { name: 'Fit to view', exact: true }).click()
          await expectStableGeometry(onDisk.nodes[0].id)
          return onDisk
        }

        // The earlier steps' Saves ranked every node (operator-drawn nodes broke file order),
        // so the agent first clears those ranks with `zIndex: null`, then adds three boxes
        // overlapping in that order: a board whose file holds no rank at all.
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')
        const ranked = (JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc).nodes.filter(
          (n) => typeof n.zIndex === 'number'
        )
        expect(ranked.length, 'the earlier steps left ranked nodes to clear').toBeGreaterThan(0)
        await mcp.call('draw_canvas', {
          folder,
          ops: [
            ...ranked.map((n) => ({ op: 'update_node', id: n.id, zIndex: null })),
            {
              op: 'add_node',
              shape: 'box',
              x: 700,
              y: 500,
              width: BOX_W,
              height: BOX_H,
              label: 'L1'
            },
            {
              op: 'add_node',
              shape: 'box',
              x: 716,
              y: 506,
              width: BOX_W,
              height: BOX_H,
              label: 'L2'
            },
            {
              op: 'add_node',
              shape: 'box',
              x: 732,
              y: 512,
              width: BOX_W,
              height: BOX_H,
              label: 'L3'
            }
          ]
        })
        let doc = JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
        expect(
          doc.nodes.filter((n) => 'zIndex' in n),
          'the agent left no zIndex in the file'
        ).toEqual([])
        for (const n of doc.nodes)
          if (n.label !== undefined && Object.hasOwn(L, n.label))
            L[n.label as keyof typeof L] = n.id
        expect(ids().every(Boolean), 'the agent added L1, L2 and L3').toBe(true)
        doc = await reloadBoard()
        await expectStableGeometry(L.L3)
        expect(
          (await paintOrder()).slice(-3),
          'a fresh load paints L1, L2, L3 in file order'
        ).toEqual(ids())

        // A move of L3 alone never writes a zIndex: an unranked file stays unranked.
        const l3 = await inside(L.L3, BOX_W - 6, BOX_H / 2)
        await drag(l3, { x: l3.x + 20 * l3.s, y: l3.y })
        doc = await saveAndRead()
        expect(
          doc.nodes.filter((n) => 'zIndex' in n).map((n) => n.id),
          'no node carries a zIndex after a plain move'
        ).toEqual([])

        // L1 to the front from the panel: it paints last, and a click on the overlap hits it.
        const l1 = await inside(L.L1, 8, BOX_H / 2)
        await page.mouse.click(l1.x, l1.y)
        await expect.poll(selectedIds, 'L1 is selected').toEqual([L.L1])
        await layer('front')
        await expect.poll(async () => (await paintOrder()).at(-1)).toBe(L.L1)
        const blank = await blankRect(10, 10)
        await page.mouse.click(blank.x + 5, blank.y + 5)
        await expect.poll(selectedIds, 'nothing selected after a blank click').toEqual([])
        const overlap = await sharedCentre()
        await page.mouse.click(overlap.x, overlap.y)
        await expect
          .poll(selectedIds, 'a click on the overlap selects the front box')
          .toEqual([L.L1])

        // A theme switch redraws the pane: L1 stays in front, and the history survives it.
        await setTheme('light')
        await expect.poll(async () => (await paintOrder()).at(-1)).toBe(L.L1)
        await page.mouse.click(overlap.x, overlap.y)
        await page.keyboard.press('Control+z')
        await expect.poll(stack, 'Ctrl+Z puts L1 back under L2 and L3').toEqual(ids())
        await page.keyboard.press('Control+y')
        await expect.poll(stack, 'Ctrl+Y puts L1 on top again').toEqual([L.L2, L.L3, L.L1])
        await setTheme('default-dark')

        // Saving writes a rank on every node, L1 the highest, and none on an edge.
        doc = await saveAndRead()
        expect(
          doc.nodes.every((n) => typeof n.zIndex === 'number'),
          'every node has a zIndex'
        ).toBe(true)
        const l1Rank = doc.nodes.find((n) => n.id === L.L1)?.zIndex ?? 0
        expect(
          doc.nodes.filter((n) => n.id !== L.L1).every((n) => (n.zIndex ?? 0) < l1Rank),
          "L1's rank is strictly above every other node's"
        ).toBe(true)
        const rankOf = (d: SavedDoc, id: string): number =>
          d.nodes.find((n) => n.id === id)?.zIndex ?? Number.NaN
        const ranksAlong = async (d: SavedDoc): Promise<number[]> =>
          (await paintOrder()).map((id) => rankOf(d, id))
        const strictlyUp = (r: number[]): boolean => r.every((v, i) => i === 0 || v > r[i - 1])
        expect(strictlyUp(await ranksAlong(doc)), 'saved ranks rise along the paint order').toBe(
          true
        )
        expect(doc.edges.length, 'the board still has its edge').toBeGreaterThan(0)
        expect(
          doc.edges.some((e) => 'zIndex' in e),
          'no edge has a zIndex'
        ).toBe(false)

        // A box drawn over the stack is the newest: it paints last, saved and reloaded.
        const union = await Promise.all(ids().map((id) => nodeBox(id)))
        const from = {
          x: Math.min(...union.map((b) => b.x)) - 12,
          y: Math.min(...union.map((b) => b.y)) - 12
        }
        const to = await sharedCentre()
        await page.keyboard.press('r')
        await expect(tool('rectangle')).toHaveAttribute('aria-pressed', 'true')
        await drag(from, to)
        await expect(rename).toBeFocused()
        await rename.fill('N')
        await rename.press('Enter')
        doc = await saveAndRead()
        const drawn = doc.nodes.filter((n) => n.label === 'N')
        expect(drawn).toHaveLength(1)
        await expect.poll(async () => (await paintOrder()).at(-1)).toBe(drawn[0].id)
        expect(
          doc.nodes
            .filter((n) => n.id !== drawn[0].id)
            .every((n) => (n.zIndex ?? 0) < (drawn[0].zIndex ?? 0)),
          "N's saved rank is strictly above every other node's"
        ).toBe(true)
        await reloadBoard()
        await expect
          .poll(async () => (await paintOrder()).at(-1), 'N paints last after a reload')
          .toBe(drawn[0].id)
        expect(
          strictlyUp(await ranksAlong(doc)),
          'saved ranks rise along the reloaded paint order'
        ).toBe(true)

        // The agent: zIndex below 1 is refused and changes nothing; a high one restacks.
        const onDisk = readFileSync(boardPath, 'utf8')
        const refused = await mcp.callRefused('draw_canvas', {
          folder,
          ops: [{ op: 'update_node', id: L.L2, zIndex: 0 }]
        })
        expect(refused).toMatch(/^BAD_ARGS/)
        expect(readFileSync(boardPath, 'utf8'), 'a refused zIndex leaves the file alone').toBe(
          onDisk
        )
        await expect(pane.getByTestId('diagram-dirty-dot')).toHaveCount(0)
        await mcp.call('draw_canvas', {
          folder,
          ops: [{ op: 'update_node', id: L.L2, zIndex: 999 }]
        })
        expect(
          (JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc).nodes.find((n) => n.id === L.L2)
            ?.zIndex
        ).toBe(999)
        await reloadBoard()
        await expect
          .poll(async () => (await paintOrder()).at(-1), 'zIndex 999 paints L2 last')
          .toBe(L.L2)

        // A mockup card takes Layers but none of the style groups.
        await mcp.call('draw_canvas', {
          folder,
          ops: [
            {
              op: 'add_node',
              shape: 'harnu/mockup-card',
              x: 400,
              y: 600,
              props: { title: 'Layers card' }
            }
          ]
        })
        doc = JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
        const card = doc.nodes.find((n) => n.shape === 'harnu/mockup-card')
        expect(card, 'the mockup card was added').toBeDefined()
        await reloadBoard()
        await expectStableGeometry((card as SavedNode).id)
        await page.mouse.click(...xy(centre(await nodeBox((card as SavedNode).id))))
        await expect.poll(selectedIds).toEqual([(card as SavedNode).id])
        if (!(await pane.getByTestId('canvas-layers').isVisible()))
          await pane.getByTestId('canvas-properties-toggle').click()
        await expect(pane.getByTestId('canvas-layers')).toBeVisible()
        await expect(pane.locator('[data-testid^="canvas-prop-group-"]')).toHaveCount(0)
      })

      await test.step('11. Arrow styles: panel and agent', async () => {
        const undo = pane.getByTestId('diagram-undo')
        const option = (key: string, value: string): Locator =>
          pane.getByTestId(`canvas-prop-${key}-${value}`)
        /** Click a panel option, opening the collapsed panel first when it is folded away. */
        const pick = async (key: string, value: string): Promise<void> => {
          const opt = option(key, value)
          if (!(await opt.isVisible())) await pane.getByTestId('canvas-properties-toggle').click()
          await opt.click()
          await expect(opt).toHaveAttribute('aria-checked', 'true')
        }
        const groupKeys = async (): Promise<string[]> =>
          (
            await pane
              .locator('[data-testid^="canvas-prop-group-"]')
              .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''))
          )
            .map((t) => t.replace('canvas-prop-group-', ''))
            .sort()
        const rootVar = (name: string): Promise<string> =>
          page.evaluate(
            (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
            name
          )
        const styleOf = (doc: SavedDoc, id: string): Record<string, unknown> | undefined =>
          doc.edges.find((e) => e.id === id)?.props?.style
        const onDisk = (): SavedDoc => JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
        /**
         * Show the board as it is on disk, through the operator's Reload button (an agent's
         * write does not reach a clean open pane live; see step 10), and wait for every
         * edge view to be drawn again.
         */
        const reloadBoard = async (): Promise<void> => {
          await page.evaluate(() =>
            document
              .querySelectorAll('[data-testid="diagram-pane"] g.x6-edge')
              .forEach((el) => el.setAttribute('data-pre-redraw', '1'))
          )
          await pane.getByRole('button', { name: 'Reload canvas', exact: true }).click()
          await expect(
            pane.locator('g.x6-edge[data-pre-redraw]'),
            'Reload: every edge view was drawn again'
          ).toHaveCount(0, { timeout: STARTUP_TIMEOUT })
          await expect(edges).toHaveCount(onDisk().edges.length, { timeout: STARTUP_TIMEOUT })
        }
        /** Select the arrow with a real click on the middle of its drawn line. */
        const clickEdge = async (id: string): Promise<void> => {
          const at = await edgeMidpoint(id)
          await page.mouse.click(at.x, at.y)
          await expect.poll(selectedIds, 'the arrow is selected').toEqual([id])
        }

        const warning = await rootVar('--color-warning')
        const red = await rootVar('--color-red')
        expect(warning, '--color-warning resolves').not.toBe('')
        expect(red, '--color-red resolves').not.toBe('')
        await expect(tool('select')).toHaveAttribute('aria-pressed', 'true')

        // The agent draws an amber arrow C → D (A → B holds the operator's arrow from
        // step 3, and a second one there would lie over it).
        await mcp.call('draw_canvas', {
          folder,
          ops: [
            {
              op: 'add_edge',
              source: idOf.C,
              target: idOf.D,
              style: { tone: 'amber' }
            }
          ]
        })
        const seededEdge = onDisk().edges.find((e) => e.source === idOf.C && e.target === idOf.D)
        expect(seededEdge, 'the agent added C → D').toBeDefined()
        const edgeId = (seededEdge as SavedEdge).id
        expect(styleOf(onDisk(), edgeId)).toEqual({ tone: 'amber' })
        await reloadBoard()
        await expect.poll(() => edgeStroke(edgeId), 'the reloaded arrow is amber').toBe(warning)
        expect(await edgeDash(edgeId), 'a styled-by-tone arrow is solid').toBeNull()

        // A click on the middle of the arrow selects it, and the panel offers an arrow's
        // groups only: tone and stroke, no Layers, and no accent tone.
        await clickEdge(edgeId)
        if (!(await option('tone', 'amber').isVisible()))
          await pane.getByTestId('canvas-properties-toggle').click()
        await expect(pane.getByTestId('canvas-prop-group-tone')).toBeVisible()
        await expect(pane.getByTestId('canvas-prop-group-stroke')).toBeVisible()
        expect(await groupKeys(), 'an arrow takes tone and stroke only').toEqual(['stroke', 'tone'])
        await expect(pane.getByTestId('canvas-layers')).toHaveCount(0)
        await expect(option('tone', 'accent')).toHaveCount(0)
        await expect(option('tone', 'amber')).toHaveAttribute('aria-checked', 'true')

        // Two panel picks: dotted, then red. The file holds both; the line is drawn.
        await pick('stroke', 'dotted')
        await pick('tone', 'red')
        let doc = await saveAndRead()
        expect(styleOf(doc, edgeId)).toEqual({ tone: 'red', stroke: 'dotted' })
        expect(await edgePathD(edgeId), 'the arrow still has a path').not.toBe('')
        expect(await edgeStroke(edgeId), "the arrow's line is the red tone").toBe(red)
        expect(await edgeDash(edgeId), "the arrow's line is dotted").toBe('2 3')

        // One undo step per pick: a single Ctrl+Z takes back the tone only.
        await page.keyboard.press('Control+z')
        doc = await saveAndRead()
        expect(styleOf(doc, edgeId)).toEqual({ tone: 'amber', stroke: 'dotted' })
        // The line is repainted from the model after the undo, not in the same tick.
        await expect
          .poll(() => edgeStroke(edgeId), 'Ctrl+Z gave the line its amber tone back')
          .toBe(warning)
        expect(await edgeDash(edgeId), 'the undo kept the dotted stroke').toBe('2 3')
        expect(await edgePathD(edgeId), 'the arrow still has a path after Ctrl+Z').not.toBe('')

        // The agent clears the stroke with the pane clean: the file keeps the tone alone,
        // and the reloaded pane draws the arrow solid.
        await expect(pane.getByTestId('diagram-dirty-dot')).toHaveCount(0)
        await mcp.call('draw_canvas', {
          folder,
          ops: [{ op: 'update_edge', id: edgeId, style: { stroke: null } }]
        })
        expect(styleOf(onDisk(), edgeId)).toEqual({ tone: 'amber' })
        await reloadBoard()
        await expect.poll(() => edgeStroke(edgeId), 'the reloaded arrow is amber').toBe(warning)
        expect(await edgeDash(edgeId), 'the reloaded arrow is solid').toBeNull()
        await expect(undo, 'a reloaded board has nothing to undo').toBeDisabled()

        // `accent` is not an arrow tone: the verb refuses it and the file is untouched.
        const before = readFileSync(boardPath, 'utf8')
        const refusal = await mcp.callRefused('draw_canvas', {
          folder,
          ops: [{ op: 'update_edge', id: edgeId, style: { tone: 'accent' } }]
        })
        expect(refusal).toMatch(/^BAD_PROPS/)
        expect(readFileSync(boardPath, 'utf8'), 'a refused call leaves the file alone').toBe(before)

        // A mixed selection (the arrow and box A) offers only what both take: tone and
        // stroke, plus Layers.
        await clickEdge(edgeId)
        const a = centre(await nodeBox(idOf.A))
        await page.keyboard.down('Shift')
        await page.mouse.click(a.x, a.y)
        await page.keyboard.up('Shift')
        await expect
          .poll(selectedIds, 'the arrow and A are selected')
          .toEqual([edgeId, idOf.A].sort())
        if (!(await pane.getByTestId('canvas-layers').isVisible()))
          await pane.getByTestId('canvas-properties-toggle').click()
        await expect(pane.getByTestId('canvas-layers')).toBeVisible()
        expect(await groupKeys(), 'a mixed selection offers tone and stroke').toEqual([
          'stroke',
          'tone'
        ])
        await expect(option('tone', 'accent')).toHaveCount(0)
      })
    } catch (err) {
      failed = true
      await page?.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => {})
      throw err
    } finally {
      await app
        .context()
        .tracing.stop(failed ? { path: testInfo.outputPath('trace.zip') } : undefined)
        .catch(() => {})
    }
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait for the window, seed the board through MCP, and bring its pane on screen. */
async function openSeededBoard(): Promise<void> {
  // The window is created hidden and shows itself on `ready-to-show`. A hidden window
  // produces no frames, and Playwright's actionability checks wait on frames, so nothing
  // is touched before the app has shown it at its default 1280×800.
  await expect
    .poll(
      () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
      { timeout: STARTUP_TIMEOUT }
    )
    .toBe(true)

  // `firstWindow()` can hand back the page before `loadFile` commits (an `about:blank` has a
  // visible body too), and a `page.evaluate` then dies with the navigation. The app's own UI
  // is the real "loaded" signal. It is also the bridge's: the renderer tells main it may
  // actuate (`renderer:ready`, which `draw_canvas` needs to open its pane) at the end of
  // `sessions.init()`, synchronously after the folder model loads — so the seeded folder's
  // sidebar row being on screen proves the command bridge is live. Calling the verb any
  // earlier answers `opened: false`.
  const folderRow = page.getByText(basename(folder), { exact: true }).first()
  await expect(folderRow).toBeVisible({ timeout: STARTUP_TIMEOUT })
  await expect
    .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]), {
      timeout: STARTUP_TIMEOUT
    })
    .toEqual([WIDTH, HEIGHT])
  await expect
    .poll(
      () => page.evaluate(() => new Promise<boolean>((r) => requestAnimationFrame(() => r(true)))),
      { timeout: STARTUP_TIMEOUT }
    )
    .toBe(true)

  const status = (await page.evaluate(() =>
    (
      window as unknown as { api: { mcpSetEnabled(v: boolean): Promise<unknown> } }
    ).api.mcpSetEnabled(true)
  )) as { enabled: boolean; port: number }
  expect(status.enabled).toBe(true)
  const cfg = JSON.parse(readFileSync(join(userData, 'harnu.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { headers?: Record<string, string> }>
  }
  const token = String(cfg.mcpServers.harnu?.headers?.Authorization ?? '').replace(/^Bearer /, '')
  expect(token).not.toBe('')
  mcp = await connectMcp(status.port, token)

  await mcp.call('adopt_folder', { folder })
  // The fleet model scans `~/.claude/projects` asynchronously after boot; until it has, the
  // seeded folder is not a session folder yet and `draw_canvas` could not open its pane.
  await expect
    .poll(async () => JSON.stringify(await mcp.call('get_fleet', {})), {
      timeout: STARTUP_TIMEOUT
    })
    .toContain(`"folderAlias":"${basename(folder)}"`)
  const drawn = await mcp.call('draw_canvas', {
    folder,
    ops: SEED.map((s) => ({
      op: 'add_node',
      shape: 'box',
      x: s.x,
      y: s.y,
      width: BOX_W,
      height: BOX_H,
      label: s.key
    }))
  })
  expect(drawn.ok).toBe(true)
  expect(drawn.nodeCount).toBe(SEED.length)
  expect(drawn.opened, 'draw_canvas opened the pane').toBe(true)
  boardPath = String(drawn.path)
  const seeded = JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
  for (const n of seeded.nodes) idOf[n.label ?? ''] = n.id
  expect(Object.keys(idOf).sort()).toEqual(SEED.map((s) => s.key).sort())

  // `draw_canvas` opened the pane in the folder's stack without selecting the folder;
  // selecting it (a real click on its sidebar row) puts the stack on screen.
  await folderRow.click()
  const pane = page.getByTestId('diagram-pane')
  await expect(pane).toBeVisible({ timeout: STARTUP_TIMEOUT })
  await expect(pane.getByTestId('canvas-toolbar')).toBeVisible({ timeout: STARTUP_TIMEOUT })
  await expect(pane.locator('g.x6-node')).toHaveCount(SEED.length, { timeout: STARTUP_TIMEOUT })
  await dismissToasts()
  // The pane settles (first-open fit) before any geometry is measured.
  await expectStableGeometry(idOf.A)
}

/**
 * Close every toast on screen. A fresh profile gets the sticky first-run "Harnu mod"
 * disclosure (`timeoutMs: 0`) in the bottom-right corner, and in CI's layout it lies over
 * the lower right of the canvas pane, so a gesture aimed there would land on the toast.
 * Whether it overlaps depends on the machine's layout, which is why this is not a wait for
 * one specific toast: it clears whatever is showing.
 */
async function dismissToasts(): Promise<void> {
  const dismiss = page
    .locator('[role="region"][aria-live="polite"]')
    .getByRole('button', { name: 'Dismiss', exact: true })
  while ((await dismiss.count()) > 0) await dismiss.first().click()
  await expect(dismiss).toHaveCount(0)
}

/**
 * One interactive CLI session whose cwd is `folder`, in the shape `claude` writes, so the
 * folder is a known session folder (the caller of `draw_canvas` always runs in one).
 */
function seedTranscript(home: string, cwd: string): void {
  const dir = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const sessionId = randomUUID()
  const line = {
    type: 'user',
    entrypoint: 'cli',
    cwd,
    sessionId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'Draw the board.' }
  }
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify(line)}\n`)
}

/** A real, stepped left-button drag: X6 needs the moves in between to see a drag at all. */
async function drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}

/** X6's current zoom: the screen scale of its viewport group (world unit → CSS px). */
async function viewScale(): Promise<number> {
  const scale = await page.evaluate(() => {
    const vp = document.querySelector(
      '[data-testid="diagram-pane"] .x6-graph-svg-viewport'
    ) as SVGGraphicsElement | null
    return vp?.getCTM()?.a ?? 0
  })
  expect(scale, 'the X6 viewport has a scale').toBeGreaterThan(0)
  return scale
}

async function nodeBox(id: string): Promise<Box> {
  const box = await page
    .getByTestId('diagram-pane')
    .locator(`g.x6-node[data-cell-id="${id}"]`)
    .boundingBox()
  expect(box, `node ${id} on screen`).not.toBeNull()
  return box as Box
}

async function allNodeBoxes(): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {}
    document.querySelectorAll('[data-testid="diagram-pane"] g.x6-node').forEach((el) => {
      const r = el.getBoundingClientRect()
      out[el.getAttribute('data-cell-id') ?? ''] = {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height
      }
    })
    return out
  })
}

/** The `data-cell-id` of every node in DOM order: the real paint order, bottom → top. */
async function paintOrder(): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="diagram-pane"] g.x6-node')).map(
      (el) => el.getAttribute('data-cell-id') ?? ''
    )
  )
}

async function selectedIds(): Promise<string[]> {
  const ids = await page
    .getByTestId('diagram-pane')
    .locator('.x6-widget-selection-box')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-cell-id') ?? ''))
  return ids.sort()
}

/** Poll until a node's screen box stops changing (window re-layout, first-open fit). */
async function expectStableGeometry(id: string): Promise<void> {
  // X6 time-slices view rendering, so `any node is on screen` does not mean THIS one is:
  // wait for its view before measuring it (a bare `nodeBox` throws while it is missing).
  await expect(
    page.getByTestId('diagram-pane').locator(`g.x6-node[data-cell-id="${id}"]`),
    `node ${id} is rendered`
  ).toHaveCount(1)
  let last = ''
  await expect
    .poll(async () => {
      const now = JSON.stringify(await nodeBox(id))
      const same = now === last
      last = now
      return same
    })
    .toBe(true)
}

/**
 * Prove FROM DISK that the board still holds exactly the seeded nodes and no edge. Save is
 * a no-op on a clean board (`save()` returns early unless dirty), so this presses Ctrl+S
 * anyway: a gesture that wrongly created a node made the board dirty, the press writes that
 * node, and the read below fails naming the step. A clean board leaves the file as seeded.
 */
async function expectSavedBoardIsSeed(when: string): Promise<void> {
  await page.keyboard.press('Control+s')
  await expect(page.getByTestId('diagram-pane').getByTestId('diagram-dirty-dot')).toHaveCount(0)
  const doc = JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
  expect(doc.nodes.map((n) => n.id).sort(), `${when}: saved nodes are exactly the seed`).toEqual(
    SEED.map((s) => idOf[s.key]).sort()
  )
  expect(doc.edges, `${when}: saved edges`).toEqual([])
}

/** Ctrl+S, wait for the dirty dot to clear, and read the board back from disk. */
async function saveAndRead(): Promise<SavedDoc> {
  const pane = page.getByTestId('diagram-pane')
  await expect(pane.getByTestId('diagram-dirty-dot')).toBeVisible()
  await page.keyboard.press('Control+s')
  await expect(pane.getByTestId('diagram-dirty-dot')).toHaveCount(0)
  return JSON.parse(readFileSync(boardPath, 'utf8')) as SavedDoc
}

/** A point as spread-able `[x, y]` arguments for `page.mouse`. */
function xy(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y]
}

/**
 * The on-screen size of a node's body element (its first SVG child, as in `bodyStroke`),
 * rounded to the pixel. The body's own box ignores the stroke width, so a style change that
 * leaves the geometry alone leaves this unchanged, and a body collapsed to nothing reads 0×0.
 */
async function bodySize(id: string): Promise<{ width: number; height: number }> {
  return page.evaluate((cellId) => {
    const el = document.querySelector(
      `[data-testid="diagram-pane"] g.x6-node[data-cell-id="${cellId}"] > :first-child`
    )
    const r = el?.getBoundingClientRect()
    return { width: Math.round(r?.width ?? 0), height: Math.round(r?.height ?? 0) }
  }, id)
}

/**
 * The arrow's visible line: the `line` selector's `<path>`, the one that carries the
 * arrowhead (`marker-end`). X6 also draws a wide transparent `wrap` path for hit-testing,
 * which has no marker; the `lines` group around them is a `<g>`.
 */
const EDGE_LINE = 'path[marker-end]'

/** The `stroke` attribute of an arrow's visible line, as X6 painted it. */
async function edgeStroke(id: string): Promise<string | null> {
  return page.evaluate(
    ([cellId, sel]) =>
      document
        .querySelector(`[data-testid="diagram-pane"] g.x6-edge[data-cell-id="${cellId}"] ${sel}`)
        ?.getAttribute('stroke') ?? null,
    [id, EDGE_LINE]
  )
}

/** The `stroke-dasharray` attribute of an arrow's visible line; null when it is solid. */
async function edgeDash(id: string): Promise<string | null> {
  return page.evaluate(
    ([cellId, sel]) =>
      document
        .querySelector(`[data-testid="diagram-pane"] g.x6-edge[data-cell-id="${cellId}"] ${sel}`)
        ?.getAttribute('stroke-dasharray') ?? null,
    [id, EDGE_LINE]
  )
}

/** The `d` attribute of an arrow's visible line; the empty string when it has no path. */
async function edgePathD(id: string): Promise<string> {
  return page.evaluate(
    ([cellId, sel]) =>
      document
        .querySelector(`[data-testid="diagram-pane"] g.x6-edge[data-cell-id="${cellId}"] ${sel}`)
        ?.getAttribute('d') ?? '',
    [id, EDGE_LINE]
  )
}

/**
 * The screen point half way along an arrow's drawn line, measured on the path itself
 * (not its bounding box, which is off the line for a bent route). Checked rather than
 * assumed to be this arrow's: the topmost element there must belong to the edge, so a
 * layout change that put a node or the panel over it fails here with a clear message.
 */
async function edgeMidpoint(id: string): Promise<{ x: number; y: number }> {
  const hit = await page.evaluate(
    ([cellId, sel]) => {
      const path = document.querySelector(
        `[data-testid="diagram-pane"] g.x6-edge[data-cell-id="${cellId}"] ${sel}`
      ) as SVGGeometryElement | null
      const ctm = path?.getScreenCTM()
      if (!path || !ctm) return null
      const p = path.getPointAtLength(path.getTotalLength() / 2)
      const x = ctm.a * p.x + ctm.c * p.y + ctm.e
      const y = ctm.b * p.x + ctm.d * p.y + ctm.f
      const top = document.elementFromPoint(x, y)
      return { x, y, owner: top?.closest('g.x6-cell')?.getAttribute('data-cell-id') ?? null }
    },
    [id, EDGE_LINE]
  )
  expect(hit, `arrow ${id} has a drawn line`).not.toBeNull()
  expect(hit?.owner, `the arrow's midpoint is on the arrow, not under something else`).toBe(id)
  return { x: (hit as { x: number }).x, y: (hit as { y: number }).y }
}

/**
 * The `stroke` attribute of a node's body element, as X6 painted it. The body is the
 * node's first SVG child (`<rect>`, `<ellipse>` or `<polygon>`) — X6 leaves no selector
 * attribute in the DOM — and the label `<text>` and the ports come after it.
 */
async function bodyStroke(id: string): Promise<string | null> {
  return page.evaluate(
    (cellId) =>
      document
        .querySelector(
          `[data-testid="diagram-pane"] g.x6-node[data-cell-id="${cellId}"] > :first-child`
        )
        ?.getAttribute('stroke') ?? null,
    id
  )
}
