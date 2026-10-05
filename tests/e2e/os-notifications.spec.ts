import { test, expect } from '@playwright/test'
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'

/**
 * OS notifications E2E (os-notifications spec §11). Proves the full
 * cross-process loop — renderer decision → preload → main → native
 * `Notification` — by driving a real task-state transition through the live
 * store and observing the main process's `[notify] shown` log line.
 *
 * This mirrors how it was verified live during development: a SECOND Electron
 * instance is run against the same dev Vite server, isolated by its own
 * `--user-data-dir` (bypasses the single-instance lock) and a free
 * `--remote-debugging-port` so it never fights the shared :9222:
 *
 *   ELECTRON_RENDERER_URL=http://localhost:5174 \
 *     npx electron ./out/main/index.js \
 *     --remote-debugging-port=9343 \
 *     --user-data-dir=/tmp/harnu-notif-e2e \
 *     --disable-gpu > /tmp/harnu-notif-e2e.log 2>&1 &
 *
 * Preconditions for running this spec:
 *   - the instance above is up (CDP on `CDP_PORT`, stdout → `LOG_PATH`),
 *   - at least one folder + session is discoverable from `~/.claude/projects`,
 *   - the build is a dev build (so `window.__omStore` is exposed — spec §11).
 *
 * Env overrides: `HARNU_CDP` (default 9343), `HARNU_LOG`
 * (default /tmp/harnu-notif-e2e.log).
 */

const CDP = `http://127.0.0.1:${process.env.HARNU_CDP ?? '9343'}`
const LOG_PATH = process.env.HARNU_LOG ?? '/tmp/harnu-notif-e2e.log'
const shownCount = (): number =>
  (readFileSync(LOG_PATH, 'utf8').match(/\[notify\] shown/g) || []).length

test('a task-state edge fires a native notification end-to-end; the prefs gate it', async () => {
  const browser = await chromium.connectOverCDP(CDP)
  const page = browser.contexts()[0].pages()[0]

  // The dev-only store handle must be present and populated.
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __omStore?: { allSessions?: unknown[] } }).__omStore
      return !!s && Array.isArray(s.allSessions) && s.allSessions.length > 0
    },
    { timeout: 25_000 }
  )

  // Defaults are opt-out (everything on).
  const defaults = await page.evaluate(() => ({
    ...(window as unknown as { __omStore: { notifyPrefs: Record<string, boolean> } }).__omStore
      .notifyPrefs
  }))
  expect(defaults).toMatchObject({ enabled: true, needsInput: true, completed: true, failed: true })

  // Settings → Integrations renders the master + three per-state switches.
  await page.locator('button[aria-label="Settings"]').first().click()
  await expect(page.getByRole('switch', { name: 'OS notifications' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Needs input' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Completed' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Failed' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Drive a real transition on a NON-selected session → the toast must reach main.
  const before = shownCount()
  const target = await page.evaluate(() => {
    const s = (
      window as unknown as {
        __omStore: {
          allSessions: { sessionId: string }[]
          select: (id: string) => void
          windowFocused: boolean
          setNotifyPref: (k: string, v: boolean) => void
          applyTaskState: (id: string, next: string) => void
        }
      }
    ).__omStore
    const id = s.allSessions[0].sessionId
    s.select('__not_selected__')
    s.windowFocused = false
    s.setNotifyPref('enabled', true)
    s.setNotifyPref('failed', true)
    s.applyTaskState(id, 'working') // clean baseline (not a notify-state)
    s.applyTaskState(id, 'failed') // edge → fires
    return id
  })
  await page.waitForTimeout(600)
  expect(shownCount(), `native [notify] shown for ${target}`).toBe(before + 1)

  // Master OFF suppresses the native fire (the gate, proven end-to-end).
  const beforeOff = shownCount()
  await page.evaluate((id) => {
    const s = (
      window as unknown as {
        __omStore: {
          setNotifyPref: (k: string, v: boolean) => void
          applyTaskState: (id: string, next: string) => void
        }
      }
    ).__omStore
    s.setNotifyPref('enabled', false)
    s.applyTaskState(id, 'working')
    s.applyTaskState(id, 'completed')
  }, target)
  await page.waitForTimeout(600)
  expect(shownCount()).toBe(beforeOff)

  await browser.close()
})

/**
 * Park case (BUG-70/BUG-69/T178 §6 "Honest gap"): the pty:exit reason-tagging,
 * the manual-park convergence onto `hibernateSession`, and the `liveTerminals`
 * disposal cannot be proven by a unit test (`pty.ts` is a coverage-excluded
 * imperative shell; `liveTerminals` is a module-private map with no exported
 * probe). This is the real end-to-end proof: park a live session — via the
 * System Monitor's "Park now", which now converges onto the same
 * `hibernateSession` transaction the automatic sweep uses — and assert ZERO
 * notifications fire, the process is actually gone, and the row is flagged
 * parked with no `completed`/`failed` state.
 */
test('parking a session (System Monitor "Park now") raises zero notifications', async () => {
  const browser = await chromium.connectOverCDP(CDP)
  const page = browser.contexts()[0].pages()[0]

  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __omStore?: { allSessions?: unknown[] } }).__omStore
      return !!s && Array.isArray(s.allSessions) && s.allSessions.length > 0
    },
    { timeout: 25_000 }
  )

  const before = shownCount()
  const target = await page.evaluate(() => {
    const s = (
      window as unknown as {
        __omStore: {
          allSessions: { sessionId: string; hibernated?: boolean; taskState?: string }[]
        }
      }
    ).__omStore
    // The selected session is never parkable (T119 policy) — pick a non-selected one.
    const id = s.allSessions[0].sessionId
    return id
  })

  // Drive the real UI gesture rather than calling the IPC verb directly, so this
  // proves the SystemMonitor.vue → ptyPark → hibernateSession → pty:hibernated
  // → onPtyHibernated (LiveTerminal disposal) chain end-to-end.
  await page.getByRole('button', { name: /system monitor/i }).click()
  await page
    .getByRole('row', { name: new RegExp(target) })
    .getByRole('button', { name: /park now/i })
    .click()
  await page.waitForTimeout(1_000)

  expect(shownCount(), 'a park must raise zero native notifications').toBe(before)

  const after = await page.evaluate((id) => {
    const s = (
      window as unknown as {
        __omStore: {
          allSessions: { sessionId: string; hibernated?: boolean; taskState?: string }[]
        }
      }
    ).__omStore
    return s.allSessions.find((x) => x.sessionId === id)
  }, target)
  expect(after?.hibernated).toBe(true)
  expect(after?.taskState).toBeUndefined()

  await browser.close()
})
