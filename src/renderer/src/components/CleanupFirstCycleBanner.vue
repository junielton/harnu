<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Recycle } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import { formatBytes } from './system-monitor-format'

/**
 * First-cycle prompt (design.md "Workspace GC — unified Cleanup / First-cycle banner"). Holds the
 * screen's one Primary button, so the hero turns Soft while this is up. The button is the
 * operator's informed consent: the sub-line states what the next cycle will clean (`cleanCount`,
 * `cleanBytes`, `when`) before it turns cleaning on. With the autopilot already on (turned on in
 * Settings, so it has only reported) the same button reads "Allow cleaning".
 */
defineProps<{
  count: number
  bytes: number
  cleanCount: number
  cleanBytes: number
  /** The per-cycle cap (`maxItemsPerCycle`): the count above is today's, the cap is the bound. */
  maxItems: number
  /** Time until the next timer tick ("58 min"), or null when none is scheduled. */
  when: string | null
  autopilotOn?: boolean
  /**
   * Days of build cache the Docker housekeeping would prune, or null when it would not run (the
   * Docker category is off, or Docker did not answer). The acknowledgement turns it on too, so
   * the banner must say so.
   */
  dockerDays?: number | null
  pending?: boolean
}>()
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
      <div class="text-body font-medium leading-5 text-text">
        {{
          t(autopilotOn ? 'cleanup.gc.firstCycle.titleOn' : 'cleanup.gc.firstCycle.title', count, {
            named: { n: count, size: formatBytes(bytes) }
          })
        }}
      </div>
      <div class="text-caption leading-4 text-text-3" data-testid="first-cycle-sub">
        <template v-if="autopilotOn">{{ t('cleanup.gc.firstCycle.onlyReported') }}&nbsp;</template>
        {{
          t(
            `cleanup.gc.firstCycle.${autopilotOn ? 'allowWillClean' : 'willClean'}${when ? '' : 'Unscheduled'}`,
            cleanCount,
            { named: { n: cleanCount, size: formatBytes(cleanBytes), max: maxItems, when } }
          )
        }}
        <template v-if="dockerDays != null">
          {{ t('cleanup.gc.firstCycle.dockerPrune', dockerDays, { named: { n: dockerDays } }) }}
        </template>
      </div>
    </div>
    <Button
      variant="primary"
      :disabled="pending"
      data-testid="first-enable"
      @click="emit('enable')"
    >
      {{ t(autopilotOn ? 'cleanup.gc.firstCycle.allow' : 'cleanup.gc.firstCycle.enable') }}
    </Button>
    <Button
      variant="ghost"
      :disabled="pending"
      data-testid="first-dismiss"
      @click="emit('dismiss')"
    >
      {{ t('cleanup.gc.firstCycle.dismiss') }}
    </Button>
  </div>
</template>
