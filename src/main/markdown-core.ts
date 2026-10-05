import { extname } from 'node:path'

/**
 * Pure core for the T74 markdown read/write shells (ADR-0001 pure-core /
 * thin-shell). The size cap, deny-code vocabulary, and (as of Cluster G) the
 * binary sniff live here — a single source of truth shared by
 * `markdown-read.ts` (the confined reader), `markdown-write.ts` (the confined
 * writer, T74 phase 2), and the pure MCP validator (`mcp/validate.ts`, the
 * `open_file` gate).
 *
 * Cluster G ("open/edit ANY file") retired the `.md`/`.markdown`/`.txt`
 * extension ALLOWLIST that used to gate admission (`hasAllowedMarkdownExt`):
 * any file can now be opened/edited as text. The only remaining admission gate
 * is content-based — {@link looksBinary} refuses images/archives/executables —
 * plus the unchanged root-containment + size cap. `PROSE_EXTENSIONS` /
 * {@link isProseExt} survive as a RENDERING decision only (parsed markdown
 * prose vs. plain monospace text), not an admission check.
 *
 * Deliberately electron-free (only `node:path`): `mcp/validate.ts` is a pure
 * validator whose tests import it WITHOUT an Electron mock, so anything it
 * transitively pulls must stay pure. Containment (`checkMarkdownReadAllowed`)
 * needs `settings.ts` (which imports electron) and therefore stays in the
 * env-bound `markdown-read.ts`, not here.
 */

/** Extensions the pane renders as parsed markdown PROSE. Every other file that
 * passes the binary sniff still opens — as plain monospace text (Cluster G). */
export const PROSE_EXTENSIONS = ['.md', '.markdown'] as const

/**
 * The canvas-document suffix (T218, spec §4.1), **mirrored** from
 * `canvas-core.ts`'s `CANVAS_SUFFIX` — which is where the constant belongs and
 * which this module deliberately does NOT import: `canvas-core.ts` reads
 * `MAX_MARKDOWN_BYTES` from here at module-evaluation time, so importing back
 * would not be merely an ugly cycle but a TDZ crash. `tests/markdown-core.test.ts`
 * asserts this copy equals the canvas core's AND the renderer's mirror
 * (`renderer/src/lib/canvas-suffix.ts`), so the three cannot drift silently.
 */
export const CANVAS_SUFFIX = '.harnucanvas.json'

/** Mirror of `canvas-core.ts`'s `LEGACY_CANVAS_SUFFIXES` — boards written before the rename. */
export const LEGACY_CANVAS_SUFFIXES: readonly string[] = ['.capycanvas.json']

/**
 * Pure: does `p` name a canvas document? Matches the full **suffix**,
 * case-insensitively — NEVER `extname()`. The double extension leaves
 * `extname('board.harnucanvas.json')` returning a bare `.json`, so an
 * extname-based check would route every ordinary JSON file in a repo to the
 * canvas pane (§4.1's implementation trap; U4 AC-2 pins both directions).
 */
export function isCanvasPath(p: string): boolean {
  const lower = p.toLowerCase()
  return lower.endsWith(CANVAS_SUFFIX) || LEGACY_CANVAS_SUFFIXES.some((s) => lower.endsWith(s))
}

/**
 * Refuse files bigger than this so a giant file can't blow up the renderer — and
 * the writer refuses to persist more than this so the viewer stays reproducible.
 * Applies to ANY file (Cluster G), not just markdown.
 */
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024 // 2 MB

/** How many leading bytes of a file we sniff to decide binary-vs-text (Cluster
 * G). Mirrors the cheap heuristic `git`/`grep --binary-files` use: a NUL byte
 * this early virtually never appears in real text, and scanning the whole file
 * would cost more for no practical gain. */
export const BINARY_SNIFF_BYTES = 8000

/** Machine-readable denial reasons — the renderer maps each to a localized steer. */
export type MarkdownDenyCode =
  | 'invalid-path'
  | 'outside-roots'
  | 'binary'
  | 'too-large'
  | 'not-found'
  | 'read-failed'
  | 'write-failed'

/** Pure: does this path end in an extension the pane renders as parsed
 * markdown prose (`.md`/`.markdown`)? Everything else that's openable (Cluster
 * G) renders as plain monospace text instead — this no longer gates admission. */
export function isProseExt(p: string): boolean {
  const ext = extname(p).toLowerCase()
  return (PROSE_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Pure binary sniff (Cluster G): true if `bytes` (already sliced to at most
 * {@link BINARY_SNIFF_BYTES}) contains a NUL byte — the standard, cheap
 * heuristic `git`/`grep --binary-files` use. Good enough to keep images,
 * archives, and executables out of the text viewer/editor without a MIME
 * database or a heavier content-sniffing dependency.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0)
}

/**
 * Image-preview fast-path (image preview in the viewer): extensions a file
 * explorer should RENDER as an `<img>` instead of refusing as binary. Extension
 * → MIME for the data: URL the confined reader builds (`img-src 'self' data:`
 * is already allowed by the renderer CSP; a `file://` src would be blocked).
 * `.svg` is deliberately here — an SVG is text/scriptable, but an `<img>`
 * context neuters scripts, so rendering it AS AN IMAGE (never inline HTML) is
 * the safe treatment. Kept to formats Chromium renders natively; anything not
 * listed keeps the binary sniff's refusal.
 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

/** Pure: the image MIME type for `p`'s extension, or `null` when `p` is not a
 * previewable image. The single source of truth for "is this an image?" —
 * shared by {@link classifyFileKind} and the reader's data-URL builder. */
export function imageMimeType(p: string): string | null {
  return IMAGE_MIME_BY_EXT[extname(p).toLowerCase()] ?? null
}

/**
 * How the viewer should treat an admitted file's content. `canvas` (T218 U4) is
 * a ROUTING kind, not an encoding one: a canvas document is ordinary UTF-8 JSON
 * on the wire, but it belongs to `DiagramPane` rather than the text viewer.
 */
export type FileOpenKind = 'image' | 'binary' | 'text' | 'canvas'

/**
 * Pure file-kind classification, in this order:
 *
 *  1. the **image** extension fast-path (a `.png` is full of NUL bytes yet
 *     perfectly renderable);
 *  2. the **NUL-byte sniff** — a non-image binary (font, archive, executable)
 *     is refused no matter what it is NAMED, including a file that borrowed the
 *     canvas suffix (U4 AC-3: the binary refusal is not weakened by T218);
 *  3. the **canvas** suffix (T218 U4) — ahead of the text classification, per
 *     spec §4.1, so a `*.capycanvas.json` routes to `DiagramPane`;
 *  4. everything else that survives: plain `text`.
 *
 * `sniff` is the file's leading bytes (at most {@link BINARY_SNIFF_BYTES}).
 * Steps 3–4 cannot collide with step 1: no image extension ends in
 * `.capycanvas.json`.
 */
export function classifyFileKind(p: string, sniff: Uint8Array): FileOpenKind {
  if (imageMimeType(p) !== null) return 'image'
  if (looksBinary(sniff)) return 'binary'
  return isCanvasPath(p) ? 'canvas' : 'text'
}
