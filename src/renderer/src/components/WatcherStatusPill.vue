<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'

// finding 02 §3 — surface ENOSPC / EMFILE / EACCES from the main-process
// chokidar watcher as a discrete sidebar-footer pill. Hidden when the watcher
// is healthy.
//
// T-1.6 is in flight in parallel and will expose `watcherStatus` on the store
// with the shape `{ degraded: boolean; code?: 'ENOSPC' | 'EMFILE' | 'EACCES'
// | 'OTHER'; message?: string }`. Until it lands we read defensively.
type WatcherCode = 'ENOSPC' | 'EMFILE' | 'EACCES' | 'OTHER'

interface WatcherStatus {
  degraded: boolean
  code?: WatcherCode
  message?: string
}

const sessions = useSessionsStore()
const { t } = useI18n()

// TODO(T-1.6): proper type once store exposes watcherStatus
const status = computed<WatcherStatus>(
  () =>
    (sessions as unknown as { watcherStatus?: WatcherStatus }).watcherStatus ?? { degraded: false }
)

const codeLabel = computed(() => {
  const code: WatcherCode = status.value.code ?? 'OTHER'
  return t(`watcher.codeLabel.${code}`)
})

const tooltip = computed(() => status.value.message ?? codeLabel.value)
</script>

<template>
  <span
    v-if="status.degraded"
    class="inline-flex items-center gap-1.5 border border-border bg-surface text-warning"
    style="padding: 2px 8px; border-radius: 999px; font-size: 10.5px; font-weight: 500"
    :title="tooltip"
    role="status"
    :aria-label="$t('watcher.title') + ': ' + codeLabel"
  >
    <AlertTriangle :size="11" :stroke-width="1.6" />
    <span>{{ $t('watcher.title') }}: {{ codeLabel }}</span>
  </span>
</template>
