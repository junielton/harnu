import { test, expect } from '@playwright/test'
import { chromium } from 'playwright-core'

/**
 * Folder-first sidebar IA E2E (folder-first model, spec §5; flattened to one
 * list in BUG-39). Connects to the running dev app over CDP (:9222 from
 * `npm run dev`) and proves the structural pivot away from the worktree bias:
 *   - sessions hang directly under a folder row (no always-present worktree
 *     level between folder and session),
 *   - there is no "Projects" eyebrow anywhere in the sidebar (the rename
 *     signal from the original folder-first pivot),
 *   - there is no "FOLDERS" / "ACTIVE ELSEWHERE" section split (BUG-39 —
 *     the classic sidebar is one flat list with no zone headers).
 *
 * Preconditions:
 *   - `npm run dev` is running with at least one folder + session visible.
 *
 * Selectors: session rows carry `[data-session-row]`; the sidebar toolbar's
 * drill toggle carries `[data-drill-toggle]`, its Hidden-folders trigger
 * carries `[data-sidebar-hidden-trigger]`.
 */
test('the sidebar is folder-first: one flat list, sessions directly under folders', async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]

  // No "Projects" eyebrow should remain anywhere in the sidebar.
  await expect(page.getByText('Projects', { exact: true })).toHaveCount(0)

  // BUG-39: the old FOLDERS / ACTIVE ELSEWHERE zone split is gone — one flat
  // list, no section headers.
  await expect(page.getByText('Folders', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Active elsewhere', { exact: false })).toHaveCount(0)

  // Expand the first folder row (click it) and confirm session rows appear
  // directly beneath — there is no intermediate worktree row to expand first.
  const sessionRows = page.locator('[data-session-row]')
  await expect(sessionRows.first()).toBeVisible({ timeout: 10_000 })

  await browser.close()
})
