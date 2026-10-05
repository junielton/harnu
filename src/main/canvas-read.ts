import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import { checkMarkdownReadAllowed, markdownKnownRoots } from './markdown-read'
import { dataDirReady } from './data-dir'
import { isPathWithinRoot } from './settings'
import {
  CANVAS_SUFFIX,
  MAX_CANVAS_BYTES,
  hasCanvasSuffix,
  parseCanvasDocument,
  type CanvasDenyCode,
  type CanvasDocument
} from './canvas-core'

/**
 * Confined canvas READER (T218 U1). Mirrors `markdown-read.ts` exactly — same
 * known-folder roots, same size cap, same `{ ok, … }` envelope, same
 * "machine-readable code, never a clamp" discipline — and adds the two things a
 * canvas needs on top: the SUFFIX gate (§4.1) and schema validation (§4.3),
 * so nothing above this ever receives a half-understood document.
 *
 * **Containment** reuses the reader's own already-tested helpers
 * (`checkMarkdownReadAllowed` → `isPathAllowed` → `isPathWithinRoot`), so `..`
 * traversal, absolute re-roots and false-positive prefixes (`harnu-secrets/`)
 * are all rejected without a bespoke check, and the roots are the SAME dynamic
 * set the sidebar, the markdown viewer and the MCP gate use.
 *
 * **What this deliberately does NOT gate: the directory.** §4.2 confines the
 * `draw_canvas` VERB to `.harnu/out/canvas/` or `docs/canvas/`; that is a rule
 * about what an agent may write, and it belongs to U5. The reader must stay
 * broader, because the operator can open ANY `*.capycanvas.json` in a known
 * folder from the Explorer pane's eye icon (§6.3), including one they saved
 * into the repo themselves. Narrowing it here would break that path.
 */

export interface CanvasReadOk {
  ok: true
  /** The resolved absolute path actually read (relative `base` inputs are resolved here). */
  path: string
  /** The validated, label-normalized document (§4.3, §4.5). */
  doc: CanvasDocument
}
export interface CanvasReadErr {
  ok: false
  code: CanvasDenyCode
  /** Short human-readable reason (English fallback; the renderer localizes by `code`). */
  error: string
}
export type CanvasReadResult = CanvasReadOk | CanvasReadErr

/** English fallbacks for the codes this shell raises itself; validation codes
 *  arrive from the pure core with their own actionable message. */
const DENY_MESSAGE: Record<string, string> = {
  'invalid-path': `not a canvas file (expected a path ending in ${CANVAS_SUFFIX})`,
  'outside-roots': 'refusing to read outside the known Harnu folders',
  'not-found': 'canvas file not found',
  'too-large': 'canvas file is too large to open',
  'read-failed': 'failed to read canvas file'
}

function deny(code: CanvasDenyCode, error?: string): CanvasReadErr {
  return { ok: false, code, error: error ?? DENY_MESSAGE[code] ?? code }
}

/**
 * Pure gate for an ALREADY-RESOLVED absolute path: it must be inside the known
 * Harnu roots AND carry a canvas suffix (`.harnucanvas.json`, or the legacy `.capycanvas.json`). Exported for unit tests
 * (containment: `..`, absolute re-root, false-positive prefix; suffix: a plain
 * `.json` is not a canvas). Refuses with a code — it never rewrites the path
 * into an allowed one.
 */
export function checkCanvasPathAllowed(
  resolvedPath: string,
  roots: string[]
): { ok: true } | { ok: false; code: Extract<CanvasDenyCode, 'invalid-path' | 'outside-roots'> } {
  if (!hasCanvasSuffix(resolvedPath)) return { ok: false, code: 'invalid-path' }
  const gate = checkMarkdownReadAllowed(resolvedPath, roots)
  if (!gate.ok) return { ok: false, code: 'outside-roots' }
  return { ok: true }
}

/**
 * Read `rawPath` (optionally resolved against `base`) as a canvas document.
 * The FINAL resolved path is what gets confined, so a malicious `base` cannot
 * escape the roots. Order is deliberate — cheap refusals first, bytes last:
 * suffix + containment → `stat` + size cap → read → parse → validate.
 */
export async function readCanvasFile(rawPath: string, base?: string): Promise<CanvasReadResult> {
  if (typeof rawPath !== 'string' || rawPath.length === 0)
    return deny('invalid-path', 'invalid path')
  const resolved =
    typeof base === 'string' && base.length > 0 ? resolve(base, rawPath) : resolve(rawPath)

  const roots = await markdownKnownRoots()
  const gate = checkCanvasPathAllowed(resolved, roots)
  if (!gate.ok) return deny(gate.code)

  // A board saved before the data-dir rename lives in the repo's legacy dir until its
  // first-use copy lands. Wait for that copy (single-flight, no-op once done) for every
  // known root holding this file, so the pane never reports `not-found` for a board that
  // is merely still being brought across.
  await Promise.all(roots.filter((r) => isPathWithinRoot(resolved, r)).map((r) => dataDirReady(r)))

  let size: number
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return deny('not-found')
    size = stat.size
  } catch {
    return deny('not-found')
  }
  // §4.7: exceeding a cap is a refusal, never a truncation — a partial canvas
  // read as if it were whole is exactly the "confidently wrong" failure mode.
  if (size > MAX_CANVAS_BYTES) {
    return deny('too-large', `canvas file is ${size} bytes; the cap is ${MAX_CANVAS_BYTES}`)
  }

  let text: string
  try {
    text = await fs.readFile(resolved, 'utf8')
  } catch {
    return deny('read-failed')
  }

  const parsed = parseCanvasDocument(text)
  if (!parsed.ok) return { ok: false, code: parsed.code, error: parsed.error }
  return { ok: true, path: resolved, doc: parsed.doc }
}

export function registerCanvasReadHandlers(): void {
  ipcMain.handle(
    'canvas:read',
    (_e, args: { path: string; base?: string }): Promise<CanvasReadResult> => {
      const { path, base } = args ?? ({} as { path: string; base?: string })
      return readCanvasFile(path, base)
    }
  )
}
