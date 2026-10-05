/**
 * Pure policy for the auto-updater (no electron imports — unit-testable).
 *
 * electron-updater fires an `error` event for benign background-check
 * failures: a first-run 404 on `releases.atom` (the GitHub repo is private or
 * has no published release yet), or a plain offline check. None of these are
 * actionable by the user, so surfacing them as a red "Update failed" toast
 * (dumping raw HTTP headers) is noise — exactly what bit us on the first
 * packaged launch.
 *
 * Rule: surface an updater error ONLY once an update was actually found
 * available — i.e. a download/install-phase failure the user is waiting on.
 * Errors raised before any `update-available` event are check-phase failures
 * and get logged-and-dropped in the main process.
 */
export function shouldSurfaceUpdaterError(updateWasAvailable: boolean): boolean {
  return updateWasAvailable
}

/**
 * GitHub owner/repo electron-updater publishes to and checks against —
 * sourced from `electron-builder.yml`'s `publish:` block.
 */
// Keep in sync with `publish.owner` / `publish.repo` in electron-builder.yml.
export const UPDATER_OWNER = 'junielton'
export const UPDATER_REPO = 'harnu'

/**
 * macOS and Windows builds are unsigned/unnotarized, so Gatekeeper /
 * Squirrel.Mac / Squirrel.Windows refuse to let electron-updater apply a
 * downloaded update silently on these platforms — an OS-level constraint,
 * not an app bug. These platforms fall back to a manual "Update available"
 * toast linking to the GitHub release page instead of a silent
 * download-and-restart. Linux (AppImage) is unaffected and keeps the
 * existing silent flow.
 */
export function usesManualUpdateFlow(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/** GitHub release page URL for a given app version (e.g. `"0.3.29"`). */
export function releaseUrlFor(version: string): string {
  return `https://github.com/${UPDATER_OWNER}/${UPDATER_REPO}/releases/tag/v${version}`
}
