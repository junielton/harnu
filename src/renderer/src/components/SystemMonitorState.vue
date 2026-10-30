<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Moon } from 'lucide-vue-next'
import type { CompanionState } from '../../../main/companion/companion-state-core'
import { monitorCell } from '../lib/companion-view'
import { formatIdle, isNoteworthyLiveReason } from './system-monitor-format'
import type { SessionSample } from '../../../preload'

/**
 * The state cluster of one session (design.md "System Monitor (takeover)"): the state
 * pip, the reason chip (+ idle time for a hibernation candidate), the "next to be swept"
 * note and the Harnu mod cell. Shared by the card footer and the table's State column.
 *
 * Quiet by rule: the Harnu mod cell is never `--warning`/`--red` (`legacy` is a fact, not
 * a fault), and a parked session shows no mod cell and no sweep note.
 */
const props = defineProps<{ row: SessionSample; companion: CompanionState | null }>()
const { t } = useI18n()

const live = computed(() => props.row.state === 'live')
/** A live row's reason is only worth a chip when it names a hibernation candidate. */
const showReasonChip = computed(() =>
  live.value ? isNoteworthyLiveReason(props.row.reason) : !!props.row.reason
)
const showIdle = computed(() => live.value && props.row.idleMs > 0)
const showNextSweep = computed(() => live.value && props.row.sweepRank === 1)
const modCell = computed(() => (live.value ? monitorCell(props.companion, t) : null))
const modQuiet = computed(() => props.companion?.state !== 'live')
</script>

<template>
  <span class="inline-flex shrink-0 items-center gap-2">
    <span
      class="inline-flex shrink-0 items-center gap-1.5 text-[11px]"
      :class="live ? 'text-green' : 'text-text-3'"
    >
      <span class="h-1.5 w-1.5 rounded-full" :class="live ? 'bg-green' : 'bg-text-4'" />
      {{ live ? t('systemMonitor.stateLive') : t('systemMonitor.stateParked') }}
    </span>
    <span
      v-if="showReasonChip"
      class="inline-flex h-[17px] shrink-0 items-center rounded-sm bg-surface-2 px-1.5 font-mono text-[10.5px] text-text-3"
      data-testid="reason-chip"
      >{{ row.reason }}<template v-if="showIdle"> · {{ formatIdle(row.idleMs) }}</template></span
    >
  </span>
  <span
    v-if="showNextSweep"
    class="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-warning"
    data-testid="next-sweep"
  >
    <Moon :size="11" :stroke-width="1.8" />{{ t('systemMonitor.nextSweep') }}
  </span>
  <span
    v-if="modCell"
    class="shrink-0 text-[11px]"
    :class="modQuiet ? 'text-text-4' : 'text-text-3'"
    :title="modCell.title"
    data-testid="mod-cell"
    >{{ modCell.text }}</span
  >
</template>
