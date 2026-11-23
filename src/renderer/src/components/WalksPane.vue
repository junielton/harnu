<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bookmark,
  Expand,
  GitBranch,
  GitPullRequest,
  Library,
  Lightbulb,
  Maximize2,
  MoreHorizontal,
  Minimize2,
  RefreshCw,
  Target,
  Trash2,
  X
} from 'lucide-vue-next'
import type { LibraryEntry } from '../../../preload'
import { useFocusRegion } from '../composables/useTerminalFocus'
import {
  deleteConfirm,
  libraryView,
  type LibraryIcon,
  type LibraryRowView
} from '../lib/walk-library'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useKeybindingsStore } from '../stores/keybindings'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useWalkStore } from '../stores/walk'
import { textScaleKey } from '../lib/walk-keys'
import WalkCode from './WalkCode.vue'
import WalkTextSize from './WalkTextSize.vue'

/**
 * The Walks library (design.md §6 "Walks library", spec S-4, AC-20): the repo's saved walks as a list, not a
 * dashboard. A source icon, the title, the source, the last run's date and the outcome, then Re-run and Open; Delete
 * lives in the row's menu and asks once, inline, naming a run in progress (D-18). Newest run first, no search and no
 * filter. It owns nothing: the walks live in main (`.harnu/walks/`), this pane lists them (`walk:list`) and hands
 * Open and Re-run to the walk pane, which it then gives its place to (the mockup's one cell).
 */
interface Props {
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

const { t, locale } = useI18n()
const helpers = useHelpersStore()
const keybindings = useKeybindingsStore()
const ui = useUiStore()
const settings = useSettingsStore()
const walk = useWalkStore()

const folder = computed(() => props.worktreePath || (props.pane as { cwd: string }).cwd)

// ---- the list ---------------------------------------------------------------------------------------

const entries = ref<LibraryEntry[]>([])
const loaded = ref(false)
const failed = ref(false)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let gone = false

async function load(): Promise<void> {
  const res = await window.api.walkList({ folder: folder.value })
  if (gone) return
  if (!res.ok) {
    failed.value = true
    loaded.value = true
    return
  }
  failed.value = false
  entries.value = res.walks
  now.value = Date.now()
  loaded.value = true
}
function onFocus(): void {
  void load()
}
onMounted(() => {
  void load()
  window.addEventListener('focus', onFocus)
  // a run moves on while this pane is open (a session reports, the operator walks in the other pane)
  timer = setInterval(() => void load(), 5000)
})
onBeforeUnmount(() => {
  gone = true
  window.removeEventListener('focus', onFocus)
  if (timer) clearInterval(timer)
})

const view = computed(() =>
  libraryView(entries.value, (k, p) => t(k, p ?? {}), { now: now.value, locale: locale.value })
)

// ---- header -----------------------------------------------------------------------------------------

function onHeaderMouseDown(ev: MouseEvent): void {
  if (props.resizable) emit('headerMouseDown', ev)
}
const isMaximized = computed(() => helpers.maximizedPaneId(props.worktreePath) === props.pane.id)
const isExpanded = computed(() => helpers.expandedPaneId(props.worktreePath) === props.pane.id)
const rootEl = ref<HTMLDivElement | null>(null)
function close(): void {
  helpers.removeHelper(props.worktreePath, props.pane.id)
}
useFocusRegion(props.pane.id, rootEl, {
  focus: () => rootEl.value?.focus(),
  close
})

// ---- rows -------------------------------------------------------------------------------------------

const icons: Record<LibraryIcon, unknown> = {
  target: Target,
  'git-pull-request': GitPullRequest,
  lightbulb: Lightbulb,
  'git-branch': GitBranch,
  bookmark: Bookmark
}

/** Hand the cell to a walk pane: the library gives its place to what the operator chose (the mockup's one cell). */
function openRun(walkId: string, runId: string, past: boolean): void {
  helpers.addWalkHelper(folder.value, walkId, runId, { past })
  close()
}

async function onRerun(row: LibraryRowView): Promise<void> {
  const res = await walk.rerun(folder.value, row.walkId)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: t('walksLibrary.rerunFailed') })
    return
  }
  openRun(res.walkId, res.runId, false)
}

async function onOpen(row: LibraryRowView): Promise<void> {
  // a walk never started has no run to show: opening it starts its first run from the roadmap
  if (row.openAs === 'start' || !row.openRunId) return onRerun(row)
  openRun(row.walkId, row.openRunId, row.openAs === 'past')
}

// ---- Delete: a row menu, then one question asked inline ---------------------------------------------

const menuFor = ref<string | null>(null)
const confirmFor = ref<string | null>(null)
const deleting = ref(false)

function toggleMenu(row: LibraryRowView): void {
  confirmFor.value = null
  menuFor.value = menuFor.value === row.walkId ? null : row.walkId
}
function askDelete(row: LibraryRowView): void {
  menuFor.value = null
  confirmFor.value = row.walkId
}
async function confirmDelete(row: LibraryRowView): Promise<void> {
  deleting.value = true
  try {
    const res = await window.api.walkDelete({ folder: folder.value, walkId: row.walkId })
    if (!res.ok) {
      ui.pushToast({ kind: 'danger', title: t('walksLibrary.delete.failed') })
      return
    }
    // a pane that shows the deleted walk would only show an empty state: it goes too
    const paneId = helpers.walkHelperId(folder.value, row.walkId)
    if (paneId) helpers.removeHelper(folder.value, paneId)
    confirmFor.value = null
    await load()
  } finally {
    deleting.value = false
  }
}
function onKeydown(ev: KeyboardEvent): void {
  // Ctrl/Cmd + = / - / 0: the same text size as the walk pane (T807)
  const size = textScaleKey(ev)
  if (size) {
    ev.preventDefault()
    ev.stopPropagation()
    settings.stepWalkTextScale(size)
    return
  }
  if (ev.key !== 'Escape') return
  if (menuFor.value || confirmFor.value) {
    ev.preventDefault()
    ev.stopPropagation()
    menuFor.value = null
    confirmFor.value = null
  }
}
</script>

<template>
  <div
    ref="rootEl"
    class="wk walks relative flex h-full w-full flex-col overflow-hidden bg-bg group/pane no-default-ring"
    style="container: wk / inline-size"
    :style="{ '--walk-text-scale': settings.walkTextScale }"
    tabindex="0"
    :data-focus-region="pane.id"
    :data-state="view.mode"
    data-dsqa="library"
    :aria-label="$t('walksLibrary.label')"
    @keydown="onKeydown"
  >
    <header
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors group-focus-within/pane:text-text"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      data-dsqa-part="pane-header"
      @mousedown="onHeaderMouseDown"
    >
      <Library :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate">
        <b class="font-medium text-text">{{ $t('walksLibrary.title') }}</b>
      </span>
      <WalkTextSize />
      <button
        class="flex shrink-0 items-center justify-center rounded transition hover:bg-surface-2 hover:text-text"
        :class="isExpanded ? 'text-accent' : 'text-text-3'"
        style="width: 18px; height: 18px"
        :title="
          keybindings.withChord(
            isExpanded ? $t('helperPane.exitExpand') : $t('helperPane.expand'),
            'pane.expandToWindow'
          )
        "
        :aria-label="isExpanded ? $t('helperPane.exitExpand') : $t('helperPane.expand')"
        :aria-pressed="isExpanded"
        data-test="pane-expand"
        @mousedown.stop
        @click="helpers.toggleExpandPane(worktreePath, pane.id)"
      >
        <Expand :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="
          keybindings.withChord(
            isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize'),
            'pane.toggleMaximize'
          )
        "
        :aria-label="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        @mousedown.stop
        @click="helpers.toggleMaximizePane(worktreePath, pane.id)"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="keybindings.withChord($t('helperPane.close'), 'pane.close')"
        :aria-label="$t('helperPane.close')"
        data-test="walks-close"
        @mousedown.stop
        @click="close"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>

    <div class="wk-body select-text" tabindex="-1" data-test="walks-body">
      <!-- no walks: the empty state and nothing else -->
      <div
        v-if="loaded && view.mode === 'empty' && view.empty"
        class="center"
        data-dsqa-part="library-empty"
        data-test="walks-empty"
      >
        <Library class="i i14" :size="14" />
        <b>{{ view.empty.title }}</b>
        <p>{{ view.empty.body }}</p>
        <div class="cmd">
          <WalkCode :text="view.empty.command" :what="$t('walksLibrary.empty.copy')" />
        </div>
        <p class="hint">{{ view.empty.hint }}</p>
      </div>

      <template v-else-if="view.mode === 'list'">
        <div class="wk-head">
          <h2 class="wk-title">{{ view.title }}</h2>
          <div class="sub" data-test="walks-sub">{{ view.sub }}</div>
        </div>
        <ol class="lib" data-dsqa-part="library-list" data-test="walks-list">
          <li
            v-for="r in view.rows"
            :key="r.walkId"
            class="lib-row"
            data-dsqa-part="walk-row"
            :data-walk-id="r.walkId"
          >
            <span class="lic"
              ><component :is="icons[r.icon]" class="i i12" :size="12" aria-hidden="true"
            /></span>
            <div class="lib-main">
              <div class="lib-t">{{ r.title }}</div>
              <div class="lib-m">
                <span>{{ r.source }}</span>
                <template v-if="r.date"
                  ><span class="dot">·</span><span>{{ r.date }}</span></template
                >
                <span class="dot">·</span>
                <template v-if="r.outcome.kind === 'walked'">
                  <span
                    class="gl"
                    :class="r.outcome.warn ? 'gl-warn' : 'gl-ok'"
                    aria-hidden="true"
                    >{{ r.outcome.warn ? '!' : '✓' }}</span
                  >
                </template>
                <span :class="{ warnt: r.outcome.warn }" data-test="walk-outcome">{{
                  r.outcome.text
                }}</span>
              </div>
            </div>
            <div class="lib-a">
              <button type="button" class="btn" data-test="walk-row-rerun" @click="onRerun(r)">
                <RefreshCw class="i i10" :size="10" />{{ $t('walksLibrary.rerun') }}
              </button>
              <button type="button" class="btn ghost" data-test="walk-row-open" @click="onOpen(r)">
                {{ $t('walksLibrary.open') }}
              </button>
              <span class="lib-more">
                <button
                  type="button"
                  class="ib"
                  aria-haspopup="menu"
                  :aria-expanded="menuFor === r.walkId"
                  :aria-label="$t('walksLibrary.menu.more')"
                  :title="$t('walksLibrary.menu.more')"
                  data-test="walk-row-menu"
                  @click="toggleMenu(r)"
                >
                  <MoreHorizontal class="i i12" :size="12" />
                </button>
                <ul v-if="menuFor === r.walkId" class="lib-menu" role="menu">
                  <li role="none">
                    <button
                      type="button"
                      role="menuitem"
                      data-test="walk-row-delete"
                      @click="askDelete(r)"
                    >
                      <Trash2 class="i i10" :size="10" />{{ $t('walksLibrary.menu.delete') }}
                    </button>
                  </li>
                </ul>
              </span>
            </div>
            <div
              v-if="confirmFor === r.walkId"
              class="lib-confirm"
              role="alertdialog"
              data-test="walk-delete-confirm"
            >
              <span class="ask">{{ deleteConfirm(r, (k, p) => t(k, p ?? {})) }}</span>
              <span class="acts">
                <button
                  type="button"
                  class="btn md danger"
                  :disabled="deleting"
                  data-test="walk-delete-yes"
                  @click="confirmDelete(r)"
                >
                  {{ $t('walksLibrary.delete.confirm') }}
                </button>
                <button type="button" class="btn ghost" @click="confirmFor = null">
                  {{ $t('walksLibrary.delete.cancel') }}
                </button>
              </span>
            </div>
          </li>
        </ol>
      </template>
    </div>
  </div>
</template>

<style>
/* the Walks library: a list, not a dashboard (docs/design/guided-walks/mockup.css, "Walks library"); tokens only */
.wk ol.lib {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.wk .lib-row {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  gap: 2px 10px;
  align-items: center;
  padding: 10px 0;
  border-top: 1px solid var(--color-border);
}
.wk .lib-row:first-child {
  border-top: 0;
}
.wk .lib-row .lic {
  color: var(--color-text-4);
  align-self: start;
  padding-top: 2px;
  display: inline-flex;
}
.wk .lib-t {
  font-size: calc(14px * var(--walk-text-scale, 1));
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.wk .lib-m {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
  margin-top: 2px;
}
.wk .lib-m .dot {
  color: var(--color-text-disabled);
}
.wk .lib-m .warnt {
  color: var(--color-warning);
}
.wk .lib-a {
  display: flex;
  gap: 6px;
  align-items: center;
}
.wk .lib-more {
  position: relative;
  display: inline-flex;
}
.wk .lib-menu {
  position: absolute;
  top: 24px;
  right: 0;
  z-index: 5;
  margin: 0;
  padding: 3px;
  list-style: none;
  min-width: 120px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius);
  background: var(--color-surface-2);
  box-shadow: var(--shadow-pop);
}
.wk .lib-menu button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-red);
  white-space: nowrap;
}
.wk .lib-menu button:hover,
.wk .lib-menu button:focus-visible {
  background: var(--color-red-soft);
}
.wk .lib-confirm {
  grid-column: 2 / -1;
  margin-top: 6px;
  border-left: 2px solid var(--color-red-line);
  padding: 2px 0 2px 10px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
}
.wk .lib-confirm .ask {
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  color: var(--color-text-2);
  flex: 1 1 220px;
  min-width: 0;
}
.wk .lib-confirm .acts {
  display: flex;
  gap: 6px;
}
.wk .btn.danger {
  border-color: var(--color-red-line);
  color: var(--color-red);
}
@container wk (max-width: 479px) {
  .wk .lib-row {
    grid-template-columns: 16px minmax(0, 1fr);
  }
  .wk .lib-a {
    grid-column: 2;
    margin-top: 4px;
  }
}
</style>
