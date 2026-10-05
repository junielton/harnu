/**
 * "Harnu self-awareness" (T55): make `claude` sessions know they run inside Harnu.
 *
 * A versioned, hand-written doc (`docs/harnu-features.md`, updated each release
 * like the CHANGELOG) describes the environment Harnu wraps around the session —
 * the Approval Inbox, the footer image gallery, the MCP verbs (hedged behind
 * "when enabled"), worktrees, and the "guide the user through the UI" pattern.
 * When the feature is ON, that doc is PREPENDED to the session's effective
 * `--append-system-prompt` at spawn (see `claude-args.ts#composeAppendSystemPrompt`
 * + the two call sites in `pty.ts`), composing with — never clobbering — the
 * user's own append, and never touching the default system prompt.
 *
 * env-bound (electron `app` + `node:fs`) ⇒ e2e-only per ADR-0001 (no unit test;
 * goes in coverage.exclude). The doc is embedded via Vite `?raw` so it inlines
 * into the bundle at build time (no runtime file read, works packaged). The pure
 * composition logic lives in `claude-args.ts` and is unit-tested there.
 */

import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import rawDoc from '../../docs/harnu-features.md?raw'
import { appLocale } from './app-locale'
import { memoryLanguageLine } from './memory-language'

/** The environment doc, trimmed. Injected verbatim as the append-system-prompt preamble. */
export const HARNU_FEATURES_DOC = rawDoc.trim()

/** Parse a `<!-- harnu-features vN ... -->` marker (the pre-rename `capy-` prefix is accepted too). */
export function parseFeaturesVersion(doc: string): string {
  const m = /<!--\s*(?:harnu|capy)-features\s+(v\d+)/i.exec(doc)
  return m ? m[1] : 'v0'
}

/** Parsed version marker for staleness/debugging. */
export const HARNU_FEATURES_VERSION = parseFeaturesVersion(rawDoc)

/** On-disk file name under `app.getPath('userData')`. */
const FILE_NAME = 'harnu-features.json'

/**
 * Pre-rename file name. The one-time userData migration copies the old directory
 * as-is, so an existing install carries its choice under this name: it is read
 * as a fallback when `harnu-features.json` is missing, and never written again.
 */
const LEGACY_FILE_NAME = 'capy-features.json'

function prefsPath(name: string = FILE_NAME): string {
  return path.join(app.getPath('userData'), name)
}

/**
 * Default **ON** (T55 §7): the doc is cheap (~500 tokens, prompt-cached as system
 * prompt) and makes the session immediately useful about its own environment. The
 * user can flip it off in Settings; only an explicit `{ "enabled": false }` opts
 * out. A missing/corrupt prefs file (first run, torn write) → default ON.
 */
const DEFAULT_ENABLED = true

/**
 * In-memory cache for the sync read at spawn time. Hydrated from disk on
 * `registerHarnuFeaturesHandlers`, kept fresh on every write.
 */
let enabledCache = DEFAULT_ENABLED

/** Read one prefs file's flag; `null` when the file is missing, unreadable or torn. */
async function readEnabledFrom(name: string): Promise<boolean | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(prefsPath(name), 'utf8'))
    return parsed?.enabled !== false
  } catch {
    return null
  }
}

/**
 * Read the enable flag from disk. Default ON; only an explicit `false` opts out.
 * Prefers `harnu-features.json`, falling back to the legacy `capy-features.json`.
 */
export async function readHarnuFeaturesEnabled(): Promise<boolean> {
  return (
    (await readEnabledFrom(FILE_NAME)) ??
    (await readEnabledFrom(LEGACY_FILE_NAME)) ??
    DEFAULT_ENABLED
  )
}

/** Persist the enable flag and refresh the sync cache. */
export async function writeHarnuFeaturesEnabled(enabled: boolean): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(prefsPath(), JSON.stringify({ enabled }, null, 2) + '\n', 'utf8')
  enabledCache = enabled
}

/**
 * The append-system-prompt preamble to inject at spawn: the doc when the feature
 * is ON, `''` when OFF. Synchronous (reads the hydrated cache) so the PTY spawn
 * path — which is sync at the argv-build step — can prepend it without an await.
 *
 * T85: one RUNTIME line is appended to the checked-in doc — the app language +
 * the standing "write project memory in it" instruction. It is runtime-derived
 * (from the synced locale cache), not baked into the versioned `.md`, so the
 * session always sees the CURRENT Settings language.
 */
export function harnuPreamble(): string {
  if (!enabledCache) return ''
  return `${HARNU_FEATURES_DOC}\n\n${memoryLanguageLine(appLocale())}`
}

/** Register the toggle IPC + hydrate the sync cache from disk. */
export function registerHarnuFeaturesHandlers(): void {
  void readHarnuFeaturesEnabled()
    .then((v) => {
      enabledCache = v
    })
    .catch(() => {
      /* keep the default */
    })
  ipcMain.handle('harnuFeatures:get', () => readHarnuFeaturesEnabled())
  ipcMain.handle('harnuFeatures:setEnabled', async (_e, enabled: boolean) => {
    await writeHarnuFeaturesEnabled(enabled === true)
    return enabledCache
  })
}
