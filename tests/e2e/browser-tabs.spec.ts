import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AddressInfo } from 'node:net'
import { launchApp } from './ci/fixtures/launch-app'
import { seedDialogWorld, seedLaunchEnv, type DialogSeed } from './ci/fixtures/dialog-seed'

/**
 * browser-tabs S-4 / AC-22, AC-40, AC-41 — the tab chords, the login shared across the tabs of a pane, and the Topbar
 * Browser button adding a tab. S-7 / AC-34 — every child of the pane header on one vertical centre line.
 *
 * Launches the BUILT app on a throwaway `userData` (the `ci` fixtures: it never touches the operator's running
 * Harnu), serves two tiny pages from a local HTTP server (one sets a cookie, the other records the cookie it was
 * sent) and drives the real pane. Requires `npm run build` first.
 *
 * Run: `npx playwright test --project=smoke tests/e2e/browser-tabs.spec.ts`
 */

let seed: DialogSeed
let app: ElectronApplication
let page: Page
let server: Server
let base = ''
/** `path → Cookie header` of every request the server saw, in order. */
const seen: Array<{ path: string; cookie: string }> = []

const tabs = () => page.getByTestId('browser-tab')
const address = () => page.getByTestId('browser-address')

async function openBrowserPane(): Promise<void> {
  await page.locator(`[data-folder-path="${seed.repo}"]`).first().click()
  await page.getByRole('button', { name: 'Browser', exact: true }).first().click()
  await expect(address()).toBeVisible()
  // The helper stack is narrow: expand the pane to the window so every tab fits in the strip.
  await page.locator('[data-test="pane-expand"]').first().click()
}

async function go(url: string): Promise<void> {
  await address().fill(url)
  await address().press('Enter')
}

async function closePanes(): Promise<void> {
  const closes = page.getByTestId('browser-close')
  while ((await closes.count()) > 0) await closes.first().click()
}

test.describe('browser tabs (browser-tabs S-4)', () => {
  test.beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ path: req.url ?? '', cookie: req.headers.cookie ?? '' })
      if (req.url === '/login') {
        res.setHeader('Set-Cookie', 'sid=abc123; Path=/; HttpOnly')
        res.setHeader('Content-Type', 'text/html')
        res.end('<title>Login</title><body>signed in</body>')
        return
      }
      res.setHeader('Content-Type', 'text/html')
      res.end('<title>Page</title><body>page</body>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    seed = seedDialogWorld({ worktrees: 1 })
    app = await launchApp({ userData: seed.userData, env: seedLaunchEnv(seed) })
    page = await app.firstWindow()
    await expect(page.locator('body')).toBeVisible()
    await page.waitForTimeout(1500)
  })

  test.afterAll(async () => {
    await app?.close()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    if (seed) rmSync(seed.root, { recursive: true, force: true })
  })

  test.afterEach(async () => {
    await closePanes()
  })

  test('keys', async () => {
    await openBrowserPane()
    await go(`${base}/one`)
    await expect(tabs()).toHaveCount(0) // one tab: no strip

    await test.step('Ctrl+T from the pane chrome adds a tab and focuses its address field', async () => {
      await address().press('Control+t')
      await expect(page.getByTestId('browser-tab-strip')).toBeVisible()
      await expect(tabs()).toHaveCount(2)
      await expect(address()).toBeFocused()
      // Full mode: each tab is drawn at the layout's 168px (not at the width of its text), and + follows the last
      // tab. Polled: the expanded pane is still settling for a moment.
      await expect
        .poll(async () => {
          const boxes = await tabs().evaluateAll((els) =>
            els.map((el) => {
              const b = el.getBoundingClientRect()
              return { left: b.left, width: b.width }
            })
          )
          const plus = await page.getByTestId('browser-tab-new').boundingBox()
          const last = boxes[boxes.length - 1]!
          return Math.max(
            ...boxes.map((b) => Math.abs(b.width - 168)),
            Math.abs(plus!.x - (last.left + last.width + 4))
          )
        })
        .toBeLessThanOrEqual(1)
    })

    await test.step('Ctrl+Tab and Ctrl+Shift+Tab move between tabs', async () => {
      const active = () => page.locator('[data-testid="browser-tab"][data-active="true"]')
      const second = await tabs().nth(1).getAttribute('data-tab-id')
      await expect(active()).toHaveAttribute('data-tab-id', second!)
      await address().press('Control+Tab')
      await expect(active()).not.toHaveAttribute('data-tab-id', second!)
      await address().press('Control+Shift+Tab')
      await expect(active()).toHaveAttribute('data-tab-id', second!)
    })

    await test.step('Ctrl+W closes the tab, not the session', async () => {
      await address().press('Control+w')
      await expect(tabs()).toHaveCount(0) // back to one tab
      await expect(page.getByTestId('browser-pane')).toBeVisible()
      // The folder is still the one in view: close-session would have cleared it.
      await expect(page.locator(`[data-folder-path="${seed.repo}"]`).first()).toBeVisible()
    })

    await test.step('the chords reach main before the page when the page has the focus', async () => {
      const before = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length)
      await app.evaluate(({ webContents }, origin) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(origin))
        if (!guest) throw new Error('no guest page')
        guest.focus()
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
        guest.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
      }, base)
      await expect(page.getByTestId('browser-tab-strip')).toBeVisible()
      await expect(tabs()).toHaveCount(2)
      expect(before).toBeGreaterThan(0)
      // Ctrl+W from the page closes the pane's active tab (the app's close-session never sees it). Take the keyboard
      // out of the pane chrome first, so only the page's chord path can do it.
      await address().evaluate((el: HTMLInputElement) => el.blur())
      await app.evaluate(({ webContents }, origin) => {
        const guest = webContents.getAllWebContents().find((wc) => wc.getURL().startsWith(origin))
        if (!guest) throw new Error('no guest page')
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] })
        guest.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] })
      }, base)
      await expect(tabs()).toHaveCount(0)
    })
  })

  test('login shared across tabs', async () => {
    seen.length = 0
    await openBrowserPane()
    await go(`${base}/login`)
    await expect.poll(() => seen.some((s) => s.path === '/login')).toBe(true)

    await address().press('Control+t')
    await expect(tabs()).toHaveCount(2)
    await go(`${base}/whoami`)
    await expect.poll(() => seen.some((s) => s.path === '/whoami')).toBe(true)
    // Another tab of the same operator pane sent the cookie the first tab's page set.
    expect(seen.find((s) => s.path === '/whoami')!.cookie).toContain('sid=abc123')

    await test.step('the agent partition never holds it', async () => {
      const cookies = await app.evaluate(async ({ session }, origin) => {
        const operator = await session
          .fromPartition('persist:harnu-browser')
          .cookies.get({ url: origin })
        const agent = await session
          .fromPartition('persist:harnu-browser-agent')
          .cookies.get({ url: origin })
        return { operator: operator.map((c) => c.name), agent: agent.map((c) => c.name) }
      }, base)
      expect(cookies.operator).toContain('sid')
      expect(cookies.agent).not.toContain('sid')
    })
  })

  test('topbar focuses new tab', async () => {
    await openBrowserPane()
    await go(`${base}/home`)
    await expect(tabs()).toHaveCount(0)
    // Take the focus off the field, then click the Topbar button again.
    await address().evaluate((el: HTMLInputElement) => el.blur())
    await page.getByRole('button', { name: 'Browser', exact: true }).first().click()
    await expect(tabs()).toHaveCount(2)
    await expect(page.getByTestId('browser-pane')).toHaveCount(1) // a tab, not one more pane
    await expect(address()).toBeFocused()
  })
  test('one centre line', async () => {
    /** The vertical centre of every child of the pane header (and of the strip's own children), in px. */
    const centres = (): Promise<Array<{ what: string; centre: number }>> =>
      page.evaluate(() => {
        const header = document.querySelector('[data-dsqa-part="header"]')
        if (!header) throw new Error('no pane header')
        const out: Array<{ what: string; centre: number }> = []
        const visit = (el: Element, what: string): void => {
          const r = el.getBoundingClientRect()
          const pos = getComputedStyle(el).position
          // Screen-reader-only nodes (1px, absolute) are not part of the visual row.
          if (r.width === 0 || r.height === 0 || pos === 'absolute') return
          out.push({ what, centre: r.top + r.height / 2 })
        }
        for (const child of Array.from(header.children)) {
          const id = child.getAttribute('data-testid') ?? child.tagName.toLowerCase()
          visit(child, id)
          if (child.getAttribute('data-testid') === 'browser-tab-strip') {
            const list = child.querySelector('[data-testid="browser-tab-list"]')
            for (const tab of Array.from(list?.children ?? [])) visit(tab, 'tab')
            for (const el of Array.from(child.children)) {
              if (el !== list) visit(el, el.getAttribute('data-testid') ?? el.tagName.toLowerCase())
            }
          }
          // A chip wrapper holds the icon and its buttons as children of its own.
          if (
            child.getAttribute('data-testid') === 'agent-connection-chip' ||
            child.getAttribute('data-testid') === 'browser-chip'
          ) {
            for (const el of Array.from(child.children)) {
              visit(el, el.getAttribute('data-testid') ?? el.tagName.toLowerCase())
            }
          }
        }
        return out
      })
    const expectOneLine = async (state: string): Promise<void> => {
      const rows = await centres()
      expect(rows.length, `${state}: header children measured`).toBeGreaterThan(3)
      const spread = Math.max(...rows.map((r) => r.centre)) - Math.min(...rows.map((r) => r.centre))
      expect(spread, `${state}: ${JSON.stringify(rows)}`).toBeLessThanOrEqual(0.5)
    }

    await test.step('single', async () => {
      await openBrowserPane()
      await go(`${base}/one`)
      await expect(tabs()).toHaveCount(0)
      await expectOneLine('single')
    })

    await test.step('tabs', async () => {
      await address().press('Control+t')
      await expect(tabs()).toHaveCount(2)
      await expectOneLine('tabs')
    })

    await test.step('overflow', async () => {
      for (let i = 0; i < 4; i++) await address().press('Control+t')
      await expect(tabs().first()).toBeVisible()
      // Out of the expanded view, back in the narrow stack: six tabs no longer fit the strip.
      await page.locator('[data-test="pane-expand"]').first().click()
      await expect(page.getByTestId('browser-tab-more')).toBeVisible()
      await expectOneLine('overflow')
    })

    await test.step('agent', async () => {
      await closePanes()
      // Enable the control server and let an "agent" open a pane in the folder: its header carries the icon.
      await page.evaluate(() =>
        (
          window as unknown as { api: { mcpSetEnabled(v: boolean): Promise<unknown> } }
        ).api.mcpSetEnabled(true)
      )
      const cfg = JSON.parse(readFileSync(join(seed.userData, 'harnu.mcp.json'), 'utf8')) as {
        mcpServers: Record<string, { url: string; headers?: Record<string, string> }>
      }
      const harnu = Object.values(cfg.mcpServers)[0]!
      const client = new Client({ name: 'browser-tabs-e2e', version: '0.0.0' })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(harnu.url), {
          requestInit: { headers: harnu.headers ?? {} }
        })
      )
      try {
        const opened = await client.callTool({
          name: 'browser_open',
          arguments: { folder: seed.repo, url: `${base}/agent` }
        })
        expect(opened.isError).not.toBe(true)
        await expect(page.getByTestId('agent-icon')).toBeVisible()
        await expectOneLine('agent')
      } finally {
        await client.close()
      }
    })
  })
})
