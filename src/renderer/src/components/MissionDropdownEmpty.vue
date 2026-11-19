<script setup lang="ts">
/**
 * Mission dropdown — the states with no mission to draw (Missions v4 mission dropdown S-5; design.md §6 "Mission
 * dropdown" → "Empty state"; mockup `docs/design/mission-dropdown/`, screen `mission-dropdown`, state `empty`).
 *
 * Three states, one component, all inside the dropdown's body:
 * - `loading`: the first answer has not come yet — one quiet line;
 * - `refused`: the view could not read the mission — the words, the server's reason and Retry;
 * - `none`: the session is in no open mission — the `target` glyph, "This session has no mission.", the picker
 *   of the folder's open missions (Attach asks first, in place; "Start a new mission" writes no record, it puts
 *   one instruction into the session's prompt) and, under the picker, "See a sample mission".
 *
 * It computes nothing about a mission: the rows are what `lib/mission-pane-view.ts` built from the server's
 * answer, a door goes through the store (which reads the view again after every reply), and a door that fails
 * says what to do next, never its code. A request to join this session is answered here too: only the operator
 * decides, and a session with no mission has no card to carry it. The sample link opens the sample in place; the
 * strip that says it is made up, with its state chooser and the way out, is the dropdown's.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Link, Plus, Target } from 'lucide-vue-next'
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

/** A request to join a mission: the id the door takes and the title the sentence quotes. */
export interface EmptyRequestRow {
  requestId: string
  missionId: string
  missionTitle: string
  /** The session that asked, or `null` when it is the session the dropdown follows. */
  askerId: string | null
}

const props = defineProps<{
  kind: 'loading' | 'none' | 'refused'
  /** The session the dropdown follows: the one an Attach attaches and Start a new mission writes to. */
  sessionId: string | null
  /** The folder's open missions. */
  picker?: PickerRow[]
  requests?: EmptyRequestRow[]
  /** The server's reason for a refused read. */
  refusal?: string
  /** The sample is not showing: its link is drawn. */
  sampleLink?: boolean
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
  () => props.picker?.find((m) => m.id === confirming.value)?.title ?? ''
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
  if (busy.value || !props.sessionId) return
  busy.value = true
  attachError.value = null
  try {
    const res = await store.runV4DoorOn(missionId, { door: 'attach', sessionId: props.sessionId })
    if (res.ok) confirming.value = null
    else attachError.value = t(`missionDropdown.empty.error.${attachErrorKey(res.code)}`)
  } finally {
    busy.value = false
  }
}
function startMission(): void {
  if (!props.sessionId) return
  startState.value = writeIntoSession(
    { isLive: sessions.isSessionLive, write: writeToSession },
    props.sessionId,
    NEW_MISSION_INSTRUCTION
  )
}

// ---- a request to join --------------------------------------------------------------------------------
const deciding = ref<string | null>(null)
const requestNote = ref<{ kind: 'info' | 'error'; text: string } | null>(null)
async function decide(row: EmptyRequestRow, decision: 'allowed' | 'denied'): Promise<void> {
  if (deciding.value) return
  deciding.value = row.requestId
  requestNote.value = null
  try {
    const res = await store.runV4DoorOn(row.missionId, {
      door: 'decideAttach',
      requestId: row.requestId,
      decision
    })
    if (!res.ok) requestNote.value = { kind: 'error', text: t('missionDropdown.next.error') }
    else if (!res.changed)
      requestNote.value = { kind: 'info', text: t('missionDropdown.next.already') }
  } finally {
    deciding.value = null
  }
}

/** The compact button (design.md §6 "Mission dropdown"): `h-5`, `px-2`, `11px`; never the large one. */
const BTN =
  'inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border px-2 text-[11px] font-medium leading-none transition disabled:cursor-not-allowed disabled:opacity-40'
const BTN_PRIMARY = 'border-accent bg-accent text-accent-ink hover:brightness-110'
const BTN_SOFT = 'border-border-2 bg-surface-2 text-text hover:border-text-4'
const BTN_GHOST = 'border-transparent text-text-3 hover:bg-surface-2 hover:text-text'
</script>

<template>
  <div
    v-if="kind === 'loading'"
    class="text-text-3"
    style="padding: 14px; font-size: 12px"
    data-test="mission-loading"
  >
    {{ $t('missionDropdown.empty.loading') }}
  </div>

  <!-- A refusal: the words, the server's reason and Retry (the empty layout, centred). -->
  <div
    v-else-if="kind === 'refused'"
    class="flex flex-col items-center text-center text-text-3"
    style="padding: 28px 18px 18px; gap: 8px; font-size: 12.5px; line-height: 1.5"
    data-test="mission-refused"
  >
    <Target
      :size="14"
      :stroke-width="1.6"
      class="text-text-4"
      data-glyph="target"
      aria-hidden="true"
    />
    <b class="text-text" style="font-weight: 500">{{ $t('missionDropdown.empty.refusedTitle') }}</b>
    <span
      v-if="refusal"
      class="break-words font-mono text-text-3"
      style="font-size: 11.5px"
      data-test="refused-reason"
      >{{ refusal }}</span
    >
    <span class="rounded-sm">
      <button
        type="button"
        :class="[BTN, BTN_SOFT]"
        data-test="refused-retry"
        @click="store.refreshV4()"
      >
        {{ $t('missionDropdown.empty.retry') }}
      </button>
    </span>
  </div>

  <!-- No mission: the glyph and the sentence, then the picker, then the sample link. -->
  <div v-else class="flex flex-col" data-test="mission-none">
    <div
      class="flex flex-col items-center text-center text-text-4"
      style="padding: 28px 18px 14px; gap: 8px"
    >
      <Target :size="14" :stroke-width="1.6" data-glyph="target" aria-hidden="true" />
      <b class="text-text" style="font-size: 12.5px; font-weight: 500">{{
        $t('missionDropdown.empty.title')
      }}</b>
    </div>

    <div class="flex flex-col text-left" style="padding: 0 14px 14px; gap: 8px">
      <!-- A request to join this session: only the operator answers it. -->
      <section
        v-for="r in requests ?? []"
        :key="r.requestId"
        class="flex flex-col rounded border border-accent-line bg-accent-soft text-text"
        style="padding: 10px 12px; gap: 6px; font-size: 12.5px; line-height: 1.45"
        data-test="attach-request"
      >
        <span
          class="uppercase text-accent"
          style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
          >{{ $t('missionDropdown.next.requestEyebrow') }}</span
        >
        <span class="break-words [overflow-wrap:anywhere]">{{
          $t('missionDropdown.next.requestText', {
            session:
              r.askerId === null
                ? $t('missionDropdown.empty.requestThisSession')
                : nameOf(r.askerId),
            mission: r.missionTitle
          })
        }}</span>
        <span class="flex flex-wrap rounded-sm" style="gap: 6px">
          <button
            type="button"
            :class="[BTN, BTN_PRIMARY]"
            :disabled="deciding !== null"
            data-test="attach-allow"
            @click="decide(r, 'allowed')"
          >
            {{ $t('missionDropdown.next.allow') }}
          </button>
          <button
            type="button"
            :class="[BTN, BTN_GHOST]"
            :disabled="deciding !== null"
            data-test="attach-deny"
            @click="decide(r, 'denied')"
          >
            {{ $t('missionDropdown.next.deny') }}
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

      <!-- The picker: the folder's open missions, and a way to start a new one. A request waiting for an
           answer is the whole state; the picker comes back once it is answered. -->
      <section
        v-if="(requests ?? []).length === 0 && picker"
        class="flex flex-col"
        style="gap: 6px"
        data-test="attach-picker"
      >
        <span
          v-if="picker.length > 0"
          class="uppercase text-text-4"
          style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
          >{{ $t('missionDropdown.empty.pickerTitle') }}</span
        >
        <span
          v-else
          class="text-text-3"
          style="font-size: 12px; line-height: 1.45"
          data-test="attach-empty"
          >{{ $t('missionDropdown.empty.none') }}</span
        >

        <div
          v-for="(m, i) in picker"
          :key="m.id"
          class="rounded border border-border text-text"
          style="padding: 9px 10px; font-size: 12.5px"
          data-test="attach-row"
          :data-mission="m.id"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center @max-[300px]:grid-cols-1"
            style="gap: 2px 10px"
          >
            <span class="[overflow-wrap:anywhere]">{{ m.title }}</span>
            <span class="col-start-1 [overflow-wrap:anywhere] text-text-4" style="font-size: 10.5px"
              >{{ translateHeadline(t, m.headline) }} ·
              {{
                m.leaderId
                  ? $t('missionDropdown.empty.ledBy', { name: nameOf(m.leaderId) })
                  : $t('missionDropdown.empty.unled')
              }}</span
            >
            <span
              v-if="confirming !== m.id"
              class="col-start-2 row-span-2 row-start-1 rounded-sm @max-[300px]:col-start-1 @max-[300px]:row-span-1 @max-[300px]:row-start-3 @max-[300px]:justify-self-start"
            >
              <button
                type="button"
                :class="[BTN, BTN_SOFT]"
                data-test="attach-open"
                :data-autofocus="i === 0 ? '' : undefined"
                @click="askAttach(m.id)"
              >
                <Link :size="10" :stroke-width="1.6" aria-hidden="true" />{{
                  $t('missionDropdown.empty.attach')
                }}
              </button>
            </span>
          </div>

          <!-- Attach asks first: nothing is written until the second Attach. -->
          <div
            v-if="confirming === m.id"
            class="flex flex-col border-t border-border"
            style="margin-top: 8px; padding-top: 8px; gap: 8px"
            data-test="attach-confirm"
          >
            <span class="[overflow-wrap:anywhere]" style="font-size: 12px; line-height: 1.45">{{
              $t('missionDropdown.empty.confirm.text', { title: confirmTitle })
            }}</span>
            <span class="flex flex-wrap rounded-sm" style="gap: 6px">
              <button
                type="button"
                :class="[BTN, BTN_GHOST]"
                :disabled="busy"
                data-test="attach-cancel"
                @click="cancelAttach"
              >
                {{ $t('missionDropdown.empty.confirm.cancel') }}
              </button>
              <button
                type="button"
                :class="[BTN, BTN_PRIMARY]"
                :disabled="busy"
                data-test="attach-confirm-yes"
                @click="confirmAttach(m.id)"
              >
                {{ $t('missionDropdown.empty.confirm.yes') }}
              </button>
            </span>
          </div>
        </div>

        <span
          v-if="attachError"
          class="break-words rounded-sm border border-red-line bg-red-soft text-text"
          style="padding: 6px 8px; font-size: 11.5px; line-height: 1.4"
          role="alert"
          data-test="attach-error"
          >{{ attachError }}</span
        >

        <!-- It writes no record: the session makes the mission, once the operator agrees what done means. -->
        <span class="self-start rounded-sm">
          <button
            type="button"
            :class="[BTN, BTN_GHOST]"
            data-test="attach-start"
            @click="startMission"
          >
            <Plus :size="10" :stroke-width="1.6" aria-hidden="true" />{{
              $t('missionDropdown.empty.start')
            }}
          </button>
        </span>
        <span
          v-if="startState === 'sent'"
          class="break-words text-text-3"
          style="font-size: 11.5px; line-height: 1.4"
          role="status"
          data-test="attach-start-done"
          >{{ $t('missionDropdown.empty.startDone') }}</span
        >
        <span
          v-else-if="startState === 'not-running'"
          class="break-words rounded-sm border border-red-line bg-red-soft text-text"
          style="padding: 6px 8px; font-size: 11.5px; line-height: 1.4"
          role="alert"
          data-test="attach-start-error"
          >{{ $t('missionDropdown.empty.startError') }}</span
        >
      </section>

      <!-- The sample shows every state of the dropdown with made-up data, whether or not a mission exists. -->
      <span v-if="sampleLink" class="self-start rounded-sm" style="margin-top: 2px">
        <button
          type="button"
          class="text-accent transition hover:underline"
          style="font-size: 12px; font-weight: 500"
          data-test="mission-sample-open"
          @click="store.showSample('default')"
        >
          {{ $t('missionDropdown.empty.sampleOpen') }}
        </button>
      </span>
    </div>
  </div>
</template>
