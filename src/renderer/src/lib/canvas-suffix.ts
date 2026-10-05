/**
 * The canvas file suffix, mirrored into the renderer (T218 U2).
 *
 * The value belongs to `src/main/canvas-core.ts` (`CANVAS_SUFFIX`, spec §4.1),
 * but that module cannot be VALUE-imported from the sandboxed renderer: it
 * pulls `MAX_MARKDOWN_BYTES` from `markdown-core.ts`, which imports
 * `node:path`. Type-only imports are erased and safe; this one constant is not
 * a type. Mirrored here — and asserted equal to the core's in
 * `tests/canvas-pane-render.test.ts` — rather than left to drift silently.
 *
 * Matching on the SUFFIX is the point (§4.1's implementation trap): the double
 * extension keeps `extname()` returning `.json`, so an `extname`-based check
 * would route every ordinary JSON file in a repo to the canvas pane.
 */
export const CANVAS_SUFFIX = '.harnucanvas.json'

/** Mirror of `canvas-core.ts`'s `LEGACY_CANVAS_SUFFIXES` — boards written before the rename. */
export const LEGACY_CANVAS_SUFFIXES: readonly string[] = ['.capycanvas.json']

/**
 * Pure: does `p` name a canvas document? The renderer's mirror of
 * `canvas-core.ts`'s `hasCanvasSuffix` / `markdown-core.ts`'s `isCanvasPath`,
 * for the same reason the constant above is mirrored — neither main-side module
 * is value-importable from the sandboxed renderer.
 *
 * Every renderer pane-routing decision goes through this one function (T218 U4)
 * so the "match the suffix, never `extname()`" rule lives in a single place
 * instead of being retyped at each call site.
 */
export function hasCanvasSuffix(p: string): boolean {
  if (typeof p !== 'string') return false
  const lower = p.toLowerCase()
  return lower.endsWith(CANVAS_SUFFIX) || LEGACY_CANVAS_SUFFIXES.some((s) => lower.endsWith(s))
}
