/**
 * Missions v4 · stp-21 (T751) · AC-7 — the dialog baseline driver launches the app the way the CI specs do.
 *
 * `tests/e2e/ci/fixtures/launch-env.ts` strips the Wayland variables (BUG-199) so the Electron child opens on the
 * virtual display, not on the operator's desktop, where its window never settles and every route that clicks
 * a sidebar row times out. `scripts/dev/dialog-routes/launch.mjs` (the baseline driver's launcher) did not, so
 * the hand-off route could not be captured on a Wayland session. It now builds its environment the same way.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs module with no type declarations
import { sideEnv } from '../scripts/dev/dialog-routes/launch.mjs'

describe('the baseline driver’s launch environment', () => {
  const base = {
    WAYLAND_DISPLAY: 'wayland-0',
    XDG_SESSION_TYPE: 'wayland',
    DISPLAY: ':99',
    PATH: '/usr/bin',
    KEEP: 'yes'
  }

  it('never passes the Wayland variables to the child, so it opens on the virtual display', () => {
    const env = sideEnv(base, '/tmp/side-before')
    expect(env).not.toHaveProperty('WAYLAND_DISPLAY')
    expect(env).not.toHaveProperty('XDG_SESSION_TYPE')
    expect(env.DISPLAY).toBe(':99')
    expect(env.KEEP).toBe('yes')
  })

  it('points HOME at the side’s own user data, and a caller’s env wins over the default', () => {
    expect(sideEnv(base, '/tmp/side-before').HOME).toBe('/tmp/side-before')
    const env = sideEnv(base, '/tmp/side-before', { HOME: '/tmp/seeded', WAYLAND_DISPLAY: 'again' })
    expect(env.HOME).toBe('/tmp/seeded')
    // the Wayland variables are removed last: an override cannot put them back
    expect(env).not.toHaveProperty('WAYLAND_DISPLAY')
  })
})
