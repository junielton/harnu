/**
 * BUG-199 — the environment an e2e Electron child gets.
 *
 * On a Wayland session Electron ignores xvfb and opens its window on the operator's real
 * desktop, where it can also take real mouse input. These two variables are what make it pick the
 * Wayland compositor, so the child never sees them. Kept free of Playwright imports so the unit
 * suite can test it.
 */
const WAYLAND_VARS = ['WAYLAND_DISPLAY', 'XDG_SESSION_TYPE'] as const

/**
 * `base` plus `overrides`, minus the Wayland variables (removed last, so an override cannot put
 * them back) and minus undefined values. Never mutates its inputs.
 */
export function buildElectronEnv(
  base: Record<string, string | undefined>,
  overrides: Record<string, string | undefined> = {}
): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...base, ...overrides }
  for (const name of WAYLAND_VARS) delete merged[name]
  return Object.fromEntries(
    Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}
