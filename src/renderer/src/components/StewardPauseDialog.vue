<script setup lang="ts">
/**
 * Pause steward dialog (T609, campaign ch.5b — design.md §6 "Mission progress" → Pause steward
 * dialog; campaign spec §3.4). "Pause steward…" is a MISSION door, not a worker switch, and it takes a
 * mandatory reason: the Pause button stays disabled while the field is blank. The reason goes to the
 * mission's Log (a `steward` entry) and onto the You list ("Steward paused {age}: {reason}") until the
 * operator resumes.
 *
 * The End dialog's anatomy: Teleport → overlay-fade backdrop → fade-in-scale card, focus trap, Esc +
 * backdrop close. Initial focus is the reason field — the one thing the dialog needs. The backdrop
 * carries `data-mission-close-confirm` so the pill's click-outside leaves the popover open behind it.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pause, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import Button from './ui/Button.vue'

defineProps<{ busy: boolean }>()
const emit = defineEmits<{ cancel: []; confirm: [reason: string] }>()

const { t } = useI18n()
const reason = ref('')
const reasonRef = ref<HTMLTextAreaElement | null>(null)
const canConfirm = computed(() => reason.value.trim() !== '')

function onConfirm(): void {
  if (canConfirm.value) emit('confirm', reason.value.trim())
}

const dialogRef = ref<HTMLElement | null>(null)
useFocusTrap({ active: computed(() => true), containerRef: dialogRef, initialFocusRef: reasonRef })

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) emit('cancel')
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('cancel')
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
          width: min(440px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="steward-pause-title"
        data-test="steward-pause-dialog"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="steward-pause-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ t('mission.steward.pauseDialog.title') }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="t('mission.steward.pauseDialog.dismiss')"
            :disabled="busy"
            @click="emit('cancel')"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div class="text-text-2" style="padding: 14px 18px; font-size: 12.5px; line-height: 19px">
          <p>{{ t('mission.steward.pauseDialog.body') }}</p>
          <label class="block" style="margin-top: 10px">
            <span class="block text-text-3" style="font-size: 11px; margin-bottom: 4px">{{
              t('mission.steward.pauseDialog.reason')
            }}</span>
            <textarea
              ref="reasonRef"
              v-model="reason"
              rows="2"
              maxlength="500"
              required
              class="w-full resize-none rounded-sm border border-border-2 bg-bg text-text outline-none focus:border-accent-line"
              style="padding: 6px 8px; font-size: 12px; line-height: 17px"
              :placeholder="t('mission.steward.pauseDialog.reasonPlaceholder')"
              :disabled="busy"
              data-test="steward-pause-reason"
            />
          </label>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <Button
            variant="ghost"
            :disabled="busy"
            data-test="steward-pause-cancel"
            @click="emit('cancel')"
          >
            {{ t('mission.steward.pauseDialog.cancel') }}
          </Button>
          <Button
            variant="primary"
            :disabled="busy || !canConfirm"
            data-test="steward-pause-go"
            @click="onConfirm"
          >
            <Pause :size="14" :stroke-width="1.8" />{{ t('mission.steward.pauseDialog.confirm') }}
          </Button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
