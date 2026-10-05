import { describe, it, expect } from 'vitest'
import {
  shouldSurfaceUpdaterError,
  usesManualUpdateFlow,
  releaseUrlFor
} from '../src/main/updater-policy'

/**
 * The auto-updater emits an `error` event for benign background-check
 * failures — a first-run 404 (repo private / no release published yet) or a
 * plain offline check. Those are not actionable and must not alarm the user
 * with a red "Update failed" toast. We surface an error ONLY once an update
 * was actually found available (a download/install failure the user awaits).
 */
describe('shouldSurfaceUpdaterError', () => {
  it('suppresses a check-phase failure (no update was ever found available)', () => {
    // First-run 404 on releases.atom, offline, "no published versions", etc.
    expect(shouldSurfaceUpdaterError(false)).toBe(false)
  })

  it('surfaces a failure that occurs after an update was found available', () => {
    // A download/install error the user is actually waiting on.
    expect(shouldSurfaceUpdaterError(true)).toBe(true)
  })
})

/**
 * macOS/Windows builds are unsigned, so electron-updater cannot silently
 * apply a downloaded update there (Gatekeeper/Squirrel refuse it) — those
 * platforms fall back to a manual "Update available" toast instead of the
 * silent download-and-restart flow Linux (AppImage) keeps.
 */
describe('usesManualUpdateFlow', () => {
  it('requires the manual flow on darwin', () => {
    expect(usesManualUpdateFlow('darwin')).toBe(true)
  })

  it('requires the manual flow on win32', () => {
    expect(usesManualUpdateFlow('win32')).toBe(true)
  })

  it('does not require the manual flow on linux (existing silent AppImage flow)', () => {
    expect(usesManualUpdateFlow('linux')).toBe(false)
  })
})

describe('releaseUrlFor', () => {
  it('builds the version-tagged GitHub release page URL', () => {
    expect(releaseUrlFor('0.3.29')).toBe('https://github.com/junielton/harnu/releases/tag/v0.3.29')
  })
})
