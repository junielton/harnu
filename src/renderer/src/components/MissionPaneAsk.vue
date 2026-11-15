<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { writeToSession } from '../lib/terminal-bus'
import { askMessage, sessionNameOf, writeIntoSession } from '../lib/mission-pane-view'

/**
 * Ask on a milestone (Missions v4 S-21, design.md §6 "Mission pane" → Attach, the attach request and Ask).
 * The operator types a question and it goes to the session that LEADS the mission, into its prompt, the way
 * "Reference in session" does: through the writer bus, no Enter (the operator sends it in that session, and
 * the answer shows there, never here). It writes no record. A leader that is not running gets nothing, and
 * the question stays in the box.
 */
const props = defineProps<{
  milestoneTitle: string
  /** The session that leads the mission now: where the question goes. */
  leaderId: string
}>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const sessions = useSessionsStore()

const question = ref('')
const state = ref<'idle' | 'done' | 'not-running'>('idle')

const leaderName = computed(() => sessionNameOf(props.leaderId, sessions.allSessions, t))
const canSend = computed(() => question.value.trim() !== '')

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
</script>

<template>
  <div
    class="flex flex-col rounded border border-accent-line bg-bg"
    style="margin: 4px 0 8px; padding: 8px 10px; gap: 8px"
    data-test="ask-box"
  >
    <template v-if="state !== 'done'">
      <textarea
        v-model="question"
        rows="2"
        class="w-full resize-none border-0 bg-transparent p-0 text-text outline-none placeholder:text-text-4"
        style="font-size: 12.5px; line-height: 1.4"
        :placeholder="$t('missionPane.ask.placeholder')"
        :aria-label="$t('missionPane.ask.label', { title: milestoneTitle })"
        data-test="ask-input"
        @input="state = 'idle'"
      />
      <span
        v-if="state === 'not-running'"
        class="break-words text-red"
        style="font-size: 11.5px; line-height: 1.4"
        role="alert"
        data-test="ask-error"
        >{{ $t('missionPane.ask.notRunning', { name: leaderName }) }}</span
      >
      <div class="flex flex-wrap items-center text-text-4" style="gap: 8px; font-size: 10.5px">
        <span class="min-w-0 flex-1 break-words">{{
          $t('missionPane.ask.hint', { name: leaderName })
        }}</span>
        <span class="ml-auto flex" style="gap: 6px">
          <button
            type="button"
            class="inline-flex items-center whitespace-nowrap rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="height: 20px; padding: 0 7px; font-size: 11px; font-weight: 500"
            data-test="ask-cancel"
            @click="emit('close')"
          >
            {{ $t('missionPane.ask.cancel') }}
          </button>
          <button
            type="button"
            class="inline-flex items-center whitespace-nowrap rounded-sm bg-accent text-accent-ink transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            style="height: 20px; padding: 0 7px; font-size: 11px; font-weight: 500"
            :disabled="!canSend"
            data-test="ask-send"
            @click="send"
          >
            {{ $t('missionPane.ask.send') }}
          </button>
        </span>
      </div>
    </template>
    <template v-else>
      <span
        class="break-words text-text"
        style="font-size: 12px; line-height: 1.45"
        role="status"
        data-test="ask-done"
        >{{ $t('missionPane.ask.done', { name: leaderName }) }}</span
      >
      <span class="flex">
        <button
          type="button"
          class="inline-flex items-center whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 text-text transition hover:border-text-4"
          style="height: 20px; padding: 0 7px; font-size: 11px; font-weight: 500"
          data-test="ask-close"
          @click="emit('close')"
        >
          {{ $t('missionPane.ask.close') }}
        </button>
      </span>
    </template>
  </div>
</template>
