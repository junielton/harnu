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
import { useI18n } from 'vue-i18n'
import { Check, FileText, Flag, TriangleAlert } from 'lucide-vue-next'
import type { MissionDoor, MissionView } from '../../../main/mission-ipc'
import type { MissionLinkSignal, MissionYouItem } from '../../../main/mcp/tool-handlers'
import { endWarnings, headlineText, type EndChoice, type MissionModel } from '../lib/mission-view'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import Button from './ui/Button.vue'
import MissionStepRail from './MissionStepRail.vue'
import MissionCloseConfirmDialog from './MissionCloseConfirmDialog.vue'

const props = defineProps<{ view: MissionView; model: MissionModel }>()

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

/** Step ids as the operator reads them: their titles. */
function stepTitles(ids: readonly string[]): string {
  return ids.map((id) => props.view.mission.steps.find((s) => s.id === id)?.title || id).join(', ')
}

/** One owed item in the operator's words (never the English `mission_get` sentence). */
function youText(item: MissionYouItem): string {
  switch (item.kind) {
    case 'rescope':
      return t('mission.you.rescope', { kind: item.end.kind, target: item.end.target })
    case 'close':
      return t('mission.you.close')
    case 'blocker':
      return t('mission.you.blocker', { reason: item.reason, unblocks: item.unblocks })
    case 'checks':
      return t(
        'mission.you.checks',
        { count: item.count, steps: stepTitles(item.stepIds) },
        item.count
      )
    case 'human-steps':
      return t('mission.you.humanSteps', { steps: stepTitles(item.stepIds) }, item.stepIds.length)
    case 'review-import':
      return t('mission.you.reviewImport')
    case 'approvals':
      return t('mission.you.approvals', { count: item.count, session: sessionName(item.sessionId) })
    case 'needs-input':
      return t('mission.you.needsInput', { session: sessionName(item.sessionId) })
  }
}

const firstYou = computed<MissionYouItem | null>(() => props.view.you[0] ?? null)
const youExpanded = ref(false)

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
</script>

<template>
  <div
    class="anim-fade-in-scale flex flex-col overflow-hidden rounded border border-border-2 bg-surface shadow-pop"
    style="width: 400px; max-height: 560px"
    :data-dsqa="`mission-popover--${model.state}`"
  >
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
            firstYou ? youText(firstYou) : $t('mission.you.clear')
          }}</span>
          <ul
            v-if="youExpanded && view.you.length > 1"
            class="list-disc"
            style="margin: 4px 0 0; padding-left: 15px"
            data-test="mission-you-rest"
          >
            <li v-for="(item, i) in view.you.slice(1)" :key="i">{{ youText(item) }}</li>
          </ul>
          <button
            v-if="view.you.length > 1"
            type="button"
            class="block hover:underline"
            style="margin-top: 3px; font-size: 11px"
            data-test="mission-you-more"
            @click="youExpanded = !youExpanded"
          >
            {{
              youExpanded
                ? $t('mission.you.less')
                : $t('mission.you.more', { n: view.you.length - 1 })
            }}
          </button>
          <div v-if="firstYou?.kind === 'close'" style="margin-top: 7px">
            <Button
              variant="success"
              :disabled="missions.doorInFlight"
              data-test="mission-close"
              @click="openEnd('delivered')"
            >
              <Check :size="14" :stroke-width="1.8" />{{ $t('mission.close') }}
            </Button>
          </div>
          <div v-if="firstYou?.kind === 'rescope'" style="margin-top: 7px">
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
