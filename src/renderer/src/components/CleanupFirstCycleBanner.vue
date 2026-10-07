<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Recycle } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'

/**
 * First-cycle report-only prompt (design.md "Workspace GC — unified Cleanup / First-cycle banner").
 * Holds the screen's one Primary button, so the hero turns Soft while this is up. Enabling calls
 * `gc:ackFirstReport` and `gc:prefs:set({ autopilot: true })` — the store does both.
 */
defineProps<{ count: number; bytes: number }>()
const emit = defineEmits<{ enable: []; dismiss: [] }>()
const { t } = useI18n()
</script>

<template>
  <div
    role="region"
    :aria-label="t('cleanup.gc.firstCycle.label')"
    class="flex items-center gap-3 rounded border border-accent-line bg-accent-soft px-4 py-3"
    data-testid="first-cycle-banner"
  >
    <Recycle :size="16" :stroke-width="1.6" class="shrink-0 text-accent" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <div class="text-[13px] font-medium leading-5 text-text">
        {{
          t('cleanup.gc.firstCycle.title', count, { named: { n: count, size: formatBytes(bytes) } })
        }}
      </div>
      <div class="text-[11px] leading-4 text-text-3">{{ t('cleanup.gc.firstCycle.sub') }}</div>
    </div>
    <Button variant="primary" data-testid="first-enable" @click="emit('enable')">
      {{ t('cleanup.gc.firstCycle.enable') }}
    </Button>
    <Button variant="ghost" data-testid="first-dismiss" @click="emit('dismiss')">
      {{ t('cleanup.gc.firstCycle.dismiss') }}
    </Button>
  </div>
</template>
