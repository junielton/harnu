import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { launchApp } from './ci/fixtures/launch-app'
import { seedDialogWorld, seedLaunchEnv, type DialogSeed } from './ci/fixtures/dialog-seed'

/**
 * browser-tabs S-4 / AC-22, AC-40, AC-41 — the tab chords, the login shared across the tabs of a pane, and the Topbar
 * Browser button adding a tab.
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
      // The selection survived: the Topbar's Browser button only exists while a folder is selected, and
      // close-session clears the selection. (The sidebar row is not a safe witness: it collapses while the pane expands.)
      await expect(page.locator('[data-test="topbar-browser"]')).toBeVisible()
      await expect(page.getByTestId('browser-pane')).toBeVisible()
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
})
