import type { ElectronApplication, Page } from '@playwright/test'

/**
 * What the failing run knew about the app, captured so a red e2e explains itself (BUG-205).
 *
 * Playwright rewrites EVERY non-JavaScript failure of `electronApplication.evaluate` into
 * "Execution context was destroyed, most likely because of a navigation", whatever the real cause
 * (a crashed or exited main process, a context that went away, a protocol error). The CI artifact
 * then holds a screenshot and a runner-side trace with nothing about the main process, so the same
 * sentence could not be told apart across three sightings. This records the events that WOULD
 * tell the causes apart; the spec attaches the log to the report when a test fails.
 */
export interface AppDiagnostics {
  /** Timestamped events seen so far, oldest first. */
  readonly events: string[]
  /** The log plus the live state of the app and its window, as one attachable text. */
  report(): Promise<string>
}

const MAX_EVENTS = 400
const MAX_STDERR = 4000

export function collectAppDiagnostics(app: ElectronApplication, page: Page): AppDiagnostics {
  const t0 = Date.now()
  const events: string[] = []
  const note = (what: string): void => {
    if (events.length >= MAX_EVENTS) events.shift()
    events.push(`+${Date.now() - t0}ms ${what}`)
  }

  page.on('framenavigated', (f) =>
    note(`framenavigated ${f.parentFrame() ? 'sub' : 'main'} ${f.url()}`)
  )
  page.on('crash', () => note('page crash'))
  page.on('close', () => note('page close'))
  page.on('pageerror', (e) => note(`pageerror ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') note(`console.${m.type()} ${m.text()}`)
  })
  app.on('close', () => note('app close'))
  app.on('window', (w) => note(`app window ${w.url()}`))

  const proc = app.process()
  let stderr = ''
  proc.stderr?.on('data', (b: Buffer) => {
    stderr = (stderr + b.toString()).slice(-MAX_STDERR)
  })
  proc.on('exit', (code, signal) => note(`main process exit code=${code} signal=${signal}`))

  return {
    events,
    async report() {
      const state: string[] = [
        `main process: pid=${proc.pid} exitCode=${proc.exitCode} signal=${proc.signalCode}`,
        `page closed: ${page.isClosed()}`
      ]
      const live = await app
        .evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((w) => ({
            destroyed: w.isDestroyed(),
            loading: w.webContents.isLoading(),
            crashed: w.webContents.isCrashed(),
            size: w.getContentSize()
          }))
        )
        .then((w) => JSON.stringify(w))
        .catch((e: Error) => `main process did not answer: ${e.message}`)
      state.push(`windows: ${live}`)
      return [
        ...state,
        '--- events ---',
        ...events,
        '--- main process stderr (tail) ---',
        stderr || '(empty)'
      ].join('\n')
    }
  }
}
