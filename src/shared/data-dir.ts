/**
 * The name of the per-repo data directory — the ONE place it is spelled.
 *
 * Dependency-free on purpose (no `node:` imports), so the sandboxed renderer can
 * value-import it alongside the main process. Main-process code builds paths
 * through `src/main/data-dir.ts`; the renderer, which only ever shows a
 * repo-relative path, composes `${DATA_DIR}/…` from this constant.
 */
export const DATA_DIR = '.harnu'
