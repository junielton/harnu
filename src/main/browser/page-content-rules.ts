/**
 * Tiny pure rules the plan-level content check shares with the verbs (T569 delta 1, F6), kept import-light so
 * `content-check.ts` does not pull the file-system parts of the page protocol.
 */
import { posix as pathPosix } from 'node:path'
export { isDeniedPagePath } from './page-url'

/** Every patch mode but `remove` needs `html`. */
export function isPatchModeNeedingHtml(mode: string): boolean {
  return mode === 'inner' || mode === 'outer' || mode === 'append' || mode === 'prepend'
}

export const PANEL_DIR = '.harnu/out/panels'

/** A file name for a panel from the name the agent gave it: lowercase, `a-z0-9-`, never empty. */
export function panelSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return slug === '' ? 'panel' : slug
}

/**
 * The folder-relative page file a `browser_open({ path | html, name })` call would show, judged LEXICALLY (no disk),
 * or `null` when it cannot be told without the disk (a path that leaves the folder, a symlink, a missing `name`). The
 * plan layer uses it to tell a call that REUSES a pane already showing that file from one that needs a new pane.
 */
export function lexicalPageTarget(
  args: { path?: unknown; html?: unknown; name?: unknown },
  folder: string
): string | null {
  if (typeof args.html === 'string') {
    return typeof args.name === 'string' && args.name.trim() !== ''
      ? `${PANEL_DIR}/${panelSlug(args.name)}.html`
      : null
  }
  if (typeof args.path !== 'string' || args.path === '' || args.path.includes('\0')) return null
  const abs = pathPosix.isAbsolute(args.path)
    ? pathPosix.normalize(args.path)
    : pathPosix.join(folder, args.path)
  const rel = pathPosix.relative(folder, abs)
  if (rel === '' || rel === '..' || rel.startsWith('../') || pathPosix.isAbsolute(rel)) return null
  return rel
}
