<script setup lang="ts">
/**
 * Merge batch dialog (T609, campaign ch.5b — design.md §6 "Mission progress" → Merge batch; mockup
 * `v6--campaign` state `merge-batch`; campaign spec §4). The operator confirms "merge #A → #B → #C in
 * order"; Harnu merges ONE, lets the steward rebase the rest and re-check the gates, STOPS on any red and
 * asks again. No MCP verb reaches this door.
 *
 * Self-contained: it runs the door itself (`missions.runMergeBatch`) so both popovers just mount it.
 * Three phases — confirm (the ordered list, Cancel focused), running (a batch waits on the steward and on
 * CI between merges and can take minutes), and stopped (why, what merged, what is left, and a "Merge the
 * rest…" confirm — nothing more merges until the operator answers). A clean run closes the dialog.
 *
 * The End dialog's anatomy: Teleport, overlay fade, fade-in-scale card, focus trap, Esc/backdrop cancel.
 * The backdrop carries `data-mission-close-confirm` so the pill's click-outside leaves the popover open.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitMerge, TriangleAlert, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import { useMissionsStore } from '../stores/missions'
import { useUiStore } from '../stores/ui'
import type { MergeReadyPr } from '../lib/mission-view'
import type { MergeBatchOutcome } from '../../../main/merge-batch-core'
import Button from './ui/Button.vue'
import MissionStepGlyph from './MissionStepGlyph.vue'

const props = defineProps<{ root: string; missionId: string; prs: MergeReadyPr[] }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const missions = useMissionsStore()
const ui = useUiStore()

/** The outcome of the last run when it stopped; `null` before a run and after a clean one. */
const stopped = ref<MergeBatchOutcome | null>(null)
/** The PRs the next confirm merges: all of them first, then what a stop left. */
const pending = computed<MergeReadyPr[]>(() => {
  if (!stopped.value) return props.prs
  const left = new Set(stopped.value.remaining)
  return props.prs.filter((p) => left.has(p.number))
})
const mergedNumbers = computed(() => new Set(stopped.value?.merged ?? []))
/** Every PR the dialog draws: the ones already merged (done glyph) and the ones still to merge. */
const shown = computed<MergeReadyPr[]>(() =>
  stopped.value
    ? props.prs.filter((p) => mergedNumbers.value.has(p.number) || pending.value.includes(p))
    : props.prs
)
const busy = computed(() => missions.mergeBatchInFlight)

const list = (ns: readonly number[]): string => ns.map((n) => `#${n}`).join(' → ')

const stopTitle = computed(() =>
  stopped.value?.stop ? t('mission.mergeBatch.stoppedAt', { pr: stopped.value.stop.at }) : ''
)
const stopReason = computed(() => {
  const s = stopped.value?.stop
  if (!s) return ''
  return t(`mission.mergeBatch.reason.${s.reason}`, { pr: s.at, detail: s.detail })
})

async function onConfirm(): Promise<void> {
  const numbers = pending.value.map((p) => p.number)
  const res = await missions.runMergeBatch({
    root: props.root,
    missionId: props.missionId,
    prs: numbers
  })
  if (!res.ok) return // the store toasted the refusal; the dialog stays so the operator can retry or cancel
  if (res.outcome.stop) {
    // Merge what the previous runs already merged into the picture, so "Merged:" is the whole batch's.
    stopped.value = {
      ...res.outcome,
      merged: [...(stopped.value?.merged ?? []), ...res.outcome.merged]
    }
    return
  }
  ui.pushToast({
    kind: 'success',
    title: t('mission.mergeBatch.done', {
      n: (stopped.value?.merged.length ?? 0) + res.outcome.merged.length
    })
  })
  emit('close')
}

const dialogRef = ref<HTMLElement | null>(null)
const cancelRef = ref<InstanceType<typeof Button> | null>(null)
/** Initial focus is Cancel — the dialog exists to stop a stray click: merging is irreversible. */
const cancelEl = computed<HTMLElement | null>(() => (cancelRef.value?.$el as HTMLElement) ?? null)
useFocusTrap({ active: computed(() => true), containerRef: dialogRef, initialFocusRef: cancelEl })

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget && !busy.value) emit('close')
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    if (!busy.value) emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      data-mission-close-confirm
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(480px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-batch-title"
        data-test="merge-batch-dialog"
        data-dsqa="merge-dialog"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="merge-batch-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            data-test="merge-batch-title"
          >
            {{ t('mission.mergeBatch.title', { n: props.prs.length }) }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="t('mission.mergeBatch.dismiss')"
            :disabled="busy"
            @click="emit('close')"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div
          class="scrollable overflow-y-auto text-text-2"
          style="padding: 14px 18px; font-size: 12.5px; line-height: 19px"
        >
          <div class="flex items-start" style="gap: 8px">
            <MissionStepGlyph visual="running" :label="t('mission.visual.running')" />
            <i18n-t keypath="mission.mergeBatch.who" tag="span" scope="global">
              <template #steward
                ><b class="text-text">{{ t('mission.mergeBatch.stewardWord') }}</b></template
              >
            </i18n-t>
          </div>

          <ol class="m-0 list-none p-0" style="margin-top: 10px">
            <template v-for="(p, i) in shown" :key="p.number">
              <li
                v-if="i > 0"
                class="flex items-center text-text-3"
                style="gap: 6px; padding: 5px 0 5px 3px"
                data-test="merge-batch-between"
              >
                <span
                  class="shrink-0 rounded-full bg-text-4"
                  style="width: 6px; height: 6px"
                  aria-hidden="true"
                />
                <span
                  v-for="chip in [
                    t('mission.mergeBatch.rebase', { pr: p.number }),
                    t('mission.mergeBatch.recheck'),
                    t('mission.mergeBatch.stopOnRed')
                  ]"
                  :key="chip"
                  class="rounded-sm border border-border-2 text-text-3"
                  style="padding: 0 6px; font-size: 10.5px; line-height: 17px"
                  >{{ chip }}</span
                >
              </li>
              <li
                class="flex items-center"
                style="gap: 8px; padding: 4px 0"
                data-test="merge-batch-pr"
                :data-pr="p.number"
              >
                <MissionStepGlyph
                  :visual="mergedNumbers.has(p.number) ? 'verified' : 'waiting'"
                  :label="
                    t(
                      mergedNumbers.has(p.number)
                        ? 'mission.visual.verified'
                        : 'mission.visual.waiting'
                    )
                  "
                />
                <b class="font-mono text-text" style="font-weight: 500">#{{ p.number }}</b>
                <span class="min-w-0 flex-1 truncate text-text-2">{{ p.title }}</span>
                <span class="shrink-0 text-text-4" style="font-size: 11px">{{
                  t('mission.mergeBatch.ciGreen')
                }}</span>
              </li>
            </template>
          </ol>

          <p
            v-if="busy"
            class="text-text-3"
            style="margin-top: 10px; font-size: 11.5px"
            data-test="merge-batch-running"
          >
            {{ t('mission.mergeBatch.running') }}
          </p>

          <div
            v-if="stopped?.stop && !busy"
            class="flex items-start rounded-sm border border-warning-line bg-warning-soft text-warning"
            style="
              gap: 6px;
              margin-top: 10px;
              padding: 8px 10px;
              font-size: 11.5px;
              line-height: 1.5;
            "
            data-test="merge-batch-stop"
          >
            <TriangleAlert :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
            <div class="min-w-0 flex-1">
              <span
                class="block uppercase opacity-85"
                style="
                  font-size: 9.5px;
                  font-weight: 700;
                  letter-spacing: 0.06em;
                  margin-bottom: 3px;
                "
                >{{ stopTitle }}</span
              >
              <span class="block" style="font-weight: 500">{{ stopReason }}</span>
              <span
                v-if="stopped.merged.length"
                class="block text-text-3"
                style="font-size: 11px"
                >{{ t('mission.mergeBatch.merged', { list: list(stopped.merged) }) }}</span
              >
              <span class="block text-text-3" style="font-size: 11px">{{
                t('mission.mergeBatch.remaining', { list: list(stopped.remaining) })
              }}</span>
            </div>
          </div>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <Button
            ref="cancelRef"
            variant="ghost"
            :disabled="busy"
            data-test="merge-batch-cancel"
            @click="emit('close')"
          >
            {{ t(stopped ? 'mission.mergeBatch.close' : 'mission.mergeBatch.cancel') }}
          </Button>
          <Button
            variant="primary"
            :disabled="busy || pending.length === 0"
            data-test="merge-batch-go"
            @click="onConfirm"
          >
            <GitMerge :size="14" :stroke-width="1.8" />{{
              busy
                ? t('mission.mergeBatch.merging')
                : stopped
                  ? t('mission.mergeBatch.mergeRest')
                  : t('mission.mergeBatch.confirm', { n: pending.length })
            }}
          </Button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
