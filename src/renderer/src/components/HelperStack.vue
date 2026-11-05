<script setup lang="ts">
import { computed } from 'vue'
import { useHelpersStore } from '../stores/helpers'
import { useUiStore } from '../stores/ui'
import { useLayoutStore } from '../stores/layout'
import { useI18n } from 'vue-i18n'
import { paneComponents } from '../lib/pane-components'
import { hasCanvasSuffix } from '../lib/canvas-suffix'
import type { ExplorerEntry } from '../../../preload'

const helpers = useHelpersStore()
const ui = useUiStore()
const layout = useLayoutStore()
const { t } = useI18n()

/**
 * T627 — `stacked` puts the session area on top and this stack below, so the panes
 * run left to right (width splitters); `side-by-side` keeps today's top-to-bottom
 * stack. Every pane keeps its own 24px header either way.
 */
const stacked = computed(() => layout.splitOrientation === 'stacked')

const worktreePath = computed<string>(() => helpers.currentWorktreePath ?? '')
const panes = computed(() => helpers.panesForCurrentWorktree)
/** Maximized pane id for the visible stack, or null when nothing is maximized. */
const maximizedId = computed(() => helpers.maximizedPaneIdForCurrentWorktree)

/** markdown-write/-read deny code → i18n subkey under `markdownPane.error` (mirrors MarkdownPane's own map). */
function errorKey(code: string): string {
  const map: Record<string, string> = {
    'outside-roots': 'outsideRoots',
    binary: 'binary',
    'too-large': 'tooLarge',
    'not-found': 'notFound',
    'read-failed': 'readFailed',
    'write-failed': 'writeFailed',
    'invalid-path': 'readFailed'
  }
  return `markdownPane.error.${map[code] ?? 'readFailed'}`
}

/**
 * Cluster G seam: the Explorer's eye icon (the ONLY way a file opens now — the
 * row's name/body click is inert on a file) was clicked. Unlike the old
 * Cluster E seam this is no longer markdown-only: ANY file opens in a
 * MarkdownPane (which itself now renders `.md`/`.markdown` as prose, common
 * images as an inline `<img>` — the image fast-path — and every other file as
 * plain text). The extension gate that used to live here is gone — the
 * main-process `markdown:read`/`markdown:write` gate is the source of truth
 * (root-containment + a binary sniff with an image fast-path + the size cap),
 * so a non-image-binary/oversized/out-of-root file surfaces its refusal as a
 * toast here instead of silently failing. This is still the in-app replacement
 * for the retired native "Open file…" dialog (unusable on Linux/Wayland, where
 * the XDG portal ignores defaultPath).
 */
function onExplorerOpenFile(entry: ExplorerEntry): void {
  if (entry.isDir) return
  const wt = worktreePath.value
  if (!wt) return
  // T218 U2 — a canvas document opens in the DiagramPane instead. Matched on
  // the SUFFIX `.capycanvas.json`, never `extname()` (which yields a bare
  // `.json` here and would swallow every ordinary JSON file in the repo, spec
  // §4.1). Admission is the confined `canvas:read` gate inside the pane — it
  // validates the schema, so a malformed board surfaces a readable refusal in
  // the pane rather than silently falling back to the text viewer.
  if (hasCanvasSuffix(entry.path)) {
    helpers.addCanvasHelper(wt, entry.path, wt)
    return
  }
  void window.api.markdownRead(entry.path).then((res) => {
    if (res.ok) {
      helpers.addMarkdownHelper(wt, entry.path, wt)
    } else {
      ui.pushToast({ kind: 'danger', title: t(errorKey(res.code)) })
    }
  })
}

interface DragState {
  idx: number
  /** Pointer position on the stack's axis when the drag began (Y top-to-bottom, X left-to-right). */
  start: number
  startRatios: number[]
  stacked: boolean
}
let dragging: DragState | null = null

function onDividerMouseDown(idx: number, ev: MouseEvent): void {
  if (!worktreePath.value) return
  ev.preventDefault()
  const ratios = panes.value.map((p) => p.ratio)
  const isStacked = stacked.value
  dragging = {
    idx,
    start: isStacked ? ev.clientX : ev.clientY,
    startRatios: ratios,
    stacked: isStacked
  }
  document.addEventListener('mousemove', onDividerMouseMove)
  document.addEventListener('mouseup', onDividerMouseUp)
}

function onDividerMouseMove(ev: MouseEvent): void {
  if (!dragging) return
  const stackEl = document.getElementById('helper-stack-host')
  if (!stackEl) return
  const total = dragging.stacked ? stackEl.offsetWidth : stackEl.offsetHeight
  if (total < 1) return
  const delta = (dragging.stacked ? ev.clientX : ev.clientY) - dragging.start
  const deltaRatio = delta / total
  const next = [...dragging.startRatios]
  // Minimum 5% per pane to avoid collapsing one entirely
  const proposedTop = next[dragging.idx] + deltaRatio
  const proposedBottom = next[dragging.idx + 1] - deltaRatio
  if (proposedTop < 0.05 || proposedBottom < 0.05) return
  next[dragging.idx] = proposedTop
  next[dragging.idx + 1] = proposedBottom
  helpers.setPaneRatios(worktreePath.value, next)
}

function onDividerMouseUp(): void {
  dragging = null
  document.removeEventListener('mousemove', onDividerMouseMove)
  document.removeEventListener('mouseup', onDividerMouseUp)
}

/**
 * Per-pane flex-basis (design.md §6 — "Maximizing a pane"). Ratio-driven as
 * usual when nothing is maximized; while a pane IS maximized, that pane grows
 * to fill the stack and every other pane collapses to its own 24px header
 * height — every pane header is already `h-6`/24px and the wrapper below
 * already carries `overflow-hidden`, so this alone produces the header-only
 * strip with no separate show/hide branch. Stacked, the same 24px is the strip's
 * WIDTH (the panes run left to right), so the other panes shrink to a sliver.
 */
function paneFlex(pane: { id: string; ratio: number }): string {
  if (!maximizedId.value) return `${pane.ratio} 1 0`
  return pane.id === maximizedId.value ? '1 1 0' : '0 0 24px'
}
</script>

<template>
  <!--
    No top padding and no standalone divider rows: every pane carries its own
    title bar (HelperPane "Header da pane", design.md §6), and that bar doubles
    as the inter-pane resize handle. Dragging pane[idx]'s header moves the
    boundary above it (between idx-1 and idx), so the first pane's header is
    inert and panes 2..n resize against their predecessor.

    T627: stacked, the panes run left to right. The same header drag moves the
    boundary on the pane's LEFT (on X), and a width splitter sits on each boundary
    as the visible handle.
  -->
  <aside
    id="helper-stack-host"
    class="helper-stack flex min-w-0 min-h-0 flex-1"
    :class="stacked ? 'helper-stack--stacked flex-row' : 'flex-col'"
    :data-orientation="stacked ? 'stacked' : 'side-by-side'"
    :aria-label="$t('helperStack.label')"
  >
    <!--
      Ratio-stack — EVERY pane (shell or claude) opens as a full-size strip, top-to-bottom
      (side by side) or left-to-right (stacked), resizable by dragging its header.
      Pane[idx]'s header moves the boundary before it.
    -->
    <template v-for="(pane, idx) in panes" :key="pane.id">
      <!-- Width splitter (stacked only, none while a pane is maximized — ratios are meaningless then). -->
      <div
        v-if="stacked && idx > 0 && !maximizedId"
        class="group flex w-1.5 shrink-0 cursor-col-resize justify-end"
        role="separator"
        aria-orientation="vertical"
        @mousedown="onDividerMouseDown(idx - 1, $event)"
      >
        <div class="h-full w-px bg-border-2 transition-colors group-hover:bg-accent-line" />
      </div>
      <div class="min-h-0 min-w-0 overflow-hidden" :style="{ flex: paneFlex(pane) }">
        <!-- T121 — one registration point per pane type (`pane-components.ts`).
           Non-PTY types (markdown = T74, memory = T79, explorer = Cluster D) route
           to their own viewer; every PTY-backed type shares the xterm-backed
           HelperPane. All emit the same `header-mouse-down` so the inter-pane
           resize works identically; `open-file` (Cluster E, ExplorerPane only) is
           bound uniformly since a non-explorer component simply never emits it. -->
        <component
          :is="paneComponents[pane.type]"
          :pane="pane"
          :worktree-path="worktreePath"
          :resizable="idx > 0 && !maximizedId"
          @header-mouse-down="onDividerMouseDown(idx - 1, $event)"
          @open-file="onExplorerOpenFile"
        />
      </div>
    </template>
  </aside>
</template>

<style>
/* T627 — stacked, a resizable pane header drags on X, so it shows the column cursor and drops the
   top-edge hover line the vertical stack uses (the width splitter carries the accent instead). Every
   pane type shares the `cursor-row-resize` header class, so one rule here covers them all. */
.helper-stack--stacked .cursor-row-resize {
  cursor: col-resize;
  border-top-width: 0;
}
</style>
