<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChevronRight,
  Eye,
  FileText,
  FilePlus,
  Folder,
  FolderTree,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  Search,
  X
} from 'lucide-vue-next'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { ancestorChain } from '../lib/explorer-reveal'
import type {
  HelperPane,
  ExplorerEntry,
  ExplorerListing,
  ExplorerSearchResult
} from '../../../preload'

/**
 * Root-backed project file-tree pane (Cluster D, design.md §6 — Explorer pane).
 * The non-PTY twin of `MemoryPane`: owns the pane chrome (header +
 * reload/close/resize) and a lazy tree confined to `pane.root`, listed through
 * the confined `explorer:listDir` IPC (Cluster C — gitignore-aware, 1000-capped).
 * Every row (file AND folder) offers an "add to chat" affordance that injects its
 * absolute path into the selected session's live PTY (Cluster A) — the in-app
 * answer to dropping a plan/PRD into the chat without leaving Harnu. A FILE row
 * also carries a dedicated "view" (`eye`) button (Cluster G) — the ONLY way a
 * file opens now; clicking the row's name/body just toggles folders and is a
 * no-op on a file (HelperStack's `openFile` handler opens ANY text file, not
 * just markdown, and common images render inline via the image fast-path — a
 * non-image binary/oversized file is refused with a toast once the pane
 * actually tries to read it).
 */
interface Props {
  /** The shared pane union (HelperStack routes only `type:'explorer'` here). */
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
  headerMouseDown: [ev: MouseEvent]
  /** The eye icon on a file row was clicked (Cluster G — the ONLY way a file
   * opens now). HelperStack opens ANY text file in a MarkdownPane (images
   * render inline); a non-image binary or oversized file is refused with a
   * toast once the pane reads it. */
  openFile: [entry: ExplorerEntry]
}>()

const { t } = useI18n()
const helpers = useHelpersStore()
const sessions = useSessionsStore()
const ui = useUiStore()

/** The project root this tree is confined to (HelperStack guarantees `explorer`). */
const root = computed<string>(() => (props.pane as HelperPane).root ?? '')

/** Cross-platform basename — the renderer has no node `path`. */
function basename(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || p
  )
}
const rootName = computed<string>(() => basename(root.value))

// ── Lazy tree state ─────────────────────────────────────────────────────────
// Keyed by absolute dir path. `childrenByDir` caches a dir's listing once
// fetched (collapse keeps it cached); `expanded` drives which cached dirs are
// spliced into the flat render list; `loadingDirs`/`errorByDir`/`truncatedDirs`
// mirror the listing's transient/edge states. Expansion resets on reload — no
// need to persist it (the pane is reproducible from `root` alone).
const childrenByDir = shallowRef<Map<string, ExplorerEntry[]>>(new Map())
const expanded = reactive(new Set<string>())
const loadingDirs = reactive(new Set<string>())
const errorByDir = reactive(new Map<string, string>())
const truncatedDirs = reactive(new Set<string>())

/** Root-level load status (drives the top-level loading / error / empty states). */
type RootState = 'loading' | 'ready' | 'error'
const rootState = ref<RootState>('loading')

/** List one dir through the confined IPC, folding the result into the caches. */
async function listDir(dir: string): Promise<ExplorerListing> {
  loadingDirs.add(dir)
  errorByDir.delete(dir)
  let listing: ExplorerListing
  try {
    listing = await window.api.explorerListDir(root.value, dir)
  } catch {
    listing = { entries: [], error: 'read-failed' }
  }
  loadingDirs.delete(dir)
  if (listing.error) {
    errorByDir.set(dir, listing.error)
  } else {
    const next = new Map(childrenByDir.value)
    next.set(dir, listing.entries)
    childrenByDir.value = next
    if (listing.truncated) truncatedDirs.add(dir)
    else truncatedDirs.delete(dir)
  }
  return listing
}

/** (Re)load the root listing, dropping every cached child + expansion. */
async function loadRoot(): Promise<void> {
  if (!root.value) {
    rootState.value = 'error'
    return
  }
  rootState.value = 'loading'
  childrenByDir.value = new Map()
  expanded.clear()
  errorByDir.clear()
  truncatedDirs.clear()
  const listing = await listDir(root.value)
  rootState.value = listing.error ? 'error' : 'ready'
}

onMounted(() => {
  void loadRoot().then(() => void consumeRevealRequest())
  // Opening the pane is a "find me a file" gesture (Topbar / Folder View
  // "Browse files"), so the finder takes focus the moment the pane appears.
  if (helpers.explorerFocusRequest === props.pane.id) focusSearch()
})

/**
 * Focus (and select) the search field. `nextTick` because the caller may be the
 * same tick the pane mounts in, before the input exists in the DOM.
 */
function focusSearch(): void {
  helpers.consumeExplorerFocus(props.pane.id)
  void nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
  })
}

// A re-click on "Browse files" dedups to THIS already-mounted pane (one explorer
// per root), so `onMounted` never fires again — the store's request ref is what
// carries the second gesture through.
watch(
  () => helpers.explorerFocusRequest,
  (id) => {
    if (id === props.pane.id) focusSearch()
  }
)

// A reveal into an ALREADY-open pane never re-mounts, so the store's request
// ref is what carries the gesture through (same shape as the focus watcher).
watch(
  () => helpers.explorerRevealRequest,
  () => void consumeRevealRequest()
)

// The store may swap the pane's root (a dedup hit re-targeting the same id).
watch(
  () => root.value,
  (next, prev) => {
    if (next && next !== prev) void loadRoot()
  }
)

function reload(): void {
  void loadRoot()
}

// ── Recursive project search (Cluster F) ────────────────────────────────────
// A header search field drives a RECURSIVE, project-wide file finder through the
// confined `explorer:search` IPC (gitignore-pruned, .git-skipped, 500-capped).
// With ≥2 chars the flat result list REPLACES the tree; cleared/short returns to
// the lazy tree unchanged. Input is debounced ~180ms and each request carries a
// seq token so a slow response can never clobber a newer query's results.
const MIN_SEARCH_QUERY = 2
const query = ref('')
/** The search field itself — focused on open (see {@link focusSearch}). */
const searchInput = ref<HTMLInputElement | null>(null)
const searchResults = shallowRef<ExplorerEntry[]>([])
const searchTruncated = ref(false)
const searchError = ref(false)
const searching = ref(false)
let searchSeq = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** True once the query is long enough to search — flips body into results mode. */
const isSearching = computed<boolean>(() => query.value.trim().length >= MIN_SEARCH_QUERY)

async function runSearch(q: string): Promise<void> {
  const seq = ++searchSeq
  searching.value = true
  searchError.value = false
  let res: ExplorerSearchResult
  try {
    res = await window.api.explorerSearch(root.value, q)
  } catch {
    res = { entries: [], error: 'read-failed' }
  }
  if (seq !== searchSeq) return // a newer query superseded this one
  searching.value = false
  if (res.error) {
    searchError.value = true
    searchResults.value = []
    searchTruncated.value = false
  } else {
    searchResults.value = res.entries
    searchTruncated.value = res.truncated === true
  }
}

watch(query, (q) => {
  if (searchTimer) clearTimeout(searchTimer)
  const trimmed = q.trim()
  if (trimmed.length < MIN_SEARCH_QUERY) {
    searchSeq++ // invalidate any in-flight request
    searching.value = false
    searchResults.value = []
    searchTruncated.value = false
    searchError.value = false
    return
  }
  searchTimer = setTimeout(() => void runSearch(trimmed), 180)
})

function clearSearch(): void {
  query.value = ''
}

/** Root-relative split of an absolute entry path → dimmed dir prefix + filename. */
function relSplit(abs: string): { dir: string; name: string } {
  const r = root.value.replace(/[/\\]+$/, '')
  let rel = abs
  if (abs === r) rel = basename(abs)
  else if (abs.startsWith(r)) rel = abs.slice(r.length).replace(/^[/\\]+/, '')
  const name = basename(rel)
  const dir = rel.length > name.length ? rel.slice(0, rel.length - name.length) : ''
  return { dir, name }
}

/** A search result row's body-click is INERT (Cluster G) — files no longer
 * open on click (the eye icon is the only way, file rows only) and dir rows
 * never expanded in flat mode either. Kept as a no-op button (not a plain
 * div) so hover/focus styling and the full-path `title` stay consistent with
 * the tree rows below. */
function onResultClick(_entry: ExplorerEntry): void {
  // Intentional no-op — see doc comment above.
}

// ── New file (Cluster E) ─────────────────────────────────────────────────────
// Dialog-free replacement for the retired native "New markdown" save dialog.
// A `+` in the header reveals an inline input at the tree root; Enter creates
// `<root>/<name>.md` EMPTY through the confined `markdown:write` (a refusal —
// outside roots / too large — surfaces as a toast, mirroring T74) and opens it in
// a MarkdownPane in edit mode. The name gets a `.md` default when it carries no
// markdown extension. Escape / blur / empty cancels.
const creating = ref(false)
const newFileName = ref('')
const newFileInput = ref<HTMLInputElement | null>(null)

/** markdown-write deny code → i18n subkey under `markdownPane.error`. */
function writeErrorSubkey(code: string): string {
  const map: Record<string, string> = {
    'outside-roots': 'outsideRoots',
    binary: 'binary',
    'too-large': 'tooLarge',
    'write-failed': 'writeFailed'
  }
  return map[code] ?? 'writeFailed'
}

function startCreate(): void {
  // The inline input lives in tree mode — leave search so it's visible.
  clearSearch()
  creating.value = true
  newFileName.value = ''
  void nextTick(() => newFileInput.value?.focus())
}

function cancelCreate(): void {
  creating.value = false
  newFileName.value = ''
}

async function confirmCreate(): Promise<void> {
  const raw = newFileName.value.trim()
  if (!raw || !root.value) {
    cancelCreate()
    return
  }
  const name = /\.(md|markdown|txt)$/i.test(raw) ? raw : `${raw}.md`
  const path = `${root.value.replace(/[/\\]+$/, '')}/${name}`
  const res = await window.api.markdownWrite(path, '')
  if (res.ok) {
    helpers.addMarkdownHelper(props.worktreePath, res.path, root.value, { initialMode: 'edit' })
    cancelCreate()
    reload()
  } else {
    ui.pushToast({ kind: 'danger', title: t(`markdownPane.error.${writeErrorSubkey(res.code)}`) })
  }
}

// ── Flattened render list ─────────────────────────────────────────────────
// Walk the root's children; for each expanded dir, splice its cached children
// in at depth+1, recursively. A row carries its depth for indentation.
interface Row {
  entry: ExplorerEntry
  depth: number
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (dir: string, depth: number): void => {
    const kids = childrenByDir.value.get(dir)
    if (!kids) return
    for (const entry of kids) {
      out.push({ entry, depth })
      if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1)
    }
  }
  walk(root.value, 0)
  return out
})

/** Root has children after gitignore? (only meaningful once ready). */
const rootEmpty = computed<boolean>(
  () => rootState.value === 'ready' && (childrenByDir.value.get(root.value)?.length ?? 0) === 0
)

/**
 * The row an option+click reveal landed on (T-file-links). Selection is
 * reveal-only — clicking rows in the tree does not set it — so the highlight
 * always answers "the thing you just clicked in the transcript is HERE".
 */
const selectedPath = ref<string | null>(null)

/** Row element per absolute path, so a reveal can scroll its row into view. */
const rowEls = new Map<string, HTMLElement>()
function setRowEl(path: string, el: unknown): void {
  if (el instanceof HTMLElement) rowEls.set(path, el)
  else rowEls.delete(path)
}

// ── Row interactions ───────────────────────────────────────────────────────

/** Folder body-click toggles expand (lazy-fetching children on first open). A
 * FILE row's body-click is INERT (Cluster G) — the dedicated eye icon
 * ({@link onViewFile}) is now the ONLY way a file opens. */
function onRowClick(entry: ExplorerEntry): void {
  if (!entry.isDir) return
  if (expanded.has(entry.path)) {
    expanded.delete(entry.path)
    return
  }
  expanded.add(entry.path)
  if (!childrenByDir.value.has(entry.path)) void listDir(entry.path)
}

/** The eye icon on a file row (Cluster G) — emits `openFile`, which
 * HelperStack routes to `addMarkdownHelper` for ANY text file or image (a
 * non-image binary or oversized file is refused with a toast once the pane
 * reads it). */
function onViewFile(entry: ExplorerEntry): void {
  emit('openFile', entry)
}

/** Find an already-listed entry by absolute path (its parent must be cached). */
function findEntry(target: string): ExplorerEntry | undefined {
  for (const entries of childrenByDir.value.values()) {
    const hit = entries.find((e) => e.path === target)
    if (hit) return hit
  }
  return undefined
}

/**
 * Reveal `target` in the tree (T-file-links — option+click on a path in a
 * transcript). Leaves search mode, expands every ancestor directory in order
 * (listing each lazily, exactly as a manual click would), selects the row and
 * scrolls it into view.
 *
 * A FILE additionally emits `openFile` — the same seam the eye icon uses — so
 * `HelperStack`'s `markdown:read` gate decides whether a viewer pane opens and
 * surfaces its own toast for a non-image binary or oversized file. A DIRECTORY
 * is expanded instead; nothing opens.
 *
 * A missing ancestor (deleted between the resolve and the click) simply stops
 * the walk — the pane shows the deepest directory it managed to reach.
 */
async function revealPath(target: string): Promise<void> {
  const chain = ancestorChain(root.value, target)
  if (chain === null) return
  clearSearch()

  // `chain` excludes the root itself (a top-level target's chain is `[]`), but
  // `findEntry` below needs the root's own listing cached — nothing else in
  // this function guarantees that. It normally IS cached by `onMounted`'s
  // `loadRoot()`, but a reveal landing while a reload is in flight (or before
  // one has ever completed for this root) would otherwise silently find
  // nothing. Same error handling as the chain loop below: a failed listing
  // stops the reveal rather than walking into a known-bad cache.
  if (!childrenByDir.value.has(root.value)) {
    const listing = await listDir(root.value)
    if (listing.error) return
  }

  for (const dir of chain) {
    if (!childrenByDir.value.has(dir)) {
      const listing = await listDir(dir)
      if (listing.error) return
    }
    expanded.add(dir)
  }

  const entry = findEntry(target)
  if (!entry) return // deleted between resolve and click, or a truncated listing hid it

  selectedPath.value = target
  await nextTick()
  rowEls.get(target)?.scrollIntoView({ block: 'nearest' })

  if (entry.isDir) {
    expanded.add(entry.path)
    if (!childrenByDir.value.has(entry.path)) void listDir(entry.path)
  } else {
    emit('openFile', entry)
  }
}

/**
 * Act on a pending reveal request addressed to THIS pane, then clear it —
 * unconditionally, whether or not `revealPath` actually landed on the target.
 *
 * `onMounted` calls this same function, so a lingering request would be
 * re-consumed by a later remount (pane torn down and rebuilt, e.g. via
 * `pane-registry`'s persistable id) and fire a stale reveal the user asked
 * for minutes earlier — which is precisely why we clear it here even when the
 * reveal couldn't reach its target. Recovery is cheap either way: the store
 * bumps a `nonce` per request, so a repeat Option+click on the same path
 * re-fires this pane's watcher and tries again.
 */
async function consumeRevealRequest(): Promise<void> {
  const req = helpers.explorerRevealRequest
  if (!req || req.paneId !== props.pane.id) return
  await revealPath(req.path)
  helpers.consumeExplorerReveal(props.pane.id)
}

/**
 * Row "add to chat": inject the entry's absolute path into the SELECTED
 * session's live PTY (folder paths are valid — Claude can read a dir). No live
 * PTY (dormant/synthetic session, or nothing selected) → the same discreet
 * not-live toast Cluster B uses on a drop.
 */
function onAddToChat(entry: ExplorerEntry): void {
  const id = sessions.selectedId
  if (!id || !sessions.injectPathIntoSession(id, entry.path)) {
    ui.pushToast({
      kind: 'info',
      title: t('terminalDrop.notLiveTitle'),
      description: t('terminalDrop.notLiveBody')
    })
  }
}

function onClose(): void {
  helpers.removeHelper(props.worktreePath, props.pane.id)
}

/** Begin an inter-pane resize drag when the header (not a button) is pressed. */
function onHeaderMouseDown(ev: MouseEvent): void {
  if (props.resizable) emit('headerMouseDown', ev)
}

/** Whether THIS pane is the one currently maximized in its worktree's stack. */
const isMaximized = computed(() => helpers.maximizedPaneId(props.worktreePath) === props.pane.id)
function onToggleMaximize(): void {
  helpers.toggleMaximizePane(props.worktreePath, props.pane.id)
}
</script>

<template>
  <!-- Mirrors MemoryPane's shell: a 24px header, then a padded scroll body. -->
  <div
    class="flex h-full w-full flex-col overflow-hidden bg-bg"
    :aria-label="$t('explorerPane.label')"
  >
    <header
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      @mousedown="onHeaderMouseDown"
    >
      <FolderTree :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate" :title="root">{{ rootName }}</span>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('explorerPane.newFile')"
        :aria-label="$t('explorerPane.newFile')"
        @mousedown.stop
        @click="startCreate"
      >
        <FilePlus :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('explorerPane.reload')"
        :aria-label="$t('explorerPane.reload')"
        @mousedown.stop
        @click="reload"
      >
        <RotateCcw :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        :aria-label="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        @mousedown.stop
        @click="onToggleMaximize"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('helperPane.close')"
        :aria-label="$t('helperPane.close')"
        @mousedown.stop
        @click="onClose"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>

    <!-- Search bar (Cluster F) — the primary finder control, its own full-width
         row under the title bar. Typing ≥2 chars replaces the tree below with a
         flat, project-wide result list (recursive, gitignore-pruned IPC). -->
    <div
      class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-bg px-2 transition-colors"
    >
      <Search :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
      <input
        ref="searchInput"
        v-model="query"
        type="text"
        class="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-4"
        style="font-size: 12px; height: 22px"
        :placeholder="$t('explorerPane.searchPlaceholder')"
        spellcheck="false"
        @keydown.esc.prevent="clearSearch"
      />
      <button
        v-if="query"
        class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('explorerPane.searchClear')"
        :aria-label="$t('explorerPane.searchClear')"
        @click="clearSearch"
      >
        <X :size="12" :stroke-width="1.6" />
      </button>
    </div>

    <div class="scrollable min-h-0 flex-1 overflow-y-auto" style="padding: 6px 4px">
      <!-- ── Search results mode (Cluster F) — flat, project-wide finder ── -->
      <template v-if="isSearching">
        <!-- In-flight spinner (until the first result set lands) -->
        <div
          v-if="searching && searchResults.length === 0 && !searchError"
          class="flex items-center gap-1.5 text-text-3"
          style="font-size: 12px; padding: 8px"
        >
          <Loader2 :size="12" :stroke-width="1.8" class="shrink-0 animate-spin" />
          {{ $t('explorerPane.searching') }}
        </div>
        <div
          v-else-if="searchError"
          class="flex h-full items-center justify-center text-center text-text-3"
          style="font-size: 12px; padding: 24px"
        >
          {{ $t('explorerPane.error') }}
        </div>
        <div
          v-else-if="searchResults.length === 0"
          class="flex h-full items-center justify-center text-center text-text-3"
          style="font-size: 12px; padding: 24px"
        >
          {{ $t('explorerPane.noMatches') }}
        </div>
        <template v-else>
          <div
            v-for="entry in searchResults"
            :key="entry.path"
            class="group flex items-center rounded text-text-2 transition-colors hover:bg-surface-2"
            style="height: 24px; padding-right: 4px; padding-left: 4px"
          >
            <button
              class="flex min-w-0 flex-1 items-center gap-1 text-left"
              :title="entry.path"
              @click="onResultClick(entry)"
            >
              <component
                :is="entry.isDir ? Folder : FileText"
                :size="12"
                :stroke-width="1.6"
                class="shrink-0 text-text-3"
              />
              <span class="min-w-0 flex-1 truncate" style="font-size: 12px">
                <span class="text-text-4">{{ relSplit(entry.path).dir }}</span
                >{{ relSplit(entry.path).name }}
              </span>
            </button>
            <!-- View (files only, Cluster G) — the ONLY way this row opens. -->
            <button
              v-if="!entry.isDir"
              class="flex shrink-0 items-center justify-center rounded text-text-4 opacity-0 transition hover:bg-surface hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
              style="width: 18px; height: 18px"
              :title="$t('explorerPane.viewFile')"
              :aria-label="$t('explorerPane.viewFile')"
              @click.stop="onViewFile(entry)"
            >
              <Eye :size="12" :stroke-width="1.8" />
            </button>
            <button
              class="flex shrink-0 items-center justify-center rounded text-text-4 opacity-0 transition hover:bg-surface hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
              style="width: 18px; height: 18px"
              :title="$t('explorerPane.addToChat')"
              :aria-label="$t('explorerPane.addToChat')"
              @click.stop="onAddToChat(entry)"
            >
              <Plus :size="12" :stroke-width="1.8" />
            </button>
          </div>
          <!-- Cap hint — 500 matches reached (or the visit cap tripped) -->
          <div v-if="searchTruncated" class="text-text-4" style="font-size: 11px; padding: 4px 8px">
            {{ $t('explorerPane.searchTruncated') }}
          </div>
        </template>
      </template>

      <!-- ── Tree mode (Cluster D/E) — unchanged lazy tree ── -->
      <template v-else>
        <!-- Inline "new file" input (Cluster E) — creates `<root>/<name>.md` empty
           via the confined `markdown:write`, then opens it in edit mode. -->
        <div v-if="creating" class="flex items-center gap-1" style="height: 24px; padding: 0 4px">
          <FilePlus :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
          <input
            ref="newFileInput"
            v-model="newFileName"
            type="text"
            class="min-w-0 flex-1 rounded border border-accent-line bg-surface-2 text-text outline-none"
            style="font-size: 12px; height: 20px; padding: 0 5px"
            :placeholder="$t('explorerPane.newFilePlaceholder')"
            spellcheck="false"
            @keydown.enter.prevent="confirmCreate"
            @keydown.esc.prevent="cancelCreate"
            @blur="cancelCreate"
          />
        </div>

        <!-- Root loading / error / empty states -->
        <div
          v-if="rootState === 'loading'"
          class="text-text-3"
          style="font-size: 12px; padding: 8px"
        >
          {{ $t('explorerPane.loading') }}
        </div>
        <div
          v-else-if="rootState === 'error'"
          class="flex h-full items-center justify-center text-center text-text-3"
          style="font-size: 12px; padding: 24px"
        >
          {{ $t('explorerPane.error') }}
        </div>
        <div
          v-else-if="rootEmpty"
          class="flex h-full items-center justify-center text-center text-text-3"
          style="font-size: 12px; padding: 24px"
        >
          {{ $t('explorerPane.empty') }}
        </div>

        <!-- The lazy tree -->
        <template v-else>
          <div
            v-for="row in rows"
            :key="row.entry.path"
            :ref="(el) => setRowEl(row.entry.path, el)"
            class="group flex items-center rounded text-text-2 transition-colors hover:bg-surface-2"
            :class="row.entry.path === selectedPath ? 'bg-accent-soft text-text' : ''"
            :aria-current="row.entry.path === selectedPath ? 'true' : undefined"
            style="height: 24px; padding-right: 4px"
            :style="{ paddingLeft: `${row.depth * 12 + 4}px` }"
          >
            <!-- Body: chevron + icon + name. Click toggles a folder's expand;
                 a file row's body-click is inert (Cluster G — the eye icon below
                 is the only way it opens). -->
            <button
              class="flex min-w-0 flex-1 items-center gap-1 text-left"
              :title="row.entry.path"
              @click="onRowClick(row.entry)"
            >
              <ChevronRight
                v-if="row.entry.isDir"
                :size="12"
                :stroke-width="1.8"
                class="shrink-0 text-text-4 transition-transform"
                :class="expanded.has(row.entry.path) ? 'rotate-90' : ''"
              />
              <span v-else class="shrink-0" style="width: 12px" />
              <component
                :is="row.entry.isDir ? Folder : FileText"
                :size="12"
                :stroke-width="1.6"
                class="shrink-0 text-text-3"
              />
              <span class="min-w-0 flex-1 truncate" style="font-size: 12px">{{
                row.entry.name
              }}</span>
            </button>
            <!-- View (files only, Cluster G) — the ONLY way this row opens. -->
            <button
              v-if="!row.entry.isDir"
              class="flex shrink-0 items-center justify-center rounded text-text-4 opacity-0 transition hover:bg-surface hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
              style="width: 18px; height: 18px"
              :title="$t('explorerPane.viewFile')"
              :aria-label="$t('explorerPane.viewFile')"
              @click.stop="onViewFile(row.entry)"
            >
              <Eye :size="12" :stroke-width="1.8" />
            </button>
            <!-- Add to chat: injects the path into the selected session's prompt -->
            <button
              class="flex shrink-0 items-center justify-center rounded text-text-4 opacity-0 transition hover:bg-surface hover:text-text group-hover:opacity-100 focus-visible:opacity-100"
              style="width: 18px; height: 18px"
              :title="$t('explorerPane.addToChat')"
              :aria-label="$t('explorerPane.addToChat')"
              @click.stop="onAddToChat(row.entry)"
            >
              <Plus :size="12" :stroke-width="1.8" />
            </button>
          </div>

          <!-- Per-dir "…and more" hint when the 1000-cap was hit -->
          <template v-for="dir in truncatedDirs" :key="`trunc-${dir}`">
            <div
              v-if="dir === root || expanded.has(dir)"
              class="text-text-4"
              style="font-size: 11px; padding: 4px 8px"
            >
              {{ $t('explorerPane.truncated') }}
            </div>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>
