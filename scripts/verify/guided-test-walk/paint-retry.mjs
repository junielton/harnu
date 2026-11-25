/**
 * BUG-298: relaunch a smoke instance whose window does not paint.
 *
 * A freshly started Electron under xvfb sometimes loses its GPU process, and a window with no GPU process never
 * produces a frame: `requestAnimationFrame` never fires and a screenshot hangs, although the page's JavaScript and
 * the control server keep answering. It happens whatever the size of docs/harnu-features.md. A stalled window never
 * recovers by waiting, so the only way out is a new process on the same user-data-dir.
 *
 * Only a paint stall is retried. Any other error (CDP, the control server) passes through, and after `attempts`
 * windows the last stall is thrown, so a real freeze is never hidden.
 *
 * @param {{
 *   waitPainting: () => Promise<unknown>,
 *   relaunch: () => Promise<unknown>,
 *   attempts?: number,
 *   log?: (line: string) => void
 * }} o
 * @returns {Promise<number>} how many times the instance was relaunched
 */
export async function paintOrRelaunch({ waitPainting, relaunch, attempts = 3, log = () => {} }) {
  for (let k = 0; ; k++) {
    try {
      await waitPainting()
      return k
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!/does not paint/.test(message) || k >= attempts - 1) throw err
      log(`the window does not paint (${message}): starting the instance again`)
      await relaunch()
    }
  }
}
