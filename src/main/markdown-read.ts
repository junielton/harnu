import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { isPathAllowed } from './settings'
import { readUserProjects } from './user-projects'
import { scanFolders } from './claude-reader'
import {
  MAX_MARKDOWN_BYTES,
  BINARY_SNIFF_BYTES,
  classifyFileKind,
  imageMimeType,
  type MarkdownDenyCode
} from './markdown-core'

/**
 * Confined file reader (T74 S1; broadened by Cluster G to ANY text file). A
 * renderer/agent hands us an absolute path; we read its UTF-8 contents ONLY
 * when the path is contained by one of Harnu's *known folders* (the pinned
 * folders + the scanned `~/.claude` roots — the SAME source the MCP gate uses
 * in `server.ts`), fits under a size cap, and doesn't look binary (a NUL-byte
 * sniff of the first {@link BINARY_SNIFF_BYTES} bytes — Cluster G).
 *
 * This follows the precedent shape of `session:digest` (`session-ops.ts`): an
 * absolute path → confine → `{ ok, ... }` envelope. It is deliberately NOT the
 * same reader: digest confines to a single hardcoded root
 * (`~/.claude/projects/`) and tails JSONL; here the allowed roots are dynamic
 * (whatever the operator pinned / Harnu discovered) and we read the whole file.
 *
 * Containment reuses the pure, already-tested helpers from `settings.ts`
 * (`isPathAllowed` → `isPathWithinRoot` → `path.relative`), so `..` traversal,
 * absolute re-roots, and false-positive prefixes (`projects-other/`) are all
 * rejected without a bespoke check. Cluster G retired the `.md`/`.markdown`/
 * `.txt` extension ALLOWLIST that used to gate admission here — any file can be
 * opened as text now; only its CONTENT (binary sniff) and size still refuse it.
 * The size cap + deny vocabulary + binary sniff live in the pure
 * `markdown-core.ts` (shared with the confined writer and the `open_file` MCP
 * validator); they are re-exported here so the existing S1 containment tests
 * keep their import surface.
 */

export {
  PROSE_EXTENSIONS,
  CANVAS_SUFFIX,
  MAX_MARKDOWN_BYTES,
  BINARY_SNIFF_BYTES,
  isProseExt,
  isCanvasPath,
  looksBinary,
  classifyFileKind,
  imageMimeType,
  type MarkdownDenyCode
} from './markdown-core'

export interface MarkdownReadOk {
  ok: true
  /** The resolved absolute path actually read (relative `base` inputs are resolved here). */
  path: string
  /**
   * How `content` is encoded: `text` = full UTF-8 file contents; `image` = a
   * `data:<mime>;base64,…` URL for an `<img>` src (the image fast-path —
   * common image extensions render inline instead of the binary refusal; the
   * renderer CSP already allows `img-src data:`, while `file://` would be
   * blocked).
   */
  kind: 'text' | 'image'
  /** Full UTF-8 file contents (`kind: 'text'`) or a data: URL (`kind: 'image'`). */
  content: string
}
export interface MarkdownReadErr {
  ok: false
  code: MarkdownDenyCode
  /** Short human-readable reason (English fallback; the renderer localizes by `code`). */
  error: string
}
export type MarkdownReadResult = MarkdownReadOk | MarkdownReadErr

/**
 * Pure gate — is this ALREADY-RESOLVED absolute path allowed to be read?
 * Cluster G narrowed this to root-containment ONLY — the extension allowlist
 * that used to live here (`hasAllowedMarkdownExt`) is gone; any path can be
 * opened as text now, and only the binary sniff (content, checked once the
 * bytes are on hand) or the size cap can still refuse it. Exported for unit
 * tests (containment: `..`, absolute, false-positive prefix).
 */
export function checkMarkdownReadAllowed(
  resolvedPath: string,
  roots: string[]
): { ok: true } | { ok: false; code: Extract<MarkdownDenyCode, 'outside-roots'> } {
  if (!isPathAllowed(resolvedPath, roots)) return { ok: false, code: 'outside-roots' }
  return { ok: true }
}

/** English fallbacks — the renderer keys its own localized copy off `code`. */
const DENY_MESSAGE: Record<MarkdownDenyCode, string> = {
  'invalid-path': 'invalid path',
  'outside-roots': 'refusing to read outside the known Harnu folders',
  binary: 'refusing to open a binary file as text',
  'too-large': 'file is too large to preview',
  'not-found': 'file not found',
  'read-failed': 'failed to read file',
  'write-failed': 'failed to write file'
}

function deny(code: MarkdownDenyCode): MarkdownReadErr {
  return { ok: false, code, error: DENY_MESSAGE[code] }
}

/**
 * The live known-folder roots: pinned user folders + scanned roots. Same policy
 * source as the MCP gate (`readUserProjects()` + `scanFolders()`), so a folder
 * the operator can see in the sidebar is exactly one the viewer can read from.
 * Exported so the confined WRITER (`markdown-write.ts`) and the `open_file` MCP
 * verb (`mcp/server.ts`) confine against the exact same root set as the reader.
 */
export async function markdownKnownRoots(): Promise<string[]> {
  const [projectsFile, folders] = await Promise.all([readUserProjects(), scanFolders()])
  return [...projectsFile.projects.map((p) => p.path), ...folders.map((f) => f.path)]
}

/**
 * Read `rawPath` (optionally resolved against `base` when it is a relative link
 * from an already-open document). Returns the confined `{ ok, kind, content,
 * path }` envelope. Any relative `base` input is resolved with `path.resolve`,
 * then the FINAL resolved path is re-confined — a malicious `base` can't escape
 * the roots. Cluster G: any (non-binary, under-cap) file is readable now — the
 * content is sniffed for a NUL byte in its first {@link BINARY_SNIFF_BYTES}
 * bytes and refused as `binary` before it's ever decoded as UTF-8. Image
 * fast-path: a common image extension skips the sniff and comes back as
 * `kind: 'image'` with a base64 data: URL (same size cap), so the viewer can
 * render it instead of refusing.
 */
export async function readMarkdownFile(
  rawPath: string,
  base?: string
): Promise<MarkdownReadResult> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return deny('invalid-path')
  const resolved =
    typeof base === 'string' && base.length > 0 ? resolve(base, rawPath) : resolve(rawPath)

  const gate = checkMarkdownReadAllowed(resolved, await markdownKnownRoots())
  if (!gate.ok) return deny(gate.code)

  let size: number
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return deny('not-found')
    size = stat.size
  } catch {
    return deny('not-found')
  }
  if (size > MAX_MARKDOWN_BYTES) return deny('too-large')

  let buf: Buffer
  try {
    buf = await fs.readFile(resolved)
  } catch {
    return deny('read-failed')
  }
  const kind = classifyFileKind(resolved, buf.subarray(0, Math.min(buf.length, BINARY_SNIFF_BYTES)))
  if (kind === 'binary') return deny('binary')
  if (kind === 'image') {
    // The size cap above already bounds the payload (2 MB → ~2.7 MB base64).
    const mime = imageMimeType(resolved) as string
    return {
      ok: true,
      path: resolved,
      kind,
      content: `data:${mime};base64,${buf.toString('base64')}`
    }
  }
  // `text` and `canvas` both come back as UTF-8 text: this envelope's `kind`
  // describes the ENCODING the renderer must decode, not which pane hosts the
  // file. Canvas ROUTING happens before this reader is ever reached (the
  // suffix match in the renderer's pane host, T218 U4), and `DiagramPane` reads
  // its document through the confined `canvas:read` gate — so a canvas path
  // that does arrive here (an explicit text read) still reads as text rather
  // than being refused.
  return { ok: true, path: resolved, kind: 'text', content: buf.toString('utf8') }
}

export function registerMarkdownReadHandlers(): void {
  ipcMain.handle(
    'markdown:read',
    (_e, args: { path: string; base?: string }): Promise<MarkdownReadResult> => {
      const { path, base } = args ?? ({} as { path: string; base?: string })
      return readMarkdownFile(path, base)
    }
  )
}
