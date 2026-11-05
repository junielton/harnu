<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy, Info } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { useFocusTrap } from '../composables/useFocusTrap'
import { POOL_ADVICE_SNIPPET } from '../lib/docker-card-view'

/**
 * The one-time address-pool advice (design.md "Address-pool advice dialog", U3.7): a copyable
 * `default-address-pools` snippet for `/etc/docker/daemon.json`, the restart note and the VPN/LAN
 * clash note. Harnu never edits that file. Opened only from the Docker card's callout; Dismiss (and
 * Esc, which closes only this dialog) records that the advice was seen for these pools.
 */
defineProps<{ free: number; total: number }>()
const emit = defineEmits<{ dismiss: [] }>()
const { t } = useI18n()

const FILE = '/etc/docker/daemon.json'
const RESTART = 'sudo systemctl restart docker'

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(POOL_ADVICE_SNIPPET)
  } catch {
    return // clipboard unavailable: the snippet stays selectable on screen
  }
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => (copied.value = false), 2000)
}

const dialogRef = ref<HTMLElement | null>(null)
const dismissEl = ref<HTMLElement | null>(null)
function setDismiss(c: Element | ComponentPublicInstance | null): void {
  dismissEl.value = c ? ((c as ComponentPublicInstance).$el ?? (c as Element)) : null
}
useFocusTrap({ active: computed(() => true), containerRef: dialogRef, initialFocusRef: dismissEl })

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('dismiss')
  }
}
window.addEventListener('keydown', onKeydown, true)
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  if (copiedTimer) clearTimeout(copiedTimer)
})
function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) emit('dismiss')
}
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 flex items-start justify-center overflow-y-auto pt-18"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale mb-6 flex w-120 max-w-[90vw] flex-col rounded-lg border border-border-2 bg-surface text-text shadow-pop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pool-advice-title"
        data-testid="pool-advice-dialog"
        @mousedown.stop
      >
        <header class="flex flex-col gap-0.5 px-5 pb-2 pt-4">
          <span class="text-eyebrow uppercase text-text-4">{{
            t('cleanup.gc.docker.pool.eyebrow')
          }}</span>
          <span id="pool-advice-title" class="text-subtitle font-medium">{{
            t('cleanup.gc.docker.pool.title')
          }}</span>
        </header>

        <div class="flex flex-col gap-3 px-5 pb-3">
          <p class="m-0 text-ui text-text-2">
            {{ t('cleanup.gc.docker.pool.intro', { total, free }) }}
          </p>

          <ol class="m-0 flex list-none flex-col gap-3 p-0">
            <li class="flex gap-2.5">
              <span class="mt-0.5 text-caption font-medium tabular-nums text-text-4">1</span>
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div class="text-ui text-text">
                  {{ t('cleanup.gc.docker.pool.step1', { file: FILE }) }}
                </div>
                <div class="text-caption leading-4 text-text-3">
                  {{ t('cleanup.gc.docker.pool.step1Hint') }}
                </div>
                <div
                  class="flex items-start gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2"
                  data-testid="pool-advice-snippet"
                >
                  <pre
                    class="m-0 min-w-0 flex-1 overflow-x-auto font-mono text-caption text-text-2"
                    >{{ POOL_ADVICE_SNIPPET }}</pre>
                  <Button
                    :variant="copied ? 'success' : 'soft'"
                    data-testid="pool-advice-copy"
                    @click="copy"
                  >
                    <component :is="copied ? Check : Copy" :size="12" :stroke-width="1.7" />
                    {{
                      copied ? t('cleanup.gc.docker.pool.copied') : t('cleanup.gc.docker.pool.copy')
                    }}
                  </Button>
                </div>
                <div class="text-caption text-text-4">{{ t('cleanup.gc.docker.pool.size') }}</div>
              </div>
            </li>
            <li class="flex gap-2.5">
              <span class="mt-0.5 text-caption font-medium tabular-nums text-text-4">2</span>
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div class="text-ui text-text">{{ t('cleanup.gc.docker.pool.step2') }}</div>
                <div class="text-caption leading-4 text-text-3">
                  {{ t('cleanup.gc.docker.pool.step2Hint', { command: RESTART }) }}
                </div>
              </div>
            </li>
          </ol>

          <div
            class="flex items-start gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2 text-caption text-text-3"
            role="note"
            data-testid="pool-advice-note"
          >
            <Info :size="12" :stroke-width="1.7" class="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{{ t('cleanup.gc.docker.pool.note') }}</span>
          </div>
        </div>

        <footer class="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button
            :ref="setDismiss"
            variant="ghost"
            data-testid="pool-advice-dismiss"
            @click="emit('dismiss')"
          >
            {{ t('cleanup.gc.docker.pool.dismiss') }}
          </Button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
