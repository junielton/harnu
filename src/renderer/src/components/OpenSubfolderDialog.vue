<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X, Folder as FolderIcon, Search, ChevronRight } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { SubfolderEntry, ChildFolderEntry } from '../../../preload'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useFocusTrap } from '../composables/useFocusTrap'

/**
 * "Open subfolder" picker (T69, made lazy in T73). Two modes over the folder the
 * FolderMenu targeted (`ui.folderActionPath`):
 *
 * - **Idle (no search): a lazy tree.** Only the root's direct children load up
 *   front (`foldersListChildFolders`, one level); a chevron expands a node and
 *   reads THAT level on demand — a real repo no longer dumps its whole depth-4
 *   BFS at once (the flat-list overwhelm this task fixes).
 * - **Searching: the flat deep index.** The first keystroke lazily loads the
 *   recursive scan (`foldersListSubfolders`, depth ≤4) and filters it by
 *   substring — the old behaviour, now the search mode.
 *
 * Choosing a row pins it with `sessions.pinFolder` (probes git, T70A). See
 * design.md §6 "Open subfolder".
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'openSubfolder')
const rootPath = computed(() => ui.folderActionPath ?? '')

/** Cross-platform basename for the header subtitle. */
function basename(p: string): string {
  if (!p) return ''
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  )
}
const rootName = computed(() => basename(rootPath.value))

const query = ref('')
const searching = computed(() => query.value.trim().length > 0)

// --- Tree mode (idle) — one level loaded per expand ------------------------
const childrenByPath = ref(new Map<string, ChildFolderEntry[]>())
const expanded = ref(new Set<string>())
const loadingPaths = ref(new Set<string>())
const rootLoading = ref(false)
const treeTruncated = ref(false)

// --- Search mode — the deep flat index, loaded on first keystroke ----------
const deepIndex = ref<SubfolderEntry[] | null>(null)
const deepLoading = ref(false)
const deepTruncated = ref(false)

const selectedIndex = ref(0)
const listRef = ref<HTMLElement | null>(null)

/** A rendered row — a tree node (idle) or a flat match (searching). */
interface Row {
  path: string
  /** Display label: the segment name (tree) or the relative path (search). */
  label: string
  /** Indentation level (0 = a direct child of the root). */
  depth: number
  /** Tree only — the node holds children, so it can expand. */
  expandable: boolean
  expanded: boolean
  loading: boolean
}

function flattenTree(parentPath: string, depth: number, out: Row[]): void {
  const kids = childrenByPath.value.get(parentPath)
  if (!kids) return
  for (const k of kids) {
    const isExpanded = expanded.value.has(k.path)
    out.push({
      path: k.path,
      label: k.name,
      depth,
      expandable: k.hasChildren,
      expanded: isExpanded,
      loading: loadingPaths.value.has(k.path)
    })
    if (isExpanded) flattenTree(k.path, depth + 1, out)
  }
}

const treeRows = computed<Row[]>(() => {
  const out: Row[] = []
  flattenTree(rootPath.value, 0, out)
  return out
})

const searchRows = computed<Row[]>(() => {
  const idx = deepIndex.value
  if (!idx) return []
  const q = query.value.trim().toLowerCase()
  return idx
    .filter((e) => e.relativePath.toLowerCase().includes(q))
    .map<Row>((e) => ({
      path: e.path,
      label: e.relativePath,
      depth: Math.max(0, e.depth - 1),
      expandable: false,
      expanded: false,
      loading: false
    }))
})

const rows = computed<Row[]>(() => (searching.value ? searchRows.value : treeRows.value))

const showLoading = computed(() =>
  searching.value ? deepLoading.value && deepIndex.value === null : rootLoading.value
)
const truncated = computed(() => (searching.value ? deepTruncated.value : treeTruncated.value))

// Keep the selection in range whenever the visible list changes.
watch(rows, (list) => {
  if (selectedIndex.value >= list.length) selectedIndex.value = Math.max(0, list.length - 1)
})

async function loadChildren(dirPath: string): Promise<void> {
  if (childrenByPath.value.has(dirPath) || loadingPaths.value.has(dirPath)) return
  loadingPaths.value = new Set(loadingPaths.value).add(dirPath)
  const isRoot = dirPath === rootPath.value
  if (isRoot) rootLoading.value = true
  try {
    const scan = await window.api.foldersListChildFolders(dirPath)
    childrenByPath.value = new Map(childrenByPath.value).set(dirPath, scan.entries)
    if (scan.truncated) treeTruncated.value = true
  } catch {
    // Unreadable / vanished — treat as no children so the chevron just collapses.
    childrenByPath.value = new Map(childrenByPath.value).set(dirPath, [])
  } finally {
    const next = new Set(loadingPaths.value)
    next.delete(dirPath)
    loadingPaths.value = next
    if (isRoot) rootLoading.value = false
  }
}

async function ensureDeepIndex(): Promise<void> {
  if (deepIndex.value !== null || deepLoading.value) return
  deepLoading.value = true
  try {
    const scan = await window.api.foldersListSubfolders(rootPath.value)
    deepIndex.value = scan.entries
    deepTruncated.value = scan.truncated
  } catch {
    deepIndex.value = []
    deepTruncated.value = false
  } finally {
    deepLoading.value = false
  }
}

function toggleExpand(row: Row): void {
  if (!row.expandable) return
  const next = new Set(expanded.value)
  if (next.has(row.path)) {
    next.delete(row.path)
  } else {
    next.add(row.path)
    void loadChildren(row.path)
  }
  expanded.value = next
}

async function choose(path: string): Promise<void> {
  try {
    await sessions.pinFolder(path)
    ui.closeDialog()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({ kind: 'danger', title: t('openSubfolder.openFailed'), description: message })
  }
}

function confirmSelection(): void {
  const row = rows.value[selectedIndex.value]
  if (row) void choose(row.path)
}

function scrollSelectedIntoView(): void {
  void nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-index="${selectedIndex.value}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function close(): void {
  ui.closeDialog()
}

const searchInputRef = ref<HTMLInputElement | null>(null)
const dialogRef = ref<HTMLElement | null>(null)

useFocusTrap({ active: isOpen, containerRef: dialogRef, initialFocusRef: searchInputRef })

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
    return
  }
  const list = rows.value
  const n = list.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (n === 0) return
    selectedIndex.value = (selectedIndex.value + 1) % n
    scrollSelectedIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (n === 0) return
    selectedIndex.value = (selectedIndex.value - 1 + n) % n
    scrollSelectedIntoView()
  } else if (e.key === 'ArrowRight') {
    // Tree nav: expand a collapsed node, or step into its first child.
    if (searching.value) return
    const row = list[selectedIndex.value]
    if (!row) return
    e.preventDefault()
    if (row.expandable && !row.expanded) toggleExpand(row)
    else if (row.expanded && selectedIndex.value < n - 1) {
      selectedIndex.value += 1
      scrollSelectedIntoView()
    }
  } else if (e.key === 'ArrowLeft') {
    // Tree nav: collapse an expanded node, or step out to its parent.
    if (searching.value) return
    const row = list[selectedIndex.value]
    if (!row) return
    e.preventDefault()
    if (row.expanded) {
      toggleExpand(row)
    } else {
      for (let i = selectedIndex.value - 1; i >= 0; i--) {
        if (list[i].depth < row.depth) {
          selectedIndex.value = i
          scrollSelectedIntoView()
          break
        }
      }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    confirmSelection()
  }
}

// Load the deep index the moment a search begins; reset the cursor on mode flip.
watch(searching, (on) => {
  selectedIndex.value = 0
  if (on) void ensureDeepIndex()
})

watch(isOpen, (open) => {
  if (open) {
    query.value = ''
    selectedIndex.value = 0
    childrenByPath.value = new Map()
    expanded.value = new Set()
    loadingPaths.value = new Set()
    treeTruncated.value = false
    deepIndex.value = null
    deepTruncated.value = false
    window.addEventListener('keydown', onKeydown, true)
    void loadChildren(rootPath.value)
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(560px, 90vw);
          height: min(70vh, 560px);
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-subfolder-dialog-title"
        @mousedown.stop
      >
        <!-- Header -->
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div class="flex items-baseline" style="gap: 8px; min-width: 0">
            <h2
              id="open-subfolder-dialog-title"
              class="text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ $t('openSubfolder.title') }}
            </h2>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">{{
              rootName
            }}</span>
          </div>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('openSubfolder.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <!-- Search -->
        <div class="shrink-0 border-b border-border" style="padding: 10px 18px">
          <div
            class="flex items-center border border-border bg-bg text-text-2"
            style="border-radius: 5px; padding: 0 10px; height: 32px; gap: 8px"
          >
            <Search :size="13" :stroke-width="1.6" class="shrink-0 text-text-4" />
            <input
              ref="searchInputRef"
              v-model="query"
              class="w-full bg-transparent text-text"
              style="font-size: 13px; outline: none; border: none"
              type="text"
              autocomplete="off"
              spellcheck="false"
              :placeholder="$t('openSubfolder.searchPlaceholder')"
            />
          </div>
        </div>

        <!-- List -->
        <div ref="listRef" class="scrollable flex-1 overflow-y-auto" style="padding: 6px 8px">
          <div
            v-if="showLoading"
            class="flex items-center text-text-4"
            style="padding: 10px 10px; font-size: 12px; gap: 8px"
          >
            {{ $t('openSubfolder.loading') }}
          </div>
          <div
            v-else-if="rows.length === 0"
            class="flex items-center text-text-4"
            style="padding: 10px 10px; font-size: 12px"
          >
            {{ searching ? $t('openSubfolder.noMatch') : $t('openSubfolder.empty') }}
          </div>
          <template v-else>
            <div
              v-for="(row, idx) in rows"
              :key="row.path"
              :data-index="idx"
              class="flex w-full cursor-pointer items-center text-left transition"
              :class="
                idx === selectedIndex
                  ? 'bg-surface-2 text-text'
                  : 'text-text-2 hover:bg-surface-2 hover:text-text'
              "
              style="border-radius: 5px; padding: 6px 8px; gap: 4px; font-size: 12.5px"
              role="option"
              :aria-selected="idx === selectedIndex"
              @mouseenter="selectedIndex = idx"
              @click="choose(row.path)"
            >
              <!-- Indentation -->
              <span aria-hidden="true" class="shrink-0" :style="{ width: `${row.depth * 14}px` }" />
              <!-- Chevron (tree, expandable) or a spacer to keep labels aligned -->
              <button
                v-if="!searching && row.expandable"
                class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:bg-surface hover:text-text-2"
                style="width: 16px; height: 16px"
                :aria-label="
                  row.expanded ? $t('openSubfolder.collapse') : $t('openSubfolder.expand')
                "
                @click.stop="toggleExpand(row)"
              >
                <ChevronRight
                  :size="13"
                  :stroke-width="1.7"
                  :style="{
                    transition: 'transform var(--dur-fast) var(--ease)',
                    transform: row.expanded ? 'rotate(90deg)' : 'rotate(0deg)'
                  }"
                />
              </button>
              <span v-else aria-hidden="true" class="shrink-0" style="width: 16px" />
              <FolderIcon :size="13" :stroke-width="1.6" class="shrink-0 text-text-4" />
              <span class="flex-1 truncate font-mono" style="font-size: 12px; padding-left: 2px">{{
                row.label
              }}</span>
            </div>
          </template>
        </div>

        <!-- Footer -->
        <footer
          class="flex shrink-0 items-center justify-between border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <span class="truncate text-text-4" style="font-size: 11px">
            <template v-if="truncated && searching">{{
              $t('openSubfolder.truncated', { n: (deepIndex ?? []).length })
            }}</template>
            <template v-else-if="truncated">{{ $t('openSubfolder.levelTruncated') }}</template>
          </span>
          <div class="flex shrink-0 items-center" style="gap: 8px">
            <button
              class="border border-border bg-transparent text-text-2 transition hover:text-text"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                height: 28px;
              "
              @click="close()"
            >
              {{ $t('actions.cancel') }}
            </button>
            <button
              class="flex items-center bg-accent text-accent-ink transition"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                border: none;
                height: 28px;
                gap: 7px;
              "
              :style="{
                opacity: rows.length > 0 ? 1 : 0.4,
                cursor: rows.length > 0 ? 'pointer' : 'not-allowed'
              }"
              :disabled="rows.length === 0"
              @click="confirmSelection()"
            >
              <FolderIcon :size="13" :stroke-width="1.7" />
              {{ $t('openSubfolder.open') }}
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
