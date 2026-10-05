<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from 'lucide-vue-next'
import { useMonitorStore } from '../stores/monitor'
import { useUiStore } from '../stores/ui'
import { heapPercent, heapBarClass } from './system-monitor-format'

/**
 * Footer heap gauge (design.md "Heap gauge (footer, T127 S3)"). The always-on
 * early-warning signal the 2026-07-14 OOM incident needed and didn't have — fed
 * purely by S1's cheap heartbeat (`monitor:heap`, 30s, `v8.getHeapStatistics()`
 * only), so it reads live heap pressure with the System Monitor takeover closed.
 * Grafted into `StatusFooter.vue`'s existing fleet pill; clicking it TOGGLES the
 * takeover (`ui.toggleSystemMonitor()`) — the entry point spec §4 calls out, and
 * the same button closes it again rather than being a one-way door.
 *
 * Hidden until the first heartbeat lands (`monitor.lastHeap` null) — same rule
 * the takeover's own header gauge follows, so nothing renders a fake 0%.
 */
const monitor = useMonitorStore()
const ui = useUiStore()
const { t } = useI18n()

const heapPct = computed(() => heapPercent(monitor.lastHeap))
const fillClass = computed(() => heapBarClass(monitor.lastHeap?.status))
const status = computed(() => monitor.lastHeap?.status ?? 'ok')
const label = computed(() => t('footer.a11yHeapGauge', { pct: Math.round(heapPct.value) }))

function onClick(): void {
  ui.toggleSystemMonitor()
}
</script>

<template>
  <button
    v-if="monitor.lastHeap"
    type="button"
    class="flex items-center gap-1.5 whitespace-nowrap rounded font-mono transition-colors"
    :class="ui.systemMonitorOpen ? 'text-accent' : 'text-text-2 hover:text-text'"
    :aria-label="label"
    :title="label"
    :aria-pressed="ui.systemMonitorOpen"
    @click="onClick"
  >
    <span>{{ t('systemMonitor.heapLabel') }}</span>
    <span class="h-1.5 w-[54px] overflow-hidden rounded-full bg-surface-2">
      <span
        class="block h-full rounded-full"
        :class="fillClass"
        :style="{ width: `${heapPct}%` }"
      />
    </span>
    <span class="tabular-nums">{{ Math.round(heapPct) }}%</span>
    <TriangleAlert
      v-if="status !== 'ok'"
      :size="12"
      :stroke-width="1.8"
      :class="status === 'critical' ? 'text-red' : 'text-warning'"
    />
  </button>
</template>
