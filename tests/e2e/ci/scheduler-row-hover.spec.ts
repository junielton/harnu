import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './fixtures/launch-app'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T590 AC-8 — hovering or focusing a Scheduler list row moves nothing.
 *
 * The row swaps its state label (a ~15px line) for the Run now / Delete buttons on
 * hover. When the buttons were taller than the label, line 1 grew and the whole row
 * content shifted. jsdom has no box model, so the unit suite cannot see that; this
 * spec measures real boxes in Chromium: every row's rect and the rects of its line 1,
 * name, pin, state/actions and run ticks are identical before and after hover, and
 * before and after keyboard focus.
 *
 * Subscription-free like `scheduler-result-css.spec.ts`: the workers are either off,
 * or armed with a run that started just now and a day-long cadence, so nothing is due
 * and the shell never spawns `claude`. Requires `npm run build` first.
 */

const DAY_MIN = 24 * 60

function seedUserData(): string {
  const userData = mkdtempSync(join(tmpdir(), 'harnu-t590-hover-'))
  const base = {
    prompt: 'never runs',
    folder: userData,
    everyMinutes: DAY_MIN,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    notifyOn: 'silent',
    failureStreak: 0
  }
  const workers = [
    { ...base, id: 'on-1', name: 'Armed worker one', enabled: true },
    { ...base, id: 'on-2', name: 'Armed worker two', enabled: true },
    { ...base, id: 'off-1', name: 'Off worker one', enabled: false },
    { ...base, id: 'off-2', name: 'Off worker two', enabled: false }
  ]
  writeFileSync(join(userData, 'schedulers.json'), JSON.stringify({ version: 1, workers }, null, 2))

  mkdirSync(join(userData, 'scheduler-runs'), { recursive: true })
  const startedAt = Date.now()
  for (const id of ['on-1', 'on-2']) {
    writeFileSync(
      join(userData, 'scheduler-runs', `${id}.jsonl`),
      JSON.stringify({
        workerId: id,
        startedAt,
        endedAt: startedAt + 1000,
        durationMs: 1000,
        status: 'ok',
        result: 'fine',
        terminalReason: '',
        numTurns: 1,
        costUsd: 0,
        tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
        denials: []
      }) + '\n'
    )
  }
  return userData
}

type Rect = { x: number; y: number; width: number; height: number }

/** Every box that could move, for every row, in document order. */
async function measure(page: Page): Promise<Record<string, Rect | null>[]> {
  return page.evaluate(() => {
    const box = (el: Element | null): Rect | null => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return [...document.querySelectorAll('[data-worker-list] [role="option"]')].map((row) => ({
      row: box(row),
      line1: box(row.querySelector('[data-row-line1]')),
      pin: box(row.querySelector('[data-action="pin"]')),
      name: box(row.querySelector('[data-worker-name]')),
      meta: box(row.querySelector('[data-worker-mode]')),
      ticks: box(row.querySelector('[data-run-ticks]'))
    }))
  })
}

let app: ElectronApplication
let page: Page

test.describe('scheduler row hover/focus — no layout shift (T590 AC-8)', () => {
  test.beforeAll(async () => {
    app = await launchApp({ userData: seedUserData() })
    page = await app.firstWindow()
    await expect(page.locator('body')).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900)
    })
    await page.locator('[data-dsqa="scheduler-footer-pill"]').click()
    await expect(page.locator('[data-dsqa="scheduler-takeover"]')).toBeVisible()
    await expect(page.locator('[data-worker-list] [role="option"]')).toHaveCount(4)
  })

  test.afterAll(async () => {
    await app?.close()
  })

  for (const index of [0, 1, 2, 3]) {
    test(`hovering row ${index} moves no row and no box inside it`, async () => {
      const rows = page.locator('[data-worker-list] [role="option"]')
      await page.mouse.move(2, 2)
      const before = await measure(page)

      await rows.nth(index).hover()
      // The swap really happened — otherwise "nothing moved" proves nothing.
      await expect(rows.nth(index).locator('[data-row-actions]')).toBeVisible()
      await expect(rows.nth(index).locator('[data-row-state]')).toBeHidden()
      const during = await measure(page)
      expect(during).toEqual(before)

      await page.mouse.move(2, 2)
      expect(await measure(page)).toEqual(before)
    })

    test(`focusing row ${index} moves no row and no box inside it`, async () => {
      const rows = page.locator('[data-worker-list] [role="option"]')
      await page.mouse.move(2, 2)
      const before = await measure(page)

      await rows.nth(index).focus()
      await expect(rows.nth(index).locator('[data-row-actions]')).toBeVisible()
      expect(await measure(page)).toEqual(before)

      await rows.nth(index).blur()
    })
  }
})
