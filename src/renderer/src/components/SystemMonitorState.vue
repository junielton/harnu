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
const props = defineProps<{
  row: SessionSample
  companion: CompanionState | null
  /**
   * Table mode: the cluster lives on ONE fixed-height line, so it may never wrap or
   * overflow. The chip and the mod cell truncate (full text in the tooltip), and the
   * sweep note drops to its icon in a table narrower than ~960px. A card keeps its
   * footer, which wraps.
   */
  compact?: boolean
}>()
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
/** The chip's full text — also its tooltip, since a compact chip can truncate. */
const chipText = computed(
  () => props.row.reason + (showIdle.value ? ' · ' + formatIdle(props.row.idleMs) : '')
)
/** What may shrink in compact mode; in a card nothing does (the footer wraps instead). */
const shrinkable = computed(() => (props.compact ? 'min-w-0 truncate' : 'shrink-0'))
</script>

<template>
  <span class="inline-flex items-center gap-2" :class="compact ? 'min-w-0' : 'shrink-0'">
    <span
      class="inline-flex shrink-0 items-center gap-1.5 text-[11px]"
      :class="live ? 'text-green' : 'text-text-3'"
    >
      <span class="h-1.5 w-1.5 rounded-full" :class="live ? 'bg-green' : 'bg-text-4'" />
      {{ live ? t('systemMonitor.stateLive') : t('systemMonitor.stateParked') }}
    </span>
    <span
      v-if="showReasonChip"
      class="inline-flex h-[17px] items-center rounded-sm bg-surface-2 px-1.5 font-mono text-[10.5px] text-text-3"
      :class="shrinkable"
      :title="chipText"
      data-testid="reason-chip"
      >{{ chipText }}</span
    >
  </span>
  <span
    v-if="showNextSweep"
    class="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-warning"
    :title="compact ? t('systemMonitor.nextSweep') : undefined"
    data-testid="next-sweep"
  >
    <Moon :size="11" :stroke-width="1.8" />
    <span :class="compact ? '@max-[960px]:sr-only' : ''">{{ t('systemMonitor.nextSweep') }}</span>
  </span>
  <span
    v-if="modCell"
    class="text-[11px]"
    :class="[shrinkable, modQuiet ? 'text-text-4' : 'text-text-3']"
    :title="modCell.title ?? modCell.text"
    data-testid="mod-cell"
    >{{ modCell.text }}</span
  >
</template>
