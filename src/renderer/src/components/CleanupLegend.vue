<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleHelp, Lock } from 'lucide-vue-next'

/**
 * The legend row under the split bar (design.md "Workspace GC — unified Cleanup / Page anatomy" 5): the
 * three buckets as icon + word + a short gloss in the bucket's ink — a bucket is never colour alone —
 * and, pushed right, what a block's area means. Without disk sizes there is no area to explain.
 */
defineProps<{ hasBytes: boolean }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption"
    role="group"
    :aria-label="t('cleanup.gc.legend.label')"
    data-testid="legend"
  >
    <span class="inline-flex items-center gap-1.5 text-green" data-testid="legend-ready">
      <CircleCheck :size="12" :stroke-width="1.7" aria-hidden="true" />{{
        t('cleanup.gc.legend.ready')
      }}
    </span>
    <span class="inline-flex items-center gap-1.5 text-warning" data-testid="legend-review">
      <CircleHelp :size="12" :stroke-width="1.7" aria-hidden="true" />{{
        t('cleanup.gc.legend.review')
      }}
    </span>
    <span class="inline-flex items-center gap-1.5 text-text-3" data-testid="legend-in-use">
      <Lock :size="12" :stroke-width="1.7" aria-hidden="true" />{{ t('cleanup.gc.legend.inUse') }}
    </span>
    <span v-if="hasBytes" class="ml-auto text-text-3" data-testid="legend-area">{{
      t('cleanup.gc.legend.area')
    }}</span>
  </div>
</template>
