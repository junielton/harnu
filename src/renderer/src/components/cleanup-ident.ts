import type { ReapItem } from '../../../preload'

/** Everything the identity helpers need — keeps them testable without a full
 * `ReapItem` (and reusable from both `CleanupView.vue` and
 * `SweepConfirmDialog.vue`, which render the same identity). */
export type ReapIdent = Pick<ReapItem, 'kind' | 'repoPath'> &
  Partial<Pick<ReapItem, 'branch' | 'path'>>

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * Visible identity, sized for the plan-locked 240px identity column.
 *
 * A hidden folder is shown relative to its repo when it lives *inside* it, but
 * the common shape is a sibling worktree dir (`~/w/org/proj-231` next to the
 * repo `~/w/org/www`) — there the relative path degrades to the full absolute
 * path, which truncates to an unreadable `/home/user/Workspace/org/pr…`. Fall
 * back to the folder's own name, which is what actually distinguishes the row;
 * the untruncated path stays reachable via {@link identTitle}.
 *
 * A detached worktree has no branch to show and takes the same treatment: it is
 * identified by a path, so it hits the exact same truncation (BUG-95).
 */
export function identText(item: ReapIdent): string {
  if ((item.kind === 'hidden-folder' || item.kind === 'detached-worktree') && item.path) {
    const prefix = `${item.repoPath}/`
    return item.path.startsWith(prefix) ? item.path.slice(prefix.length) : basename(item.path)
  }
  return item.branch ?? item.path ?? ''
}

/**
 * Full identity for the native hover tooltip — the absolute path for
 * folder-backed rows, the branch for branch-only ones. Returns `undefined`
 * when it would merely repeat the visible text, so branch rows don't get a
 * redundant tooltip.
 */
export function identTitle(item: ReapIdent): string | undefined {
  const full = item.path ?? item.branch ?? ''
  return full && full !== identText(item) ? full : undefined
}
