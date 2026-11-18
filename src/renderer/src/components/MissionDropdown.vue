<script setup lang="ts">
/**
 * Mission dropdown — the shell (Missions v4; design.md §6 "Mission dropdown" → "Anchoring, size, scroll"
 * and "Keyboard and focus"; mockup `docs/design/mission-dropdown/`).
 *
 * A teleported, non-modal `role="dialog"` layer that hangs under the Topbar pill: `position: fixed` on
 * `--z-dialog`, 6px under the Topbar's bottom edge, its left edge on the pill's (flipped to the right edge
 * near the window's), 8px clear of every window edge (`lib/mission-dropdown-position.ts`). It is a column:
 * the **body** is the one scroller (`.scrollable`, a size container), the **footer** is pinned under it —
 * and under 420px of window height it scrolls with the body instead.
 *
 * Its open state is the existing `ui.popovers.missionProgress` flag, so the App's Esc binding and
 * `anyPopoverOpen` order it with the other popovers. It closes on Esc (focus goes back to the pill), on a
 * click outside it (one that lands on a dialog does not count), and on the pill again — the pill and the
 * `view.missionProgress` chord flip the same flag, so a click on the pill is left to the pill. A door that
 * ends the mission calls the `close` this component exposes.
 *
 * S-2 draws the top of the body: the head (the title, one progress row and, when the session leads several
 * missions, the one-line switch) and the one card that holds what the operator owes next. S-3 draws the tree
 * under them: milestone, step, criteria, with the state glyphs' labels and Ask. It reads the same view the pane
 * does (the sample while one shows, else the session's own reply), and the Topbar pill, which is always mounted,
 * is what keeps the store polling. S-4 drew the open step. S-5 draws what is not a mission (the loading line, a
 * refused read and the empty state with its picker and its "See a sample mission" link: `MissionDropdownEmpty`),
 * the strip over a shown sample, the footer ("Close mission…", pinned) and the close dialog the dropdown opens: a
 * dialog makes the dropdown `inert` and dimmed, takes initial focus on Cancel and gives focus back to its opener
 * on Esc, and a door that ends the mission closes the dropdown too.
 * S-6 adds the "Test it" controls (the tree draws the step's and the milestone's; the footer draws "Test the whole
 * mission" for a mission that is ready to close) and the seam they call, `lib/walk-entry.ts`: a control is drawn
 * only when `walkEntryAvailable(source)` says yes, a click calls `startWalk(source)` and then this component
 * closes the dropdown; opening the walk's pane is the provider's job. The shipped provider says no.
 * The Topbar pill opens it (S-7), and the Mission pane it replaced is gone (S-8).
 */
import { computed, customRef, nextTick, onBeforeUnmount, ref, useSlots, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Flag, ListChecks } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import {
  DROPDOWN_SHORT_WINDOW,
  placeMissionDropdown,
  type DropdownAnchor
} from '../lib/mission-dropdown-position'
import { useSessionLinks } from '../composables/useSessionLinks'
import {
  askLeaderOf,
  classifyReply,
  closeErrorKey,
  closeMatters,
  isReadyToClose,
  ledMissionRows,
  nextCardOf,
  pickerRows,
  v4MissionOf,
  type PaneKind
} from '../lib/mission-pane-view'
import { SAMPLE_STATES, type SampleState } from '../lib/mission-sample'
import { startWalk, walkEntryAvailable, type WalkSource } from '../lib/walk-entry'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import MissionCloseConfirmDialog from './MissionCloseConfirmDialog.vue'
import MissionDropdownEmpty, { type EmptyRequestRow } from './MissionDropdownEmpty.vue'
import MissionDropdownHead from './MissionDropdownHead.vue'
import MissionDropdownNext from './MissionDropdownNext.vue'
import MissionDropdownTree from './MissionDropdownTree.vue'

const props = defineProps<{
  /**
   * The pill's rectangle, when the caller knows it. Without it the dropdown reads the Topbar pill from
   * the page (`PILL_SELECTOR`), and with no pill at all it sits on the left margin.
   */
  anchorRect?: DropdownAnchor | null
}>()

const emit = defineEmits<{
  /** "Open step" on the card: the tree (S-4) brings the step into view. */
  openStep: [stepId: string]
}>()

const { t } = useI18n()
const ui = useUiStore()
const missions = useMissionsStore()
const sessions = useSessionsStore()

// ---- what it shows -----------------------------------------------------------------------------------
// The sample, when shown, stands in for the real answer and for the session the dropdown follows.
const sample = computed(() => missions.sampleView)
const sessionId = computed(
  () => sample.value?.sessionId ?? sessions.selectedSession?.sessionId ?? null
)
const reply = computed(() =>
  sample.value ? sample.value.reply : missions.v4ReplyForSession(sessionId.value)
)
const mission = computed(() => (sessionId.value ? v4MissionOf(reply.value, sessionId.value) : null))
const kind = computed<PaneKind>(() =>
  sessionId.value ? classifyReply(reply.value, sessionId.value) : 'none'
)
const refusal = computed(() => (reply.value?.state === 'refused' ? reply.value.error : ''))
// ---- no mission: the picker, and a request to join this session -------------------------------------------
const picker = computed(() =>
  kind.value === 'none' && sessionId.value
    ? pickerRows(reply.value?.state === 'none' ? reply.value.missions : [])
    : undefined
)
const requestRows = computed<EmptyRequestRow[]>(() => {
  const id = sessionId.value
  if (!id || kind.value !== 'none') return []
  const asks = sample.value ? sample.value.asks : missions.attachAsksForSession(id)
  return asks.map((a) => ({
    requestId: a.requestId,
    missionId: a.missionId,
    missionTitle: a.title,
    askerId: null
  }))
})
// A session that leads several missions may switch here: the choice is the store's, and nothing is written.
const led = computed(() => (sample.value ? [] : ledMissionRows(missions.readers, sessionId.value)))
/** The switch's list is open: it is all the body shows, as in the mockup's `chooser` state. */
const chooserOpen = ref(false)
// No mission, no list: nothing is left to hide the body behind.
watch(mission, (m) => {
  if (!m) chooserOpen.value = false
})
async function chooseLed(id: string): Promise<void> {
  if (sessionId.value && id) await missions.chooseMission(sessionId.value, id)
}

// ---- the sample -------------------------------------------------------------------------------------------
// A sample stands in for the real answer: a strip says it is made up, offers its states and the way out. The
// states the dropdown no longer has (sessions, the hand-off) are not offered.
const SAMPLE_GONE: readonly SampleState[] = ['sessions', 'handoff-suggest', 'handoff-confirm']
const sampleStates = SAMPLE_STATES.filter((s) => !SAMPLE_GONE.includes(s))
function chooseSample(ev: Event): void {
  missions.showSample((ev.target as HTMLSelectElement).value as SampleState)
}
// The hints quote the labels the dropdown really has, so the sample never words one thing twice.
const sampleHintLabel = computed(() =>
  sample.value?.state === 'all-steps'
    ? t('missionDropdown.tree.more', { n: 'N' }, 2)
    : t('missionDropdown.next.more', { n: 'N' }, 2)
)

// ---- the footer and the close dialog (S-5) ---------------------------------------------------------------
// The footer holds "Close mission…" unless the next card already is that, and in the empty and chooser views.
const nextIsClose = computed(() => {
  const primary = mission.value ? nextCardOf(mission.value).primary : null
  return primary?.kind === 'item' && primary.item.kind === 'close'
})
const showFooterClose = computed(
  () => mission.value !== null && !chooserOpen.value && !nextIsClose.value
)

const slots = useSlots()
const hasFooter = computed(
  () => showFooterClose.value || showFooterTest.value || slots.footer !== undefined
)
/** The ghost, compact button (design.md §6 "Mission dropdown"): `h-5`, `px-2`, `11px`. */
const FOOTER_BTN =
  'inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-2 text-[11px] font-medium leading-none text-text-3 transition hover:bg-surface-2 hover:text-text'

/** The bordered, compact button (design.md §6 "Mission dropdown"): what "Test the whole mission" is. */
const TEST_BTN =
  'inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 px-2 text-[11px] font-medium leading-none text-text transition hover:border-text-4'

const closeOpen = ref(false)
const closeBusy = ref(false)
const closeError = ref<string | null>(null)
const matters = computed(() => closeMatters(mission.value?.closeWarnings ?? []))
const readyToClose = computed(() => (mission.value ? isReadyToClose(mission.value.detail) : false))
// "Test the whole mission" (S-6): at the end of a mission, when the provider offers a walk from the mission.
const showFooterTest = computed(
  () =>
    mission.value !== null &&
    !chooserOpen.value &&
    readyToClose.value &&
    walkEntryAvailable({ kind: 'mission', missionId: mission.value.missionId })
)

/** A control asked for a walk: start it, then close the dropdown. Opening the walk's pane is the provider's job. */
function walk(source: WalkSource): void {
  startWalk(source)
  close()
}

/** The element that opened the dialog: focus goes back to it when the dialog closes. */
let closeOpener: HTMLElement | null = null

function openClose(): void {
  closeOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  closeError.value = null
  closeOpen.value = true
  // The dialog lists what the view counted: read it again, the poll may be up to 20 s old.
  if (!sample.value) void missions.refreshV4()
}
async function cancelClose(): Promise<void> {
  if (closeBusy.value) return
  closeOpen.value = false
  await nextTick()
  if (closeOpener?.isConnected) closeOpener.focus()
  closeOpener = null
}
async function confirmClose(closedAs: 'delivered' | 'discarded', reason?: string): Promise<void> {
  if (closeBusy.value) return
  closeBusy.value = true
  closeError.value = null
  try {
    const res = await missions.closeMission({ closedAs, reason })
    if (res.ok) {
      // A door that ends the mission closes the dropdown too: there is no mission left to look at.
      closeOpen.value = false
      closeOpener = null
      close()
    } else closeError.value = `missionPane.close.error.${closeErrorKey(res.code)}`
  } finally {
    closeBusy.value = false
  }
}
// A mission that is no longer this dropdown's (it closed, the view lost it) takes its dialog with it.
watch(mission, (m) => {
  if (!m) closeOpen.value = false
})
watch(
  () => ui.popovers.missionProgress,
  (isOpen) => {
    if (!isOpen) closeOpen.value = false
  }
)

/** The Topbar pill (`MissionPill.vue` draws `data-dsqa="topbar-pill--<tone>"`). */
const PILL_SELECTOR = '[data-dsqa^="topbar-pill--"]'

const open = computed(() => ui.popovers.missionProgress)
const root = ref<HTMLElement | null>(null)

// ---- the tree ----------------------------------------------------------------------------------------
// A step's PR number gets its address from the links the session wrote (the footer's Links shelf reads the
// same transcript); a sample, or a session that has no transcript yet, has none. Ask goes to the session that
// LEADS the mission, which may not be the one this dropdown follows.
const linkSession = computed(() => {
  const id = sessionId.value
  return id && !id.startsWith('synthetic-') && !sample.value ? id : null
})
const { entries: sessionLinks } = useSessionLinks(linkSession)
const askLeader = computed(() => (mission.value ? askLeaderOf(mission.value) : null))
const treeRef = ref<InstanceType<typeof MissionDropdownTree> | null>(null)

/** "Open step" on the card: the tree unfolds it and brings it into view; the caller hears of it too. */
function openStep(stepId: string): void {
  void treeRef.value?.openStep(stepId)
  emit('openStep', stepId)
}

// A sample state that is a click on another one opens that part of the tree for you (an open step, the Ask box).
watch(
  () => [open.value, sample.value?.state ?? null] as const,
  async ([isOpen, state]) => {
    const ui = sample.value?.ui
    if (!isOpen || !state || !ui) return
    await nextTick()
    if (ui.openStep) void treeRef.value?.openStep(ui.openStep)
    if (ui.ask) treeRef.value?.openAsk(ui.ask)
  },
  { flush: 'post', immediate: true }
)

/** The window's size, kept current while the layer is up. */
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
/** The pill's rectangle, read when the layer opens and when the window resizes. */
const pillRect = ref<DropdownAnchor | null>(null)

function pill(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PILL_SELECTOR)
}

function measure(): void {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  const el = pill()
  if (el) {
    const r = el.getBoundingClientRect()
    pillRect.value = { left: r.left, right: r.right }
  } else {
    pillRect.value = null
  }
}

const placement = computed(() =>
  placeMissionDropdown({
    anchor: props.anchorRect ?? pillRect.value,
    viewport: viewport.value
  })
)

/** Under 420px of window height the footer scrolls with the body instead of staying pinned. */
const footerInBody = computed(() => viewport.value.height < DROPDOWN_SHORT_WINDOW)

/** Close it. What a door that ends the mission calls (AC-17). */
function close(): void {
  ui.closePopover('missionProgress')
}
defineExpose({ close })

// ---- focus -----------------------------------------------------------------------------------------
// Tab and Shift+Tab cycle inside it. Initial focus is on the card's button (the next step's, Approve or
// Allow: the one that carries `data-autofocus`); while nothing is owed it is the dropdown itself
// (`tabindex="-1"`). Read when the trap asks, after the layer has drawn.
const initialFocus: Ref<HTMLElement | null> = customRef(() => ({
  get: () => root.value?.querySelector<HTMLElement>('[data-autofocus]') ?? root.value,
  set: () => undefined
}))
// While a dialog sits on top the trap steps aside: the dialog owns Tab and focus (it gives focus back on its own).
useFocusTrap({
  active: open,
  containerRef: root,
  initialFocusRef: initialFocus,
  suspended: closeOpen
})

/** Set by Esc: when the layer has gone, focus goes back to the pill. */
let returnFocusToPill = false

watch(
  open,
  async (isOpen) => {
    if (isOpen) {
      measure()
      await nextTick()
      document.addEventListener('click', onClickOutside, true)
      window.addEventListener('keydown', onKeydown)
      window.addEventListener('resize', measure)
    } else {
      detach()
    }
  },
  { immediate: true }
)
// After the trap has given focus back to whatever held it, Esc puts it on the pill.
watch(
  open,
  (isOpen) => {
    if (isOpen || !returnFocusToPill) return
    returnFocusToPill = false
    pill()?.focus()
  },
  { flush: 'post' }
)

function detach(): void {
  document.removeEventListener('click', onClickOutside, true)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', measure)
}
onBeforeUnmount(detach)

/** Another dialog is on top of this one (a close confirm): it owns Esc and clicks. */
function dialogOnTop(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"]')).some((d) => d !== root.value)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || !open.value) return
  if (dialogOnTop()) return
  returnFocusToPill = true
  close()
}

function onClickOutside(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target
  if (!(target instanceof Node)) return
  if (root.value?.contains(target)) return
  // The pill toggles the flag itself; closing here too would reopen it on the same click.
  if (pill()?.contains(target)) return
  // A click that lands on a dialog (the close confirm opened from here) does not close it.
  const el = target instanceof Element ? target : target.parentElement
  if (el?.closest('[role="dialog"]')) return
  close()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      role="dialog"
      tabindex="-1"
      :aria-label="t('missionDropdown.shell.label')"
      :inert="closeOpen ? true : undefined"
      data-test="mission-dropdown"
      data-dsqa="mission-dropdown"
      class="anim-fade-in-scale fixed z-(--z-dialog) flex max-h-[min(640px,calc(100vh-56px))] w-[min(420px,calc(100vw-16px))] origin-top-left flex-col rounded-lg border border-border-2 bg-surface text-text shadow-pop outline-none [-webkit-app-region:no-drag]"
      :class="closeOpen ? 'saturate-[0.7]' : ''"
      :style="{ top: `${placement.top}px`, left: `${placement.left}px` }"
    >
      <div
        class="scrollable @container min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        data-test="mission-dropdown-body"
      >
        <!-- The sample strip: what shows below is made up, its states, and the way out. -->
        <section
          v-if="sample"
          class="flex flex-col border-b border-accent-line bg-accent-soft text-text"
          style="padding: 8px 14px; gap: 6px; font-size: 11.5px; line-height: 1.45"
          :aria-label="t('missionDropdown.sample.label')"
          data-test="mission-sample"
        >
          <span class="flex items-center rounded-sm" style="gap: 8px">
            <b
              class="min-w-0 flex-1 truncate uppercase text-accent"
              style="font-size: 10px; letter-spacing: 0.07em"
              >{{ t('missionDropdown.sample.label') }}</b
            >
            <button
              type="button"
              class="inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 px-2 text-[11px] font-medium leading-none text-text transition hover:border-text-4"
              data-test="mission-sample-leave"
              @click="missions.showSample(null)"
            >
              {{ t('missionDropdown.sample.leave') }}
            </button>
          </span>
          <span class="text-text-2 [overflow-wrap:anywhere]" data-test="mission-sample-note">{{
            t('missionDropdown.sample.note')
          }}</span>
          <label class="flex items-center" style="gap: 8px">
            <span class="shrink-0 text-text-3">{{ t('missionDropdown.sample.chooser') }}</span>
            <select
              class="h-[22px] min-w-0 flex-1 rounded-sm border border-border-2 bg-bg px-1 text-[11.5px] text-text outline-none focus:border-accent-line"
              :value="sample.state"
              data-test="mission-sample-state"
              @change="chooseSample"
            >
              <option v-for="st in sampleStates" :key="st" :value="st">
                {{ t(`missionDropdown.sample.state.${st}`) }}
              </option>
            </select>
          </label>
          <span
            v-if="sample.hint"
            class="text-text-3 [overflow-wrap:anywhere]"
            data-test="mission-sample-hint"
            >{{
              t(`missionDropdown.sample.hint.${sample.state}`, { label: sampleHintLabel })
            }}</span
          >
        </section>
        <template v-if="mission">
          <MissionDropdownHead
            :detail="mission.detail"
            :led="led"
            :current-id="mission.missionId"
            @choose="chooseLed"
            @chooser="chooserOpen = $event"
          />
          <MissionDropdownNext
            v-show="!chooserOpen"
            :mission="mission"
            @open-step="openStep"
            @close="openClose"
          />
          <!-- Keyed by the mission the reply was answered for: another mission starts with its own folds. -->
          <MissionDropdownTree
            v-show="!chooserOpen"
            ref="treeRef"
            :key="`${mission.missionId}:${sample?.state ?? ''}`"
            :detail="mission.detail"
            :ask-leader="askLeader"
            :session-links="sessionLinks"
            @walk="walk"
          />
        </template>
        <MissionDropdownEmpty
          v-else
          :kind="kind === 'mission' ? 'none' : kind"
          :session-id="sessionId"
          :picker="picker"
          :requests="requestRows"
          :refusal="refusal"
          :sample-link="!sample && kind === 'none' && sessionId !== null"
        />
        <div v-show="!chooserOpen"><slot /></div>
        <div
          v-if="footerInBody && hasFooter"
          class="border-t border-border"
          style="padding: 7px 14px"
          data-test="mission-dropdown-footer"
          data-dsqa-part="footer"
        >
          <div
            v-if="showFooterClose || showFooterTest"
            class="flex flex-wrap items-center rounded-sm"
            style="gap: 6px"
          >
            <span v-if="showFooterClose" class="inline-flex rounded-sm">
              <button type="button" :class="FOOTER_BTN" data-test="footer-close" @click="openClose">
                <Flag :size="10" :stroke-width="1.8" data-glyph="flag" aria-hidden="true" />{{
                  t('missionDropdown.footer.close')
                }}
              </button>
            </span>
            <span v-if="showFooterTest" class="inline-flex rounded-sm">
              <button
                type="button"
                :class="TEST_BTN"
                :title="t('missionDropdown.testIt.mission.tip')"
                data-test="test-it-mission"
                @click="walk({ kind: 'mission', missionId: mission!.missionId })"
              >
                <ListChecks :size="10" :stroke-width="2" aria-hidden="true" />{{
                  t('missionDropdown.testIt.mission.label')
                }}
              </button>
            </span>
          </div>
          <slot name="footer" />
        </div>
      </div>
      <div
        v-if="!footerInBody"
        class="shrink-0"
        :class="hasFooter ? 'border-t border-border' : ''"
        :style="hasFooter ? 'padding: 7px 14px' : undefined"
        data-test="mission-dropdown-footer"
        data-dsqa-part="footer"
      >
        <div
          v-if="showFooterClose || showFooterTest"
          class="flex flex-wrap items-center rounded-sm"
          style="gap: 6px"
        >
          <span v-if="showFooterClose" class="inline-flex rounded-sm">
            <button type="button" :class="FOOTER_BTN" data-test="footer-close" @click="openClose">
              <Flag :size="10" :stroke-width="1.8" data-glyph="flag" aria-hidden="true" />{{
                t('missionDropdown.footer.close')
              }}
            </button>
          </span>
          <span v-if="showFooterTest" class="inline-flex rounded-sm">
            <button
              type="button"
              :class="TEST_BTN"
              :title="t('missionDropdown.testIt.mission.tip')"
              data-test="test-it-mission"
              @click="walk({ kind: 'mission', missionId: mission!.missionId })"
            >
              <ListChecks :size="10" :stroke-width="2" aria-hidden="true" />{{
                t('missionDropdown.testIt.mission.label')
              }}
            </button>
          </span>
        </div>
        <slot name="footer" />
      </div>
    </div>
  </Teleport>
  <!-- Teleported after the dropdown, so at the same `--z-dialog` layer it sits above it. -->
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
</template>
