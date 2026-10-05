import { ipcMain } from 'electron'
import { dirname, resolve } from 'node:path'
import { atomicWriteFile } from './mcp/atomic-write'
import { markdownKnownRoots } from './markdown-read'
import { checkCanvasPathAllowed } from './canvas-read'
import { suppressNextCanvasChange } from './canvas-watch'
import {
  MAX_CANVAS_BYTES,
  serializeCanvasDocument,
  validateCanvasDocument,
  type CanvasDenyCode
} from './canvas-core'
import { mkdirDataDir } from './data-dir'

/**
 * Confined canvas WRITER (T218 U1). Writing is the sensitive half of the seam,
 * so it MIRRORS the reader's containment exactly (same known-folder roots, same
 * suffix gate, same size cap) and adds nothing looser:
 *
 *  - **Containment** reuses `checkCanvasPathAllowed` — one source of truth with
 *    the reader. A path outside the known folders can NEVER be created or
 *    overwritten, and it is REFUSED with a code rather than clamped into an
 *    allowed directory (§4.2).
 *  - **Validation before bytes** — the document is validated by the pure core
 *    (§4.3, §4.4, §4.7) BEFORE anything touches the disk, so a Save that fails
 *    validation writes nothing at all (§7.2, U3 AC-9). The payload arrives over
 *    IPC from the renderer, which is untrusted from main's perspective, so it is
 *    validated here even though the pane validates it too.
 *  - **Atomic** — `atomicWriteFile` (temp sibling + `rename`), the same helper
 *    the MCP server already uses. An interrupted write leaves the PREVIOUS file
 *    completely intact; a reader racing the rename sees the old or the new
 *    document, never a truncated one (§7.2).
 *  - **Self-write suppression** — armed immediately before the rename, so the
 *    chokidar `change` event our own Save fires does not loop back to the pane
 *    that just saved as a false "changed on disk" push (§7.3).
 *
 * The writer is intentionally narrow: one absolute path + one whole document,
 * replacing the file. It never appends, moves or deletes.
 */

export interface CanvasWriteOk {
  ok: true
  /** The resolved absolute path actually written. */
  path: string
  /** Bytes written (UTF-8). */
  bytes: number
}
export interface CanvasWriteErr {
  ok: false
  code: CanvasDenyCode
  error: string
}
export type CanvasWriteResult = CanvasWriteOk | CanvasWriteErr

const DENY_MESSAGE: Record<string, string> = {
  'invalid-path': 'not a canvas file (expected a path ending in .harnucanvas.json)',
  'outside-roots': 'refusing to write outside the known Harnu folders',
  'too-large': 'refusing to write a canvas file this large',
  'write-failed': 'failed to write canvas file'
}

function deny(code: CanvasDenyCode, error?: string): CanvasWriteErr {
  return { ok: false, code, error: error ?? DENY_MESSAGE[code] ?? code }
}

/**
 * Write `doc` to `rawPath` when — and only when — the resolved path is a
 * `.harnucanvas.json` (or legacy `.capycanvas.json`) contained by the known Harnu folders, the document is
 * valid, and the SERIALIZED bytes fit under the cap. Creates the file (and its
 * parent directory — the default `.harnu/out/canvas/` will not exist on a fresh
 * worktree) if absent, replaces it in place if present; both go through the
 * same gate.
 *
 * `doc` is typed `unknown` on purpose: this is a trust boundary, and the pure
 * validator is the only thing allowed to decide the payload is a document.
 */
export async function writeCanvasFile(rawPath: string, doc: unknown): Promise<CanvasWriteResult> {
  if (typeof rawPath !== 'string' || rawPath.length === 0)
    return deny('invalid-path', 'invalid path')
  const resolved = resolve(rawPath)

  const gate = checkCanvasPathAllowed(resolved, await markdownKnownRoots())
  if (!gate.ok) return deny(gate.code)

  const validated = validateCanvasDocument(doc)
  if (!validated.ok) return { ok: false, code: validated.code, error: validated.error }

  const body = serializeCanvasDocument(validated.doc)
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > MAX_CANVAS_BYTES) {
    return deny('too-large', `canvas document is ${bytes} bytes; the cap is ${MAX_CANVAS_BYTES}`)
  }

  try {
    await mkdirDataDir(dirname(resolved))
  } catch {
    return deny('write-failed')
  }

  try {
    // Arm the suppression BEFORE the write: `atomicWriteFile`'s rename is what
    // chokidar reports, and arming after it would race the event.
    suppressNextCanvasChange(resolved)
    await atomicWriteFile(resolved, body, 0o644)
    return { ok: true, path: resolved, bytes }
  } catch {
    // The temp file is already cleaned up by `atomicWriteFile`; the previous
    // file — if any — was never touched, because the rename never landed.
    return deny('write-failed')
  }
}

export function registerCanvasWriteHandlers(): void {
  ipcMain.handle(
    'canvas:write',
    (_e, args: { path: string; doc: unknown }): Promise<CanvasWriteResult> => {
      const { path, doc } = args ?? ({} as { path: string; doc: unknown })
      return writeCanvasFile(path, doc)
    }
  )
}
