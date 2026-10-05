import { ipcMain } from 'electron'
import { constants as fsConstants, promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { markdownKnownRoots } from './markdown-read'
import { checkCanvasPathAllowed } from './canvas-read'
import { CANVAS_SUFFIX, canvasStem } from './canvas-core'
import { claudeTmpRoot, confirmTmpImageSource } from './claude-tmp-images'
import { canvasAssetsDir, planCanvasAssets, MAX_CANVAS_IMAGES_PER_CALL } from './mcp/canvas-ops'
import {
  buildCardAssetFilename,
  resolveCardAssetDestination,
  CARD_ASSET_MAX_BYTES
} from './roadmap-core'
import { mkdirDataDir } from './data-dir'

/**
 * Canvas ASSET externalisation (T218 U6, spec §4.6). One implementation, two
 * callers: the `draw_canvas` verb (which hands it validated path sources) and
 * the pane's paste/drop path (which hands it clipboard bytes over IPC).
 *
 * **Why this file exists at all.** §4.6 says operator paste and drag-drop
 * "land in the same `assets/` directory through the same server-side path" as
 * the agent's images. Before U6 that server-side path lived inside
 * `mcp/tool-handlers.ts` as a private function, reachable only from an MCP
 * call. Leaving it there and writing a second copier for the pane is exactly
 * the fork the spec warns against — two implementations of "never overwrite an
 * earlier attach" that can disagree. So the copier moved here, `tool-handlers`
 * imports it, and both sides are now the same bytes on the same rules.
 *
 * **The failure this whole file prevents (live loop test, finding 3).** A
 * 1,486-byte pasted image became a 2,006-byte data URI and grew the canvas file
 * by ~4.5 KB. A real screenshot is megabytes, and every Save rewrites the whole
 * file (§7.2), so the cost is paid on every Save rather than once. An image
 * node stores `assets/<file>`; image bytes never enter the canvas file.
 *
 * **The rules are the Harnu board's card-`images` handling, copied rather than
 * redesigned** (§4.6's table maps them one-to-one): a source jail, a
 * server-generated destination filename, a destination jail against traversal,
 * validate-all-before-copying-any, `COPYFILE_EXCL` with an index retry, and the
 * board's own 6-per-call / 2 MB caps.
 */

/** Per-image cap for a canvas asset — the board's, verbatim (§4.6, §4.7). */
export const CANVAS_ASSET_MAX_BYTES = CARD_ASSET_MAX_BYTES

/**
 * MIME → extension for clipboard bytes.
 *
 * Bytes pasted out of a clipboard event have no filename, so the extension —
 * which is what the whole image gate is expressed in (`imageMimeType`) — has to
 * come from the item's MIME type instead. This table is the ONLY place that
 * inversion exists, and a test asserts every extension here maps back through
 * `imageMimeType` to the MIME it came from, so the two can never drift.
 */
const EXT_BY_IMAGE_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/x-icon': '.ico'
}

/** Pure: the extension a clipboard MIME type maps to, or `null` when it is not
 *  an image type this build can externalise. Parameters like `image/png;
 *  charset=binary` are trimmed; the match is case-insensitive. */
export function imageExtForMime(mime: unknown): string | null {
  if (typeof mime !== 'string') return null
  const bare = mime.split(';')[0].trim().toLowerCase()
  return EXT_BY_IMAGE_MIME[bare] ?? null
}

/**
 * One asset to place. `source` (copy a file) and `bytes` (write a clipboard
 * payload) are mutually exclusive; `raw` is what the caller named it, echoed in
 * refusals only, and `ext` is the already-validated extension. A
 * `PlannedCanvasAsset` from `planCanvasAssets` satisfies this structurally,
 * which is what keeps the verb on this code path unchanged.
 */
export interface CanvasAssetItem {
  readonly source?: string
  /** Set for a source the jail accepted under the Claude tmp images root — `copyCanvasAssets` realpath-confirms it (BUG-149). */
  readonly tmpRoot?: string
  readonly bytes?: Uint8Array
  readonly ext: string
  readonly raw: string
}

export type CopyCanvasAssetsResult =
  { ok: true; srcs: string[] } | { ok: false; code: string; message: string }

/**
 * Place every item in `assetsDir`, exclusively (`COPYFILE_EXCL` / the `wx`
 * open flag, retrying the index on `EEXIST`) so a later attach never overwrites
 * an earlier one, and **validate every item before writing any of them** (§4.6:
 * no partial attach on disk). Each item's extension and — for a path source —
 * its jail were already decided by the caller; what needs `fs` (existence,
 * size, the write) is what lives here.
 *
 * Returns the relative `assets/<file>` strings, in call order — exactly what a
 * node's `props.src` carries.
 */
export async function copyCanvasAssets(
  assetsDir: string,
  canvasName: string,
  items: readonly CanvasAssetItem[]
): Promise<CopyCanvasAssetsResult> {
  // ---- validate ALL, write NONE ------------------------------------------
  // Tmp-root sources are copied from their REAL path, after the symlink check.
  const realSource = new Map<CanvasAssetItem, string>()
  for (const a of items) {
    if (a.bytes) {
      if (a.bytes.byteLength > CANVAS_ASSET_MAX_BYTES) {
        return {
          ok: false,
          code: 'IMAGE_TOO_LARGE',
          message: `image "${a.raw}" is ${a.bytes.byteLength} bytes — cap is ${CANVAS_ASSET_MAX_BYTES} bytes (~2 MB).`
        }
      }
      continue
    }
    if (!a.source) {
      return {
        ok: false,
        code: 'BAD_ARGS',
        message: `image "${a.raw}" has no source and no bytes.`
      }
    }
    if (a.tmpRoot) {
      const real = await confirmTmpImageSource(a.source, a.tmpRoot)
      if (real === null) {
        return {
          ok: false,
          code: 'SOURCE_NOT_ALLOWED',
          message: `image "${a.raw}" is not a genuine pasted image under the Claude tmp images dir.`
        }
      }
      realSource.set(a, real)
    }
    let size: number
    try {
      const st = await fs.stat(realSource.get(a) ?? a.source)
      if (!st.isFile()) throw new Error('not a file')
      size = st.size
    } catch {
      return {
        ok: false,
        code: 'SOURCE_NOT_FOUND',
        message: `image "${a.raw}" does not exist on disk.`
      }
    }
    if (size > CANVAS_ASSET_MAX_BYTES) {
      return {
        ok: false,
        code: 'IMAGE_TOO_LARGE',
        message: `image "${a.raw}" is ${size} bytes — cap is ${CANVAS_ASSET_MAX_BYTES} bytes (~2 MB).`
      }
    }
  }

  // ---- write --------------------------------------------------------------
  await mkdirDataDir(assetsDir)
  const srcs: string[] = []
  let cursor = 1
  for (const a of items) {
    let placed = false
    for (let attempt = 0; attempt < 1000 && !placed; attempt++) {
      const filename = buildCardAssetFilename(canvasName, cursor, a.ext)
      const dest = resolveCardAssetDestination(assetsDir, filename)
      if (!dest) {
        return { ok: false, code: 'WRITE_FAILED', message: `could not place image "${a.raw}".` }
      }
      try {
        // Both branches are EXCLUSIVE creates — `COPYFILE_EXCL` for a copy, the
        // `wx` open flag for bytes. Same guarantee either way: the write fails
        // rather than clobbering an asset an earlier attach already placed.
        if (a.bytes) await fs.writeFile(dest, a.bytes, { flag: 'wx', mode: 0o644 })
        else
          await fs.copyFile(
            realSource.get(a) ?? (a.source as string),
            dest,
            fsConstants.COPYFILE_EXCL
          )
        srcs.push(`assets/${filename}`)
        placed = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          cursor++
          continue
        }
        return { ok: false, code: 'WRITE_FAILED', message: `could not copy image "${a.raw}".` }
      }
    }
    cursor++
    if (!placed) {
      return { ok: false, code: 'WRITE_FAILED', message: `could not place image "${a.raw}".` }
    }
  }
  return { ok: true, srcs }
}

// ---- the pane's paste/drop entry point -------------------------------------

/** What the renderer may hand `canvas:attachAssets`. Clipboard bytes carry a
 *  MIME type (there is no filename to read an extension off); a `path` source
 *  goes through the same jail the verb's images do. */
export type CanvasAttachInput =
  { kind: 'bytes'; mime: string; bytes: Uint8Array; name?: string } | { kind: 'path'; path: string }

export interface CanvasAttachOk {
  ok: true
  /** Relative `assets/<file>` per input, in order — a node's `props.src`. */
  srcs: string[]
}
export interface CanvasAttachErr {
  ok: false
  code: string
  error: string
}
export type CanvasAttachResult = CanvasAttachOk | CanvasAttachErr

function deny(code: string, error: string): CanvasAttachErr {
  return { ok: false, code, error }
}

function withinRoot(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root + sep)
}

/**
 * Externalise the operator's pasted or dropped images next to `rawCanvasPath`
 * (§4.6, §7.1's one exception to "nothing touches the file until Save": asset
 * bytes are written immediately, because they exist only in a clipboard event).
 *
 * The canvas path is confined by the SAME gate the reader and writer use, so
 * the renderer cannot aim `assets/` at an arbitrary directory, and the
 * destination filename is derived from the canvas basename here in main — never
 * from anything the renderer sent.
 *
 * A `path` input is jailed by U5's `planCanvasAssets` (under
 * `~/.claude/image-cache/`, exactly a Claude tmp `…/images/<n>.png`, or inside the folder root that owns this canvas —
 * anything else is refused). The PANE never sends one: it sends bytes it
 * already holds, which is strictly tighter, since supplying bytes is not a way
 * to read a file the sender could not already read. The form exists because the
 * jail is the contract §4.6 states, and it is what makes the two callers one
 * pipeline instead of two.
 */
export async function attachCanvasAssets(
  rawCanvasPath: string,
  inputs: readonly CanvasAttachInput[]
): Promise<CanvasAttachResult> {
  if (typeof rawCanvasPath !== 'string' || rawCanvasPath.length === 0) {
    return deny('invalid-path', 'invalid canvas path')
  }
  if (!Array.isArray(inputs) || inputs.length === 0) {
    return deny('BAD_ARGS', 'no images to attach')
  }
  // §4.7: a cap is a refusal with a code, never a truncation of the batch.
  if (inputs.length > MAX_CANVAS_IMAGES_PER_CALL) {
    return deny('BAD_ARGS', `at most ${MAX_CANVAS_IMAGES_PER_CALL} images per call`)
  }

  const canvasPath = resolve(rawCanvasPath)
  const roots = await markdownKnownRoots()
  const gate = checkCanvasPathAllowed(canvasPath, roots)
  if (!gate.ok) {
    return deny(
      gate.code,
      gate.code === 'invalid-path'
        ? `not a canvas file (expected a path ending in ${CANVAS_SUFFIX})`
        : 'refusing to write outside the known Harnu folders'
    )
  }
  // The folder root that OWNS this canvas is what a `path` source is jailed
  // against — the same "inside the repo folder" arm the board's jail uses.
  const folder = roots.find((r) => withinRoot(canvasPath, resolve(r)))
  if (!folder) return deny('outside-roots', 'refusing to write outside the known Harnu folders')

  const base = basename(canvasPath)
  const canvasName = canvasStem(base)

  // Validate EVERY input before a single byte lands (§4.6). Path sources go
  // through U5's planner so the jail is one implementation, not two.
  const items: CanvasAssetItem[] = []
  const pathInputs: { index: number; path: string }[] = []
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    if (input && input.kind === 'path') {
      if (typeof input.path !== 'string' || input.path.length === 0) {
        return deny('BAD_ARGS', `images[${i}] must be a non-empty absolute path`)
      }
      pathInputs.push({ index: i, path: input.path })
      continue
    }
    if (!input || input.kind !== 'bytes') return deny('BAD_ARGS', `images[${i}] is not an image`)
    const ext = imageExtForMime(input.mime)
    if (ext === null) {
      return deny(
        'SOURCE_NOT_IMAGE',
        `"${input.name ?? input.mime}" is not a recognized image type (png/jpg/jpeg/gif/webp/bmp/svg/ico)`
      )
    }
    const bytes =
      input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes ?? [])
    if (bytes.byteLength === 0) return deny('BAD_ARGS', `images[${i}] is empty`)
    items[i] = { bytes, ext, raw: input.name ?? `pasted image ${i + 1}` }
  }

  if (pathInputs.length > 0) {
    const planned = planCanvasAssets(
      canvasName,
      pathInputs.map((p) => p.path),
      homedir(),
      folder,
      claudeTmpRoot(tmpdir())
    )
    if (!planned.ok) return deny(planned.code, planned.error)
    planned.assets.forEach((a, n) => {
      items[pathInputs[n].index] = {
        source: a.source,
        ext: a.ext,
        raw: a.raw,
        ...(a.tmpRoot ? { tmpRoot: a.tmpRoot } : {})
      }
    })
  }

  const copied = await copyCanvasAssets(canvasAssetsDir(canvasPath), canvasName, items)
  if (!copied.ok) return deny(copied.code, copied.message)
  return { ok: true, srcs: copied.srcs }
}

export function registerCanvasAssetHandlers(): void {
  ipcMain.handle(
    'canvas:attachAssets',
    (
      _e,
      args: { path: string; images: CanvasAttachInput[] }
    ): Promise<CanvasAttachResult> | CanvasAttachResult => {
      const { path, images } = args ?? ({} as { path: string; images: CanvasAttachInput[] })
      return attachCanvasAssets(path, images ?? [])
    }
  )
}

/** The directory a canvas's assets live in — re-exported so the pane's IPC and
 *  the verb name the same place. */
export { canvasAssetsDir }
