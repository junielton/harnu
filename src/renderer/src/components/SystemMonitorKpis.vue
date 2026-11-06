<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Cpu, MemoryStick, Moon } from 'lucide-vue-next'
import { formatBytes, formatPct1, type MonitorTotals } from './system-monitor-format'

/**
 * The KPI strip of the System Monitor (design.md "System Monitor (takeover)" → "KPI
 * strip"): Total RAM with a Harnu / sessions split bar, CPU with the process count,
 * and the live / parked counts with what parking reclaimed. Every number comes from
 * `monitorTotals` — this component only lays it out.
 */
defineProps<{ totals: MonitorTotals }>()
const { t } = useI18n()
</script>

<template>
  <div class="grid grid-cols-[1.4fr_1fr_1.2fr] gap-2.5" data-testid="monitor-kpis">
    <div
      class="flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-border bg-sidebar px-3 py-2.5"
    >
      <div class="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-text-4">
        <MemoryStick :size="12" :stroke-width="1.8" />{{ t('systemMonitor.kpi.totalRam') }}
      </div>
      <div
        class="font-mono text-[22px] font-semibold leading-tight tracking-tight whitespace-nowrap"
        data-testid="kpi-ram"
      >
        {{ formatBytes(totals.totalBytes) }}
      </div>
      <div class="flex h-1.5 gap-0.5 overflow-hidden rounded-[3px]" data-testid="kpi-split">
        <i
          class="block h-full bg-[color-mix(in_srgb,var(--color-text-4)_45%,var(--color-surface))]"
          :style="{ width: `${totals.harnuSharePct}%` }"
        />
        <i
          class="block h-full bg-accent"
          :style="{ width: `${totals.totalBytes > 0 ? 100 - totals.harnuSharePct : 0}%` }"
        />
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-3">
        <span class="inline-flex items-center gap-1 whitespace-nowrap">
          <span
            class="inline-block h-2 w-2 rounded-[2px] bg-[color-mix(in_srgb,var(--color-text-4)_45%,var(--color-surface))]"
          />{{ t('systemMonitor.kpi.ramHarnu', { size: formatBytes(totals.harnuBytes) }) }}
        </span>
        <span class="inline-flex items-center gap-1 whitespace-nowrap">
          <span class="inline-block h-2 w-2 rounded-[2px] bg-accent" />{{
            t('systemMonitor.kpi.ramSessions', { size: formatBytes(totals.sessionsBytes) })
          }}
        </span>
      </div>
    </div>

    <div
      class="flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-border bg-sidebar px-3 py-2.5"
    >
      <div class="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-text-4">
        <Cpu :size="12" :stroke-width="1.8" />{{ t('systemMonitor.kpi.cpu') }}
      </div>
      <div
        class="font-mono text-[22px] font-semibold leading-tight tracking-tight whitespace-nowrap"
        data-testid="kpi-cpu"
      >
        {{ formatPct1(totals.cpuPct) }}
      </div>
      <div class="text-[11px] text-text-3">
        {{ t('systemMonitor.kpi.cpuAcross', { count: totals.processCount }) }}
      </div>
    </div>

    <div
      class="flex flex-col gap-1.5 rounded-[var(--radius-lg)] border border-border bg-sidebar px-3 py-2.5"
    >
      <div class="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-text-4">
        <Moon :size="12" :stroke-width="1.8" />{{ t('systemMonitor.kpi.sessions') }}
      </div>
      <div
        class="font-mono text-[22px] font-semibold leading-tight tracking-tight whitespace-nowrap"
        data-testid="kpi-sessions"
      >
        {{ totals.live }}
        <small class="font-sans text-[11px] font-normal tracking-normal text-text-3">{{
          t('systemMonitor.kpi.live')
        }}</small>
        · {{ totals.parked }}
        <small class="font-sans text-[11px] font-normal tracking-normal text-text-3">{{
          t('systemMonitor.kpi.parked')
        }}</small>
      </div>
      <div
        v-if="totals.reclaimedBytes !== null"
        class="text-[11px] text-green"
        data-testid="kpi-reclaimed"
      >
        {{ t('systemMonitor.kpi.reclaimed', { size: formatBytes(totals.reclaimedBytes) }) }}
      </div>
    </div>
  </div>
</template>
