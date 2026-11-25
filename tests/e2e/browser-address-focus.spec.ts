import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { rmSync } from 'node:fs'
import { launchApp } from './ci/fixtures/launch-app'
import { seedDialogWorld, seedLaunchEnv, type DialogSeed } from './ci/fixtures/dialog-seed'

/**
 * browser-tabs S-1 / AC-1 — the browser pane's address field shows ONE focus border.
 *
 * The field draws its own `--accent-line` border on focus. The global
 * `:focus-visible:not(.no-default-ring)` rule (main.css) also paints a 2px outline, which showed as
 * a second box around the first. `.no-default-ring` opts the field out.
 *
 * This spec launches the BUILT app on a throwaway `userData` (the `ci` fixtures, so it never touches
 * the operator's running Harnu), opens a browser pane from the Topbar, moves focus to the address
 * field with the keyboard, and reads the computed style. Requires `npm run build` first.
 *
 * Run: `npx playwright test --project=smoke tests/e2e/browser-address-focus.spec.ts`
 */

let seed: DialogSeed
let app: ElectronApplication
let page: Page

test.describe('browser address field focus (browser-tabs S-1)', () => {
  test.beforeAll(async () => {
    seed = seedDialogWorld({ worktrees: 1 })
    app = await launchApp({ userData: seed.userData, env: seedLaunchEnv(seed) })
    page = await app.firstWindow()
    await expect(page.locator('body')).toBeVisible()
    // The first-run toast is not part of the pane.
    await page.waitForTimeout(1500)
  })

  test.afterAll(async () => {
    await app?.close()
    if (seed) rmSync(seed.root, { recursive: true, force: true })
  })

  test('one border', async () => {
    // Open a browser pane in the seeded folder, the way an operator does.
    await page
      .locator(`[data-tree-folder]:has([data-folder-path="${seed.repo}"]) [data-folder-head]`)
      .click()
    await page.getByRole('button', { name: 'Browser', exact: true }).first().click()

    const address = page.getByTestId('browser-address')
    await expect(address).toBeVisible()

    // Take the focus off the field (the pane focuses it on open), then come back to it with the
    // keyboard: focus the control right after it in the header and press Shift+Tab, so
    // `:focus-visible` matches for the keyboard reason, not the programmatic one.
    await address.evaluate((el: HTMLInputElement) => el.blur())
    await expect(address).not.toBeFocused()
    await page.getByRole('button', { name: 'Device mode' }).first().focus()
    await page.keyboard.press('Shift+Tab')
    await expect(address).toBeFocused()

    await test.step('outline-style is none', async () => {
      const outline = await address.evaluate((el) => getComputedStyle(el).outlineStyle)
      expect(outline).toBe('none')
    })

    await test.step('border colour is --accent-line', async () => {
      const { border, accentLine } = await address.evaluate((el) => {
        // Resolve the token through a probe so the comparison is colour-space exact.
        const probe = document.createElement('i')
        probe.style.borderTop = '1px solid var(--color-accent-line)'
        document.body.appendChild(probe)
        const accentLine = getComputedStyle(probe).borderTopColor
        probe.remove()
        return { border: getComputedStyle(el).borderTopColor, accentLine }
      })
      expect(border).toBe(accentLine)
    })
  })
})
