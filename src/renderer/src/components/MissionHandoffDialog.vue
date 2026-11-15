<script setup lang="ts">
import { computed } from 'vue'
import { ArrowLeftRight, Loader2 } from 'lucide-vue-next'
import { parseSummary } from '../lib/mission-pane-view'
import Dialog from './ui/Dialog.vue'

/**
 * "Continue this mission in a new session" (Missions v4 S-20, design.md §6 "Mission pane" → Sessions and
 * the hand-off). The operator always decides a hand-off: Harnu may notice and offer, and this dialog is
 * where the operator confirms. It says in three lines what happens, shows the summary the new session
 * starts with (so the operator can judge whether it is enough to start cold), and starts nothing itself:
 * `confirm` is the only path to the door, and the owner calls it.
 *
 * The door waits up to 90 seconds for the new session to appear, so there is a pending state: the dialog
 * stays open, the buttons are off and a second press starts nothing. A refusal stays in the dialog as
 * words that say what to do next (never the code), with the buttons back. After a hand-off that took
 * effect, the dialog says the new session leads and offers to open it.
 *
 * Controlled, on the `Dialog` shell: it never closes itself.
 */
const props = defineProps<{
  open: boolean
  /** The server's mission summary: the text the new session starts with. */
  brief: string
  /** The door is waiting. */
  pending: boolean
  /** The `missionPane.handoff.error` key that says what went wrong, or `null`. */
  errorKey: string | null
  /** The hand-off took effect. */
  done: boolean
  /** The new session is loaded in the sidebar, so it can be opened from here. */
  canOpenNew: boolean
}>()
const emit = defineEmits<{ cancel: []; confirm: []; close: []; openNew: [] }>()

const parsed = computed(() => parseSummary(props.brief))

function onDialogClose(): void {
  // A dialog that is waiting for the door is not dismissible (the shell ignores it); this runs for the rest.
  if (props.done) emit('close')
  else emit('cancel')
}
</script>

<template>
  <Dialog
    :open="open"
    size="md"
    :title="$t('missionPane.handoff.title')"
    :dismissible="!pending"
    initial-focus="[data-test='handoff-cancel'], [data-test='handoff-close']"
    data-test="handoff-dialog"
    @close="onDialogClose"
  >
    <!-- It took effect: the mission is the new session's. -->
    <div
      v-if="done"
      class="flex flex-col text-text-2"
      style="gap: 6px; font-size: 12.5px; line-height: 1.5"
      data-test="handoff-done"
    >
      <b class="text-text" style="font-weight: 500">{{ $t('missionPane.handoff.done.title') }}</b>
      <span>{{ $t('missionPane.handoff.done.body') }}</span>
    </div>

    <div
      v-else
      class="flex flex-col text-text-2"
      style="gap: 12px; font-size: 12.5px; line-height: 1.5"
    >
      <ol class="m-0 flex flex-col" style="padding-left: 18px; gap: 4px">
        <li data-test="handoff-step">{{ $t('missionPane.handoff.steps.one') }}</li>
        <li data-test="handoff-step">{{ $t('missionPane.handoff.steps.two') }}</li>
        <li data-test="handoff-step">{{ $t('missionPane.handoff.steps.three') }}</li>
      </ol>

      <!-- Above the summary, so a long one can never push what happened out of sight. -->
      <!-- The door waits for the new session to appear, up to 90 seconds. -->
      <div
        v-if="pending"
        class="flex items-start rounded border border-accent-line bg-accent-soft text-text"
        style="gap: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.45"
        role="status"
        data-test="handoff-pending"
      >
        <Loader2
          :size="14"
          :stroke-width="1.7"
          class="mt-0.5 shrink-0 animate-spin text-accent"
          aria-hidden="true"
        />
        <span class="min-w-0">
          <b class="block" style="font-weight: 500">{{ $t('missionPane.handoff.pending') }}</b>
          <span class="block text-text-3" style="font-size: 11.5px">{{
            $t('missionPane.handoff.pendingHint')
          }}</span>
        </span>
      </div>

      <!-- It did not happen: what to do next, never the code. -->
      <div
        v-if="errorKey"
        class="rounded border border-red-line bg-red-soft text-text"
        style="padding: 8px 10px; font-size: 12px; line-height: 1.45"
        role="alert"
        data-test="handoff-error"
      >
        {{ $t(`missionPane.handoff.error.${errorKey}`) }}
      </div>

      <!-- The summary the new session starts with: labelled sections, as the server wrote them. -->
      <div
        class="rounded border border-border bg-bg"
        style="padding: 10px 12px; font-size: 12px"
        data-test="handoff-summary"
      >
        <span
          class="block uppercase text-text-4"
          style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em; margin-bottom: 6px"
          >{{ $t('missionPane.handoff.brief.heading') }}</span
        >
        <div
          v-if="parsed.sections.length > 0"
          class="grid"
          style="grid-template-columns: 82px 1fr; gap: 6px 10px"
        >
          <template v-for="s in parsed.sections" :key="s.heading">
            <span class="text-text-4" data-test="handoff-heading">{{ s.heading }}</span>
            <span
              class="min-w-0 whitespace-pre-line break-words"
              data-test="handoff-section"
              :data-heading="s.heading"
              >{{ s.body }}</span
            >
          </template>
        </div>
        <span v-else-if="brief.trim() !== ''" class="block whitespace-pre-line break-words">{{
          brief.trim()
        }}</span>
        <span v-else class="block text-text-3">{{ $t('missionPane.handoff.brief.empty') }}</span>
      </div>
    </div>

    <template #footer>
      <template v-if="done">
        <button
          v-if="canOpenNew"
          type="button"
          class="border border-border bg-transparent text-text-2 transition hover:text-text"
          style="
            padding: 7px 14px;
            font-size: 12.5px;
            font-weight: 500;
            border-radius: 5px;
            height: 28px;
          "
          data-test="handoff-open-new"
          @click="emit('openNew')"
        >
          {{ $t('missionPane.handoff.done.open') }}
        </button>
        <button
          type="button"
          class="bg-accent text-accent-ink transition"
          style="
            padding: 7px 14px;
            font-size: 12.5px;
            font-weight: 500;
            border-radius: 5px;
            border: none;
            height: 28px;
          "
          data-test="handoff-close"
          @click="emit('close')"
        >
          {{ $t('missionPane.handoff.done.close') }}
        </button>
      </template>
      <template v-else>
        <button
          type="button"
          class="border border-border bg-transparent text-text-2 transition hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
          style="
            padding: 7px 14px;
            font-size: 12.5px;
            font-weight: 500;
            border-radius: 5px;
            height: 28px;
          "
          :disabled="pending"
          data-test="handoff-cancel"
          @click="emit('cancel')"
        >
          {{ $t('missionPane.handoff.cancel') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center bg-accent text-accent-ink transition disabled:cursor-not-allowed disabled:opacity-40"
          style="
            padding: 7px 14px;
            gap: 6px;
            font-size: 12.5px;
            font-weight: 500;
            border-radius: 5px;
            border: none;
            height: 28px;
          "
          :disabled="pending"
          data-test="handoff-confirm"
          @click="emit('confirm')"
        >
          <ArrowLeftRight :size="14" :stroke-width="1.7" />{{ $t('missionPane.handoff.confirm') }}
        </button>
      </template>
    </template>
  </Dialog>
</template>
