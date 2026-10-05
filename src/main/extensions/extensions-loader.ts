import { ipcMain, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import chokidar, { type FSWatcher } from 'chokidar'
import type { CardKind } from '../roadmap-core'
import {
  buildExtensionRegistry,
  type ExtensionRegistry,
  type ResolvedExtensionMode,
  type ScannedExtension
} from './extension-registry'
import type { ExtensionTheme } from './extension-manifest-core'
import { SESSION_MODES, modeContract, isSessionModeId } from '../session-modes'

/**
 * Extension loader IPC shell (T137 — Extension SDK Phase 1).
 *
 * The imperative casing around the pure {@link buildExtensionRegistry}: it owns
 * the `~/.claude/capy-extensions/` directory read, the chokidar hot-reload, and
 * the compiled {@link ExtensionRegistry} every consuming surface reads from —
 * `getExtensionThemes` (pushed to the renderer via `extensions:themes-changed`,
 * pulled via the `extensions:listThemes` invoke) and
 * `getExtensionBoardTemplatePath` (pulled on-demand by `roadmap-ipc.ts`'s
 * `loadBoardTemplate`, so board templates need no push event at all — the next
 * read just sees the live map). Mirrors `detect/screen-detect.ts`'s shell shape
 * one level up: one shared watcher fans out to every `contributes` consumer
 * instead of one watcher per surface (ADR-0002 §2.2).
 *
 * `depth: 1` on the chokidar watch covers both structural changes this loader
 * cares about — a manifest.json edited, or a whole extension folder
 * added/removed — without recursing into `templates/*.md` or `modes/*.md`
 * content files: those are read fresh on every request (no caching), so an
 * edit to a template's CONTENT is hot already, with no watcher event needed.
 */

/**
 * `~/.claude/capy-extensions` — where users drop `<id>/manifest.json` extension folders. The
 * directory name is the pre-rename one and is kept on purpose: it is a real on-disk path users
 * already have packs in, so renaming it would orphan them.
 */
export function extensionsDir(): string {
  return join(homedir(), '.claude', 'capy-extensions')
}

let registry: ExtensionRegistry = { themes: [], boardTemplates: new Map(), modes: [] }

/** Read-only view of the current extension themes (renderer pulls this via IPC). */
export function getExtensionThemes(): readonly ExtensionTheme[] {
  return registry.themes
}

/** The absolute path an extension overrides `kind`'s board template with, or `null`. */
export function getExtensionBoardTemplatePath(kind: CardKind): string | null {
  return registry.boardTemplates.get(kind)?.absolutePath ?? null
}

/** Read-only view of the current extension mode contributions (T138). */
export function getExtensionModes(): readonly ResolvedExtensionMode[] {
  return registry.modes
}

/**
 * The builtin `SESSION_MODES` ∪ every installed extension's `contributes.modes`,
 * in the shape the renderer's `Modes ▸` submenu needs (T138) — this is what
 * replaces `FolderMenu.vue`'s compile-time `import { SESSION_MODES } from
 * '../../../main/session-modes'` (the study's identified gap): builtins now
 * travel over IPC too, not just extension contributions, since the point is
 * removing the cross-process source import entirely. Builtins first (menu
 * order, mirrors the detector triad's builtins-then-overrides precedence).
 */
export interface SessionModeWire {
  id: string
  /** Set for builtins — the renderer resolves this via `$t()`. */
  labelKey?: string
  /** Set for extension modes — a plain, self-localizing string (ADR-0002 §2). */
  label?: string
  icon: string
  origin: 'builtin' | 'extension'
  extensionId?: string
  extensionLabel?: string
}

export function listSessionModes(): SessionModeWire[] {
  return [
    ...SESSION_MODES.map((m) => ({
      id: m.id,
      labelKey: m.labelKey,
      icon: m.icon,
      origin: 'builtin' as const
    })),
    ...registry.modes.map((m) => ({
      id: m.id,
      label: m.label,
      icon: m.icon,
      origin: 'extension' as const,
      extensionId: m.extensionId,
      extensionLabel: m.extensionLabel
    }))
  ]
}

/**
 * Resolve `id`'s contract text — a builtin resolves instantly from memory
 * (`modeContract`); an extension mode's `.md` is read FRESH from disk on
 * every call (no caching, matching `getExtensionBoardTemplatePath`'s callers)
 * so an edit to the doc is hot with no watcher event needed. Never throws: an
 * unknown id, or a doc file that's gone missing, degrades to `''` — the exact
 * invariant `modeContract` already has for an unknown builtin id.
 */
export async function resolveModeContract(id: string | undefined): Promise<string> {
  if (isSessionModeId(id)) return modeContract(id)
  if (!id) return ''
  const ext = registry.modes.find((m) => m.id === id)
  if (!ext) return ''
  try {
    return await readFile(ext.docPath, 'utf8')
  } catch {
    return ''
  }
}

/** Test-only seam: inject a registry without going through the chokidar shell. */
export function __setRegistryForTest(r: ExtensionRegistry): void {
  registry = r
}

/**
 * Scan every immediate subdirectory of `dir` for a `manifest.json`. Best-effort
 * per entry: a missing/unreadable/non-JSON manifest yields `raw: undefined`
 * (the registry fold logs + skips it) rather than aborting the whole scan.
 */
async function scanExtensions(dir: string): Promise<ScannedExtension[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return [] // dir absent → no extensions installed
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  dirs.sort() // deterministic fold order (last-wins on a board-template kind collision)
  const out: ScannedExtension[] = []
  for (const id of dirs) {
    const dirPath = join(dir, id)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(join(dirPath, 'manifest.json'), 'utf8'))
    } catch {
      raw = undefined
    }
    out.push({ id, dirPath, raw })
  }
  return out
}

let watcher: FSWatcher | null = null
const RELOAD_DEBOUNCE_MS = 100
let reloadTimer: NodeJS.Timeout | null = null

/** Recompile the registry from disk and notify the renderer's theme store. */
async function reloadRegistry(getWindow: () => BrowserWindow | null): Promise<void> {
  const scanned = await scanExtensions(extensionsDir())
  registry = buildExtensionRegistry(scanned, (reason) => console.error(`[extensions] ${reason}`))
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('extensions:themes-changed')
    // T138: modes can change independently of themes (a pack contributing
    // only modes), so this fires on every reload alongside the theme event
    // rather than being folded into it.
    win.webContents.send('modes:changed')
  }
}

/** Register the extension loader: boot-time scan + live chokidar hot-reload + the theme IPCs. */
export function registerExtensionsHandlers(getWindow: () => BrowserWindow | null): void {
  void (async () => {
    const dir = extensionsDir()
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      /* can't create the dir — extensions just won't be available */
    }
    await reloadRegistry(getWindow)
    watcher = chokidar.watch(dir, {
      depth: 1,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 }
    })
    const onChange = (): void => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = null
        void reloadRegistry(getWindow)
      }, RELOAD_DEBOUNCE_MS)
    }
    watcher
      .on('add', onChange)
      .on('change', onChange)
      .on('unlink', onChange)
      .on('unlinkDir', onChange)
  })().catch((err) => console.error('[extensions] watch setup failed:', err))

  ipcMain.handle('extensions:listThemes', () => getExtensionThemes())
  // T138: the merged builtin ∪ extension modes list — see `listSessionModes`.
  ipcMain.handle('modes:list', () => listSessionModes())
}

/** Close the extension watcher on quit/teardown. */
export function closeExtensionsWatcher(): void {
  if (reloadTimer) {
    clearTimeout(reloadTimer)
    reloadTimer = null
  }
  registry = { themes: [], boardTemplates: new Map(), modes: [] }
  if (watcher) {
    const w = watcher
    watcher = null
    void w.close().catch(() => {})
  }
}
