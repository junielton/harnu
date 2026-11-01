<script setup lang="ts">
/**
 * Mission progress popover (T370; Mission v3 S3 — design.md §6 "Mission
 * progress" → Popover). The Activity bell's shell at 400px: a header (Progress
 * · the server's headline · title · the counts line · scope links · optional
 * sub-line), the step rail, the `you` block, the open questions and a footer
 * with the end door. Hosts the operator doors — approve a re-scope, the
 * human-step tick, the checks, and ending the mission — the only writes the
 * mission UI makes. Ending is the one irreversible door: its buttons only open
 * `MissionCloseConfirmDialog`, and the door fires from that dialog's confirm.
 */
import { computed, ref } from 'vue'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import { useI18n } from 'vue-i18n'
import { Check, ChevronLeft, FileText, Flag, TriangleAlert } from 'lucide-vue-next'
import type { MissionDoor, MissionView } from '../../../main/mission-ipc'
import type { MissionLinkSignal } from '../../../main/mcp/tool-handlers'
import {
  endWarnings,
  formatDuration,
  headlineText,
  type EndChoice,
  type MissionModel,
  youRowText,
  type YouRow
} from '../lib/mission-view'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import Button from './ui/Button.vue'
import MissionStepRail from './MissionStepRail.vue'
import MissionCloseConfirmDialog from './MissionCloseConfirmDialog.vue'

const props = defineProps<{
  view: MissionView
  model: MissionModel
  /**
   * T596 — set when this chapter popover was opened from the Campaign popover: the back row's
   * "Chapter {ordinal} of {total}" (`ordinal: null` for a side chapter). Absent = no back row.
   */
  campaignBack?: { ordinal: number | null; total: number; side?: boolean }
}>()
const emit = defineEmits<{ back: [] }>()

const { t } = useI18n()
const missions = useMissionsStore()
const sessions = useSessionsStore()

const headline = computed(() => headlineText(t, props.model.headline))

const subLine = computed<string | null>(() => {
  if (props.view.mission.status === 'delivered') return t('mission.sub.delivered')
  if (props.model.addedCount > 0) {
    return t('mission.sub.totalChanged', {
      total: props.model.total,
      was: props.model.total - props.model.addedCount,
      n: props.model.addedCount
    })
  }
  return null
})

/** Scope documents (Mission v3 §3.3) — an attachment, never a step. */
const scopeLinks = computed(() =>
  props.view.derived.scope.links.map((l: MissionLinkSignal) => ({
    ref: l.ref,
    name: l.ref.split('/').filter(Boolean).pop() ?? l.ref,
    onBranch: !l.exists
  }))
)

/** A linked session's display name for the `you` block. */
function sessionName(id: string): string {
  const s = sessions.allSessions.find((x) => x.sessionId === id)
  return (s && sessionTitle(s, sessions.allSessions, t)) || id.slice(0, 8)
}

/** One You-lane row in the operator's words; a "Decide" row names its decision node. */
function rowText(row: YouRow): string {
  return youRowText(t, props.view, row, sessionName)
}

/** Campaign spec Amendment d: the first row is boxed, every other row stands on its own. */
const firstRow = computed<YouRow | null>(() => props.model.youRows[0] ?? null)
const restRows = computed(() => props.model.youRows.slice(1))

const RISK_CLASS: Record<YouRow['risk'], string> = {
  high: 'text-red',
  mid: 'text-warning',
  low: 'text-text-4'
}

/** "3h 0m" — only where the record had a timestamp. */
function ageText(row: YouRow): string | null {
  return row.ageMs === null ? null : formatDuration(row.ageMs)
}

/** The ledger tail's "3m ago". */
function ledgerAge(at: string): string {
  const ms = Date.parse(at)
  return Number.isFinite(ms)
    ? t('mission.ledger.ago', { age: formatDuration(Math.max(0, Date.now() - ms)) })
    : ''
}

/** Run a door on this mission; a refusal or IPC failure is toasted by the store. */
async function door(d: Omit<MissionDoor, 'root' | 'missionId'>): Promise<boolean> {
  const res = await missions.runDoor({
    ...d,
    root: props.view.root,
    missionId: props.view.mission.id
  } as MissionDoor)
  return res.ok
}

/** The end dialog is open — the only way the end door can fire. */
const confirmingClose = ref(false)
/** The choice the dialog opens on: a requested close presets "Close as delivered". */
const endChoice = ref<EndChoice>('delivered')

function openEnd(choice: EndChoice): void {
  endChoice.value = choice
  confirmingClose.value = true
}

/**
 * The end door (Mission v3 §3.5). On success the store removes the mission from
 * the door's `view: null` at once, which unmounts this popover and the dialog;
 * on a refusal or an IPC failure the store toasts and the dialog closes here.
 */
async function confirmClose(closedAs: EndChoice, reason?: string): Promise<void> {
  await door({
    door: 'end',
    closedAs,
    ...(reason ? { reason } : {})
  } as Omit<MissionDoor, 'root' | 'missionId'>)
  confirmingClose.value = false
}

function onTick(stepId: string, verified: boolean): void {
  void door({ door: 'verifyStep', stepId, verified } as Omit<MissionDoor, 'root' | 'missionId'>)
}

async function onAddCheck(stepId: string, label: string, done: () => void): Promise<void> {
  const ok = await door({ door: 'addCheck', stepId, label } as Omit<
    MissionDoor,
    'root' | 'missionId'
  >)
  if (ok) done()
}

async function onTickCheck(
  stepId: string,
  checkId: string,
  ticked: boolean,
  settle: (ok: boolean) => void
): Promise<void> {
  settle(
    await door({ door: 'tickCheck', stepId, checkId, ticked } as Omit<
      MissionDoor,
      'root' | 'missionId'
    >)
  )
}

function onDeleteCheck(stepId: string, checkId: string): void {
  void door({ door: 'deleteCheck', stepId, checkId } as Omit<MissionDoor, 'root' | 'missionId'>)
}

/** Campaign spec §4 — Choose: the operator picks a decision node's option (`mission:choose`). */
function onChoose(stepId: string, index: number): void {
  void door({ door: 'chooseDecision', stepId, index } as Omit<MissionDoor, 'root' | 'missionId'>)
}

// An in-app popover: registers with the native-overlay freeze (a browser pane under it freezes, spec §2.4).
const rootEl = ref<HTMLElement | null>(null)
useNativeOverlay('mission-popover', rootEl)
</script>

<template>
  <div
    ref="rootEl"
    class="anim-fade-in-scale flex flex-col overflow-hidden rounded border border-border-2 bg-surface shadow-pop"
    style="width: 400px; max-height: 560px"
    :data-dsqa="`mission-popover--${model.state}`"
  >
    <button
      v-if="campaignBack"
      type="button"
      class="flex shrink-0 cursor-pointer items-center text-text-3 hover:text-text-2"
      style="gap: 4px; padding: 8px 14px 0; font-size: 11px"
      data-test="mission-back-to-campaign"
      @click="emit('back')"
    >
      <ChevronLeft :size="12" :stroke-width="1.8" class="shrink-0" />
      <span>{{ $t('mission.back.campaign') }}</span>
      <template v-if="campaignBack.ordinal !== null || campaignBack.side">
        <span class="text-text-4">·</span>
        <span class="tabular-nums">{{
          campaignBack.ordinal === null
            ? $t('mission.back.sideQuest')
            : $t('mission.back.chapter', { n: campaignBack.ordinal, m: campaignBack.total })
        }}</span>
      </template>
    </button>
    <div class="shrink-0 border-b border-border" style="padding: 10px 14px">
      <div class="flex items-center" style="gap: 8px">
        <span class="text-text" style="font-size: 12.5px; font-weight: 500">{{
          $t('mission.progress')
        }}</span>
        <span
          class="ml-auto shrink-0 tabular-nums text-text-4"
          style="font-size: 11px"
          data-test="mission-count"
          >{{ headline }}</span
        >
      </div>
      <div
        class="truncate text-text-3"
        style="font-size: 11px; margin-top: 2px"
        :title="view.title"
      >
        {{ view.title }}
      </div>
      <div
        class="tabular-nums text-text-4"
        style="font-size: 11px; margin-top: 3px"
        data-test="mission-counts"
      >
        {{ $t('mission.header.counts', { done: model.done, verified: model.verified }) }}
        <span v-if="model.leftBehind > 0" class="text-warning">{{
          $t('mission.header.leftBehind', { n: model.leftBehind })
        }}</span>
      </div>
      <div
        v-if="scopeLinks.length"
        class="flex flex-wrap items-center"
        style="gap: 4px 10px; margin-top: 4px"
        data-test="mission-scope"
      >
        <span
          v-for="l in scopeLinks"
          :key="l.ref"
          class="flex min-w-0 items-center"
          style="gap: 4px"
          :title="l.ref"
        >
          <FileText :size="11" :stroke-width="1.6" class="shrink-0 text-text-4" />
          <span class="truncate font-mono text-text-3" style="font-size: 10.5px">{{ l.name }}</span>
          <span v-if="l.onBranch" class="shrink-0 text-text-4" style="font-size: 10.5px">{{
            $t('mission.header.onBranch')
          }}</span>
        </span>
      </div>
      <div v-if="subLine" class="text-text-4" style="font-size: 11px; margin-top: 3px">
        {{ subLine }}
      </div>
    </div>

    <div class="scrollable overflow-y-auto" style="padding: 12px 14px 14px">
      <MissionStepRail
        :view="view"
        :model="model"
        :busy="missions.doorInFlight"
        @tick="onTick"
        @add-check="onAddCheck"
        @tick-check="onTickCheck"
        @delete-check="onDeleteCheck"
        @choose="onChoose"
      />

      <div class="bg-border" style="height: 1px; margin: 12px 0" />

      <!-- The you block — always rendered, one of three looks (Mission v3 §3.12). -->
      <div
        class="flex items-start rounded-sm"
        :class="
          model.youLook === 'warning'
            ? 'border border-warning-line bg-warning-soft text-warning'
            : model.youLook === 'success'
              ? 'border border-green-line bg-green-soft text-green'
              : 'text-text-4'
        "
        :style="
          model.youLook === 'clear'
            ? 'gap: 7px; font-size: 11.5px; line-height: 1.5'
            : 'gap: 7px; padding: 8px 10px; font-size: 11.5px; line-height: 1.5'
        "
        :data-dsqa="`mission-you--${model.youLook}`"
      >
        <TriangleAlert
          v-if="model.youLook === 'warning'"
          :size="13"
          :stroke-width="1.8"
          class="mt-0.5 shrink-0"
        />
        <Check
          v-else-if="model.youLook === 'success'"
          :size="13"
          :stroke-width="1.8"
          class="mt-0.5 shrink-0"
        />
        <div class="min-w-0 flex-1">
          <span
            class="block uppercase opacity-85"
            style="font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; margin-bottom: 3px"
            >{{ $t('mission.you.label') }}</span
          >
          <span data-test="mission-you-first">{{
            firstRow ? rowText(firstRow) : $t('mission.you.clear')
          }}</span>
          <span
            v-if="firstRow && ageText(firstRow)"
            class="ml-2 tabular-nums opacity-75"
            style="font-size: 10.5px"
            data-test="mission-you-first-age"
            >{{ ageText(firstRow) }}</span
          >
          <div v-if="firstRow?.kind === 'close'" style="margin-top: 7px">
            <Button
              variant="success"
              :disabled="missions.doorInFlight"
              data-test="mission-close"
              @click="openEnd('delivered')"
            >
              <Check :size="14" :stroke-width="1.8" />{{ $t('mission.close') }}
            </Button>
          </div>
          <div v-if="firstRow?.kind === 'rescope'" style="margin-top: 7px">
            <Button
              variant="primary"
              :disabled="missions.doorInFlight"
              data-test="mission-approve-rescope"
              @click="door({ door: 'approveRescope' })"
            >
              <Check :size="14" :stroke-width="1.8" />{{ $t('mission.approveRescope') }}
            </Button>
          </div>
        </div>
      </div>

      <!-- The rest of the You lane: one row per owed item with its risk dot and age (Amendment d). -->
      <div v-if="restRows.length" style="margin-top: 6px" data-test="mission-you-rest">
        <div
          v-for="(row, i) in restRows"
          :key="i"
          class="flex items-baseline border-t border-border text-text-2 first:border-t-0"
          style="gap: 8px; padding: 5px 0; font-size: 11.5px"
          data-test="mission-you-row"
        >
          <span
            class="shrink-0"
            :class="RISK_CLASS[row.risk]"
            style="font-size: 10px"
            aria-hidden="true"
            >●</span
          >
          <span class="min-w-0 flex-1">{{ rowText(row) }}</span>
          <span
            v-if="ageText(row)"
            class="shrink-0 tabular-nums text-text-4"
            style="font-size: 10.5px"
            data-test="mission-you-age"
            >{{ ageText(row) }}</span
          >
        </div>
      </div>

      <!-- The ledger tail (Amendment c): the last rows Harnu wrote, newest first. -->
      <div v-if="model.ledgerTail.length" style="margin-top: 12px" data-test="mission-ledger">
        <div
          class="uppercase text-text-4"
          style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em; margin-bottom: 5px"
        >
          {{ $t('mission.ledger.label') }}
        </div>
        <div
          v-for="(r, i) in model.ledgerTail"
          :key="`${r.at}-${i}`"
          class="flex items-baseline text-text-3"
          style="gap: 8px; padding: 2px 0; font-size: 11px"
          data-test="mission-ledger-row"
        >
          <span class="shrink-0">{{ $t(`mission.ledger.kind.${r.kind}`) }}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-text-2" style="font-size: 10.5px">{{
            r.ref
          }}</span>
          <span class="shrink-0 tabular-nums text-text-4" style="font-size: 10.5px">{{
            ledgerAge(r.at)
          }}</span>
        </div>
      </div>

      <div v-if="view.mission.openQuestions.length" style="margin-top: 12px">
        <div
          class="uppercase text-text-4"
          style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em; margin-bottom: 5px"
        >
          {{ $t('mission.openQuestions') }}
        </div>
        <ul
          class="list-disc text-text-3"
          style="margin: 0; padding-left: 15px; font-size: 11.5px; line-height: 1.65"
        >
          <li v-for="(q, i) in view.mission.openQuestions" :key="i">{{ q }}</li>
        </ul>
      </div>
    </div>

    <!-- The end door (Mission v3 §3.5): any non-closed mission, any time. -->
    <div class="flex shrink-0 justify-end border-t border-border" style="padding: 8px 14px">
      <Button
        variant="ghost"
        :disabled="missions.doorInFlight"
        data-test="mission-end-open"
        @click="openEnd('delivered')"
      >
        <Flag :size="14" :stroke-width="1.8" />{{ $t('mission.end.open') }}
      </Button>
    </div>

    <MissionCloseConfirmDialog
      v-if="confirmingClose"
      :title="view.title"
      :busy="missions.doorInFlight"
      :warnings="endWarnings(view)"
      :initial="endChoice"
      @cancel="confirmingClose = false"
      @confirm="confirmClose"
    />
  </div>
</template>
