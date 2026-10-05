import type { Component } from 'vue'
import type { AnyHelperPane } from '../stores/helpers'
import HelperPane from '../components/HelperPane.vue'
import MarkdownPane from '../components/MarkdownPane.vue'
import MemoryPane from '../components/MemoryPane.vue'
import ExplorerPane from '../components/ExplorerPane.vue'
import DiagramPane from '../components/DiagramPane.vue'

/**
 * T121 — the Vue component that renders each pane type. Kept apart from the
 * data-only `pane-registry.ts` (see its header comment) because it imports
 * Vue SFCs; only `HelperStack.vue` (a leaf — nothing imports it) needs this
 * map, so importing it doesn't risk a store↔component cycle.
 *
 * Non-PTY viewers (markdown/memory/explorer/canvas) get a dedicated component;
 * every PTY-backed type (shell/claude/claude-fork-pending/review-companion)
 * shares the xterm-backed `HelperPane`, which resolves its PTY kind from
 * `pane-registry.ts`'s `ptyKind`.
 */
export const paneComponents: Record<AnyHelperPane['type'], Component> = {
  shell: HelperPane,
  claude: HelperPane,
  'claude-fork-pending': HelperPane,
  'review-companion': HelperPane,
  markdown: MarkdownPane,
  memory: MemoryPane,
  explorer: ExplorerPane,
  canvas: DiagramPane
}
