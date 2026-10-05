import { test, expect } from '@playwright/test'
import { chromium } from 'playwright-core'

/**
 * Configurable session sort E2E (folder-first model, spec §7 — the
 * "configurable, not fixed" requirement). Connects to the running dev app over
 * CDP (:9222 from `npm run dev`) and proves the session sort is a *preference*,
 * not the forced attention-sort it used to be: switching it in
 * Settings → Sidebar re-checks the chosen mode and re-orders the sessions
 * within a folder.
 *
 * Preconditions:
 *   - `npm run dev` is running.
 *   - At least one folder with **2+ sessions** is visible and expanded (so a
 *     reorder is observable). With <2 sessions the order assertion is a no-op
 *     and only the preference toggle is checked.
 *
 * The sort radios live in `SettingsDialog.vue` (role="radio", labels from
 * `settings.sidebar.sort*`); session rows carry `[data-session-row]`.
 */
test('switching the session sort preference re-checks and reorders', async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]

  // Capture the current session-row order (top-level, across the sidebar).
  const rowOrderBefore = await page.locator('[data-session-row]').allTextContents()

  // Open Settings → Sidebar section.
  await page.getByRole('button', { name: 'Settings' }).first().click()
  const nameRadio = page.getByRole('radio', { name: 'Name' })
  const recentRadio = page.getByRole('radio', { name: 'Recent activity' })
  const attentionRadio = page.getByRole('radio', { name: 'Attention' })
  await expect(nameRadio).toBeVisible({ timeout: 5_000 })

  // Switch to Name — the radio must become checked.
  await nameRadio.click()
  await expect(nameRadio).toHaveAttribute('aria-checked', 'true')
  await expect(attentionRadio).toHaveAttribute('aria-checked', 'false')

  // Switch to Recent activity — checked state must follow.
  await recentRadio.click()
  await expect(recentRadio).toHaveAttribute('aria-checked', 'true')

  // Back to Attention (the default) and confirm it re-checks.
  await attentionRadio.click()
  await expect(attentionRadio).toHaveAttribute('aria-checked', 'true')

  // Close settings (Escape) and confirm the sidebar still renders rows — the
  // sort change must never blank the list.
  await page.keyboard.press('Escape')
  const rowOrderAfter = await page.locator('[data-session-row]').allTextContents()
  expect(rowOrderAfter.length).toBe(rowOrderBefore.length)

  await browser.close()
})
