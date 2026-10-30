<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from 'lucide-vue-next'
import type { HeapSample, ProcSample } from '../../../preload'
import {
  HEAP_CRIT_PCT,
  HEAP_WARN_PCT,
  formatBytes,
  formatPct1,
  heapPercent,
  monitorHeapFillClass,
  monitorHeapTextClass,
  relativePct,
  type MonitorTotals
} from './system-monitor-format'

/**
 * The Harnu sidebar of the System Monitor (design.md "System Monitor (takeover)" →
 * "Left column"): the process count and size, the main-process heap card with its
 * 70% / 85% tick marks, one row per Electron process (a muted bar relative to the
 * largest), and the Harnu + sessions totals line pinned to the bottom.
 */
const props = defineProps<{
  processes: readonly ProcSample[]
  heap: HeapSample | null
  totals: MonitorTotals
}>()
const { t } = useI18n()

const heapPct = computed(() => heapPercent(props.heap))
const fillClass = computed(() => monitorHeapFillClass(props.heap?.status))
const textClass = computed(() => monitorHeapTextClass(props.heap?.status))
const alerting = computed(() => !!props.heap && props.heap.status !== 'ok')
const maxRss = computed(() => Math.max(0, ...props.processes.map((p) => p.rssBytes ?? 0)))
</script>

<template>
  <aside
    class="flex flex-col gap-4 border-r border-border bg-sidebar p-4 max-[1000px]:border-b max-[1000px]:border-r-0"
    data-testid="monitor-sidebar"
  >
    <div class="flex items-center gap-2.5">
      <span class="text-[10.5px] font-semibold uppercase tracking-wide text-text-2">{{
        t('systemMonitor.groupHarnu')
      }}</span>
      <span class="text-[11px] text-text-3">{{
        t('systemMonitor.harnuCount', {
          count: processes.length,
          size: formatBytes(totals.harnuBytes)
        })
      }}</span>
    </div>

    <div
      v-if="heap"
      class="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-border bg-surface px-3.5 py-3"
      data-testid="heap-card"
      :data-status="heap.status"
    >
      <div class="text-[10.5px] uppercase tracking-wide text-text-4">
        {{ t('systemMonitor.heapCardLabel') }}
      </div>
      <div class="flex items-baseline gap-2">
        <span
          class="font-mono text-[30px] font-semibold leading-none tracking-tight"
          :class="textClass"
          data-testid="heap-percent"
          >{{ Math.round(heapPct) }}%</span
        >
        <span
          class="flex items-center gap-1 text-[11px]"
          :class="alerting ? textClass : 'text-text-4'"
        >
          <TriangleAlert
            v-if="alerting"
            :size="11"
            :stroke-width="1.8"
            data-testid="heap-alert-icon"
          />
          {{
            t('systemMonitor.heapOf', {
              used: formatBytes(heap.usedBytes),
              limit: formatBytes(heap.limitBytes)
            })
          }}
        </span>
      </div>
      <div class="relative h-2.5 rounded-full bg-border-2" role="img">
        <span
          class="absolute inset-y-0 left-0 rounded-full"
          :class="fillClass"
          :style="{ width: `${heapPct}%` }"
          data-testid="heap-fill"
        />
        <i
          class="absolute -bottom-[3px] -top-[3px] w-px bg-text-4"
          :style="{ left: `${HEAP_WARN_PCT}%` }"
        />
        <i
          class="absolute -bottom-[3px] -top-[3px] w-px bg-text-4"
          :style="{ left: `${HEAP_CRIT_PCT}%` }"
        />
      </div>
      <div class="relative h-3 font-mono text-[10px] text-text-4">
        <span
          class="absolute -translate-x-full whitespace-nowrap pr-1"
          :style="{ left: `${HEAP_WARN_PCT}%` }"
          >{{ t('systemMonitor.heapTickWarn', { pct: HEAP_WARN_PCT }) }}</span
        >
        <span class="absolute whitespace-nowrap pl-1" :style="{ left: `${HEAP_CRIT_PCT}%` }">{{
          t('systemMonitor.heapTickCrit', { pct: HEAP_CRIT_PCT })
        }}</span>
      </div>
    </div>

    <div v-if="processes.length > 0" data-testid="process-list">
      <div
        v-for="(proc, i) in processes"
        :key="proc.pid"
        class="flex h-[30px] items-center gap-2.5 text-[12px] text-text"
        :class="i > 0 ? 'border-t border-border' : ''"
      >
        <span class="w-[66px] shrink-0 truncate">{{ proc.name }}</span>
        <span class="relative h-1 flex-1 overflow-hidden rounded-sm bg-border-2">
          <span
            class="absolute inset-y-0 left-0 rounded-sm bg-text-4"
            :style="{ width: `${relativePct(proc.rssBytes, maxRss)}%` }"
          />
        </span>
        <span class="w-14 shrink-0 text-right font-mono text-[11.5px] text-text-2">{{
          formatBytes(proc.rssBytes)
        }}</span>
        <span class="w-[38px] shrink-0 text-right font-mono text-[11.5px] text-text-4">{{
          formatPct1(proc.cpuPct)
        }}</span>
      </div>
    </div>
    <div v-else class="py-2 text-[12px] text-text-3">{{ t('systemMonitor.loading') }}</div>

    <div
      class="mt-auto flex justify-between border-t border-border pt-3 text-[11px] text-text-3"
      data-testid="monitor-totals"
    >
      <span>{{ t('systemMonitor.totalsLabel') }}</span>
      <span class="font-mono text-[11.5px] text-text-2">{{
        t('systemMonitor.totalsValue', {
          size: formatBytes(totals.totalBytes),
          cpu: formatPct1(totals.cpuPct)
        })
      }}</span>
    </div>
  </aside>
</template>
