/**
 * T460 batch 0 — launching ONE side of the dialog baseline (spec §6.3 steps 1-2).
 *
 * `_electron.launch()` on the BUILT app of one worktree, exactly as `tests/e2e/ci/*` does it:
 * no `--remote-debugging-port` (that flips `IS_DEV` and sends the renderer to :5174), a throwaway
 * `--user-data-dir` + `HOME`, working directory = that side's worktree. Playwright talks to
 * Electron over a debugging pipe, so two sides can run at once or one after the other.
 */
import { _electron as electron } from '@playwright/test'

export const WIDTH = 1280
/** The two window heights every dialog is measured at (spec §6.3 step 4). */
export const HEIGHTS = [900, 560]

/**
 * @param {{ buildDir: string, userData: string, width?: number, height?: number, extraArgs?: string[] }} o
 * @returns {Promise<{ app: import('@playwright/test').ElectronApplication, page: import('@playwright/test').Page }>}
 */
export async function launchSide({
  buildDir,
  userData,
  width = WIDTH,
  height = 900,
  extraArgs = []
}) {
  const app = await electron.launch({
    args: [
      'out/main/index.js',
      `--user-data-dir=${userData}`,
      '--no-sandbox',
      '--disable-gpu',
      ...extraArgs
    ],
    cwd: buildDir,
    env: { ...process.env, HOME: userData }
  })
  const page = await app.firstWindow()
  await page.locator('body').waitFor({ state: 'visible' })
  await setViewport(app, width, height)
  return { app, page }
}

/** `BrowserWindow.setContentSize`, as `scheduler-result-css.spec.ts` does. */
export async function setViewport(app, width, height) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(w, h)
    },
    [width, height]
  )
}

/** Set a theme the way the app does: the `data-theme` attribute on <html> drives every token. */
export async function setTheme(page, theme) {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
}
