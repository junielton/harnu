<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeftRight, Expand, Maximize2, Minimize2, Target, X } from 'lucide-vue-next'
import { useFocusRegion } from '../composables/useTerminalFocus'
import { useSessionLinks } from '../composables/useSessionLinks'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useKeybindingsStore } from '../stores/keybindings'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import {
  buildPaneTree,
  classifyReply,
  doorErrorKey,
  handoffErrorKey,
  handoffOfferView,
  missionNumbers,
  missionProgressLine,
  missionStateKey,
  progressPercent,
  sessionNameOf,
  v4MissionOf,
  type PaneKind
} from '../lib/mission-pane-view'
import Button from './ui/Button.vue'
import MissionHandoffDialog from './MissionHandoffDialog.vue'
import MissionPaneNext from './MissionPaneNext.vue'
import MissionPaneSessions from './MissionPaneSessions.vue'
import MissionPaneTree from './MissionPaneTree.vue'

/**
 * The Mission pane (Missions v4 S-17, design.md §6 "Mission pane"): the one surface of a v4 mission, a
 * non-PTY pane in the helper stack that the Topbar pill opens and closes. It FOLLOWS the selected session
 * and shows only that session's mission.
 *
 * It reads, and it holds the operator's doors. The missions store asks the view channel for the selected
 * session (when it changes and on its 20 s poll: there is no push event) and the pill reads the same
 * answer; this component never calls the view itself. A door (mark a criterion, clear a blocker, approve or
 * decline a staged Done when) goes through the store, which reads the view again after every reply. What it draws is what the server said: the numbers are the
 * server's, the state is an identifier translated through i18n, a v3 record is not drawn at all (the v3
 * popover still serves it). The Sessions row and the hand-off (S-20) live in `MissionPaneSessions` and
 * `MissionHandoffDialog`: this component hosts them, holds the operator's "Not now" and calls the store's
 * hand-off only from the dialog's confirm.
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
// An open step lists the links its session wrote: the ones Harnu already collects for it (the footer's
// Links shelf reads the same transcript). The clock is for how long a blocker has waited.
const linkSession = computed(() => {
  const id = sessionId.value
  return id && !id.startsWith('synthetic-') ? id : null
})
const { entries: sessionLinks } = useSessionLinks(linkSession)
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(clock))
const tree = computed(() =>
  mission.value
    ? buildPaneTree(mission.value.detail, { sessionLinks: sessionLinks.value, now: now.value })
    : null
)
const hasTree = computed(
  () =>
    tree.value !== null &&
    (tree.value.milestones.length > 0 ||
      tree.value.optional.length > 0 ||
      (tree.value.loose?.shown.length ?? 0) + (tree.value.loose?.folded.length ?? 0) > 0)
)
const treeRef = ref<InstanceType<typeof MissionPaneTree> | null>(null)

// A Done when a session staged waits for the operator: approve it or decline it (the doors never refuse).
const doneWhenBusy = ref(false)
const doneWhenError = ref<string | null>(null)
async function decideDoneWhen(door: 'approveDoneWhen' | 'declineDoneWhen'): Promise<void> {
  if (doneWhenBusy.value) return
  doneWhenBusy.value = true
  doneWhenError.value = null
  try {
    const res = await missions.runV4Door({ door })
    if (!res.ok) doneWhenError.value = t(`missionPane.step.error.${doorErrorKey(res.code)}`)
  } finally {
    doneWhenBusy.value = false
  }
}

// ---- Sessions and the hand-off (S-20) -----------------------------------------------------------------
// The operator always decides a hand-off. The view may OFFER one (the leader's context at 80 percent or
// more); nothing here starts a session until the operator confirms in the dialog.
const offer = computed(() => {
  const o = mission.value ? handoffOfferView(mission.value, sessionId.value) : null
  if (!o || !mission.value) return null
  // "Not now" is kept per leader: at a reading no higher than the one it was said at, stay quiet.
  const at = missions.handoffDismissedAt(mission.value.missionId, o.leaderId)
  return at !== null && o.percent <= at ? null : o
})
const offerName = computed(() =>
  offer.value?.leaderId ? sessionNameOf(offer.value.leaderId, sessions.allSessions, t) : ''
)
const handoffOpen = ref(false)
const handoffDone = ref(false)
const handoffError = ref<string | null>(null)
const newLeader = ref<string | null>(null)
// The summary the confirmation shows is the last one the view gave. When the view stops holding the mission
// (it closed under the dialog, the session was released), the dialog still shows what it was asked about.
const lastSummary = ref('')
watch(
  () => mission.value?.detail.summary,
  (summary) => {
    if (summary !== undefined) lastSummary.value = summary
  },
  { immediate: true }
)
const handoffSummary = computed(() => mission.value?.detail.summary ?? lastSummary.value)
const newLeaderLoaded = computed(
  () =>
    newLeader.value !== null && sessions.allSessions.some((s) => s.sessionId === newLeader.value)
)

function openHandoff(): void {
  handoffDone.value = false
  handoffError.value = null
  handoffOpen.value = true
}
function closeHandoff(): void {
  // A hand-off that is waiting for the door cannot be dismissed from here: the dialog is not dismissible.
  if (missions.handOffPending) return
  handoffOpen.value = false
}
async function confirmHandoff(): Promise<void> {
  if (missions.handOffPending) return
  handoffError.value = null
  const res = await missions.runHandOff()
  if (res.ok) {
    handoffDone.value = true
    newLeader.value = res.sessionId
  } else {
    handoffError.value = handoffErrorKey(res.code)
  }
}
function openNewLeader(): void {
  if (newLeader.value && newLeaderLoaded.value) sessions.select(newLeader.value)
  handoffOpen.value = false
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
          <!-- A Done when a session staged: only the operator makes it the mission's end. -->
          <section
            v-if="mission.pendingDoneWhen"
            class="flex flex-col rounded border border-accent-line bg-accent-soft"
            style="margin-top: 10px; padding: 10px 12px; gap: 8px"
            data-test="done-when-staged"
          >
            <span
              class="uppercase text-accent"
              style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
              >{{ $t('missionPane.doneWhen.eyebrow') }}</span
            >
            <span
              class="break-words text-text"
              style="font-size: 13px; line-height: 1.4"
              data-test="done-when-text"
              >{{ mission.pendingDoneWhen.text }}</span
            >
            <span class="text-text-3" style="font-size: 11.5px; line-height: 1.4">{{
              $t('missionPane.doneWhen.body')
            }}</span>
            <div class="flex flex-wrap items-center" style="gap: 10px">
              <Button
                variant="primary"
                :disabled="doneWhenBusy"
                data-test="done-when-approve"
                @click="decideDoneWhen('approveDoneWhen')"
              >
                {{ $t('missionPane.doneWhen.approve') }}
              </Button>
              <Button
                :disabled="doneWhenBusy"
                data-test="done-when-decline"
                @click="decideDoneWhen('declineDoneWhen')"
              >
                {{ $t('missionPane.doneWhen.decline') }}
              </Button>
            </div>
            <span
              v-if="doneWhenError"
              class="break-words text-text"
              style="font-size: 11.5px; line-height: 1.4"
              role="alert"
              data-test="done-when-error"
              >{{ doneWhenError }}</span
            >
          </section>
        </section>
        <section v-if="hasTree && tree" style="padding: 14px 16px" data-dsqa-part="tree">
          <!-- Keyed by the mission the reply was answered for: another mission starts with its own folds. -->
          <MissionPaneTree ref="treeRef" :key="mission.missionId" :tree="tree" />
        </section>
        <!-- Who worked on the mission, and the way to continue it in a new session. -->
        <MissionPaneSessions
          :mission="mission"
          :selected-id="sessionId"
          :pending="missions.handOffPending"
          @continue="openHandoff"
        />
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

    <!-- The offer: the leader's context is high. Pinned under the scroll body so it is never below the fold. -->
    <section
      v-if="kind === 'mission' && offer"
      class="flex shrink-0 flex-col rounded border border-warning-line bg-warning-soft text-text"
      style="margin: 0 12px 10px; padding: 10px 12px; gap: 8px; font-size: 12px; line-height: 1.45"
      data-dsqa-part="handoff-notice"
      data-test="handoff-offer"
    >
      <span>{{
        offer.leaderIsCurrent
          ? $t('missionPane.handoff.offer.thisSession', { percent: offer.percent })
          : $t('missionPane.handoff.offer.otherSession', {
              percent: offer.percent,
              name: offerName || $t('missionPane.handoff.offer.leaderUnnamed')
            })
      }}</span>
      <span class="flex flex-wrap" style="gap: 6px">
        <button
          type="button"
          class="inline-flex items-center whitespace-nowrap rounded-sm bg-accent text-accent-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          style="height: 20px; padding: 0 7px; gap: 4px; font-size: 11px; font-weight: 500"
          :disabled="missions.handOffPending"
          data-test="handoff-offer-open"
          @click="openHandoff"
        >
          <ArrowLeftRight :size="10" :stroke-width="1.8" />{{
            $t('missionPane.handoff.offer.open')
          }}
        </button>
        <button
          type="button"
          class="inline-flex items-center whitespace-nowrap rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
          style="height: 20px; padding: 0 7px; font-size: 11px; font-weight: 500"
          data-test="handoff-offer-later"
          @click="missions.dismissHandoff()"
        >
          {{ $t('missionPane.handoff.offer.later') }}
        </button>
      </span>
    </section>

    <!-- At the pane's root, not in the mission branch: after a hand-off this session is released, the pane
         shows no mission, and the dialog is still the one that says what happened. -->
    <MissionHandoffDialog
      :open="handoffOpen"
      :summary="handoffSummary"
      :pending="missions.handOffPending"
      :error-key="handoffError"
      :done="handoffDone"
      :can-open-new="newLeaderLoaded"
      @cancel="closeHandoff"
      @close="closeHandoff"
      @confirm="confirmHandoff"
      @open-new="openNewLeader"
    />
  </div>
</template>
