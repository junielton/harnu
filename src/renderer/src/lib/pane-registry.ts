import type { AnyHelperPane } from '../stores/helpers'
import type { HelperPane } from '../../../preload'

/**
 * T121 — one-place pane registration. Data-only (no Vue component imports):
 * used by `stores/helpers.ts` (dedup + persistence) and `HelperPane.vue`
 * (PTY kind). The component-per-type map lives separately in
 * `pane-components.ts` — folding Vue SFC imports in here would create a
 * store↔component import cycle (`stores/helpers.ts` → `pane-registry.ts` →
 * `MarkdownPane.vue` → `stores/helpers.ts`, since every pane component
 * imports `useHelpersStore`).
 */

/** PTY kind requested from main for pane types the xterm-backed `HelperPane.vue`
 * renders. Mirrors `main/pty.ts`'s `PtyKind` (kept as a local literal union
 * rather than importing main code across the process boundary). */
export type HelperPtyKind = 'shell' | 'claude-new' | 'claude-resume' | 'claude-fork'

export interface PaneRegistryEntry {
  /** Whether this pane type survives a `helpers.json` write. */
  persistable: boolean
  /**
   * Extracts this pane's dedup identity, or `undefined` if panes of this
   * type are never deduped (always appended fresh — e.g. `shell`, a fresh
   * `claude-fork-pending`). Called only on panes already known to share
   * `pane.type` with the candidate, so it's safe to read type-specific
   * fields directly.
   */
  dedupKey?: (pane: AnyHelperPane) => string | undefined
  /** Cap on simultaneous panes of this type per worktree; past the cap the
   * OLDEST instance is recycled (dropped) instead of piling on another.
   * Omit for no cap. */
  maxInstances?: number
  /** PTY kind to request from main — set only for the types the generic
   * xterm-backed `HelperPane.vue` renders (the split-terminal panes). */
  ptyKind?: HelperPtyKind
  /**
   * T245 — spawn this pane's `claude` READ-ONLY: main forces `--permission-mode
   * plan`, hard-denies the file-writing tools, drops any permission-bypass the
   * user's Claude Boot config carries, and withholds Harnu's own MCP server.
   *
   * A flag on the registry rather than a literal in `HelperPane.vue` for the
   * same reason `ptyKind` is: the pane type is the thing that knows, and a new
   * read-only type must not have to remember to opt in at the call site.
   */
  readOnly?: boolean
}

/** Cap on markdown panes per worktree (§5, T74). */
export const MAX_MARKDOWN_PANES = 4

/** Cap on canvas panes per worktree (T218 U2). Same number and the same reason
 *  as the markdown cap: a canvas is per-FILE, so a stack could otherwise fill
 *  with boards nobody closed. */
export const MAX_CANVAS_PANES = 4

/**
 * `Record<AnyHelperPane['type'], ...>` — TypeScript forces every member of
 * the pane-type union to have an entry here, so adding a new persisted or
 * transient pane type without registering it is a compile error, not a
 * silent gap.
 */
export const paneRegistry: Record<AnyHelperPane['type'], PaneRegistryEntry> = {
  shell: {
    persistable: true,
    ptyKind: 'shell'
  },
  claude: {
    persistable: true,
    dedupKey: (p) => (p as HelperPane).sessionId,
    ptyKind: 'claude-resume'
  },
  'claude-fork-pending': {
    persistable: false,
    ptyKind: 'claude-fork'
  },
  // T245 U1 — the review companion: a FRESH `claude` beside the review pane,
  // read-only, scoped to the review that opened it.
  //
  // NOT modelled on `claude-fork-pending`: the fork-pending pane resolves into
  // a `claude` pane, which is `persistable: true` — a companion built that way
  // would be written into `helpers.json` and reopen on every future app boot,
  // i.e. become a permanent tab, the exact opposite of a pane scoped to one
  // review (PRD §3 Tier 1).
  //
  // `dedupKey` is a constant: at most ONE companion per worktree. Re-invoking
  // the affordance reveals the conversation already running instead of stacking
  // a second stranger with no shared context.
  'review-companion': {
    persistable: false,
    dedupKey: () => 'review-companion',
    ptyKind: 'claude-new',
    readOnly: true
  },
  markdown: {
    persistable: true,
    dedupKey: (p) => (p as HelperPane).filePath,
    maxInstances: MAX_MARKDOWN_PANES
  },
  memory: {
    persistable: true,
    dedupKey: (p) => (p as HelperPane).folder
  },
  explorer: {
    persistable: true,
    dedupKey: (p) => (p as HelperPane).root
  },
  // T218 U2 — the canvas viewer. Non-PTY and reproducible from its `filePath`,
  // so it persists and reopens on boot exactly like the markdown pane, and it
  // dedupes on the same key: opening the same board twice should re-reveal the
  // pane that already has it, not stack a second copy of the same document.
  canvas: {
    persistable: true,
    dedupKey: (p) => (p as HelperPane).filePath,
    maxInstances: MAX_CANVAS_PANES
  }
}
