<script setup lang="ts">
/**
 * Bulk close confirm (BUG-173 S5, spec §3.5 — design.md §6 "Mission progress" →
 * Bulk close confirm). The irreversible step of the Missions review: it lists
 * every mission about to be closed **as delivered**, with the server's
 * `closeWarnings` for each, and takes ONE optional reason for all of them.
 * Warnings are shown, never enforced. There is no Discard here — discarding is
 * a per-mission judgment that stays on the End dialog.
 *
 * Anatomy copied from `MissionCloseConfirmDialog`: Teleport → overlay-fade
 * backdrop → fade-in-scale card, focus trap, Esc + backdrop cancel, initial
 * focus on Cancel, and the confirm chime + OS attention on open — an
 * irreversible decision is never a silent one. The component only asks; the
 * review dialog runs the doors.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, TriangleAlert, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import { playNotificationSound } from '../lib/notification-sound'
import { endWarningHeading, type EndWarning } from '../lib/mission-view'
import Button from './ui/Button.vue'

export interface BulkCloseItem {
  id: string
  title: string
  /** The server's `closeWarnings` as `endWarnings(view)` — step titles, never ids. */
  warnings: EndWarning[]
}

const props = defineProps<{
  items: BulkCloseItem[]
  /** Doors are running: everything is disabled. */
  busy: boolean
  /** Doors answered so far, while `busy`. */
  progress: { done: number; total: number } | null
}>()
const emit = defineEmits<{ cancel: []; confirm: [reason: string] }>()

const { t } = useI18n()

const reason = ref('')
const count = computed(() => props.items.length)

const dialogRef = ref<HTMLElement | null>(null)
const cancelRef = ref<InstanceType<typeof Button> | null>(null)
/** Initial focus is Cancel — the dialog exists to stop a stray click or Enter. */
const cancelEl = computed<HTMLElement | null>(() => (cancelRef.value?.$el as HTMLElement) ?? null)

useFocusTrap({
  active: computed(() => true),
  containerRef: dialogRef,
  initialFocusRef: cancelEl
})

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget && !props.busy) emit('cancel')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    if (!props.busy) emit('cancel')
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown, true)
  try {
    playNotificationSound()
    window.api.requestAttention()
  } catch {
    /* no audio device / IPC teardown — the dialog still guards the door */
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
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
        aria-labelledby="mission-bulk-close-title"
        data-test="bulk-close-confirm"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="mission-bulk-close-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ t('mission.bulk.title', { count }, count) }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="t('mission.bulk.dismiss')"
            :disabled="busy"
            @click="emit('cancel')"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div
          class="scrollable overflow-y-auto text-text-2"
          style="padding: 14px 18px; font-size: 12.5px; line-height: 19px"
        >
          <p>{{ t('mission.bulk.body') }}</p>

          <ul style="margin: 10px 0 0; padding: 0; list-style: none">
            <li
              v-for="item in items"
              :key="item.id"
              class="border-t border-border"
              style="padding: 6px 0"
              data-test="bulk-close-item"
              :data-mission-id="item.id"
            >
              <span class="block truncate text-text" style="font-weight: 500">{{
                item.title
              }}</span>
              <div
                v-if="item.warnings.length"
                class="flex items-start rounded-sm border border-warning-line bg-warning-soft text-warning"
                style="
                  gap: 6px;
                  margin-top: 4px;
                  padding: 6px 8px;
                  font-size: 11.5px;
                  line-height: 1.5;
                "
              >
                <TriangleAlert :size="13" :stroke-width="1.8" class="mt-0.5 shrink-0" />
                <ul class="min-w-0 flex-1" style="margin: 0; padding: 0; list-style: none">
                  <li v-for="w in item.warnings" :key="w.kind" :data-kind="w.kind">
                    <span class="block" style="font-weight: 500">{{
                      endWarningHeading(t, w)
                    }}</span>
                    <span
                      v-for="(line, i) in w.items"
                      :key="i"
                      class="block break-words text-text-3"
                      style="font-size: 11px"
                      >{{ line.step
                      }}<template v-if="line.label"> — {{ line.label }}</template></span
                    >
                  </li>
                </ul>
              </div>
            </li>
          </ul>

          <label class="block" style="margin-top: 10px">
            <span class="block text-text-3" style="font-size: 11px; margin-bottom: 4px">{{
              t('mission.bulk.reason')
            }}</span>
            <textarea
              v-model="reason"
              rows="2"
              maxlength="480"
              class="w-full resize-none rounded-sm border border-border-2 bg-bg text-text outline-none focus:border-accent-line"
              style="padding: 6px 8px; font-size: 12px; line-height: 17px"
              :placeholder="t('mission.bulk.reasonPlaceholder')"
              :disabled="busy"
              data-test="bulk-close-reason"
            />
          </label>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <Button
            ref="cancelRef"
            variant="ghost"
            :disabled="busy"
            data-test="bulk-close-cancel"
            @click="emit('cancel')"
          >
            {{ t('mission.bulk.cancel') }}
          </Button>
          <Button
            variant="success"
            :disabled="busy"
            data-test="bulk-close-go"
            @click="emit('confirm', reason)"
          >
            <Check :size="14" :stroke-width="1.8" />{{
              progress
                ? t('mission.bulk.closing', { done: progress.done, total: progress.total })
                : t('mission.bulk.confirm', { count }, count)
            }}
          </Button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
