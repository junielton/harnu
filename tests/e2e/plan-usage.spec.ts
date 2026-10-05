import { test, expect } from '@playwright/test'
import { chromium } from 'playwright-core'

/**
 * Plan-usage panel E2E (plan-usage-widget spec). Connects to the running dev app
 * over CDP (:9222 from `npm run dev`) and asserts the sidebar panel rendered from
 * a real `claude -p "/usage"` snapshot.
 *
 * Preconditions: `npm run dev` is running and the user is on a Claude
 * subscription (Pro/Max) so `/usage` returns data. For API-key / non-subscription
 * users the panel self-hides, so the test skips.
 */
test('plan usage panel renders from a real /usage snapshot', async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]

  // The store calls usageGet() on init; ask main for the current snapshot.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snap = await page.evaluate(() => (window as any).api.usageGet())
  test.skip(!snap || !snap.available, 'No subscription usage available — panel self-hides')

  // Header present and at least one bar rendered.
  await expect(page.getByText('Plan usage')).toBeVisible()
  const fills = page.locator('[data-usage-fill]')
  expect(await fills.count()).toBeGreaterThanOrEqual(1)

  // The first (session) bar width tracks the reported percentage.
  const firstWidth = await fills.first().evaluate((el) => (el as HTMLElement).style.width)
  expect(firstWidth).toBe(`${snap.session.usedPercent}%`)

  await browser.close()
})
