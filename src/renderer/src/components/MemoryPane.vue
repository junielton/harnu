<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowUpRight,
  GitBranch,
  Maximize2,
  Minimize2,
  NotebookText,
  RotateCcw,
  X
} from 'lucide-vue-next'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useMemoryStore } from '../stores/memory'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import MarkdownRenderer from './MarkdownRenderer.vue'
import type { HelperPane, MemoryPaneData, DigestMeta } from '../../../preload'

/**
 * Folder-backed project-memory viewer pane (T79 S3, design.md §6 — Memory pane).
 * The non-PTY twin of `MarkdownPane`: owns the pane chrome (header +
 * reload/close/resize) and a tab strip (**hot · decisions · timeline**), reads
 * the repo's memory through the confined `memory:read` IPC (via `useMemoryStore`,
 * shared with the folder-hover cue), and renders each page via the reusable
 * `MarkdownRenderer`. The timeline is the default view of the `sessions/` digests
 * (§4.2): a digest carrying a session id becomes a link that reveals the session
 * in the sidebar, degrading gracefully when no matching session is loaded.
 */
interface Props {
  /** The shared pane union (HelperStack routes only `type:'memory'` here). */
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

const { t } = useI18n()
const helpers = useHelpersStore()
const memory = useMemoryStore()
const sessions = useSessionsStore()
const ui = useUiStore()

/** The repo folder this pane shows memory for (HelperStack guarantees `memory`). */
const paneFolder = computed<string>(() => (props.pane as HelperPane).folder ?? '')

/** Cross-platform basename — the renderer has no node `path`. */
function basename(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || p
  )
}
const folderName = computed<string>(() => basename(paneFolder.value))

type Tab = 'hot' | 'decisions' | 'timeline'
const tab = ref<Tab>('hot')
const TABS: Tab[] = ['hot', 'decisions', 'timeline']

type ViewState =
  { status: 'loading' } | { status: 'ready'; data: MemoryPaneData } | { status: 'error' }
const state = ref<ViewState>({ status: 'loading' })

/** Load (or refresh) the repo memory. Keeps current content visible on reload. */
async function load(force = false): Promise<void> {
  const folder = paneFolder.value
  if (!folder) {
    state.value = { status: 'error' }
    return
  }
  if (state.value.status !== 'ready') state.value = { status: 'loading' }
  const data = await memory.load(folder, { force })
  state.value = data ? { status: 'ready', data } : { status: 'error' }
}

onMounted(() => void load())

// The store may swap the pane's folder (a dedup hit re-targeting the same id).
watch(
  () => paneFolder.value,
  (next, prev) => {
    if (next && next !== prev) void load()
  }
)

const data = computed<MemoryPaneData | null>(() =>
  state.value.status === 'ready' ? state.value.data : null
)

/** Content for the active tab (hot/decisions), or `null` when that page is absent. */
const activePageContent = computed<string | null>(() => {
  const d = data.value
  if (!d) return null
  if (tab.value === 'hot') return d.hot
  if (tab.value === 'decisions') return d.decisions
  return null
})

const timeline = computed<DigestMeta[]>(() => data.value?.timeline ?? [])

/**
 * Resolve each digest to a loaded session (§4.2) — prefer the full provenance
 * session id, else the 8-char filename prefix. Computed once per timeline/session
 * change so timeline rows can render their "open session" affordance cheaply.
 */
const resolvedSessions = computed<Map<string, string>>(() => {
  const map = new Map<string, string>()
  for (const d of timeline.value) {
    const hit = sessions.allSessions.find(
      (s) =>
        (d.sessionId && s.sessionId === d.sessionId) ||
        (d.sessionShort.length > 0 && s.sessionId.startsWith(d.sessionShort))
    )
    if (hit) map.set(d.page, hit.sessionId)
  }
  return map
})

/** A digest is "linkable" when it names a session (id or short prefix) at all. */
function hasSessionRef(d: DigestMeta): boolean {
  return !!d.sessionId || d.sessionShort.length > 0
}

/**
 * Click a timeline digest → reveal + select its originating session in the
 * sidebar. Degrades gracefully: a digest whose session isn't loaded (deleted,
 * or from another machine) steers with a toast instead of navigating nowhere.
 */
function onOpenDigest(d: DigestMeta): void {
  if (!hasSessionRef(d)) return
  const sessionId = resolvedSessions.value.get(d.page)
  if (!sessionId) {
    ui.pushToast({ kind: 'warning', title: t('memoryPane.sessionNotFound') })
    return
  }
  const session = sessions.allSessions.find((s) => s.sessionId === sessionId)
  if (session) sessions.revealFolder(session.projectPath)
  sessions.select(sessionId)
}

function reload(): void {
  void load(true)
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
  <!-- Mirrors MarkdownPane's shell: a 24px header, a tab strip, then a padded
       scroll body. Non-PTY, so no xterm padding-top hack. -->
  <div
    class="flex h-full w-full flex-col overflow-hidden bg-bg"
    :aria-label="$t('memoryPane.label')"
  >
    <header
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      @mousedown="onHeaderMouseDown"
    >
      <NotebookText :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate" :title="paneFolder">{{ folderName }}</span>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('memoryPane.reload')"
        :aria-label="$t('memoryPane.reload')"
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

    <!-- Tab strip: hot · decisions · timeline (design.md §6 — Memory pane) -->
    <div class="flex shrink-0 items-center gap-1 border-b border-border bg-bg px-2" role="tablist">
      <button
        v-for="tb in TABS"
        :key="tb"
        role="tab"
        :aria-selected="tab === tb"
        class="relative transition-colors"
        :class="tab === tb ? 'text-text' : 'text-text-3 hover:text-text-2'"
        style="padding: 6px 6px; font-size: 11.5px"
        @click="tab = tb"
      >
        {{ $t(`memoryPane.tab.${tb}`) }}
        <span
          v-if="tab === tb"
          class="absolute inset-x-1 bottom-0 bg-accent"
          style="height: 1.5px"
        />
      </button>
    </div>

    <div class="scrollable min-h-0 flex-1 overflow-y-auto" style="padding: 14px 16px">
      <!-- Loading / error / empty-memory states -->
      <div v-if="state.status === 'loading'" class="text-text-3" style="font-size: 12px">
        {{ $t('memoryPane.loading') }}
      </div>
      <div
        v-else-if="state.status === 'error'"
        class="flex h-full items-center justify-center text-center text-text-3"
        style="font-size: 12px; padding: 24px"
      >
        {{ $t('memoryPane.error') }}
      </div>
      <div
        v-else-if="data && !data.exists"
        class="flex h-full flex-col items-center justify-center text-center"
        style="padding: 24px; gap: 6px"
      >
        <div class="text-text-2" style="font-size: 12.5px; font-weight: 600">
          {{ $t('memoryPane.empty.title') }}
        </div>
        <div class="text-text-3" style="font-size: 11.5px; max-width: 280px; line-height: 1.5">
          {{ $t('memoryPane.empty.body') }}
        </div>
      </div>

      <!-- hot / decisions: rendered markdown, or a per-tab empty note -->
      <template v-else-if="tab === 'hot' || tab === 'decisions'">
        <MarkdownRenderer v-if="activePageContent" :source="activePageContent" />
        <div v-else class="text-text-3" style="font-size: 12px">
          {{ tab === 'hot' ? $t('memoryPane.hotEmpty') : $t('memoryPane.decisionsEmpty') }}
        </div>
      </template>

      <!-- timeline: the digests, newest first (§4.2) -->
      <template v-else>
        <div v-if="timeline.length === 0" class="text-text-3" style="font-size: 12px">
          {{ $t('memoryPane.timelineEmpty') }}
        </div>
        <ul v-else style="display: flex; flex-direction: column; gap: 2px">
          <li v-for="d in timeline" :key="d.page">
            <component
              :is="hasSessionRef(d) ? 'button' : 'div'"
              class="w-full text-left transition-colors"
              :class="
                hasSessionRef(d) ? 'cursor-pointer text-text-2 hover:bg-surface-2' : 'text-text-2'
              "
              style="border-radius: 5px; padding: 7px 8px; display: block"
              :title="hasSessionRef(d) ? $t('memoryPane.openSession') : undefined"
              @click="onOpenDigest(d)"
            >
              <div class="flex items-baseline" style="gap: 8px">
                <span
                  class="tabular-nums shrink-0 text-text-4 font-mono"
                  style="font-size: 10.5px"
                  >{{ d.date || '—' }}</span
                >
                <span class="min-w-0 flex-1 truncate" style="font-size: 12px">{{ d.title }}</span>
                <ArrowUpRight
                  v-if="hasSessionRef(d)"
                  :size="12"
                  :stroke-width="1.6"
                  class="shrink-0 text-text-4"
                />
              </div>
              <!-- Provenance (author / branch) — visible per §7 (injection mitigation) -->
              <div
                v-if="d.author || d.branch"
                class="flex items-center text-text-4"
                style="gap: 8px; margin-top: 3px; font-size: 10.5px"
              >
                <span v-if="d.author" class="shrink-0">{{ d.author }}</span>
                <span v-if="d.branch" class="flex min-w-0 items-center" style="gap: 3px">
                  <GitBranch :size="10" :stroke-width="1.6" class="shrink-0" />
                  <span class="truncate font-mono">{{ d.branch }}</span>
                </span>
              </div>
            </component>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
