<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from 'lucide-vue-next'
import {
  formatBusyPct,
  formatStallMs,
  offenderTitle,
  stallCountClass,
  totalStalls
} from './system-monitor-format'
import type { StallsSample, ThreadStalls } from '../../../preload'

/**
 * The Responsiveness section of the System Monitor (design.md "Responsiveness section", T697): one
 * card per JavaScript thread a keystroke crosses, with how busy it is, how many tasks over 50 / 100 /
 * 250 ms it ran in the last hour, and who ran the worst of them. All numbers arrive in the
 * `monitor:sample` payload; this component only lays them out.
 */
const props = defineProps<{ stalls: StallsSample | null; sampled: boolean }>()
const { t } = useI18n()

const threads = computed<Array<{ id: 'main' | 'renderer'; label: string; data: ThreadStalls }>>(
  () =>
    props.stalls
      ? [
          { id: 'main', label: t('systemMonitor.stalls.threadMain'), data: props.stalls.main },
          {
            id: 'renderer',
            label: t('systemMonitor.stalls.threadRenderer'),
            data: props.stalls.renderer
          }
        ]
      : []
)
const total = computed(() => totalStalls(props.stalls))
const buckets = [
  { ms: 50 as const, key: 'over50' as const },
  { ms: 100 as const, key: 'over100' as const },
  { ms: 250 as const, key: 'over250' as const }
]
</script>

<template>
  <div class="flex flex-col gap-2.5" data-testid="monitor-stalls">
    <div class="flex items-center gap-2.5">
      <span class="text-[10.5px] font-semibold uppercase tracking-wide text-text-2">{{
        t('systemMonitor.stalls.title')
      }}</span>
      <span v-if="stalls" class="text-[11px] text-text-3" data-testid="stalls-summary">{{
        t('systemMonitor.stalls.summary', { count: total }, total)
      }}</span>
    </div>

    <div v-if="!stalls && sampled" class="text-[11.5px] text-text-3" data-testid="stalls-off">
      {{ t('systemMonitor.stalls.off') }}
    </div>

    <div v-else class="grid grid-cols-2 gap-3 @max-[700px]:grid-cols-1">
      <div
        v-for="th in threads"
        :key="th.id"
        class="flex min-w-0 flex-col gap-2.5 rounded-[var(--radius-lg)] border border-border bg-sidebar px-3.5 py-3"
        :data-testid="`stalls-${th.id}`"
      >
        <div class="flex items-start gap-2">
          <span class="text-[13px] font-semibold">{{ th.label }}</span>
          <span class="flex-1" />
          <div class="flex flex-col items-end">
            <span
              class="font-mono text-[22px] font-semibold leading-tight tracking-tight whitespace-nowrap"
              :title="th.data.busyApprox ? t('systemMonitor.stalls.busyApproxHint') : undefined"
              data-testid="stalls-busy"
              >{{ formatBusyPct(th.data.busyPct, th.data.busyApprox) }}</span
            >
            <span class="text-[10.5px] uppercase tracking-wide text-text-4">{{
              t('systemMonitor.stalls.busy')
            }}</span>
          </div>
        </div>

        <div class="grid grid-cols-3 gap-2">
          <div v-for="b in buckets" :key="b.key" class="flex flex-col">
            <span
              class="font-mono text-[15px] font-semibold"
              :class="stallCountClass(b.ms, th.data[b.key])"
              :data-testid="`stalls-${b.key}`"
              >{{ th.data[b.key] }}</span
            >
            <span class="text-[10.5px] text-text-4">{{ t(`systemMonitor.stalls.${b.key}`) }}</span>
          </div>
        </div>

        <div class="flex flex-col border-t border-border pt-2">
          <span class="pb-1 text-[10.5px] uppercase tracking-wide text-text-4">{{
            t('systemMonitor.stalls.offenders')
          }}</span>
          <div
            v-if="th.data.offenders.length === 0"
            class="flex h-[26px] items-center gap-1.5 text-[11.5px] text-text-3"
            data-testid="stalls-none"
          >
            <Check :size="12" :stroke-width="1.8" class="text-green" />{{
              t('systemMonitor.stalls.none')
            }}
          </div>
          <div
            v-for="o in th.data.offenders"
            :key="o.owner"
            class="flex h-[26px] items-center gap-2 text-[11.5px]"
            data-testid="stalls-offender"
          >
            <span
              class="min-w-0 flex-1 truncate font-mono"
              :class="o.ownerKind === 'unattributed' ? 'italic text-text-3' : ''"
              :title="offenderTitle(o)"
              >{{
                o.ownerKind === 'unattributed' ? t('systemMonitor.stalls.unattributed') : o.owner
              }}</span
            >
            <span class="w-10 text-right font-mono text-text-3">{{
              t('systemMonitor.stalls.times', { count: o.count })
            }}</span>
            <span class="w-14 text-right font-mono">{{ formatStallMs(o.worstMs) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
