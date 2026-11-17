<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link, Plus } from 'lucide-vue-next'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { writeToSession } from '../lib/terminal-bus'
import {
  NEW_MISSION_INSTRUCTION,
  attachErrorKey,
  sessionNameOf,
  translateHeadline,
  writeIntoSession,
  type PickerRow
} from '../lib/mission-pane-view'

/**
 * Attach and the attach request of the Mission pane (Missions v4 S-21, design.md §6 "Mission pane" →
 * Attach, the attach request and Ask). Two jobs, one component:
 *
 * - the PICKER of a session with no mission: the folder's open missions with "Attach", and "Start a new
 *   mission". Attaching asks for confirmation first and goes through the `attach` door; "Start a new
 *   mission" writes no record, it puts one instruction into the session's prompt (no Enter) the way Ask and
 *   "Reference in session" do;
 * - a REQUEST to join, with Allow and Deny: a session asked to join a mission. The operator alone decides;
 *   the doors are `decideAttach`. The request may name this very session (its pane has no mission) or
 *   another one (the pane of a session already in the mission).
 *
 * It computes nothing about the mission: the rows and the requests are what `lib/mission-pane-view.ts`
 * built from the server's answer, the doors go through the store, and the store reads the view again after
 * every reply. A door that fails says what to do next, never its code.
 */
export interface RequestRow {
  requestId: string
  /** The mission it asks to join: the id the door takes and the title the sentence quotes. */
  missionId: string
  missionTitle: string
  /** The session that asked, or `null` when it is the session the pane follows. */
  askerId: string | null
}

const props = defineProps<{
  /** The session the pane follows: the one an Attach attaches and Start a new mission writes to. */
  sessionId: string
  /** The folder's open missions; `null` draws no picker (a pane that only shows requests). */
  missions?: PickerRow[] | null
  requests?: RequestRow[]
}>()

const { t } = useI18n()
const store = useMissionsStore()
const sessions = useSessionsStore()

const nameOf = (id: string): string => sessionNameOf(id, sessions.allSessions, t)

// ---- the picker ---------------------------------------------------------------------------------------
const confirming = ref<string | null>(null)
const busy = ref(false)
const attachError = ref<string | null>(null)
const startState = ref<'sent' | 'not-running' | null>(null)

const confirmTitle = computed(
  () => props.missions?.find((m) => m.id === confirming.value)?.title ?? ''
)

function askAttach(id: string): void {
  attachError.value = null
  startState.value = null
  confirming.value = id
}
function cancelAttach(): void {
  confirming.value = null
  attachError.value = null
}
async function confirmAttach(missionId: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  attachError.value = null
  try {
    const res = await store.runV4DoorOn(missionId, { door: 'attach', sessionId: props.sessionId })
    if (res.ok) confirming.value = null
    else attachError.value = t(`missionPane.attach.error.${attachErrorKey(res.code)}`)
  } finally {
    busy.value = false
  }
}

function startMission(): void {
  startState.value = writeIntoSession(
    { isLive: sessions.isSessionLive, write: writeToSession },
    props.sessionId,
    NEW_MISSION_INSTRUCTION
  )
}

// ---- a request to join --------------------------------------------------------------------------------
const deciding = ref<string | null>(null)
const requestNote = ref<{ kind: 'info' | 'error'; text: string } | null>(null)

async function decide(row: RequestRow, decision: 'allowed' | 'denied'): Promise<void> {
  if (deciding.value) return
  deciding.value = row.requestId
  requestNote.value = null
  try {
    const res = await store.runV4DoorOn(row.missionId, {
      door: 'decideAttach',
      requestId: row.requestId,
      decision
    })
    if (!res.ok) {
      requestNote.value = {
        kind: 'error',
        text: t(`missionPane.attach.request.error.${attachErrorKey(res.code)}`)
      }
    } else if (!res.changed) {
      requestNote.value = { kind: 'info', text: t('missionPane.attach.request.already') }
    }
  } finally {
    deciding.value = null
  }
}

/** The dense pill of the pane (design.md §6 "Mission pane" → Sessions and the hand-off). */
const PILL =
  'inline-flex items-center whitespace-nowrap rounded-sm transition disabled:cursor-not-allowed disabled:opacity-40'
const PILL_STYLE = 'height: 20px; padding: 0 7px; gap: 4px; font-size: 11px; font-weight: 500'
const PILL_SOFT = `${PILL} border border-border-2 bg-surface-2 text-text hover:border-text-4`
const PILL_PRIMARY = `${PILL} bg-accent text-accent-ink hover:brightness-110`
const PILL_GHOST = `${PILL} text-text-3 hover:bg-surface-2 hover:text-text`
</script>

<template>
  <div class="flex flex-col text-left" style="gap: 14px" data-test="attach">
    <!-- A request to join: only the operator answers it. -->
    <section
      v-for="r in requests ?? []"
      :key="r.requestId"
      class="flex flex-col rounded border border-accent-line bg-accent-soft text-text"
      style="padding: 12px; gap: 8px; font-size: 12.5px; line-height: 1.45"
      data-test="attach-request"
      :data-request="r.requestId"
    >
      <span
        class="uppercase text-accent"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        >{{ $t('missionPane.attach.request.eyebrow') }}</span
      >
      <span class="break-words">{{
        r.askerId === null
          ? $t('missionPane.attach.request.thisSession', { mission: r.missionTitle })
          : $t('missionPane.attach.request.otherSession', {
              session: nameOf(r.askerId),
              mission: r.missionTitle
            })
      }}</span>
      <span class="flex flex-wrap" style="gap: 6px">
        <button
          type="button"
          :class="PILL_PRIMARY"
          :style="PILL_STYLE"
          :disabled="deciding !== null"
          data-test="attach-allow"
          @click="decide(r, 'allowed')"
        >
          {{ $t('missionPane.attach.request.allow') }}
        </button>
        <button
          type="button"
          :class="PILL_GHOST"
          :style="PILL_STYLE"
          :disabled="deciding !== null"
          data-test="attach-deny"
          @click="decide(r, 'denied')"
        >
          {{ $t('missionPane.attach.request.deny') }}
        </button>
      </span>
    </section>
    <span
      v-if="requestNote"
      class="break-words"
      :class="requestNote.kind === 'error' ? 'text-red' : 'text-text-3'"
      style="font-size: 11.5px; line-height: 1.4"
      :role="requestNote.kind === 'error' ? 'alert' : 'status'"
      data-test="attach-request-note"
      >{{ requestNote.text }}</span
    >

    <!-- The picker: the folder's open missions, and a way to start a new one. -->
    <section v-if="missions" class="flex flex-col" style="gap: 6px" data-test="attach-picker">
      <span
        v-if="missions.length > 0"
        class="uppercase text-text-4"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        >{{ $t('missionPane.attach.pickerTitle') }}</span
      >
      <span
        v-else
        class="text-text-3"
        style="font-size: 12px; line-height: 1.45"
        data-test="attach-empty"
        >{{ $t('missionPane.attach.empty') }}</span
      >

      <div
        v-for="m in missions"
        :key="m.id"
        class="@container rounded border border-border text-text"
        style="padding: 9px 10px; font-size: 12.5px"
        data-test="attach-row"
        :data-mission="m.id"
      >
        <div
          class="grid grid-cols-[minmax(0,1fr)_auto] items-center @max-[300px]:grid-cols-1"
          style="gap: 2px 10px"
        >
          <span class="break-words">{{ m.title }}</span>
          <span class="col-start-1 break-words text-text-4" style="font-size: 10.5px"
            >{{ translateHeadline(t, m.headline) }} ·
            {{
              m.leaderId
                ? $t('missionPane.attach.ledBy', { name: nameOf(m.leaderId) })
                : $t('missionPane.attach.unled')
            }}</span
          >
          <button
            v-if="confirming !== m.id"
            type="button"
            :class="`${PILL_SOFT} col-start-2 row-span-2 row-start-1 @max-[300px]:col-start-1 @max-[300px]:row-span-1 @max-[300px]:row-start-3 @max-[300px]:justify-self-start`"
            :style="PILL_STYLE"
            data-test="attach-open"
            @click="askAttach(m.id)"
          >
            <Link :size="10" :stroke-width="1.6" />{{ $t('missionPane.attach.attach') }}
          </button>
        </div>

        <!-- Attach asks first: nothing is written until the second Attach. -->
        <div
          v-if="confirming === m.id"
          class="flex flex-col border-t border-border"
          style="margin-top: 8px; padding-top: 8px; gap: 8px"
          data-test="attach-confirm"
        >
          <span class="break-words" style="font-size: 12px; line-height: 1.45">{{
            $t('missionPane.attach.confirm.text', { title: confirmTitle })
          }}</span>
          <span class="flex flex-wrap" style="gap: 6px">
            <button
              type="button"
              :class="PILL_GHOST"
              :style="PILL_STYLE"
              :disabled="busy"
              data-test="attach-cancel"
              @click="cancelAttach"
            >
              {{ $t('missionPane.attach.confirm.cancel') }}
            </button>
            <button
              type="button"
              :class="PILL_PRIMARY"
              :style="PILL_STYLE"
              :disabled="busy"
              data-test="attach-confirm-yes"
              @click="confirmAttach(m.id)"
            >
              {{ $t('missionPane.attach.confirm.yes') }}
            </button>
          </span>
        </div>
      </div>

      <!-- Under the list, not inside a row: a mission that is gone leaves the list, and its row with it. -->
      <span
        v-if="attachError"
        class="break-words rounded-sm border border-red-line bg-red-soft text-text"
        style="padding: 6px 8px; font-size: 11.5px; line-height: 1.4"
        role="alert"
        data-test="attach-error"
        >{{ attachError }}</span
      >

      <!-- It writes no record: the session makes the mission, once the operator agrees what done means. -->
      <button
        type="button"
        :class="`${PILL_GHOST} self-start`"
        :style="PILL_STYLE"
        data-test="attach-start"
        @click="startMission"
      >
        <Plus :size="10" :stroke-width="1.6" />{{ $t('missionPane.attach.start') }}
      </button>
      <span
        v-if="startState === 'sent'"
        class="break-words text-text-3"
        style="font-size: 11.5px; line-height: 1.4"
        role="status"
        data-test="attach-start-done"
        >{{ $t('missionPane.attach.startDone') }}</span
      >
      <span
        v-else-if="startState === 'not-running'"
        class="break-words rounded-sm border border-red-line bg-red-soft text-text"
        style="padding: 6px 8px; font-size: 11.5px; line-height: 1.4"
        role="alert"
        data-test="attach-start-error"
        >{{ $t('missionPane.attach.startError') }}</span
      >
    </section>
  </div>
</template>
