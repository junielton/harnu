/**
 * App-locale sync renderer→main (T85): the Settings locale lives only in the
 * renderer (`om2tab.locale`), but the main process — where `harnu-features.ts`
 * builds the self-awareness preamble — needs it to tell every spawned session
 * which language to write project memory in.
 *
 * The renderer pushes its EFFECTIVE locale over `settings:locale` on boot and on
 * every `setLocale`; this shell caches it in memory (the sync source the preamble
 * reads at spawn time) AND persists it to `<userData>/app-locale.json` so it
 * survives before the first window paints (the cache is hydrated on register).
 *
 * env-bound (electron `app` + `node:fs`) ⇒ e2e-only per ADR-0001; the pure line
 * builder it feeds lives in `memory-language.ts` and is unit-tested there. Mirrors
 * the `harnu-features.ts` prefs shell (same read/write/cache/register shape).
 */

import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** On-disk file name under `app.getPath('userData')`. */
const FILE_NAME = 'app-locale.json'

/** Default locale (matches the renderer i18n fallback) when nothing is persisted. */
const DEFAULT_LOCALE = 'en'

/**
 * In-memory cache — the SYNC source of truth the preamble reads at spawn time.
 * Hydrated from disk on {@link registerAppLocaleHandlers}, refreshed on every push.
 */
let localeCache = DEFAULT_LOCALE

function prefsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** Read the persisted locale from disk (default `en`; never throws). */
export async function readAppLocale(): Promise<string> {
  try {
    const parsed = JSON.parse(await fs.readFile(prefsPath(), 'utf8'))
    return typeof parsed?.locale === 'string' && parsed.locale.length > 0
      ? parsed.locale
      : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

/** Persist the locale and refresh the sync cache. */
export async function writeAppLocale(locale: string): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(prefsPath(), JSON.stringify({ locale }, null, 2) + '\n', 'utf8')
  localeCache = locale
}

/**
 * The effective app locale (hydrated cache). Synchronous so the PTY spawn path —
 * which builds the preamble without an await — can read it inline.
 */
export function appLocale(): string {
  return localeCache
}

/** Register the locale-sync IPC + hydrate the sync cache from disk. */
export function registerAppLocaleHandlers(): void {
  void readAppLocale()
    .then((v) => {
      localeCache = v
    })
    .catch(() => {
      /* keep the default */
    })
  ipcMain.handle('settings:locale', async (_e, locale: unknown) => {
    if (typeof locale === 'string' && locale.length > 0) await writeAppLocale(locale)
    return localeCache
  })
}
