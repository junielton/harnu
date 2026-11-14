<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Expand, Maximize2, Minimize2, Target, X } from 'lucide-vue-next'
import { useFocusRegion } from '../composables/useTerminalFocus'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useKeybindingsStore } from '../stores/keybindings'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import {
  buildPaneTree,
  classifyReply,
  missionNumbers,
  missionProgressLine,
  missionStateKey,
  progressPercent,
  v4MissionOf,
  type PaneKind
} from '../lib/mission-pane-view'
import MissionPaneNext from './MissionPaneNext.vue'
import MissionPaneTree from './MissionPaneTree.vue'

/**
 * The Mission pane (Missions v4 S-17, design.md §6 "Mission pane"): the one surface of a v4 mission, a
 * non-PTY pane in the helper stack that the Topbar pill opens and closes. It FOLLOWS the selected session
 * and shows only that session's mission.
 *
 * It only reads. The missions store asks the view channel for the selected session (when it changes and
 * on its 20 s poll: there is no push event) and the pill reads the same answer; this component never
 * calls the view itself and never calls a door. What it draws is what the server said: the numbers are the
 * server's, the state is an identifier translated through i18n, a v3 record is not drawn at all (the v3
 * popover still serves it). This slice is the shell: the glance, an open step, sessions and the hand-off
 * land in later slices.
 */
interface Props {
  /** The shared pane union (HelperStack routes only `type:'mission'` here). */
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

const { t } = useI18n()
const helpers = useHelpersStore()
const missions = useMissionsStore()
const sessions = useSessionsStore()
const keybindings = useKeybindingsStore()

// The store polls only once someone asks it to start; the pane is a reader like the pill.
onMounted(() => missions.ensureStarted())

const sessionId = computed(() => sessions.selectedSession?.sessionId ?? null)
const reply = computed(() => missions.v4ReplyForSession(sessionId.value))
const kind = computed<PaneKind>(() =>
  sessionId.value ? classifyReply(reply.value, sessionId.value) : 'none'
)
const mission = computed(() => (sessionId.value ? v4MissionOf(reply.value, sessionId.value) : null))
const refusal = computed(() => (reply.value?.state === 'refused' ? reply.value.error : ''))

const progressLine = computed(() =>
  mission.value ? missionProgressLine(t, mission.value.detail) : ''
)
const stateKey = computed(() => (mission.value ? missionStateKey(mission.value.detail) : null))

// The glance: the bar's width and aria values are the server's numbers; the tree is the server's steps
// ordered and folded (no state is computed here).
const numbers = computed(() => (mission.value ? missionNumbers(mission.value.detail) : null))
const percent = computed(() =>
  numbers.value ? progressPercent(numbers.value.done, numbers.value.total) : 0
)
const tree = computed(() => (mission.value ? buildPaneTree(mission.value.detail) : null))
const hasTree = computed(
  () =>
    tree.value !== null &&
    (tree.value.milestones.length > 0 ||
      tree.value.optional.length > 0 ||
      (tree.value.loose?.shown.length ?? 0) + (tree.value.loose?.folded.length ?? 0) > 0)
)
const treeRef = ref<InstanceType<typeof MissionPaneTree> | null>(null)

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

/** T628: whether THIS pane is expanded to the window; its header button toggles that. */
const isExpanded = computed(() => helpers.expandedPaneId(props.worktreePath) === props.pane.id)
function onToggleExpand(): void {
  helpers.toggleExpandPane(props.worktreePath, props.pane.id)
}

// T486 U5b — a region of the pane focus ring: F6 focuses its scroll body, `pane.close` runs the header X.
const rootEl = ref<HTMLDivElement | null>(null)
const bodyEl = ref<HTMLDivElement | null>(null)
useFocusRegion(props.pane.id, rootEl, {
  focus: () => bodyEl.value?.focus(),
  close: onClose
})
</script>

<template>
  <div
    ref="rootEl"
    class="flex h-full w-full flex-col overflow-hidden bg-bg group/pane no-default-ring"
    :data-focus-region="pane.id"
    :data-state="kind"
    :data-dsqa="'mission-pane'"
    :aria-label="$t('missionPane.label')"
  >
    <!-- Mirrors MemoryPane's shell: the 24px header, then a scroll body. Non-PTY, so no xterm padding-top. -->
    <header
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors group-focus-within/pane:text-text"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      @mousedown="onHeaderMouseDown"
    >
      <Target :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate">{{ $t('missionPane.title') }}</span>
      <button
        class="flex shrink-0 items-center justify-center rounded transition hover:bg-surface-2 hover:text-text"
        :class="isExpanded ? 'text-accent' : 'text-text-3'"
        style="width: 18px; height: 18px"
        data-test="pane-expand"
        :title="
          keybindings.withChord(
            isExpanded ? $t('helperPane.exitExpand') : $t('helperPane.expand'),
            'pane.expandToWindow'
          )
        "
        :aria-label="isExpanded ? $t('helperPane.exitExpand') : $t('helperPane.expand')"
        :aria-pressed="isExpanded"
        @mousedown.stop
        @click="onToggleExpand"
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
        @click="onToggleMaximize"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="keybindings.withChord($t('helperPane.close'), 'pane.close')"
        :aria-label="$t('helperPane.close')"
        @mousedown.stop
        @click="onClose"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>

    <div
      ref="bodyEl"
      class="scrollable no-default-ring min-h-0 flex-1 overflow-y-auto outline-none"
      tabindex="-1"
    >
      <div
        v-if="kind === 'loading'"
        class="text-text-3"
        style="padding: 14px 16px; font-size: 12px"
        data-test="mission-loading"
      >
        {{ $t('missionPane.loading') }}
      </div>

      <!-- A v4 mission: the glance. The head (title, bar with the count inside, the next step), then the tree. -->
      <template v-else-if="kind === 'mission' && mission && numbers">
        <section
          class="border-b border-border"
          style="padding: 14px 16px"
          data-dsqa-part="mission-head"
        >
          <h2
            class="m-0 break-words text-text"
            style="font-size: 13.5px; font-weight: 600; line-height: 1.35"
            data-test="mission-title"
          >
            {{ mission.detail.title }}
          </h2>
          <!-- The count is INSIDE the bar (design.md §6 "Mission pane" → The glance). -->
          <div
            class="relative overflow-hidden rounded-sm border border-border bg-surface-2"
            style="margin-top: 10px; height: 24px"
            role="progressbar"
            :aria-label="$t('missionPane.bar.label')"
            aria-valuemin="0"
            :aria-valuemax="numbers.total"
            :aria-valuenow="numbers.done"
            data-test="mission-progress"
          >
            <i
              class="absolute inset-y-0 left-0 bg-green-soft"
              :class="percent < 100 ? 'border-r-2 border-green' : ''"
              :style="{ width: `${percent}%` }"
              data-test="mission-bar-fill"
            />
            <span
              class="relative flex h-full items-center tabular-nums"
              :class="percent >= 100 ? 'text-green' : 'text-text-2'"
              style="padding: 0 9px; font-size: 11.5px"
              data-test="mission-count"
              >{{ progressLine }}</span
            >
          </div>
          <span
            v-if="stateKey"
            class="mt-2 inline-block rounded-sm border border-green-line bg-green-soft text-green"
            style="padding: 1px 7px; font-size: 10.5px; font-weight: 500"
            data-test="mission-state"
            >{{ $t(stateKey) }}</span
          >
          <MissionPaneNext :detail="mission.detail" @open-step="treeRef?.openStep($event)" />
        </section>
        <section v-if="hasTree && tree" style="padding: 14px 16px" data-dsqa-part="tree">
          <!-- Keyed by the mission the reply was answered for: another mission starts with its own folds. -->
          <MissionPaneTree ref="treeRef" :key="mission.missionId" :tree="tree" />
        </section>
      </template>

      <!-- No mission, a refusal, or a v3 record: the same empty layout (design.md §6 "Mission pane" → States). -->
      <div
        v-else
        class="flex flex-col items-center text-center text-text-3"
        style="padding: 40px 24px; gap: 8px; font-size: 12.5px; line-height: 1.5"
        :data-test="`mission-${kind}`"
      >
        <Target :size="14" :stroke-width="1.6" class="text-text-4" />
        <b class="text-text" style="font-weight: 500">{{ $t(`missionPane.${kind}.title`) }}</b>
        <span v-if="kind === 'v3'">{{ $t('missionPane.v3.body') }}</span>
        <span
          v-else-if="kind === 'refused' && refusal"
          class="break-words font-mono text-text-3"
          style="font-size: 11.5px"
          >{{ refusal }}</span
        >
      </div>
    </div>
  </div>
</template>
