import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { buildElectronEnv } from './launch-env'

/**
 * The ONE place an e2e spec launches the built app (BUG-199). The child runs headless on a
 * throwaway `userData` with `HOME` pointed at it, and never sees the Wayland variables, so it
 * cannot open a window on the operator's desktop (see `launch-env.ts`).
 *
 * `env` is merged over `process.env`; the Wayland variables are stripped from the result.
 * NO `--remote-debugging-port`: on a built app that would flip `is.dev` and send the renderer to
 * the dev URL (docs/dev/live-verify-second-instance.md).
 */
export function launchApp(opts: {
  userData: string
  env?: Record<string, string | undefined>
}): Promise<ElectronApplication> {
  return electron.launch({
    args: [
      'out/main/index.js',
      `--user-data-dir=${opts.userData}`,
      '--no-sandbox',
      '--disable-gpu'
    ],
    env: buildElectronEnv(process.env, { HOME: opts.userData, ...opts.env })
  })
}
