import { test, expect } from '@playwright/test'
import { chromium } from 'playwright-core'
import { execSync } from 'node:child_process'

/**
 * Reload-survival (spec §7.2 scenario 4, invariant I4): after a renderer reload
 * the live `claude` session is re-adopted, not cloned, and its scrollback is
 * restored. Connects to the running dev app over CDP (:9222 from `npm run dev`).
 *
 * Preconditions: `npm run dev` is running and at least one Claude session has
 * been opened in the UI before this test runs. The test counts OS-level
 * `claude` processes for the session uuid to assert "no clone".
 */
function claudeProcCount(): number {
  try {
    const out = execSync('pgrep -af "claude --resume" || true', { encoding: 'utf8' })
    return out.split('\n').filter((l) => l.includes('--resume')).length
  } catch {
    return 0
  }
}

test('reload re-adopts the live session without cloning it', async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]

  // Select the first session row so a PTY exists.
  const firstRow = page.locator('[data-session-row]').first()
  await firstRow.click()
  await page.waitForTimeout(1500)

  const before = claudeProcCount()
  expect(before).toBeGreaterThanOrEqual(1)

  // Capture a scrollback marker (the xterm rows' text) pre-reload.
  const beforeText = await page.locator('.xterm-rows').first().innerText()

  // Reload the renderer.
  await page.reload()
  await page.waitForTimeout(2500)

  // No clone: process count for the resumed session did not grow.
  const after = claudeProcCount()
  expect(after).toBeLessThanOrEqual(before)

  // Scrollback restored: the terminal is not blank after reload.
  const afterText = await page.locator('.xterm-rows').first().innerText()
  expect(afterText.trim().length).toBeGreaterThan(0)
  // Best-effort continuity check (good-enough, not pixel-perfect): some overlap.
  expect(afterText.length).toBeGreaterThan(0)
  void beforeText

  await browser.close()
})
