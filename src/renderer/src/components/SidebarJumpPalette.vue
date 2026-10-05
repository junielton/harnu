<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  CornerDownLeft,
  EyeOff,
  Folder as FolderIcon,
  GitBranch,
  History,
  Search
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useJumpSearch, matchSegments, type JumpResult } from '../composables/useJumpSearch'
import { dotFor } from './session-dot'
import type { Session } from '../stores/sessions'

/**
 * Sidebar jump palette (T288) — "search means take me there", not "filter the
 * tree" (design.md §6 — "Sidebar jump palette"; spec
 * `docs/specs/2026-09-04-sidebar-explorations/spec.html#sidebar--jump-palette--unified`).
 *
 * Anchored under the sidebar's one-line header and rendered INSIDE the sidebar
 * `<aside>` rather than teleported to `<body>`: it must move and clip with the
 * sidebar. The tree behind it is never filtered — `filterQuery` is only ever
 * written by the explicit `⇥` fallback, so closing the palette never loses the
 * operator's place.
 *
 * Sections, in order: Folders → Hidden → Sessions with a query; Recent searches
 * → Recently visited with an empty one.
 *
 * Keyboard: `↑`/`↓` move the cursor across group borders, `↵` jumps, `⇥` hands
 * the query to the tree filter and closes, `Esc` closes. `⌘K` is deliberately
 * NOT bound here — it stays on the command palette.
 */

const sessions = useSessionsStore()
const ui = useUiStore()
const { t } = useI18n()

const isOpen = computed(() => ui.sidebarJumpPalette.open)

const query = ref('')
const cursor = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)

const { groups, results } = useJumpSearch(query)

const hasQuery = computed(() => query.value.trim().length > 0)

// ---------------------------------------------------------------------------
// Empty-query state — history (spec `#sidebar--jump-palette--recent`)
// ---------------------------------------------------------------------------

/**
 * The hit-count hint on a recent-search row. The counts are a snapshot from
 * when the search ran; the FIRST non-empty group in display order names it,
 * which is what makes "www → 3 folders" and "pull/177 → 1 session" both read
 * the way the spec renders them.
 */
function searchHint(e: { folders: number; hidden: number; sessions: number }): string {
  if (e.folders > 0) return t('sidebar.jump.hitFolders', e.folders, { named: { n: e.folders } })
  if (e.hidden > 0) return t('sidebar.jump.hitHidden', e.hidden, { named: { n: e.hidden } })
  return t('sidebar.jump.hitSessions', e.sessions, { named: { n: e.sessions } })
}

/** The last visited folders, resolved against the live model (stale paths drop out). */
const recentVisits = computed(() =>
  sessions.recentJumpVisits
    .map((path) => sessions.folders.find((f) => f.path === path))
    .filter((f): f is NonNullable<typeof f> => f != null)
)

/** The repo-group label a visited folder sits under — omitted for a standalone folder. */
function visitHint(path: string): string {
  for (const node of sessions.visibleFolders) {
    if (!('kind' in node) || node.kind !== 'folder-group') continue
    if (!node.folders.some((f) => f.path === path)) continue
    if (node.folders.find((f) => f.path === path)?.isMainWorktree === true) return ''
    return node.parentHint ? `${node.label} · ${node.parentHint}` : node.label
  }
  return ''
}

/**
 * The flat cursor list. With a query it is the result rows; empty, it is the
 * recent searches (which re-run themselves on ↵) followed by the visits.
 */
type HistoryItem =
  | { kind: 'search'; id: string; query: string; hint: string }
  | { kind: 'visit'; id: string; path: string; label: string; hint: string }

const historyItems = computed<HistoryItem[]>(() => {
  const out: HistoryItem[] = []
  for (const e of sessions.recentJumpSearches) {
    out.push({ kind: 'search', id: `search:${e.query}`, query: e.query, hint: searchHint(e) })
  }
  for (const f of recentVisits.value) {
    out.push({
      kind: 'visit',
      id: `visit:${f.path}`,
      path: f.path,
      label: f.alias,
      hint: visitHint(f.path)
    })
  }
  return out
})

/** Cursor length — results when searching, history rows when not. */
const cursorLength = computed(() =>
  hasQuery.value ? results.value.length : historyItems.value.length
)

const isEmpty = computed(() => cursorLength.value === 0)

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function close(): void {
  ui.closeSidebarJumpPalette()
}

/**
 * Record the query that produced the current result set, so it lands in the
 * empty-query history with the counts the operator actually saw.
 */
function rememberQuery(): void {
  const q = query.value.trim()
  if (!q) return
  const count = (kind: 'folders' | 'hidden' | 'sessions'): number =>
    groups.value.find((g) => g.kind === kind)?.results.length ?? 0
  sessions.recordJumpSearch({
    query: q,
    folders: count('folders'),
    hidden: count('hidden'),
    sessions: count('sessions')
  })
}

async function jump(r: JumpResult): Promise<void> {
  rememberQuery()
  close()
  if (r.group === 'hidden') {
    await sessions.unhideAndJump(r.path)
    return
  }
  if (r.group === 'sessions' && r.sessionId) {
    sessions.jumpToSession(r.sessionId)
    return
  }
  sessions.jumpToFolder(r.path)
}

function activateHistory(item: HistoryItem): void {
  if (item.kind === 'search') {
    // Re-run the query in place rather than jumping — the hit counts are a
    // snapshot, so the only honest thing to replay is the search itself.
    query.value = item.query
    cursor.value = 0
    inputEl.value?.focus()
    return
  }
  close()
  sessions.jumpToFolder(item.path)
}

/** `⇥` — hand the query to today's tree filter and close (the narrow-the-tree fallback). */
function applyAsFilter(): void {
  const q = query.value.trim()
  if (!q) return
  rememberQuery()
  sessions.applyQueryAsFilter(q)
  close()
}

// ---------------------------------------------------------------------------
// Keyboard + dismissal
// ---------------------------------------------------------------------------

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  if (e.key === 'Tab' && !e.shiftKey && hasQuery.value) {
    e.preventDefault()
    e.stopPropagation()
    applyAsFilter()
    return
  }
  // stopPropagation, not just preventDefault: the window-level sidebar cursor
  // would otherwise ALSO walk the tree behind the palette (the same reason
  // `CommandPalette.vue` swallows these).
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    const n = cursorLength.value
    if (n === 0) return
    const step = e.key === 'ArrowDown' ? 1 : -1
    cursor.value = (cursor.value + step + n) % n
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    if (hasQuery.value) {
      const r = results.value[cursor.value]
      if (r) void jump(r)
    } else {
      const item = historyItems.value[cursor.value]
      if (item) activateHistory(item)
    }
  }
}

function onWindowMousedown(e: MouseEvent): void {
  if (!isOpen.value) return
  if (rootRef.value?.contains(e.target as Node)) return
  // The search button toggles — let its own handler decide, or the palette
  // would close here and immediately reopen.
  if ((e.target as HTMLElement | null)?.closest('[data-sidebar-jump-trigger]')) return
  close()
}

// `immediate` so a component that MOUNTS already-open still attaches its
// listeners and takes focus — without it the palette would render but swallow
// no keys, which is exactly the shape of a silently dead surface.
watch(
  isOpen,
  async (open) => {
    if (open) {
      query.value = ''
      cursor.value = 0
      window.addEventListener('keydown', onKeydown, true)
      window.addEventListener('mousedown', onWindowMousedown, true)
      await nextTick()
      inputEl.value?.focus()
    } else {
      window.removeEventListener('keydown', onKeydown, true)
      window.removeEventListener('mousedown', onWindowMousedown, true)
    }
  },
  { immediate: true }
)

watch([query, cursorLength], () => {
  if (cursor.value >= cursorLength.value) cursor.value = 0
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('mousedown', onWindowMousedown, true)
})

/**
 * Status-dot fill for a session result row. The palette shows the plain 6px dot
 * from the spec — no pulse ring and no `stuck`/`archived` glyphs: a result row
 * is a navigation target, and the full state vocabulary lives on the tree row
 * the operator lands on.
 */
function dotBg(s: Session): string {
  switch (
    dotFor(s.taskState, s.status, sessions.activityOf(s, sessions.nowTick), s.transcriptState)
  ) {
    case 'working':
      return 'bg-green'
    case 'needs-input':
      return 'bg-warning'
    case 'failed':
    case 'stuck':
      return 'bg-red'
    default:
      return 'bg-text-4'
  }
}

/** Flat index of a result row, for the cursor comparison in the template. */
function indexOfResult(r: JumpResult): number {
  return results.value.indexOf(r)
}
</script>

<template>
  <div
    v-if="isOpen"
    ref="rootRef"
    data-sidebar-jump-palette
    class="anim-fade-in absolute overflow-hidden border border-border-2 bg-surface"
    style="
      left: 8px;
      right: 8px;
      top: 46px;
      z-index: 50;
      border-radius: var(--radius);
      box-shadow: var(--shadow-pop);
    "
    role="dialog"
    :aria-label="$t('sidebar.jump.label')"
  >
    <!-- Input row -->
    <div
      class="flex shrink-0 items-center border-b border-border"
      style="height: 34px; padding: 0 10px; gap: 8px"
    >
      <Search :size="14" :stroke-width="1.5" class="shrink-0 text-text-3" />
      <input
        ref="inputEl"
        v-model="query"
        data-sidebar-jump-input
        type="text"
        class="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-4"
        style="font-size: 12.5px"
        autocomplete="off"
        spellcheck="false"
        :placeholder="$t('sidebar.jump.placeholder')"
      />
      <kbd
        class="shrink-0 border border-border-2 bg-surface font-mono text-text-3"
        style="font-size: 10px; line-height: 14px; border-radius: 4px; padding: 0 4px"
        >esc</kbd
      >
    </div>

    <!-- Results (query) -->
    <div v-if="hasQuery" class="scrollable overflow-y-auto" style="max-height: 46vh">
      <div v-for="group in groups" :key="group.kind" style="padding: 6px 0 2px">
        <div
          class="flex items-center justify-between uppercase text-text-4"
          style="
            padding: 4px 10px;
            font-size: 10.5px;
            line-height: 14px;
            font-weight: 500;
            letter-spacing: 0.07em;
          "
        >
          <span>{{ $t(`sidebar.jump.groups.${group.kind}`) }}</span>
          <span class="tabular-nums">{{ group.results.length }}</span>
        </div>

        <button
          v-for="r in group.results"
          :key="r.id"
          type="button"
          data-sidebar-jump-result
          :data-jump-id="r.id"
          class="relative flex w-full items-center text-left transition focus:outline-none"
          :class="
            indexOfResult(r) === cursor
              ? 'bg-surface-2 text-text'
              : 'text-text-2 hover:bg-surface-2 hover:text-text'
          "
          :style="{
            height: '28px',
            padding: '0 10px',
            gap: '8px',
            opacity: r.group === 'hidden' ? 0.75 : 1
          }"
          @mouseenter="cursor = indexOfResult(r)"
          @click="jump(r)"
        >
          <span
            v-if="indexOfResult(r) === cursor"
            class="absolute bg-accent"
            style="left: 0; top: 0; bottom: 0; width: 2px; border-radius: 0 2px 2px 0"
            aria-hidden="true"
          />
          <!-- Leading glyph: eye-off for a hidden folder, git-branch for a repo
               group's main worktree, folder otherwise, status dot for a session. -->
          <EyeOff
            v-if="r.group === 'hidden'"
            :size="13"
            :stroke-width="1.8"
            class="shrink-0 text-text-3"
          />
          <span
            v-else-if="r.group === 'sessions'"
            class="flex shrink-0 items-center justify-center"
            style="width: 13px"
          >
            <span class="rounded-full" :class="dotBg(r.session!)" style="width: 6px; height: 6px" />
          </span>
          <GitBranch
            v-else-if="r.isRepoGroup"
            :size="13"
            :stroke-width="1.8"
            class="shrink-0 text-text-3"
          />
          <FolderIcon v-else :size="13" :stroke-width="1.8" class="shrink-0 text-text-3" />

          <span class="min-w-0 flex-1 truncate" style="font-size: 12.5px">
            <template v-for="(seg, i) in matchSegments(r.label, query)" :key="i">
              <b v-if="seg.match" class="font-semibold text-text">{{ seg.text }}</b>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>

          <span
            v-if="r.group === 'hidden'"
            class="shrink-0 border border-accent-line bg-accent-soft text-accent"
            style="font-size: 10px; line-height: 14px; padding: 1px 6px; border-radius: 999px"
            >{{ $t('sidebar.jump.unhideAndGo') }}</span
          >
          <!-- The hint carries the match too (spec `.pop-row .hint b`), one step
               dimmer than the label's bold so the label still wins the eye. -->
          <span
            v-else-if="r.hint"
            class="shrink-0 truncate text-text-4"
            :class="r.hintMono ? 'font-mono' : ''"
            style="font-size: 11px; max-width: 46%"
          >
            <template v-for="(seg, i) in matchSegments(r.hint, query)" :key="i">
              <b v-if="seg.match" class="font-semibold text-text-3">{{ seg.text }}</b>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
          <CornerDownLeft
            v-if="indexOfResult(r) === cursor"
            :size="12"
            :stroke-width="1.8"
            class="shrink-0 text-text-4"
          />
        </button>
      </div>

      <div
        v-if="isEmpty"
        class="text-text-3"
        style="padding: 14px 12px; font-size: 11.5px; line-height: 1.5"
      >
        {{ $t('sidebar.jump.noMatches') }}
      </div>
    </div>

    <!-- History (empty query) -->
    <div v-else class="scrollable overflow-y-auto" style="max-height: 46vh">
      <div v-if="sessions.recentJumpSearches.length > 0" style="padding: 6px 0 2px">
        <div
          class="flex items-center justify-between text-text-4"
          style="padding: 4px 10px; font-size: 10.5px; line-height: 14px; font-weight: 500"
        >
          <span class="uppercase" style="letter-spacing: 0.07em">{{
            $t('sidebar.jump.recentSearches')
          }}</span>
          <button
            type="button"
            data-sidebar-jump-clear
            class="font-normal transition hover:text-text"
            @click="sessions.clearJumpSearches()"
          >
            {{ $t('sidebar.jump.clear') }}
          </button>
        </div>
        <button
          v-for="item in historyItems.filter((h) => h.kind === 'search')"
          :key="item.id"
          type="button"
          data-sidebar-jump-history
          class="relative flex w-full items-center text-left transition focus:outline-none"
          :class="
            historyItems.indexOf(item) === cursor
              ? 'bg-surface-2 text-text'
              : 'text-text-2 hover:bg-surface-2 hover:text-text'
          "
          style="height: 28px; padding: 0 10px; gap: 8px"
          @mouseenter="cursor = historyItems.indexOf(item)"
          @click="activateHistory(item)"
        >
          <span
            v-if="historyItems.indexOf(item) === cursor"
            class="absolute bg-accent"
            style="left: 0; top: 0; bottom: 0; width: 2px; border-radius: 0 2px 2px 0"
            aria-hidden="true"
          />
          <History :size="13" :stroke-width="1.8" class="shrink-0 text-text-3" />
          <span class="min-w-0 flex-1 truncate" style="font-size: 12.5px">{{ item.query }}</span>
          <span class="shrink-0 truncate text-text-4" style="font-size: 11px; max-width: 46%">{{
            item.hint
          }}</span>
        </button>
      </div>

      <div v-if="recentVisits.length > 0" style="padding: 6px 0 2px">
        <div
          class="uppercase text-text-4"
          style="
            padding: 4px 10px;
            font-size: 10.5px;
            line-height: 14px;
            font-weight: 500;
            letter-spacing: 0.07em;
          "
        >
          {{ $t('sidebar.jump.recentlyVisited') }}
        </div>
        <button
          v-for="item in historyItems.filter((h) => h.kind === 'visit')"
          :key="item.id"
          type="button"
          data-sidebar-jump-history
          class="relative flex w-full items-center text-left transition focus:outline-none"
          :class="
            historyItems.indexOf(item) === cursor
              ? 'bg-surface-2 text-text'
              : 'text-text-2 hover:bg-surface-2 hover:text-text'
          "
          style="height: 28px; padding: 0 10px; gap: 8px"
          @mouseenter="cursor = historyItems.indexOf(item)"
          @click="activateHistory(item)"
        >
          <span
            v-if="historyItems.indexOf(item) === cursor"
            class="absolute bg-accent"
            style="left: 0; top: 0; bottom: 0; width: 2px; border-radius: 0 2px 2px 0"
            aria-hidden="true"
          />
          <FolderIcon :size="13" :stroke-width="1.8" class="shrink-0 text-text-3" />
          <span class="min-w-0 flex-1 truncate" style="font-size: 12.5px">{{ item.label }}</span>
          <span
            v-if="item.hint"
            class="shrink-0 truncate text-text-4"
            style="font-size: 11px; max-width: 46%"
            >{{ item.hint }}</span
          >
        </button>
      </div>

      <div
        v-if="isEmpty"
        class="text-text-3"
        style="padding: 14px 12px; font-size: 11.5px; line-height: 1.5"
      >
        {{ $t('sidebar.jump.noHistory') }}
      </div>
    </div>

    <!-- Footer hints. The spec's trailing `⌘K` chip is deliberately omitted:
         `⌘K` opens the COMMAND palette, not this one (T288). -->
    <div
      class="flex shrink-0 items-center border-t border-border text-text-4"
      style="height: 26px; padding: 0 10px; gap: 10px; font-size: 10.5px"
    >
      <span
        ><kbd
          class="border border-border-2 bg-surface font-mono text-text-3"
          style="font-size: 10px; border-radius: 4px; padding: 0 4px"
          >↑↓</kbd
        >
        {{ $t('sidebar.jump.hints.move') }}</span
      >
      <span
        ><kbd
          class="border border-border-2 bg-surface font-mono text-text-3"
          style="font-size: 10px; border-radius: 4px; padding: 0 4px"
          >↵</kbd
        >
        {{ $t('sidebar.jump.hints.jump') }}</span
      >
      <span v-if="hasQuery"
        ><kbd
          class="border border-border-2 bg-surface font-mono text-text-3"
          style="font-size: 10px; border-radius: 4px; padding: 0 4px"
          >⇥</kbd
        >
        {{ $t('sidebar.jump.hints.filterTree') }}</span
      >
      <span class="flex-1" />
      <span v-if="!hasQuery && sessions.dismissedFolders.length > 0">{{
        $t('sidebar.jump.hiddenIncluded', sessions.dismissedFolders.length, {
          named: { n: sessions.dismissedFolders.length }
        })
      }}</span>
    </div>
  </div>
</template>
