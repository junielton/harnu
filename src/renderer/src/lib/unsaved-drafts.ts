import { reactive } from 'vue'

/**
 * Registry of markdown panes holding unsaved edits. A `MarkdownPane` reports its
 * dirty state here so code that never sees the pane's buffer (the helper stack's
 * cap-recycle, the command router, and main's quit guard) can refuse to drop a
 * draft silently. Module-level `reactive` Map, deliberately not a Pinia store: the
 * pane, the helpers store and the router all import it directly.
 *
 * Every real change pushes the current label list to main (`unsavedDraftsSet`),
 * coalesced to one push per tick, so main always knows what a quit would lose.
 */
export interface UnsavedDraft {
  paneId: string
  filePath: string
  worktreePath: string
}

const drafts = reactive(new Map<string, UnsavedDraft>())
let pushScheduled = false

/** Cross-platform basename — the renderer has no node `path`. */
function basename(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || p
  )
}

/** Human labels of the dirty drafts, insertion order: `2026-11-24.md (repo)`. */
export function unsavedDraftLabels(): string[] {
  return [...drafts.values()].map((d) => `${basename(d.filePath)} (${basename(d.worktreePath)})`)
}

function schedulePush(): void {
  if (pushScheduled) return
  pushScheduled = true
  queueMicrotask(() => {
    pushScheduled = false
    try {
      window.api?.unsavedDraftsSet(unsavedDraftLabels())
    } catch {
      /* main unreachable (window teardown) — nothing to guard anymore */
    }
  })
}

/** Mark a pane dirty or clean. Re-setting the same state is a no-op (no push). */
export function setDraftDirty(entry: UnsavedDraft, dirty: boolean): void {
  const prev = drafts.get(entry.paneId)
  if (!dirty) {
    if (prev) {
      drafts.delete(entry.paneId)
      schedulePush()
    }
    return
  }
  if (prev && prev.filePath === entry.filePath && prev.worktreePath === entry.worktreePath) return
  drafts.set(entry.paneId, { ...entry })
  schedulePush()
}

export function isDraftDirty(paneId: string): boolean {
  return drafts.has(paneId)
}

/** Drop a pane's entry for good (the pane is gone). Safe on an unknown id. */
export function forgetDraft(paneId: string): void {
  if (drafts.delete(paneId)) schedulePush()
}

/** Test-only: empty the registry without pushing. */
export function __resetUnsavedDraftsForTests(): void {
  drafts.clear()
  pushScheduled = false
}
