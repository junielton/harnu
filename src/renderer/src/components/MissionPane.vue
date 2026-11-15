<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Expand,
  Flag,
  Maximize2,
  Minimize2,
  Target,
  X
} from 'lucide-vue-next'
import { useFocusRegion } from '../composables/useTerminalFocus'
import { useSessionLinks } from '../composables/useSessionLinks'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useKeybindingsStore } from '../stores/keybindings'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import {
  askLeaderOf,
  attachRequestsOf,
  barGeometry,
  buildPaneTree,
  classifyReply,
  closeErrorKey,
  closeMatters,
  doorErrorKey,
  handoffErrorKey,
  handoffOfferView,
  isReadyToClose,
  loadPaneSections,
  missionNumbers,
  missionSummaryText,
  missionProgressLine,
  missionStateKey,
  paneLayout,
  pickerRows,
  progressPercent,
  savePaneSections,
  sessionNameOf,
  treeLine,
  v4MissionOf,
  type PaneDisclosure,
  type PaneKind
} from '../lib/mission-pane-view'
import { SAMPLE_STATES, type SampleState } from '../lib/mission-sample'
import Button from './ui/Button.vue'
import MissionCloseConfirmDialog from './MissionCloseConfirmDialog.vue'
import MissionHandoffDialog from './MissionHandoffDialog.vue'
import MissionPaneAsk from './MissionPaneAsk.vue'
import MissionPaneAttach, { type RequestRow } from './MissionPaneAttach.vue'
import MissionPaneNext from './MissionPaneNext.vue'
import MissionPaneSessions from './MissionPaneSessions.vue'
import MissionPaneTree from './MissionPaneTree.vue'

/**
 * The Mission pane (Missions v4 S-17, design.md §6 "Mission pane"): the one surface of a mission, a
 * non-PTY pane in the helper stack that the Topbar pill opens and closes. It FOLLOWS the selected session
 * and shows only that session's mission.
 *
 * It reads, and it holds the operator's doors. The missions store asks the view channel for the selected
 * session (when it changes and on its 20 s poll: there is no push event) and the pill reads the same
 * answer; this component never calls the view itself. A door (mark a criterion, clear a blocker, approve or
 * decline a staged Done when) goes through the store, which reads the view again after every reply. What it
 * draws is what the server said: the numbers are the server's, the state is an identifier translated through
 * i18n, and a mission an earlier version wrote (a v3 file) is read as v4 and drawn like any other (S-35). The
 * Sessions row and the hand-off (S-20) live in `MissionPaneSessions` and
 * `MissionHandoffDialog`: this component hosts them, holds the operator's "Not now" and calls the store's
 * hand-off only from the dialog's confirm. Attach, the attach request and Ask (S-21) live in
 * `MissionPaneAttach` and `MissionPaneAsk`: a session with no mission gets the picker, a request to join
 * gets Allow and Deny, and a milestone's Ask goes to the leading session.
 *
 * Close and the sample (S-22). "Close mission…" opens the one end dialog (`MissionCloseConfirmDialog`, v4
 * mode): Close as delivered or Discard, the open matters as warnings that never block, and the door call
 * goes through the store. A closed mission is no mission here: the view answers none and the pane shows the
 * attach picker. The SAMPLE (`lib/mission-sample.ts`) is a view object built from nothing that the pane can
 * show in place of the real answer, so every state can be seen without a live mission; a strip says so, and
 * every door the store runs for it changes nothing.
 *
 * At a glance in a small space (stp-21). The pane lives at about 296 to 420 px, so its first screenful is
 * the title with the bar, the next step, and what waits on the operator (`PANE_ORDER`). The steps and
 * timeline, the sessions row and the rest of the waiting list are one click away, closed to begin with, and
 * the pane keeps each choice (`loadPaneSections`) so it survives a refresh. Nothing is removed: "Open step"
 * opens the steps by itself. The pane has no minimum width: below 240 px it switches to a narrow layout
 * (`paneLayout`) with tighter padding, text that wraps or truncates with a title, and no sideways scroll.
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

// ---- The pane's own width and the disclosures the operator opens (stp-21) ----------------------------------
// There is no minimum width: the layout follows the width the pane really has (`paneLayout`). Before the first
// measure (and where there is no ResizeObserver) the width is unknown and reads as regular.
const paneWidth = ref<number | null>(null)
const layout = computed(() => paneLayout(paneWidth.value ?? Number.NaN))
let resizeObserver: ResizeObserver | null = null

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
const sections = reactive(loadPaneSections(storage()))
/** Open or close one disclosure and keep the choice. */
function setSection(id: PaneDisclosure, open: boolean): void {
  sections[id] = open
  savePaneSections(storage(), { ...sections })
}
/** The sample opens a part of the pane for you without touching what the operator kept. */
const sampleTree = ref(false)
const treeOpen = computed(() => sections.tree || sampleTree.value)

// The store polls only once someone asks it to start; the pane is a reader like the pill.
onMounted(() => {
  missions.ensureStarted()
  if (typeof ResizeObserver !== 'undefined' && rootEl.value) {
    resizeObserver = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width
      if (typeof w === 'number') paneWidth.value = w
    })
    resizeObserver.observe(rootEl.value)
  }
})
onBeforeUnmount(() => resizeObserver?.disconnect())

// The sample, when shown, stands in for the real answer and for the session the pane follows.
const sample = computed(() => missions.sampleView)
const sessionId = computed(
  () => sample.value?.sessionId ?? sessions.selectedSession?.sessionId ?? null
)
const reply = computed(() =>
  sample.value ? sample.value.reply : missions.v4ReplyForSession(sessionId.value)
)
const kind = computed<PaneKind>(() =>
  sessionId.value ? classifyReply(reply.value, sessionId.value) : 'none'
)
const mission = computed(() => (sessionId.value ? v4MissionOf(reply.value, sessionId.value) : null))
const refusal = computed(() => (reply.value?.state === 'refused' ? reply.value.error : ''))

// A session that leads several missions (the normal case for an old leader, S-35) is shown the one written most
// recently and may switch here: the choice is the store's, and nothing is written.
const led = computed(() => (sample.value ? [] : missions.ledMissionsFor(sessionId.value)))
const ledChosen = computed(() => mission.value?.missionId ?? '')
async function chooseLed(ev: Event): Promise<void> {
  const id = (ev.target as HTMLSelectElement).value
  if (sessionId.value && id) await missions.chooseMission(sessionId.value, id)
}

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
// The marker of the fill sits in its own row under the count, so it can never be drawn through it.
const bar = computed(() => barGeometry(percent.value))
// An open step lists the links its session wrote: the ones Harnu already collects for it (the footer's
// Links shelf reads the same transcript). The clock is for how long a blocker has waited.
const linkSession = computed(() => {
  const id = sessionId.value
  return id && !id.startsWith('synthetic-') && !sample.value ? id : null
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
const treeMeta = computed(() => {
  const line = tree.value ? treeLine(tree.value) : null
  if (!line) return ''
  if (line.kind === 'current') return line.title
  if (line.kind === 'allDone') return t('missionPane.tree.allDone')
  return t('missionPane.tree.lineSteps', { n: line.n }, line.n)
})
/** "Open step": open the steps if they are closed, then bring the step into view. Nothing is unreachable. */
async function revealStep(stepId: string): Promise<void> {
  if (!treeOpen.value) {
    setSection('tree', true)
    await nextTick()
  }
  await treeRef.value?.openStep(stepId)
}

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

// ---- Attach, the attach request and Ask (S-21) --------------------------------------------------------
// A session with no mission is shown the folder's open missions to attach to. A request to join is shown
// where the operator is looking: on the pane of the session that asked (it has no mission yet) and on the
// pane of a session already in the mission. Ask goes to the session that LEADS, which may not be this one.
const picker = computed(() =>
  kind.value === 'none' && sessionId.value
    ? pickerRows(reply.value?.state === 'none' ? reply.value.missions : [])
    : null
)
const requestRows = computed<RequestRow[]>(() => {
  const id = sessionId.value
  if (!id) return []
  const m = mission.value
  if (m) {
    return attachRequestsOf(m.detail).map((r) => ({
      requestId: r.id,
      missionId: m.missionId,
      missionTitle: m.detail.title,
      askerId: r.sessionId
    }))
  }
  if (kind.value !== 'none') return []
  const asks = sample.value ? sample.value.asks : missions.attachAsksForSession(id)
  return asks.map((a) => ({
    requestId: a.requestId,
    missionId: a.missionId,
    missionTitle: a.title,
    askerId: null
  }))
})
// ---- Close (S-22) -------------------------------------------------------------------------------------
// One end dialog for the Mission pane. The door call is the store's; the dialog lists what is open and never
// blocks. It opens on Close as delivered only when the server says every step is done; otherwise on Discard,
// so a stray Enter on an unfinished mission confirms nothing it did not mean.
const closeOpen = ref(false)
const closeBusy = ref(false)
const closeError = ref<string | null>(null)
const matters = computed(() => closeMatters(mission.value?.closeWarnings ?? []))
const readyToClose = computed(() => (mission.value ? isReadyToClose(mission.value.detail) : false))

function openClose(): void {
  closeError.value = null
  closeOpen.value = true
  // The dialog lists what the view counted: read it again, the poll may be up to 20 s old.
  if (!sample.value) void missions.refreshV4()
}
function cancelClose(): void {
  if (!closeBusy.value) closeOpen.value = false
}
async function confirmClose(closedAs: 'delivered' | 'discarded', reason?: string): Promise<void> {
  if (closeBusy.value) return
  closeBusy.value = true
  closeError.value = null
  try {
    const res = await missions.closeMission({ closedAs, reason })
    if (res.ok) closeOpen.value = false
    else closeError.value = `missionPane.close.error.${closeErrorKey(res.code)}`
  } finally {
    closeBusy.value = false
  }
}
// A mission that is no longer this pane's (it closed, the view lost it) takes its dialog with it.
watch(kind, (k) => {
  if (k !== 'mission') closeOpen.value = false
})

const askLeader = computed(() => (mission.value ? askLeaderOf(mission.value) : null))
const askFor = ref<string | null>(null)
// Another mission starts with no question open.
watch(
  () => mission.value?.missionId,
  () => (askFor.value = null)
)
const toggleAsk = (milestoneId: string): void => {
  askFor.value = askFor.value === milestoneId ? null : milestoneId
}

// ---- Sessions and the hand-off (S-20) -----------------------------------------------------------------
// The operator always decides a hand-off. The view may OFFER one (the leader's context at 80 percent or
// more); nothing here starts a session until the operator confirms in the dialog.
const offer = computed(() => {
  const o = mission.value ? handoffOfferView(mission.value, sessionId.value) : null
  if (!o || !mission.value) return null
  // "Not now" is kept per leader: at a reading no higher than the one it was said at (raw against raw), stay quiet.
  const at = missions.handoffDismissedAt(mission.value.missionId, o.leaderId)
  return at !== null && o.reading <= at ? null : o
})
const offerName = computed(() =>
  offer.value?.leaderId
    ? sessionNameOf(offer.value.leaderId, sessions.allSessions, t, mission.value?.detail.title)
    : ''
)
const handoffOpen = ref(false)
const handoffDone = ref(false)
const handoffError = ref<string | null>(null)
const newLeader = ref<string | null>(null)
// The summary the confirmation shows is the last one the view gave. When the view stops holding the mission
// (it closed under the dialog, the session was released), the dialog still shows what it was asked about.
const lastSummary = ref('')
watch(
  () => missionSummaryText(mission.value),
  (text) => {
    if (text !== undefined) lastSummary.value = text
  },
  { immediate: true }
)
const handoffSummary = computed(() => missionSummaryText(mission.value) ?? lastSummary.value)
const newLeaderLoaded = computed(
  () =>
    newLeader.value !== null && sessions.allSessions.some((s) => s.sessionId === newLeader.value)
)

function openHandoff(): void {
  handoffDone.value = false
  handoffError.value = null
  newLeader.value = null
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
    // A session the door started that did not take over runs without being attached: name the way to it.
    newLeader.value = res.started ?? null
    handoffError.value = handoffErrorKey(res.code, res.started !== undefined)
  }
}
function openNewLeader(): void {
  if (newLeader.value && newLeaderLoaded.value) sessions.select(newLeader.value)
  handoffOpen.value = false
}

// ---- The sample (S-22) --------------------------------------------------------------------------------
const sampleHint = computed(() => sample.value?.hint === true)
// The label a hint tells the operator to press is the pane's own: the hint quotes the real key, in the reader's language.
const sampleHintLabel = computed(() => {
  const state = sample.value?.state
  if (state === 'all-steps') return t('missionPane.tree.more', { n: 'N' }, 2)
  if (state === 'sessions') return t('missionPane.sessions.label')
  return t('missionPane.next.more', { n: 'N' }, 2)
})
function chooseSample(ev: Event): void {
  missions.showSample((ev.target as HTMLSelectElement).value as SampleState)
}
// A state that is a click on another one opens that part of the pane for you.
watch(
  () => sample.value?.state ?? null,
  async (state) => {
    askFor.value = null
    handoffOpen.value = false
    handoffDone.value = false
    sampleTree.value = false
    if (!state || !sample.value) return
    const ui = sample.value.ui
    // A state that is a click inside the steps opens them for you, without changing what the operator kept.
    if (ui.openStep || ui.ask) sampleTree.value = true
    await nextTick()
    if (ui.openStep) treeRef.value?.openStep(ui.openStep)
    if (ui.ask) askFor.value = ui.ask
    if (ui.handoff) handoffOpen.value = true
  },
  { flush: 'post' }
)

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
    :data-width-mode="layout.mode"
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

    <!-- The sample strip: what shows below is made up, and where to leave it. -->
    <section
      v-if="sample"
      class="flex shrink-0 flex-col border-b border-accent-line bg-accent-soft text-text"
      style="padding: 8px 12px; gap: 6px; font-size: 11.5px; line-height: 1.45"
      :aria-label="$t('missionPane.sample.label')"
      data-test="mission-sample"
    >
      <!-- Two rows: the label and the way out, then the note across the whole strip, so it never wraps in a sliver. -->
      <span class="flex items-center" style="gap: 8px">
        <b
          class="min-w-0 flex-1 truncate uppercase text-accent"
          style="font-size: 10px; letter-spacing: 0.07em"
          >{{ $t('missionPane.sample.label') }}</b
        >
        <button
          type="button"
          class="shrink-0 rounded-sm border border-border-2 bg-surface-2 text-text transition hover:border-text-4"
          style="height: 20px; padding: 0 7px; font-size: 11px; font-weight: 500"
          data-test="mission-sample-leave"
          @click="missions.showSample(null)"
        >
          {{ $t('missionPane.sample.leave') }}
        </button>
      </span>
      <span class="break-words text-text-2" data-test="mission-sample-note">{{
        $t('missionPane.sample.note')
      }}</span>
      <label class="flex items-center" style="gap: 8px">
        <span class="shrink-0 text-text-3">{{ $t('missionPane.sample.chooser') }}</span>
        <select
          class="min-w-0 flex-1 rounded-sm border border-border-2 bg-bg text-text outline-none focus:border-accent-line"
          style="height: 22px; padding: 0 4px; font-size: 11.5px"
          :value="sample.state"
          data-test="mission-sample-state"
          @change="chooseSample"
        >
          <option v-for="s in SAMPLE_STATES" :key="s" :value="s">
            {{ $t(`missionPane.sample.state.${s}`) }}
          </option>
        </select>
      </label>
      <!-- The hints quote the labels the pane really has, so the sample and the pane never word one thing twice. -->
      <span v-if="sampleHint" class="break-words text-text-3" data-test="mission-sample-hint">{{
        $t(`missionPane.sample.hint.${sample.state}`, {
          label: sampleHintLabel,
          tree: $t('missionPane.tree.toggle')
        })
      }}</span>
    </section>

    <div
      ref="bodyEl"
      class="scrollable no-default-ring min-h-0 flex-1 overflow-y-auto overflow-x-hidden outline-none"
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
          :style="{
            paddingTop: '14px',
            paddingBottom: '14px',
            paddingLeft: `${layout.padX}px`,
            paddingRight: `${layout.padX}px`
          }"
          data-pane-section="head"
          data-dsqa-part="mission-head"
        >
          <!-- Several missions led by this session: the one shown, and the others to switch to. -->
          <!-- Label above the control, the control the full width: its text is never squeezed out of view. -->
          <label
            v-if="led.length > 1"
            class="flex flex-col text-text-3"
            style="gap: 4px; margin-bottom: 8px; font-size: 11.5px"
            data-test="mission-leads"
          >
            <span class="min-w-0 break-words">{{
              $t('missionPane.leads.label', { n: led.length })
            }}</span>
            <select
              class="w-full min-w-0 rounded-sm border border-border-2 bg-bg text-text outline-none focus:border-accent-line"
              style="height: 22px; padding: 0 4px; font-size: 11.5px"
              :value="ledChosen"
              :title="led.find((m) => m.id === ledChosen)?.title ?? mission.detail.title"
              :aria-label="$t('missionPane.leads.choose')"
              data-test="mission-leads-select"
              @change="chooseLed"
            >
              <option v-for="m in led" :key="m.id" :value="m.id" :title="m.title">
                {{ m.title }}
              </option>
            </select>
          </label>
          <h2
            class="m-0 break-words text-text"
            style="font-size: 13.5px; font-weight: 600; line-height: 1.35"
            data-test="mission-title"
          >
            {{ mission.detail.title }}
          </h2>
          <!-- The count is INSIDE the bar (design.md §6 "Mission pane" → The glance). The bar is two rows: the count
               above, and under it a 2 px marker as wide as the fill, so the marker never runs through the text. -->
          <div
            class="relative grid overflow-hidden rounded-sm border border-border bg-surface-2"
            style="margin-top: 10px; height: 24px; grid-template-rows: minmax(0, 1fr) 2px"
            role="progressbar"
            :aria-label="$t('missionPane.bar.label')"
            aria-valuemin="0"
            :aria-valuemax="numbers.total"
            :aria-valuenow="numbers.done"
            data-test="mission-progress"
          >
            <i
              class="absolute inset-y-0 left-0 bg-green-soft"
              :style="{ width: `${percent}%` }"
              data-test="mission-bar-fill"
            />
            <span
              class="relative row-start-1 block min-w-0 truncate tabular-nums"
              :class="percent >= 100 ? 'text-green' : 'text-text-2'"
              style="padding: 0 9px; font-size: 11.5px; line-height: 22px"
              :title="progressLine"
              data-test="mission-count"
              >{{ progressLine }}</span
            >
            <i
              v-if="bar.marker"
              class="relative row-start-2 bg-green"
              :style="{ width: `${bar.marker.widthPct}%` }"
              data-test="mission-bar-marker"
            />
          </div>
          <span
            v-if="stateKey"
            class="mt-2 inline-block rounded-sm border border-green-line bg-green-soft text-green"
            style="padding: 1px 7px; font-size: 10.5px; font-weight: 500"
            data-test="mission-state"
            >{{ $t(stateKey) }}</span
          >
          <MissionPaneNext
            :detail="mission.detail"
            :more-open="sections.more"
            :compact="layout.mode === 'narrow'"
            @open-step="revealStep($event)"
            @toggle-more="setSection('more', !sections.more)"
            @close="openClose"
          />
          <!-- A session asked to join: only the operator answers it. -->
          <div v-if="requestRows.length > 0" style="margin-top: 10px" data-pane-section="waiting">
            <MissionPaneAttach :session-id="sessionId as string" :requests="requestRows" />
          </div>
          <!-- A Done when a session staged: only the operator makes it the mission's end. -->
          <section
            v-if="mission.pendingDoneWhen"
            class="flex flex-col rounded border border-accent-line bg-accent-soft"
            :style="{
              marginTop: '10px',
              padding: layout.mode === 'narrow' ? '8px 8px' : '10px 12px',
              gap: '8px'
            }"
            :data-pane-section="requestRows.length > 0 ? undefined : 'waiting'"
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
        <!-- The steps and the timeline: one line that says where the mission is, and one click to open them. -->
        <section
          v-if="hasTree && tree"
          :style="{ padding: `12px ${layout.padX}px` }"
          data-pane-section="tree"
          data-dsqa-part="tree"
        >
          <button
            type="button"
            class="flex w-full items-center text-left text-text-3 transition hover:text-text"
            style="gap: 8px; font-size: 12px"
            :aria-expanded="treeOpen"
            data-test="tree-toggle"
            @click="setSection('tree', !sections.tree)"
          >
            <span class="flex shrink-0 text-text-4">
              <ChevronDown v-if="treeOpen" :size="10" :stroke-width="1.8" />
              <ChevronRight v-else :size="10" :stroke-width="1.8" />
            </span>
            <span
              class="shrink-0 uppercase text-text-4"
              style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em"
              >{{ $t('missionPane.tree.toggle') }}</span
            >
            <span
              class="ml-auto min-w-0 truncate text-text-4"
              style="font-size: 11px"
              :title="treeMeta"
              data-test="tree-meta"
              >{{ treeMeta }}</span
            >
          </button>
          <!-- Keyed by the mission the reply was answered for: another mission starts with its own folds. -->
          <div v-if="treeOpen" style="margin-top: 10px">
            <MissionPaneTree
              ref="treeRef"
              :key="mission.missionId"
              :tree="tree"
              :askable="askLeader !== null"
              @ask="toggleAsk"
            >
              <template #ask="{ milestone }">
                <MissionPaneAsk
                  v-if="askLeader && askFor === milestone.id"
                  :milestone-title="milestone.title"
                  :leader-id="askLeader"
                  @close="askFor = null"
                />
              </template>
            </MissionPaneTree>
          </div>
        </section>
        <!-- Who worked on the mission, and the way to continue it in a new session. -->
        <MissionPaneSessions
          :mission="mission"
          :selected-id="sessionId"
          :pending="missions.handOffPending"
          :open="sections.sessions"
          :pad-x="layout.padX"
          @toggle="setSection('sessions', !sections.sessions)"
          @continue="openHandoff"
        />
        <!-- Ending is the operator's: always here, ready or not (a mission can be discarded at any time). -->
        <div class="flex justify-end" :style="{ padding: `4px ${layout.padX}px 14px` }">
          <button
            type="button"
            class="inline-flex items-center rounded-sm transition hover:bg-surface-2 hover:text-text"
            :class="readyToClose ? 'text-green' : 'text-text-3'"
            style="min-height: 20px; padding: 0 7px; gap: 5px; font-size: 11px; font-weight: 500"
            data-test="mission-close-open"
            @click="openClose"
          >
            <Flag :size="11" :stroke-width="1.8" aria-hidden="true" />{{
              $t('missionPane.close.open')
            }}
          </button>
        </div>
      </template>

      <!-- No mission: the picker of the folder's open missions, and any request to join (design.md §6 "Mission pane" → Attach). -->
      <div
        v-else-if="kind === 'none' && sessionId"
        class="flex flex-col text-text-3"
        style="padding: 20px 16px; gap: 14px; font-size: 12.5px; line-height: 1.5"
        data-test="mission-none"
      >
        <span class="flex items-center" style="gap: 8px">
          <Target :size="14" :stroke-width="1.6" class="shrink-0 text-text-4" />
          <b class="text-text" style="font-weight: 500">{{ $t('missionPane.none.title') }}</b>
        </span>
        <!-- A request waiting for the operator's answer is the whole state: the picker comes back once it is answered. -->
        <MissionPaneAttach
          :key="sessionId"
          :session-id="sessionId"
          :missions="requestRows.length > 0 ? null : picker"
          :requests="requestRows"
        />
        <!-- The sample shows every state of this pane with made-up data, whether or not a mission exists. -->
        <div
          v-if="!sample"
          class="flex flex-col border-t border-border text-text-3"
          style="padding-top: 12px; gap: 4px; font-size: 11.5px; line-height: 1.45"
        >
          <button
            type="button"
            class="self-start text-accent transition hover:underline"
            style="font-size: 12px; font-weight: 500"
            data-test="mission-sample-open"
            @click="missions.showSample('default')"
          >
            {{ $t('missionPane.sample.open') }}
          </button>
          <span>{{ $t('missionPane.sample.openHint') }}</span>
        </div>
      </div>

      <!-- A refusal, or no session: the same empty layout (design.md §6 "Mission pane" → States). -->
      <div
        v-else
        class="flex flex-col items-center text-center text-text-3"
        style="padding: 40px 24px; gap: 8px; font-size: 12.5px; line-height: 1.5"
        :data-test="`mission-${kind}`"
      >
        <Target :size="14" :stroke-width="1.6" class="text-text-4" />
        <b class="text-text" style="font-weight: 500">{{ $t(`missionPane.${kind}.title`) }}</b>
        <template v-if="kind === 'refused'">
          <span
            v-if="refusal"
            class="break-words font-mono text-text-3"
            style="font-size: 11.5px"
            >{{ refusal }}</span
          >
          <button
            type="button"
            class="inline-flex items-center whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 text-text transition hover:border-text-4"
            style="height: 20px; padding: 0 7px; font-size: 11px; font-weight: 500; margin-top: 4px"
            data-test="refused-retry"
            @click="missions.refreshV4()"
          >
            {{ $t('missionPane.refused.retry') }}
          </button>
        </template>
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
    <MissionCloseConfirmDialog
      v-if="closeOpen && mission"
      mode="v4"
      :title="mission.detail.title"
      :busy="closeBusy"
      :matters="matters"
      :done-when="mission.detail.doneWhen"
      :initial="readyToClose ? 'delivered' : 'discarded'"
      :error-key="closeError"
      @cancel="cancelClose"
      @confirm="confirmClose"
    />
    <MissionHandoffDialog
      :open="handoffOpen"
      :brief="handoffSummary"
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
