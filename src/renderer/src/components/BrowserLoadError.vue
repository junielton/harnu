<script setup lang="ts">
/**
 * The load error page of a browser tab (browser-tabs spec S-3, design.md §6 "Browser pane" → "Load-error page"): drawn
 * by Harnu in the pane's host `<div>` while a tab's main-frame load has failed and its native view is hidden. It owns
 * no logic: main decides when a load failed and polls for "Reload when it is up"; this only draws the record main
 * sent and relays the two buttons.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RotateCw, Unplug } from 'lucide-vue-next'
import {
  loadErrorKind,
  loadErrorTarget,
  type BrowserTabLoadError
} from '../../../shared/browser-tabs'

const props = defineProps<{
  loadError: BrowserTabLoadError
  /** "Reload when it is up" is polling for this tab. */
  waitingForUp: boolean
}>()
const emit = defineEmits<{
  reload: []
  /** `true` starts the poll, `false` cancels it (the second click). */
  reloadWhenUp: [on: boolean]
}>()

const { t } = useI18n()

const kind = computed(() => loadErrorKind(props.loadError.code, props.loadError.local))
const params = computed(() => ({
  host: props.loadError.host,
  port: props.loadError.port ?? ''
}))
const title = computed(() => t(`browserPane.loadError.${kind.value}.title`, params.value))
const hint = computed(() => t(`browserPane.loadError.${kind.value}.hint`, params.value))
const target = computed(() => loadErrorTarget(props.loadError))

const buttonBase =
  'inline-flex h-6 items-center gap-[5px] rounded-sm border px-2.5 text-[11.5px] transition-colors focus-visible:border-accent-line focus-visible:outline-none'
</script>

<template>
  <div
    class="mx-auto flex h-full max-w-110 flex-col items-start justify-center gap-1.5 px-8"
    role="alert"
    data-testid="browser-load-error"
  >
    <Unplug :size="22" :stroke-width="1.5" class="mb-1.5 text-text-3" aria-hidden="true" />
    <div class="text-[15px] font-semibold text-text" data-testid="browser-load-error-title">
      {{ title }}
    </div>
    <div class="text-[12px] leading-normal text-text-2" data-testid="browser-load-error-hint">
      {{ hint }}
    </div>
    <code class="font-mono text-[10.5px] text-text-4" data-testid="browser-load-error-code">{{
      loadError.code
    }}</code>
    <div class="mt-2.5 flex flex-wrap gap-1.5">
      <button
        type="button"
        :class="[buttonBase, 'border-accent bg-accent text-accent-ink']"
        data-testid="browser-load-error-reload"
        @click="emit('reload')"
      >
        <RotateCw :size="12" :stroke-width="1.5" aria-hidden="true" />
        {{ $t('browserPane.loadError.reload') }}
      </button>
      <button
        v-if="loadError.local"
        type="button"
        :class="[buttonBase, 'border-border-2 text-text-2 hover:bg-surface-2 hover:text-text']"
        :aria-pressed="waitingForUp"
        data-testid="browser-load-error-when-up"
        @click="emit('reloadWhenUp', !waitingForUp)"
      >
        {{
          waitingForUp
            ? $t('browserPane.loadError.waiting', { target })
            : $t('browserPane.loadError.reloadWhenUp')
        }}
      </button>
    </div>
  </div>
</template>
