<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Clock,
  Command,
  Folder as FolderIcon,
  LayoutGrid,
  Maximize2,
  PanelRight,
  Search,
  Sparkles,
  Terminal as TerminalIcon
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useKeybindingsStore } from '../stores/keybindings'
import { sessionTitle } from '../lib/session-label'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useFuzzyMatcher } from '../composables/useJumpSearch'
import { invokeShortcut, isShortcutEnabled } from '../composables/useShortcuts'
import { KEYBINDINGS, type KeybindingGroup } from '../../../main/keybindings-core'
import type { Folder, Session } from '../stores/sessions'

/**
 * Command palette — the Cmd+K spotlight overlay, anatomy per
 * `design.md §6` (Dialog tokens + the floating-surface z-order table).
 *
 * State source: `ui.palette.open`. Driven by `useUiStore().openPalette()` and
 * `closePalette()`. Mounted once at the App level via `<Teleport to="body">`
 * — that's why this component has no Teleport of its own.
 *
 * Sections (in order):
 *  1. Recents — top 3 sessions by `modified` desc, only while the input is empty
 *  2. Actions — generated from the keybindings table (T486 §9.1)
 *  3. Folders — fuzzy-matched on `alias`
 *  4. Sessions — fuzzy-matched on `summary || firstPrompt`
 *
 * Keyboard:
 *  - `↑` / `↓` move the cursor through the flat filtered list
 *  - `Enter` activates the cursor item (runs its `handler`, then closes)
 *  - `Esc` closes the palette
 *  - Typing filters Sections 2-4 via fuse.js (Section 1 is hidden when typing)
 *
 * Selected-row styling matches the design's selected-sidebar pattern: an
 * accent left bar plus a soft accent background. The 14 px left padding keeps
 * the label aligned with non-selected rows (which use 16 px padding).
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const keybindings = useKeybindingsStore()
const { t } = useI18n()

const isOpen = computed(() => ui.palette.open)

const query = ref('')
const cursor = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
/**
 * Palette card ref — drives the focus trap (T-5.6). Tab cycles inside
 * the palette; on close the previously-focused element regains focus.
 */
const paletteRef = ref<HTMLElement | null>(null)

useFocusTrap({
  active: isOpen,
  containerRef: paletteRef,
  initialFocusRef: inputEl
})

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * One row in the palette. `section` controls grouping; `iconKey` selects the
 * lucide component (decoupled from `section` because Recents reuses the
 * "session" data shape but renders with a clock icon). `handler` runs the row's
 * action (select a session, open a dialog, toggle a view, …) on activation.
 */
type Section = 'recents' | 'actions' | 'folders' | 'sessions'
type IconKey = 'clock' | 'folder' | 'terminal' | KeybindingGroup

interface Item {
  /** Unique id used for `:key` and cursor tracking. */
  id: string
  /** The visible label — also the field fuzzy-searched against. */
  label: string
  /** Optional accelerator hint shown on the trailing edge (mono 10.5 px). */
  accelerator?: string
  section: Section
  iconKey: IconKey
  /** The row's action, run on activation (Enter or click). */
  handler: () => void
}

/** One icon per table group for action rows (design.md §6 "Command palette"). */
const ICONS = {
  clock: Clock,
  folder: FolderIcon,
  terminal: TerminalIcon,
  sessions: Sparkles,
  sidebar: Search,
  folders: FolderIcon,
  views: LayoutGrid,
  panes: PanelRight,
  takeovers: Maximize2,
  app: Command
} as const

/**
 * Sort sessions by their `modified` timestamp (ISO string) in descending
 * order — newest first. We sort a slice rather than mutating the store array.
 */
function sessionsByMtimeDesc(all: readonly Session[]): Session[] {
  return [...all].sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0))
}

function sessionLabel(s: Session): string {
  // The shared session name (BUG-78, trimmed there); the id keeps a nameless
  // session searchable.
  return sessionTitle(s, sessions.allSessions, t) || s.sessionId
}

/**
 * Pick the first session belonging to a folder. Returns `null` for folders
 * that have no JSONL on disk yet (a freshly added folder with no Claude
 * history). Used by the `folder:` activation path to give the user a useful
 * follow-on selection after the folder expands.
 */
function firstSessionInFolder(f: Folder): Session | null {
  return f.sessions.length > 0 ? f.sessions[0] : null
}

/** Top 3 recent sessions, mapped to palette items. */
const recents = computed<Item[]>(() => {
  const top = sessionsByMtimeDesc(sessions.allSessions).slice(0, 3)
  return top.map<Item>((s) => ({
    id: `recent:${s.sessionId}`,
    label: sessionLabel(s),
    section: 'recents',
    iconKey: 'clock',
    // Resume the session. Same effect as clicking it in the sidebar.
    handler: () => sessions.select(s.sessionId)
  }))
})

/**
 * Every table action the palette may list (T486 §9.1): `palette !== false`, a
 * `'global'` registration exists, and its `enabled()` context holds now — so a
 * disabled action is not shown. `keysGuard` is not consulted: the palette's
 * input has focus, which must not hide an action guarded against text fields.
 * Activation runs the registered handler (`invokeShortcut`), the same one the
 * chord and the native menu run — never a palette-local copy.
 */
const actions = computed<Item[]>(() =>
  KEYBINDINGS.filter((d) => d.palette !== false && isShortcutEnabled(d.id)).map<Item>((d) => ({
    id: `action:${d.id}`,
    label: t(d.labelKey),
    accelerator: keybindings.chordLabel(d.id) || undefined,
    section: 'actions',
    iconKey: d.group,
    handler: () => {
      invokeShortcut(d.id)
    }
  }))
)

/** The empty-query view lists only the featured actions, not the whole table. */
const featuredIds = new Set(
  KEYBINDINGS.filter((d) => d.paletteFeatured).map((d) => `action:${d.id}`)
)

/** All folders, mapped to palette items. */
const folders = computed<Item[]>(() => {
  return sessions.folders.map<Item>((f: Folder) => ({
    id: `folder:${f.path}`,
    label: f.alias,
    section: 'folders',
    iconKey: 'folder',
    handler: () => {
      // Expand the folder (no-op if already expanded), then select its first
      // session so the user lands somewhere useful.
      if (!f.expanded) sessions.toggleFolder(f.path)
      const first = firstSessionInFolder(f)
      if (first) sessions.select(first.sessionId)
    }
  }))
})

/** All sessions (every folder), mapped to palette items. */
const allSessionItems = computed<Item[]>(() => {
  return sessions.allSessions.map<Item>((s: Session) => ({
    id: `session:${s.sessionId}`,
    label: sessionLabel(s),
    section: 'sessions',
    iconKey: 'terminal',
    handler: () => sessions.select(s.sessionId)
  }))
})

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Actions, folders and sessions each filter through the SHARED matcher in
 * `composables/useJumpSearch.ts` (T288) — the same fuse.js threshold and search
 * call the sidebar's jump palette uses, so the two palettes can never drift
 * into ranking the same query differently. Key list stays `label` here; the
 * jump palette widens it (path, branch, first prompt) for its own records.
 *
 * `useFuzzyMatcher` (not the one-shot `fuzzySearch`) so the fuse.js index is
 * rebuilt only when the underlying list changes — this palette searches every
 * session in the install, and re-indexing that on each keystroke is the cost
 * the memo exists to avoid.
 */
const matchActions = useFuzzyMatcher(() => actions.value)
const matchFolders = useFuzzyMatcher(() => folders.value)
const matchSessions = useFuzzyMatcher(() => allSessionItems.value)

const filteredActions = computed(() =>
  query.value.trim().length === 0
    ? actions.value.filter((a) => featuredIds.has(a.id))
    : matchActions(query.value)
)
const filteredFolders = computed(() => matchFolders(query.value))
const filteredSessions = computed(() => matchSessions(query.value))

/**
 * Sections rendered in the palette, in display order. Recents is only shown
 * when the input is empty (search supersedes the recents shortcut).
 */
const sectionsToRender = computed<Array<{ section: Section; items: Item[] }>>(() => {
  const out: Array<{ section: Section; items: Item[] }> = []
  if (query.value.length === 0 && recents.value.length > 0) {
    out.push({ section: 'recents', items: recents.value })
  }
  if (filteredActions.value.length > 0) {
    out.push({ section: 'actions', items: filteredActions.value })
  }
  if (filteredFolders.value.length > 0) {
    out.push({ section: 'folders', items: filteredFolders.value })
  }
  if (filteredSessions.value.length > 0) {
    out.push({ section: 'sessions', items: filteredSessions.value })
  }
  return out
})

/**
 * The flat list of items for keyboard navigation. The cursor index points
 * into this list, so arrow keys jump across section borders naturally.
 */
const flatItems = computed<Item[]>(() => {
  const out: Item[] = []
  for (const group of sectionsToRender.value) {
    for (const item of group.items) out.push(item)
  }
  return out
})

const isEmpty = computed(() => flatItems.value.length === 0)

function sectionLabel(s: Section): string {
  return t(`palette.sections.${s}`)
}

// ---------------------------------------------------------------------------
// Activation + keyboard
// ---------------------------------------------------------------------------

/**
 * Run the row, then close (§9.1 keeps that order). A mouse click that opens an
 * anchored popover (Activity, pasted images, …) leaves it open: the popovers'
 * click-outside (`onClickOutside`) listens in the window CAPTURE phase, so it
 * handles this click before the row's handler opens the popover.
 */
function activate(item: Item): void {
  item.handler()
  close()
}

function close(): void {
  ui.closePalette()
}

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    close()
    return
  }
  // stopPropagation (not just preventDefault) so the key never bubbles to the
  // window-level useMagicKeys listener, which would ALSO drive the background
  // sidebar cursor (T22 — matches the terminal-keymap precedent). Redundant with
  // scope gating, but defends any future 'modal'-scope binding.
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    const n = flatItems.value.length
    if (n === 0) return
    cursor.value = (cursor.value + 1) % n
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    const n = flatItems.value.length
    if (n === 0) return
    cursor.value = (cursor.value - 1 + n) % n
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    const item = flatItems.value[cursor.value]
    if (item) activate(item)
  }
}

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

// ---------------------------------------------------------------------------
// Lifecycle — reset, listener attach/detach
// ---------------------------------------------------------------------------
// (Focus restoration on close + initial focus on open are handled by
// `useFocusTrap` above. This watcher only owns the per-open reset of
// `query` / `cursor` and the global `keydown` listener that catches
// arrow-keys and Enter.)

watch(isOpen, async (open) => {
  if (open) {
    query.value = ''
    cursor.value = 0
    window.addEventListener('keydown', onKeydown, true)
    await nextTick()
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

// Reset the cursor whenever the filtered set changes so the highlight never
// points past the new end of the list.
watch(flatItems, () => {
  if (cursor.value >= flatItems.value.length) cursor.value = 0
})

watch(query, () => {
  cursor.value = 0
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <div
    v-if="isOpen"
    class="anim-overlay-fade fixed inset-0 flex justify-center"
    style="background: rgba(0, 0, 0, 0.55); z-index: 70"
    role="presentation"
    @mousedown="onBackdropMousedown"
  >
    <div
      class="anim-fade-in-scale flex flex-col overflow-hidden border border-border-2 bg-surface text-text"
      style="
        width: min(560px, 90vw);
        max-height: 76vh;
        margin-top: 12vh;
        height: max-content;
        border-radius: 7px;
        box-shadow: var(--shadow-pop);
      "
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      @mousedown.stop
    >
      <!-- Input row -->
      <div
        class="flex shrink-0 items-center border-b border-border"
        style="padding: 12px 16px; gap: 10px"
      >
        <Search :size="13" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          class="flex-1 bg-transparent font-sans text-text outline-none"
          style="font-size: 14px"
          autocomplete="off"
          spellcheck="false"
          :placeholder="$t('palette.placeholder')"
        />
      </div>

      <!-- Results list -->
      <div class="scrollable flex-1 overflow-y-auto" style="max-height: 60vh; padding: 4px 0">
        <template v-for="group in sectionsToRender" :key="group.section">
          <!-- Eyebrow -->
          <div
            class="text-text-4"
            style="
              padding: 6px 16px 4px;
              font-size: 10.5px;
              font-weight: 500;
              text-transform: uppercase;
              letter-spacing: 0.06em;
            "
          >
            {{ sectionLabel(group.section) }}
          </div>

          <button
            v-for="item in group.items"
            :key="item.id"
            type="button"
            class="flex w-full items-center text-left transition focus:outline-none"
            :class="
              flatItems.indexOf(item) === cursor
                ? 'bg-accent-soft border-l-2 border-accent text-text'
                : 'text-text-2 hover:bg-surface-2 hover:text-text'
            "
            :style="{
              gap: '12px',
              padding: flatItems.indexOf(item) === cursor ? '8px 16px 8px 14px' : '8px 16px',
              borderLeft: flatItems.indexOf(item) === cursor ? undefined : '2px solid transparent'
            }"
            :data-palette-item="item.id"
            @mouseenter="cursor = flatItems.indexOf(item)"
            @click="activate(item)"
          >
            <component :is="ICONS[item.iconKey]" :size="13" :stroke-width="1.6" class="shrink-0" />
            <span class="flex-1 truncate" style="font-size: 12.5px">{{ item.label }}</span>
            <span
              v-if="item.accelerator"
              data-palette-accelerator
              class="font-mono text-text-4 tabular-nums"
              style="font-size: 10.5px"
              >{{ item.accelerator }}</span
            >
          </button>
        </template>

        <div
          v-if="isEmpty"
          class="text-text-4"
          style="padding: 20px 16px; font-size: 12.5px; text-align: center"
        >
          {{ $t('palette.empty') }}
        </div>
      </div>
    </div>
  </div>
</template>
