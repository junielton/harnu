<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import type { CompanionState } from '../../../main/companion/companion-state-core'
import SystemMonitorActions from './SystemMonitorActions.vue'
import SystemMonitorAvatar from './SystemMonitorAvatar.vue'
import SystemMonitorSpark from './SystemMonitorSpark.vue'
import SystemMonitorState from './SystemMonitorState.vue'
import {
  compositionSegments,
  formatBytes,
  formatCpu,
  sessionChildren,
  splitBytes,
  type SessionView
} from './system-monitor-format'

/**
 * One session as a card (design.md "System Monitor (takeover)" → "Cards view"): a 3px
 * folder-hue stripe, the avatar + name + branch, big RAM and CPU with a 60s sparkline,
 * a composition bar (own memory + children), and a footer with the state cluster. A
 * parked card is dashed and shows what parking reclaimed. Expanding it lists the own
 * memory and the `/proc` children right under the footer.
 */
const props = defineProps<{
  view: SessionView
  expanded: boolean
  history: readonly (number | null)[]
  companion: CompanionState | null
}>()
const emit = defineEmits<{ toggle: []; park: []; close: []; pingChannel: [] }>()
const { t } = useI18n()

const row = computed(() => props.view.row)
const live = computed(() => row.value.state === 'live')
const children = computed(() => sessionChildren(row.value))
const hasChildren = computed(() => live.value && children.value.length > 0)
const ram = computed(() => splitBytes(row.value.rssBytes))
const reclaimed = computed(() => splitBytes(row.value.savedBytes))
const segments = computed(() => {
  const own = children.value.find((c) => c.isSelf)
  return compositionSegments(row.value.rssBytes, own?.rssBytes ?? null, row.value.procs)
})
/** The five `--fh` shades of the composition bar, over the surface (design.md: 25/75/55/40/30%). */
const SHADE = [
  'bg-[color-mix(in_srgb,var(--fh)_25%,var(--color-surface))]',
  'bg-[color-mix(in_srgb,var(--fh)_75%,var(--color-surface))]',
  'bg-[color-mix(in_srgb,var(--fh)_55%,var(--color-surface))]',
  'bg-[color-mix(in_srgb,var(--fh)_40%,var(--color-surface))]',
  'bg-[color-mix(in_srgb,var(--fh)_30%,var(--color-surface))]'
]
const segmentLabel = (s: { isSelf: boolean; isOther: boolean; label: string }): string =>
  s.isSelf
    ? t('systemMonitor.compositionOwn')
    : s.isOther
      ? t('systemMonitor.compositionOther')
      : s.label
const showPark = computed(() => live.value && row.value.parkable)
const showPing = computed(() => live.value && props.companion?.state === 'live')
</script>

<template>
  <article
    class="group relative flex flex-col gap-2.5 overflow-hidden rounded-[var(--radius-lg)] border px-3.5 py-3"
    :class="[
      `fh-${view.hue}`,
      live ? 'border-border bg-sidebar' : 'border-dashed border-border bg-transparent'
    ]"
    data-testid="session-card"
    :data-state="row.state"
  >
    <span
      class="absolute inset-x-0 top-0 h-[3px] bg-[var(--fh)]"
      :class="live ? '' : 'opacity-40'"
      aria-hidden="true"
    />

    <div class="flex items-center gap-2.5">
      <SystemMonitorAvatar :initial="view.initial" size="lg" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-[13px] font-semibold text-text" data-testid="card-name">
          {{ view.name }}
        </div>
        <div v-if="view.branch" class="truncate text-[11px] text-text-4">{{ view.branch }}</div>
      </div>
      <SystemMonitorActions
        :show-park="showPark"
        :show-ping="showPing"
        @park="emit('park')"
        @close="emit('close')"
        @ping-channel="emit('pingChannel')"
      />
      <button
        v-if="hasChildren"
        type="button"
        class="flex h-4 w-4 shrink-0 items-center justify-center text-text-4 hover:text-text"
        :aria-label="
          expanded
            ? t('systemMonitor.collapse', { name: view.name })
            : t('systemMonitor.expand', { name: view.name })
        "
        :aria-expanded="expanded"
        @click="emit('toggle')"
      >
        <ChevronDown v-if="expanded" :size="12" :stroke-width="1.8" />
        <ChevronRight v-else :size="12" :stroke-width="1.8" />
      </button>
    </div>

    <div v-if="live" class="flex items-end gap-[18px]">
      <div>
        <div class="font-mono text-[22px] font-semibold leading-tight tracking-tight text-text">
          <template v-if="ram"
            >{{ ram.value
            }}<small class="text-[11px] font-normal text-text-3"> {{ ram.unit }}</small></template
          >
          <template v-else>—</template>
        </div>
        <div class="text-[10.5px] uppercase tracking-wide text-text-4">
          {{ t('systemMonitor.columnRam') }}
        </div>
      </div>
      <div>
        <div class="font-mono text-[22px] font-semibold leading-tight tracking-tight text-text">
          {{ formatCpu(row.cpuPct) }}
        </div>
        <div class="text-[10.5px] uppercase tracking-wide text-text-4">
          {{ t('systemMonitor.columnCpu') }}
        </div>
      </div>
      <SystemMonitorSpark
        class="ml-auto"
        :values="history"
        :width="110"
        :height="30"
        :stroke-width="1.8"
      />
    </div>
    <div v-else class="flex items-center gap-[18px]">
      <div>
        <div
          class="font-mono text-[22px] font-semibold leading-tight tracking-tight"
          :class="reclaimed ? 'text-green' : 'text-text-4'"
          data-testid="reclaimed"
        >
          <template v-if="reclaimed"
            >−{{ reclaimed.value
            }}<small class="text-[11px] font-normal text-text-3">
              {{ reclaimed.unit }}</small
            ></template
          >
          <template v-else>—</template>
        </div>
        <div class="text-[10.5px] uppercase tracking-wide text-text-4">
          {{ t('systemMonitor.reclaimed') }}
        </div>
      </div>
      <div class="ml-auto max-w-[140px] text-right text-[11px] text-text-4">
        {{ t('systemMonitor.wakeHint') }}
      </div>
    </div>

    <template v-if="live && segments.length > 0">
      <div class="flex h-1.5 gap-px overflow-hidden rounded-[3px]" data-testid="composition-bar">
        <span
          v-for="s in segments"
          :key="s.key"
          class="h-full"
          :class="SHADE[s.shade]"
          :style="{ width: `${s.pct}%` }"
        />
      </div>
      <div
        class="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-3"
        data-testid="composition-legend"
      >
        <span v-for="s in segments" :key="s.key" class="inline-flex items-center gap-1">
          <span class="h-[7px] w-[7px] rounded-[2px]" :class="SHADE[s.shade]" />
          <em v-if="s.isSelf" class="italic text-text-4">{{ segmentLabel(s) }}</em>
          <template v-else>{{ segmentLabel(s) }}</template>
          <span class="font-mono text-[11.5px] text-text-2">{{ Math.round(s.bytes / 1e6) }}</span>
        </span>
      </div>
    </template>

    <div class="flex min-h-[30px] flex-wrap items-center gap-2 border-t border-border pt-2">
      <SystemMonitorState :row="row" :companion="companion" />
    </div>

    <div
      v-if="expanded && hasChildren"
      class="border-t border-border pt-1.5 text-[11.5px] text-text-3"
      data-testid="card-children"
    >
      <div
        v-for="c in children"
        :key="c.key"
        class="flex h-6 items-center gap-1.5"
        data-testid="child-entry"
      >
        <span class="inline-block w-3.5 font-mono text-text-disabled" aria-hidden="true">{{
          c.isSelf ? '•' : '└'
        }}</span>
        <em v-if="c.isSelf" class="italic text-text-4" :title="t('systemMonitor.ownMemoryHint')">{{
          t('systemMonitor.ownMemory')
        }}</em>
        <template v-else>{{ c.name }}</template>
        <span class="flex-1" />
        <span class="w-[60px] text-right font-mono text-[11.5px] text-text-2">{{
          formatBytes(c.rssBytes)
        }}</span>
        <span class="w-10 text-right font-mono text-[11.5px] text-text-2">{{
          c.isSelf ? '' : formatCpu(c.cpuPct)
        }}</span>
      </div>
    </div>
  </article>
</template>
