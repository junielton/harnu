<script setup lang="ts">
/**
 * Mission dropdown — Ask on a milestone (Missions v4 mission dropdown S-3; design.md §6 "Mission dropdown" →
 * "What it draws" 3; mockup `docs/design/mission-dropdown/`, state `ask`). The same box the Mission pane had.
 *
 * The operator types a question and it goes to the session that LEADS the mission, into its prompt, the way
 * "Reference in session" does: through the writer bus, no Enter (the operator sends it in that session, and the
 * answer shows there, never here). It writes no record. A leader that is not running gets nothing, and the
 * question stays in the box so it can be sent once that session runs again.
 *
 * Drawn under the milestone's summary line by `MissionDropdownTree.vue`. The textarea takes focus when the box
 * opens (`data-autofocus`, the mockup's), so the operator types at once.
 */
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Send } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import { writeToSession } from '../lib/terminal-bus'
import { askMessage, sessionNameOf, writeIntoSession } from '../lib/mission-pane-view'

const props = defineProps<{
  milestoneTitle: string
  /** The session that leads the mission now: where the question goes. */
  leaderId: string
}>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const sessions = useSessionsStore()

const inputId = `mission-ask-${useId()}`
const input = ref<HTMLTextAreaElement | null>(null)
const question = ref('')
const state = ref<'idle' | 'done' | 'not-running'>('idle')

const leaderName = computed(() => sessionNameOf(props.leaderId, sessions.allSessions, t))
const canSend = computed(() => question.value.trim() !== '')

onMounted(() => input.value?.focus())

function send(): void {
  if (!canSend.value) return
  state.value =
    writeIntoSession(
      { isLive: sessions.isSessionLive, write: writeToSession },
      props.leaderId,
      askMessage(props.milestoneTitle, question.value)
    ) === 'sent'
      ? 'done'
      : 'not-running'
}

/** The compact button (design.md §6 "Mission dropdown"): `h-5`, `px-2`, `11px`; never the large one. */
const BTN =
  'inline-flex h-5 items-center justify-center gap-1 whitespace-nowrap rounded-sm border px-2 text-[11px] font-medium leading-none transition disabled:cursor-not-allowed disabled:opacity-40'
const BTN_GHOST = 'border-transparent bg-transparent text-text-3 hover:bg-surface-2 hover:text-text'
const BTN_PRIMARY = 'border-accent bg-accent text-accent-ink hover:brightness-110'
const BTN_SOFT = 'border-border-2 bg-surface-2 text-text hover:border-text-4'
</script>

<template>
  <div class="flex flex-col" style="gap: 6px; margin: 2px 0 6px" data-test="ask-box">
    <template v-if="state !== 'done'">
      <label :for="inputId" class="text-text-3" style="font-size: 11px">{{
        $t('missionDropdown.ask.label', { title: milestoneTitle })
      }}</label>
      <!-- One box: the wrapper owns the border and the fill, the textarea sits flush inside it, and focus
           shows as the box's border turning accent (`:focus-within`), so there is no box inside a box. -->
      <div class="rounded-sm border border-border-2 bg-bg transition focus-within:border-accent">
        <textarea
          :id="inputId"
          ref="input"
          v-model="question"
          rows="2"
          class="no-default-ring block w-full resize-none border-0 bg-transparent text-text outline-none placeholder:text-text-4"
          style="font-size: 12px; padding: 6px 8px; min-height: 52px"
          :placeholder="$t('missionDropdown.ask.placeholder')"
          data-test="ask-input"
          data-autofocus
          @input="state = 'idle'"
        />
      </div>
      <span
        v-if="state === 'not-running'"
        class="break-words text-red"
        style="font-size: 11px; line-height: 1.4"
        role="alert"
        data-test="ask-error"
        >{{ $t('missionDropdown.ask.notRunning', { name: leaderName }) }}</span
      >
      <span class="text-text-4" style="font-size: 10.5px" data-test="ask-hint">{{
        $t('missionDropdown.ask.hint', { name: leaderName })
      }}</span>
      <div class="flex justify-end rounded-sm" style="gap: 6px">
        <button
          type="button"
          :class="[BTN, BTN_GHOST]"
          data-test="ask-cancel"
          @click="emit('close')"
        >
          {{ $t('missionDropdown.ask.cancel') }}
        </button>
        <button
          type="button"
          :class="[BTN, BTN_PRIMARY]"
          :disabled="!canSend"
          data-test="ask-send"
          @click="send"
        >
          <Send :size="10" :stroke-width="2" aria-hidden="true" />{{
            $t('missionDropdown.ask.send')
          }}
        </button>
      </div>
    </template>
    <template v-else>
      <span
        class="break-words text-text"
        style="font-size: 12px; line-height: 1.45"
        role="status"
        data-test="ask-done"
        >{{ $t('missionDropdown.ask.done', { name: leaderName }) }}</span
      >
      <div class="flex rounded-sm">
        <button type="button" :class="[BTN, BTN_SOFT]" data-test="ask-close" @click="emit('close')">
          {{ $t('missionDropdown.ask.close') }}
        </button>
      </div>
    </template>
  </div>
</template>
