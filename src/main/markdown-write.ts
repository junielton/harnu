import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { MAX_MARKDOWN_BYTES, type MarkdownDenyCode } from './markdown-core'
import { checkMarkdownReadAllowed, markdownKnownRoots } from './markdown-read'
import { suppressNextChange } from './markdown-watch'

/**
 * Confined file WRITER (T74 phase 2 — edit/create files in the app; broadened
 * by Cluster G to any text file, not just markdown). Writing is the most
 * sensitive surface of this feature, so it MIRRORS the read containment
 * exactly (same known-folder roots, same size cap) and adds nothing looser:
 *
 *  - **Containment** reuses `checkMarkdownReadAllowed` + `markdownKnownRoots`
 *    from the reader — a single source of truth. `..` traversal, absolute
 *    re-roots, and false-positive prefixes (`harnu-secrets/`) are rejected before
 *    a single byte is written; a path outside the known folders can NEVER be
 *    created or overwritten.
 *  - **Extension** is NO LONGER gated (Cluster G) — the writer always persists a
 *    UTF-8 string from the editor, so there's no binary content to refuse here
 *    (the binary sniff only applies to READS of pre-existing files).
 *  - **Size cap** — refuse to persist more than {@link MAX_MARKDOWN_BYTES} so the
 *    viewer stays reproducible and a runaway buffer can't fill the disk.
 *  - **Atomic** — write to a `.tmp` sibling then `rename` (like `helpers-store`),
 *    so a crash mid-write never truncates the operator's file.
 *
 * The writer is INTENTIONALLY narrow: it takes a single absolute path + the full
 * new UTF-8 content and replaces the file. It creates a NEW file (used by the
 * "New markdown" flow) or overwrites an EXISTING one in place; it never appends,
 * moves, or deletes, and never touches anything outside the known roots.
 */

export interface MarkdownWriteOk {
  ok: true
  /** The resolved absolute path actually written. */
  path: string
  /** Bytes written (UTF-8). */
  bytes: number
}
export interface MarkdownWriteErr {
  ok: false
  code: MarkdownDenyCode
  /** Short human-readable reason (English fallback; the renderer localizes by `code`). */
  error: string
}
export type MarkdownWriteResult = MarkdownWriteOk | MarkdownWriteErr

/** English fallbacks — the renderer keys its own localized copy off `code`. */
const DENY_MESSAGE: Record<MarkdownDenyCode, string> = {
  'invalid-path': 'invalid path',
  'outside-roots': 'refusing to write outside the known Harnu folders',
  binary: 'refusing to write binary content',
  'too-large': 'refusing to write a file this large',
  'not-found': 'file not found',
  'read-failed': 'failed to read file',
  'write-failed': 'failed to write file'
}

function deny(code: MarkdownDenyCode): MarkdownWriteErr {
  return { ok: false, code, error: DENY_MESSAGE[code] }
}

/**
 * Write `content` to `rawPath` when — and only when — the resolved path is
 * contained by the known Harnu folders and the content fits under the size cap
 * (Cluster G: no extension gate — any path can be written). Returns the confined `{ ok, path, bytes }`
 * envelope (or `{ ok:false, code, error }`). Creates the file if absent,
 * overwrites in place if present; both cases go through the SAME containment.
 */
export async function writeMarkdownFile(
  rawPath: string,
  content: string
): Promise<MarkdownWriteResult> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return deny('invalid-path')
  if (typeof content !== 'string') return deny('invalid-path')
  const resolved = resolve(rawPath)

  const gate = checkMarkdownReadAllowed(resolved, await markdownKnownRoots())
  if (!gate.ok) return deny(gate.code)

  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_MARKDOWN_BYTES) return deny('too-large')

  // Atomic replace: write a sibling temp, then rename over the target. A crash
  // between the two leaves the original intact (never a half-written file).
  const tmp = `${resolved}.harnu-tmp`
  try {
    await fs.writeFile(tmp, content, 'utf8')
    suppressNextChange(resolved)
    await fs.rename(tmp, resolved)
    return { ok: true, path: resolved, bytes }
  } catch {
    await fs.unlink(tmp).catch(() => {})
    return deny('write-failed')
  }
}

export function registerMarkdownWriteHandlers(): void {
  ipcMain.handle(
    'markdown:write',
    (_e, args: { path: string; content: string }): Promise<MarkdownWriteResult> => {
      const { path, content } = args ?? ({} as { path: string; content: string })
      return writeMarkdownFile(path, content)
    }
  )
}
