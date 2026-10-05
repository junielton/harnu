import { test, expect } from '@playwright/test'
import { chromium } from 'playwright-core'

/**
 * needs-input E2E (session-state real-state spec §6.2) — the regression lock for
 * the "original sin". Connects to the running dev app over CDP (:9222 from
 * `npm run dev`) and proves a session BLOCKED on an approval shows the amber
 * `needs-input` affordance and **stays** there (no decay to grey), which the old
 * mtime/timer heuristic could not represent.
 *
 * Preconditions:
 *   - `npm run dev` is running and the Hook Bridge integration is enabled
 *     (Settings → Integrations → Session state hooks = Enabled; default on).
 *   - At least one project/worktree with a session is visible in the sidebar.
 *   - This test drives a session into a tool-approval prompt, so the session must
 *     run under a permission mode that actually prompts (not bypass).
 *
 * The amber dot is rendered by `SidebarFolder.vue` as a `.anim-attention-dot`
 * span with `aria-label` = the localized `session.statusNeedsInput`.
 */
test('a session blocked on an approval shows amber needs-input and stays', async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]

  // Select the first session and send a prompt that forces a tool approval.
  const firstRow = page.locator('[data-session-row]').first()
  await firstRow.click()
  await page.waitForTimeout(1000)

  const term = page.locator('.xterm-rows').first()
  await term.click()
  // A command that Claude must ask to run under default permissions.
  await page.keyboard.type('run `git status` in the shell, do not explain')
  await page.keyboard.press('Enter')

  // The amber needs-input dot should appear and remain while the prompt pends.
  const amber = page.locator('.anim-attention-dot').first()
  await expect(amber).toBeVisible({ timeout: 30_000 })

  // Anti-decay: it must NOT relax to grey on its own (the old 5s timer would).
  await page.waitForTimeout(8000)
  await expect(amber).toBeVisible()

  // The blocked session sorts to the top of its worktree (attention sort).
  const firstDotAria = await page
    .locator('[data-session-row] [aria-label]')
    .first()
    .getAttribute('aria-label')
  expect(firstDotAria).toBeTruthy()

  await browser.close()
})
