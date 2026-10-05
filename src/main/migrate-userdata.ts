/**
 * One-time userData migration from the pre-rebrand app dirs (T41, T417).
 *
 * The app has carried three names: **om2tab** → **Capy** → **Harnu**. Electron's
 * `userData` follows the name — `<appData>/om2tab`, then `<appData>/Capy`
 * (packaged, from `productName`) / `<appData>/harnu` (dev, from package.json
 * `name`), now `<appData>/Harnu` / `<appData>/harnu` — so a user upgrading
 * silently gets a fresh dir and loses their settings. On first boot this copies
 * the first existing legacy dir ({@link LEGACY_APP_NAMES}, in order) into the
 * current `userData`.
 *
 * It copies the WHOLE legacy dir except Chromium's volatile cache/lock entries
 * ({@link isMigratableEntry}), so every app-owned dir — `Local Storage/`,
 * `scheduler-runs/`, `statusline/`, `orchestrator-guard/`, `skills/`, the reaper
 * data, `voice-kokoro/` — survives. Files are copied under their old names; any
 * rename inside userData is not this module's job.
 *
 * The renderer loads via `loadFile` → origin `file://` in every build, and
 * Chromium keys Local Storage by that serialized origin (path is not part of it),
 * so a raw copy of `Local Storage/` restores every `om2tab.*` localStorage pref
 * (theme, sort, sidebar width, …).
 *
 * SAFETY: runs only into a FRESH default userData (no `Local Storage`, no
 * `projects.json`), only once (a marker file), never for a custom
 * `--user-data-dir` (isolated/test instances), and never overwrites an existing
 * entry. The marker is written in a `finally` so a permission error or partial
 * copy can never cause a boot-loop that repeatedly re-reads real user data. All
 * failures are swallowed — losing prefs is strictly better than blocking boot.
 *
 * env-bound (`node:fs` at boot) ⇒ the pure decision ({@link shouldMigrate},
 * {@link isMigratableEntry}, {@link hasCustomUserDataDir}) is unit-tested; the
 * copy routine is covered against temp dirs.
 */

import {
  existsSync,
  readdirSync,
  cpSync,
  renameSync,
  rmSync,
  mkdirSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

/** Marker file dropped in the dest after the one-shot migration attempt. */
export const MIGRATION_MARKER = '.migrated-from-capy'

/**
 * Legacy userData dir basenames under `<appData>`, newest first — the first one
 * that exists is the migration source. `Capy` is the packaged name, `capy` the
 * dev name (the same dir on case-insensitive filesystems), `om2tab` the
 * pre-Capy app name.
 */
export const LEGACY_APP_NAMES = ['Capy', 'capy', 'om2tab'] as const

/** Markers dropped by earlier migrations — never carried into a new dir. */
const LEGACY_MARKERS: ReadonlySet<string> = new Set(['.migrated-from-om2tab', MIGRATION_MARKER])

/**
 * Chromium cache/volatile top-level entries that are regenerated (or worthless)
 * in a new dir, plus the stale pre-rename MCP config document. Everything NOT listed here is copied.
 */
const SKIPPED_ENTRIES: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'ShaderCache',
  'Crashpad',
  'blob_storage',
  'component_crx_cache',
  'Network',
  'Cookies',
  'Cookies-journal',
  'lockfile',
  // The pre-rename MCP config document: it holds a dead port + bearer token, and the server
  // unlinks it at boot anyway (see `mcp/server.ts`), so carrying it would only resurrect it.
  'capy.mcp.json'
])

/**
 * Whether a top-level userData entry should be copied: everything except the
 * Chromium cache dirs ({@link SKIPPED_ENTRIES}), `Singleton*` process locks,
 * and migration markers.
 */
export function isMigratableEntry(name: string): boolean {
  if (SKIPPED_ENTRIES.has(name)) return false
  if (name.startsWith('Singleton')) return false
  if (LEGACY_MARKERS.has(name)) return false
  return true
}

/** Whether a custom `--user-data-dir` is in effect (an isolated/test instance). */
export function hasCustomUserDataDir(argv: readonly string[]): boolean {
  return argv.some((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='))
}

/** The observable preconditions {@link shouldMigrate} decides on. */
export interface MigrationConditions {
  /** A legacy dir (one of {@link LEGACY_APP_NAMES}) exists under `<appData>`. */
  legacyExists: boolean
  /** The dest already has a Chromium `Local Storage` dir (⇒ not a fresh install). */
  destHasLocalStorage: boolean
  /** The dest already has `projects.json` (⇒ the app has run + written config). */
  destHasProjectsJson: boolean
  /** The one-shot marker is already present. */
  markerExists: boolean
  /** A custom `--user-data-dir` is in effect (isolated instance — never migrate). */
  customUserDataDir: boolean
}

/**
 * Pure decision: migrate ONLY into a fresh, default userData, exactly once.
 * False if a custom user-data-dir is set, the marker exists, the legacy dir is
 * absent, or the dest already carries data (never clobber a real config).
 */
export function shouldMigrate(c: MigrationConditions): boolean {
  if (c.customUserDataDir) return false
  if (c.markerExists) return false
  if (!c.legacyExists) return false
  if (c.destHasLocalStorage || c.destHasProjectsJson) return false
  return true
}

/** Options for {@link migrateUserData}. */
export interface MigrateUserDataOptions {
  /** `app.getPath('appData')` — the parent of both the legacy and current dirs. */
  appData: string
  /** `app.getPath('userData')` — the migration destination. */
  userData: string
  /** `process.argv` — checked for a `--user-data-dir` override. */
  argv: readonly string[]
  /** Injected clock for the marker stamp (keeps the routine testable). */
  now?: () => Date
}

/** Outcome of a migration attempt (for logging/tests). */
export type MigrateOutcome = 'migrated' | 'skipped' | 'error'

/**
 * Run the one-time migration (synchronous — must complete before the window
 * loads and before Chromium opens its Local Storage db). Returns what happened;
 * never throws (all failures are swallowed + logged).
 */
export function migrateUserData(opts: MigrateUserDataOptions): MigrateOutcome {
  const legacyName = LEGACY_APP_NAMES.find((n) => existsSync(join(opts.appData, n)))
  const legacyDir = join(opts.appData, legacyName ?? LEGACY_APP_NAMES[0])
  const dest = opts.userData
  const marker = join(dest, MIGRATION_MARKER)

  const conditions: MigrationConditions = {
    legacyExists: legacyName !== undefined,
    destHasLocalStorage: existsSync(join(dest, 'Local Storage')),
    destHasProjectsJson: existsSync(join(dest, 'projects.json')),
    markerExists: existsSync(marker),
    customUserDataDir: hasCustomUserDataDir(opts.argv)
  }
  if (!shouldMigrate(conditions)) return 'skipped'

  let outcome: MigrateOutcome = 'migrated'
  try {
    mkdirSync(dest, { recursive: true })
    for (const name of readdirSync(legacyDir).filter(isMigratableEntry)) {
      const from = join(legacyDir, name)
      const to = join(dest, name)
      if (existsSync(to)) continue // never overwrite an existing entry
      // Per entry, so one unreadable file (a FIFO, a permission error) can't
      // abort the loop and drop entries that sort after it.
      try {
        // verbatimSymlinks keeps relative links relative; otherwise cpSync
        // rewrites them to absolute paths into the legacy dir, which dangle
        // once the user removes the old install.
        const copyOpts = { recursive: true, dereference: false, verbatimSymlinks: true }
        if (name === 'Local Storage') {
          // Copy the leveldb into a temp sibling then atomically rename, so a
          // crash mid-copy never leaves a half-written db for Chromium to open.
          const tmp = join(dest, 'Local Storage.migrating.tmp')
          try {
            rmSync(tmp, { recursive: true, force: true })
            cpSync(from, tmp, copyOpts)
            renameSync(tmp, to)
          } catch (err) {
            rmSync(tmp, { recursive: true, force: true })
            throw err
          }
        } else {
          cpSync(from, to, copyOpts)
        }
      } catch (err) {
        console.error(`[migrate-userdata] failed to copy "${name}" (continuing):`, err)
        outcome = 'error'
      }
    }
  } catch (err) {
    console.error('[migrate-userdata] migration failed (continuing boot):', err)
    outcome = 'error'
  } finally {
    // One-shot marker: written whether the copy succeeded or errored, so a
    // failure can never boot-loop into repeatedly re-reading/clobbering.
    try {
      const stamp = (opts.now?.() ?? new Date()).toISOString()
      writeFileSync(marker, `migrated from ${legacyName} at ${stamp}\n`)
    } catch {
      /* if we can't even write the marker, the guard's other checks still hold */
    }
  }
  return outcome
}
