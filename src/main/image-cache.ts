import { join, resolve, sep } from 'node:path'
import { readdir, stat, readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { ipcMain, clipboard, nativeImage } from 'electron'
import {
  IMAGE_NAME_RE,
  UUID_RE,
  claudeTmpRoot,
  findTmpImageDirs,
  resolveTmpImageFile
} from './claude-tmp-images'

/**
 * Pasted-images gallery — reads the PNGs Claude Code saves when you paste a
 * screenshot. Two locations, merged (BUG-149):
 *   - PRIMARY (newer CLIs): `<os.tmpdir()>/claude-<uid>/<slug>/<session-uuid>/images/<n>.png`
 *     — see `claude-tmp-images.ts` (shape-exact, realpath-confined).
 *   - LEGACY (older CLIs): `~/.claude/image-cache/<session-uuid>/<n>.png`.
 * Same session in both → deduped by filename, the tmp copy wins.
 *
 * Read-only and ephemeral: the gallery lists what's on disk at open time and
 * never writes into either location (Claude Code prunes them itself).
 *
 * This file is split pure-core / thin-shell (ADR-0001):
 *   - PURE CORE below (no electron/fs) — path-traversal defense + sort, the risk
 *     surface, fully unit-tested (`tests/image-cache.test.ts`).
 *   - SHELL further down — fs I/O + the `registerImageCache` IPC registrar.
 *
 * Config-dir is hardcoded to `~/.claude` for parity with the rest of the main
 * process (`claude-reader.ts`, `claude-watcher.ts`, `session-ops.ts` all
 * hardcode it — there is no `CLAUDE_CONFIG_DIR` support in the app today).
 */

// ── Pure core ────────────────────────────────────────────────────────────────

/** Root of the image cache for a given home dir. Injectable for tests. */
export function imageCacheRoot(homeDir: string): string {
  return join(homeDir, '.claude', 'image-cache')
}

/**
 * Validate that `uuid` is a uuid and `name` is `<digits>.png` (no path
 * separators), then resolve the absolute path ONLY if it stays confined inside
 * `imageCacheRoot`. Returns null on any invalid/escaping input — never throws.
 * The core of the path-traversal defense (lesson security/001): a forged
 * `../../etc/passwd` is rejected before any fs touch.
 */
export function resolveImagePath(homeDir: string, uuid: string, name: string): string | null {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) return null
  if (typeof name !== 'string' || !IMAGE_NAME_RE.test(name)) return null
  const root = resolve(imageCacheRoot(homeDir))
  const candidate = resolve(join(root, uuid, name))
  // Belt-and-suspenders: the regexes already forbid separators/`..`, but
  // `resolve` collapses any survivor and the trailing `sep` rejects a sibling
  // root (`…/image-cache-other/`) the naive prefix check would let through.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  return candidate
}

/**
 * Order filenames by their numeric stem, NEWEST FIRST (`7.png` before `1.png`)
 * — Claude's counter is chronological. Non-numeric names sort to the end,
 * stable. Pure: lexicographic sort would put `10.png` before `2.png`; this
 * doesn't.
 */
export function sortImagesNewestFirst(names: string[]): string[] {
  const stemOf = (n: string): number | null => {
    const m = IMAGE_NAME_RE.test(n) ? /^(\d+)\.png$/i.exec(n) : null
    return m ? Number.parseInt(m[1], 10) : null
  }
  return names
    .map((name, index) => ({ name, index, stem: stemOf(name) }))
    .sort((a, b) => {
      if (a.stem !== null && b.stem !== null) return b.stem - a.stem
      if (a.stem !== null) return -1
      if (b.stem !== null) return 1
      return a.index - b.index // both non-numeric: keep original order
    })
    .map((e) => e.name)
}

// ── Shell (fs I/O + IPC) ─────────────────────────────────────────────────────

export interface ImageEntry {
  /** Filename, e.g. `7.png`. */
  name: string
  /** Absolute path, built in main — never trusted from the renderer. */
  path: string
  bytes: number
  mtimeMs: number
}

/** `readdir` + `stat` one directory into entries (unsorted). Never throws. */
async function entriesIn(dir: string): Promise<ImageEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return [] // ENOENT (no prints yet) or any read error → empty
  }
  const pngs = names.filter((n) => IMAGE_NAME_RE.test(n))
  const entries = await Promise.all(
    pngs.map(async (name): Promise<ImageEntry | null> => {
      const path = join(dir, name)
      try {
        const st = await stat(path)
        return { name, path, bytes: st.size, mtimeMs: st.mtimeMs }
      } catch {
        // Pruned between readdir and stat (the cache is live) → drop this one
        // rather than rejecting the whole list, so the pill never flashes to 0.
        return null
      }
    })
  )
  return entries.filter((e): e is ImageEntry => e !== null)
}

/**
 * List the PNGs cached for a session, newest-first, merged across the tmp root
 * (`tmpRoot`, primary) and the legacy `~/.claude/image-cache` — deduped by
 * filename, the tmp copy winning. `tmpRoot` omitted/null → legacy only. fs-only
 * (no electron) so it's directly unit-testable. Never throws: a missing
 * directory (the session has no prints) resolves to `[]`. The `path` is built
 * here in main, so the renderer never supplies it.
 */
export async function listImages(
  homeDir: string,
  uuid: string,
  tmpRoot?: string | null
): Promise<ImageEntry[]> {
  if (!UUID_RE.test(uuid)) return []
  const tmpDirs = tmpRoot ? await findTmpImageDirs(tmpRoot, uuid) : []
  const groups = await Promise.all([
    ...tmpDirs.map((d) => entriesIn(d)),
    entriesIn(join(imageCacheRoot(homeDir), uuid))
  ])
  const byName = new Map<string, ImageEntry>()
  for (const group of groups) for (const e of group) if (!byName.has(e.name)) byName.set(e.name, e)
  const order = sortImagesNewestFirst([...byName.keys()])
  return order.map((n) => byName.get(n)!)
}

/**
 * Resolve `<uuid>/<name>` to the file to read: the tmp root first (realpath-
 * confined), else the legacy path. Null on any invalid/escaping input.
 */
export async function resolveImageFile(
  homeDir: string,
  uuid: string,
  name: string,
  tmpRoot?: string | null
): Promise<string | null> {
  if (tmpRoot) {
    const t = await resolveTmpImageFile(tmpRoot, uuid, name)
    if (t !== null) return t
  }
  return resolveImagePath(homeDir, uuid, name)
}

/**
 * Read one cached PNG as a `data:image/png;base64,…` URL (rendered directly —
 * CSP already allows `data:`). Throws on an invalid/escaping name so the read
 * never touches an out-of-root file (the renderer catches per-thumbnail).
 */
export async function readImageDataUrl(
  homeDir: string,
  uuid: string,
  name: string,
  tmpRoot?: string | null
): Promise<string> {
  const p = await resolveImageFile(homeDir, uuid, name, tmpRoot)
  if (p === null) throw new Error('invalid image path')
  const buf = await readFile(p)
  return 'data:image/png;base64,' + buf.toString('base64')
}

/**
 * Register the Pasted-images IPC handlers (house pattern; called from
 * `index.ts` at boot). Stateless — no teardown. Every handler validates its
 * input and builds the path in main (lesson security/001).
 */
export function registerImageCache(): void {
  // Resolved per call (not at import) so a changed TMPDIR is honoured.
  const tmpRoot = (): string | null => claudeTmpRoot(tmpdir())

  ipcMain.handle('imageCache:list', async (_e, uuid: string): Promise<ImageEntry[]> => {
    if (typeof uuid !== 'string') return []
    return listImages(homedir(), uuid, tmpRoot())
  })

  ipcMain.handle(
    'imageCache:read',
    async (_e, args: { uuid: string; name: string }): Promise<string> => {
      const { uuid, name } = args ?? {}
      return readImageDataUrl(homedir(), uuid, name, tmpRoot())
    }
  )

  ipcMain.handle(
    'imageCache:copy',
    async (_e, args: { uuid: string; name: string }): Promise<{ ok: boolean }> => {
      try {
        const { uuid, name } = args ?? {}
        const p = await resolveImageFile(homedir(), uuid, name, tmpRoot())
        if (p === null) return { ok: false }
        const img = nativeImage.createFromPath(p)
        if (img.isEmpty()) return { ok: false }
        clipboard.writeImage(img)
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  )
}
