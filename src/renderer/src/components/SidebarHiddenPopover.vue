<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Folder as FolderIcon, Search } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useSessionsStore, type Folder } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { groupByRepo, isFolderGroup } from '../stores/folder-zones'

/**
 * Sidebar Hidden-folders popover (2026-07-19). Anchored to the toolbar's
 * Hidden button (`Sidebar.vue`). Replaces the "Hidden ({count})" disclosure
 * that used to live inside the combined `⋯` menu (`SidebarSectionMenu.vue`,
 * now deleted) — the Expand/Collapse-all action that used to sit above it is
 * now its own toolbar button, so this popover's only content is the list of
 * manually-hidden folders, always shown (no inner disclosure to toggle).
 *
 * T290: the flat list became a small palette — a search input at the top
 * (filters by alias, branch and path, with an "N of M" counter), rows grouped
 * under repo eyebrows resolved by the SAME `groupByRepo` the sidebar's
 * `RepoGroupHeader` uses, a per-row session-count hint, ↑/↓/↵ keyboard
 * selection, and a footer that offers "Unhide all N" while a filter narrows
 * the list. Unhiding still keeps the popover open, so several folders can be
 * restored in one visit.
 *
 * Design references: `design.md` §6 "Sidebar toolbar (rescan · drill depth ·
 * collapse-all · hidden)".
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const { t } = useI18n()

const popoverState = computed(() => ui.sidebarHiddenPopover)
const rootRef = ref<HTMLElement | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const measuredSize = ref<{ width: number; height: number } | null>(null)

const position = computed<{ left: number; top: number }>(() => {
  const rect = popoverState.value.anchorRect
  if (!rect) return { left: 0, top: 0 }
  const margin = 8
  const offsetY = 4
  let left = rect.left
  let top = rect.bottom + offsetY
  if (measuredSize.value) {
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (left + measuredSize.value.width > vw - margin) {
      left = Math.max(margin, vw - margin - measuredSize.value.width)
    }
    if (top + measuredSize.value.height > vh - margin) {
      top = Math.max(margin, rect.top - measuredSize.value.height - offsetY)
    }
  }
  return { left, top }
})

/** Folders the user dismissed via the per-folder right-click menu. */
const hiddenFolders = computed<Folder[]>(() => sessions.dismissedFolders)

// ── Search (AC-1) ───────────────────────────────────────────────────────────

const query = ref('')
/** Trimmed, lower-cased query — the empty string means "no filter". */
const needle = computed(() => query.value.trim().toLowerCase())

/**
 * Case-insensitive match over the three fields a hidden folder is recognised
 * by: its sidebar alias, its git branch, and its absolute path.
 */
function matches(folder: Folder, q: string): boolean {
  if (!q) return true
  return (
    folder.alias.toLowerCase().includes(q) ||
    (folder.gitBranch ?? '').toLowerCase().includes(q) ||
    folder.path.toLowerCase().includes(q)
  )
}

const filteredFolders = computed<Folder[]>(() =>
  hiddenFolders.value.filter((f) => matches(f, needle.value))
)

// ── Grouping (AC-2) ─────────────────────────────────────────────────────────

/** One rendered section: an eyebrow label (+ optional dim hint) and its rows. */
interface HiddenSection {
  key: string
  label: string
  parentHint?: string
  folders: Folder[]
}

/**
 * Group the FILTERED folders exactly the way the sidebar groups visible ones —
 * `groupByRepo` with the store's group aliases, so a repo renamed in the tree
 * reads the same here. A folder that doesn't join a repo group becomes its own
 * single-row section labelled with its alias.
 */
const sections = computed<HiddenSection[]>(() =>
  groupByRepo(filteredFolders.value, undefined, sessions.groupAliases).map((node) =>
    isFolderGroup(node)
      ? {
          key: node.key,
          label: node.label,
          parentHint: node.parentHint,
          folders: node.folders
        }
      : { key: `folder:${node.path}`, label: node.alias, folders: [node] }
  )
)

/** Every visible row in render order — the index space the cursor lives in. */
const flatFolders = computed<Folder[]>(() => sections.value.flatMap((s) => s.folders))

// ── Keyboard / hover selection (AC-3) ───────────────────────────────────────

const cursor = ref(0)

/** Keep the cursor inside the list whenever the filter changes its length. */
watch(
  () => flatFolders.value.length,
  (len) => {
    if (cursor.value > len - 1) cursor.value = Math.max(0, len - 1)
  }
)
watch(needle, () => {
  cursor.value = 0
})

const selectedFolder = computed<Folder | undefined>(() => flatFolders.value[cursor.value])

function isSelected(folder: Folder): boolean {
  return selectedFolder.value?.path === folder.path
}

/**
 * Whether the pending cursor change came from the keyboard. Only those scroll:
 * a hover-driven move must never slide the list under a stationary pointer,
 * which would drop a different row under it and jitter the selection.
 */
let cursorMovedByKeyboard = false

function moveCursor(delta: number): void {
  const len = flatFolders.value.length
  if (len === 0) return
  cursorMovedByKeyboard = true
  cursor.value = (cursor.value + delta + len) % len
}

/** Hover selection. Silent on a row that is no longer in the flat order. */
function selectByHover(folder: Folder): void {
  const idx = flatFolders.value.indexOf(folder)
  if (idx < 0) return
  cursorMovedByKeyboard = false
  cursor.value = idx
}

/**
 * Keep the KEYBOARD-selected row visible. The result list is capped at `60vh`,
 * and the list this popover exists for is long (43 hidden folders on the
 * operator's install), so arrowing past the fold would otherwise move an
 * invisible cursor. Hover moves are excluded on purpose — see
 * `cursorMovedByKeyboard`. `scrollIntoView` is optional-called: jsdom doesn't
 * implement it.
 */
watch(cursor, async () => {
  if (!cursorMovedByKeyboard) return
  cursorMovedByKeyboard = false
  await nextTick()
  const row = listRef.value?.querySelector<HTMLElement>('[data-row-selected="true"]')
  row?.scrollIntoView?.({ block: 'nearest' })
})

// ── Row presentation ────────────────────────────────────────────────────────

/** Split an alias around the matched substring so the middle can render bold. */
function highlight(alias: string): { before: string; match: string; after: string } {
  const q = needle.value
  if (!q) return { before: alias, match: '', after: '' }
  const idx = alias.toLowerCase().indexOf(q)
  if (idx < 0) return { before: alias, match: '', after: '' }
  return {
    before: alias.slice(0, idx),
    match: alias.slice(idx, idx + q.length),
    after: alias.slice(idx + q.length)
  }
}

/** "no sessions" / "1 session" / "N sessions" — no plural forms in this repo. */
function sessionHint(folder: Folder): string {
  const count = folder.sessions.length
  if (count === 0) return t('sidebar.hiddenPopover.sessionsNone')
  if (count === 1) return t('sidebar.hiddenPopover.sessionsOne')
  return t('sidebar.hiddenPopover.sessionsMany', { count })
}

// ── Footer (AC-4) ───────────────────────────────────────────────────────────

/** "Unhide all N" is offered only while a filter actually narrows the list. */
const showUnhideAll = computed(() => needle.value !== '' && flatFolders.value.length >= 2)

async function measureAndClamp(): Promise<void> {
  await nextTick()
  if (!rootRef.value) return
  const rect = rootRef.value.getBoundingClientRect()
  measuredSize.value = { width: rect.width, height: rect.height }
}

/** Unhide one folder. Returns the failure message, or `null` on success. */
async function unhideOne(folderPath: string): Promise<string | null> {
  try {
    await sessions.unhideFolder(folderPath)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  void measureAndClamp()
  return null
}

/** Unhide a single folder. Keeps the popover open so more can be unhidden. */
async function onUnhide(folderPath: string): Promise<void> {
  const failure = await unhideOne(folderPath)
  if (failure === null) return
  ui.pushToast({
    kind: 'danger',
    title: t('folderMenu.unhideFailed'),
    description: failure
  })
}

/**
 * Unhide every folder currently listed under the active filter. Failures are
 * collected and reported ONCE: `pushToast` neither dedupes nor caps its stack
 * and also writes a notification-history row, so toasting per folder would bury
 * the screen (and the bell) under one entry per member of the filtered set.
 */
async function onUnhideAll(): Promise<void> {
  const failures: string[] = []
  for (const folder of [...flatFolders.value]) {
    const failure = await unhideOne(folder.path)
    if (failure !== null) failures.push(failure)
  }
  if (failures.length === 0) return
  ui.pushToast({
    kind: 'danger',
    title: t('folderMenu.unhideFailed'),
    description:
      failures.length === 1
        ? failures[0]
        : t('sidebar.hiddenPopover.unhideAllFailed', {
            count: failures.length,
            reason: failures[0]
          })
  })
}

function onWindowMousedown(e: MouseEvent): void {
  if (!popoverState.value.open) return
  if (!rootRef.value) return
  if (rootRef.value.contains(e.target as Node)) return
  const target = e.target as HTMLElement
  if (target?.closest('[data-sidebar-hidden-trigger]')) return
  ui.closeSidebarHiddenPopover()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (!popoverState.value.open) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    ui.closeSidebarHiddenPopover()
    return
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.stopPropagation()
    e.preventDefault()
    moveCursor(e.key === 'ArrowDown' ? 1 : -1)
    return
  }
  if (e.key === 'Enter') {
    const folder = selectedFolder.value
    if (!folder) return
    e.stopPropagation()
    e.preventDefault()
    void onUnhide(folder.path)
  }
}

function onWindowWheel(e: WheelEvent): void {
  if (!popoverState.value.open) return
  if (rootRef.value?.contains(e.target as Node)) return
  ui.closeSidebarHiddenPopover()
}

watch(
  () => popoverState.value.open,
  async (open) => {
    if (open) {
      measuredSize.value = null
      query.value = ''
      cursor.value = 0
      window.addEventListener('mousedown', onWindowMousedown, true)
      window.addEventListener('keydown', onWindowKeydown, true)
      window.addEventListener('wheel', onWindowWheel, { passive: true })
      await measureAndClamp()
      inputRef.value?.focus()
    } else {
      window.removeEventListener('mousedown', onWindowMousedown, true)
      window.removeEventListener('keydown', onWindowKeydown, true)
      window.removeEventListener('wheel', onWindowWheel)
    }
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onWindowMousedown, true)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('wheel', onWindowWheel)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="popoverState.open && popoverState.anchorRect"
      ref="rootRef"
      class="anim-fade-in-scale fixed overflow-hidden border border-border-2 bg-surface"
      style="
        min-width: 260px;
        max-width: 340px;
        border-radius: 7px;
        box-shadow: var(--shadow-pop);
        z-index: 50;
        transform-origin: top left;
      "
      :style="{ left: position.left + 'px', top: position.top + 'px' }"
      role="dialog"
      :aria-label="t('sidebar.menu.hidden', { count: hiddenFolders.length })"
    >
      <!-- Nothing hidden at all: the historical one-line message, no search. -->
      <div
        v-if="hiddenFolders.length === 0"
        class="text-text-3"
        style="padding: 8px; font-size: 12px"
      >
        {{ t('sidebar.menu.hidden', { count: 0 }) }}
      </div>

      <template v-else>
        <!-- Search row (AC-1) -->
        <div
          class="flex items-center border-b border-border"
          style="height: 32px; padding: 0 10px; gap: 8px"
        >
          <Search :size="13" :stroke-width="1.6" class="shrink-0 text-text-3" />
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            class="min-w-0 flex-1 bg-transparent font-sans text-text outline-none"
            style="font-size: 12.5px"
            autocomplete="off"
            spellcheck="false"
            data-testid="hidden-search"
            :placeholder="t('sidebar.hiddenPopover.search')"
            :aria-label="t('sidebar.hiddenPopover.search')"
          />
          <span
            class="shrink-0 text-text-4 tabular-nums"
            style="font-size: 10.5px"
            data-testid="hidden-counter"
          >
            {{
              t('sidebar.hiddenPopover.counter', {
                shown: flatFolders.length,
                total: hiddenFolders.length
              })
            }}
          </span>
        </div>

        <!-- Results (AC-2 / AC-3) -->
        <div
          ref="listRef"
          class="scrollable"
          style="max-height: 60vh; overflow-y: auto"
          role="listbox"
          :aria-label="t('sidebar.hiddenPopover.results')"
        >
          <div
            v-if="flatFolders.length === 0"
            class="text-text-3"
            style="padding: 14px 12px; font-size: 11.5px; line-height: 1.5"
            data-testid="hidden-empty"
          >
            {{ t('sidebar.hiddenPopover.empty') }}
          </div>

          <template v-else>
            <div
              v-for="section in sections"
              :key="section.key"
              style="padding: 6px 0 2px"
              role="group"
              :aria-label="section.label"
              data-testid="hidden-section"
            >
              <div
                aria-hidden="true"
                class="flex items-center justify-between text-text-4"
                style="
                  padding: 4px 10px;
                  font-size: 10.5px;
                  line-height: 14px;
                  font-weight: 500;
                  letter-spacing: 0.07em;
                  text-transform: uppercase;
                "
              >
                <span class="truncate"
                  >{{ section.label
                  }}<span v-if="section.parentHint"> · {{ section.parentHint }}</span></span
                >
                <span class="shrink-0 tabular-nums">{{ section.folders.length }}</span>
              </div>

              <button
                v-for="folder in section.folders"
                :key="folder.path"
                type="button"
                role="option"
                tabindex="-1"
                :aria-selected="isSelected(folder)"
                :data-row-selected="isSelected(folder) ? 'true' : 'false'"
                class="relative flex w-full items-center text-left transition"
                :class="
                  isSelected(folder)
                    ? 'bg-surface-2 text-text'
                    : 'text-text-2 hover:bg-surface-2 hover:text-text'
                "
                style="gap: 8px; height: 28px; padding: 0 10px; font-size: 12px; outline: none"
                :title="t('sidebar.menu.unhide')"
                :aria-label="t('sidebar.menu.unhide') + ' — ' + folder.alias"
                @mouseenter="selectByHover(folder)"
                @mousedown.prevent
                @click="onUnhide(folder.path)"
              >
                <span
                  v-if="isSelected(folder)"
                  aria-hidden="true"
                  class="absolute bg-accent"
                  style="left: 0; top: 0; bottom: 0; width: 2px; border-radius: 0 2px 2px 0"
                />
                <FolderIcon :size="13" :stroke-width="1.8" class="shrink-0 text-text-4" />
                <span class="min-w-0 flex-1 truncate">
                  {{ highlight(folder.alias).before
                  }}<b v-if="highlight(folder.alias).match" class="font-semibold text-text">{{
                    highlight(folder.alias).match
                  }}</b
                  >{{ highlight(folder.alias).after }}
                </span>
                <span
                  class="shrink-0 truncate text-text-4"
                  style="font-size: 11px; max-width: 46%"
                  data-testid="hidden-session-hint"
                >
                  {{ sessionHint(folder) }}
                </span>
                <span
                  v-if="isSelected(folder)"
                  class="shrink-0 border border-accent-line bg-accent-soft text-accent"
                  style="font-size: 10px; line-height: 14px; padding: 1px 6px; border-radius: 999px"
                  data-testid="hidden-unhide-chip"
                >
                  {{ t('sidebar.menu.unhide') }}
                </span>
              </button>
            </div>
          </template>
        </div>

        <!-- Footer (AC-4) -->
        <div
          class="flex items-center border-t border-border text-text-4"
          style="height: 26px; padding: 0 10px; gap: 10px; font-size: 10.5px"
        >
          <span class="flex items-center" style="gap: 5px">
            <kbd
              class="inline-flex items-center justify-center border border-border bg-surface-2 font-mono text-text-3"
              style="
                min-width: 16px;
                height: 15px;
                padding: 0 4px;
                font-size: 10px;
                line-height: 13px;
                border-radius: 3px;
              "
              >↵</kbd
            >
            {{ t('sidebar.hiddenPopover.enterHint') }}
          </span>
          <span class="flex-1"></span>
          <button
            v-if="showUnhideAll"
            type="button"
            class="shrink-0 text-accent transition hover:underline"
            style="font-size: 10.5px; outline: none"
            data-testid="hidden-unhide-all"
            @mousedown.prevent
            @click="onUnhideAll()"
          >
            {{ t('sidebar.hiddenPopover.unhideAll', { count: flatFolders.length }) }}
          </button>
        </div>
      </template>
    </div>
  </Teleport>
</template>
