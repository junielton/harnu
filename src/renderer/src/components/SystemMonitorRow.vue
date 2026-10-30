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
  TABLE_GRID,
  formatBytes,
  formatCpu,
  relativePct,
  sessionChildren,
  type SessionView
} from './system-monitor-format'

/**
 * One session in the table view (design.md "System Monitor (takeover)" → "Table
 * view"), plus — when expanded — its own-memory entry and `/proc` children as indented
 * rows with a wash of the folder hue. Columns: Name | RAM | CPU | Last 60s | State.
 * The State column wraps instead of clipping; the sparkline column hides in a narrow table.
 */
const props = defineProps<{
  view: SessionView
  expanded: boolean
  history: readonly (number | null)[]
  companion: CompanionState | null
  /** The largest live session's RSS — the RAM bar is relative to it. */
  maxRss: number
}>()
const emit = defineEmits<{ toggle: []; park: []; close: []; pingChannel: [] }>()
const { t } = useI18n()

const row = computed(() => props.view.row)
const live = computed(() => row.value.state === 'live')
const children = computed(() => sessionChildren(row.value))
const hasChildren = computed(() => live.value && children.value.length > 0)
const showPark = computed(() => live.value && row.value.parkable)
const showPing = computed(() => live.value && props.companion?.state === 'live')
</script>

<template>
  <div :class="`fh-${view.hue}`" data-testid="session-row-group">
    <div
      class="group relative min-h-9 items-center gap-3 border-t border-border px-3 py-1"
      :class="[TABLE_GRID, hasChildren ? 'cursor-pointer' : '']"
      data-testid="session-row"
      :data-state="row.state"
      @click="hasChildren ? emit('toggle') : undefined"
    >
      <span class="absolute inset-y-0 left-0 w-0.5 bg-[var(--fh)]" aria-hidden="true" />

      <span class="flex min-w-0 items-center gap-2 whitespace-nowrap">
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
          @click.stop="emit('toggle')"
        >
          <ChevronDown v-if="expanded" :size="12" :stroke-width="1.8" />
          <ChevronRight v-else :size="12" :stroke-width="1.8" />
        </button>
        <span v-else class="inline-block h-4 w-4 shrink-0" aria-hidden="true" />
        <SystemMonitorAvatar :initial="view.initial" size="sm" />
        <span
          class="truncate text-[12px] font-medium text-text"
          :class="live ? '' : 'opacity-60'"
          data-testid="row-name"
          >{{ view.name }}</span
        >
        <span
          v-if="view.branch"
          class="truncate text-[11px] text-text-4"
          :class="live ? '' : 'opacity-60'"
          >· {{ view.branch }}</span
        >
      </span>

      <span class="flex items-center gap-2.5">
        <template v-if="live">
          <span class="w-[60px] shrink-0 text-right font-mono text-[11.5px] text-text-2">{{
            formatBytes(row.rssBytes)
          }}</span>
          <span class="relative h-1 flex-1 overflow-hidden rounded-sm bg-border-2">
            <span
              class="absolute inset-y-0 left-0 rounded-sm bg-[var(--fh)]"
              :style="{ width: `${relativePct(row.rssBytes, maxRss)}%` }"
            />
          </span>
        </template>
        <span
          v-else
          class="w-[60px] shrink-0 text-right font-mono text-[11.5px]"
          :class="row.savedBytes === null ? 'text-text-4' : 'text-green'"
          data-testid="reclaimed"
          >{{ row.savedBytes === null ? '—' : `−${formatBytes(row.savedBytes)}` }}</span
        >
      </span>

      <span
        class="text-right font-mono text-[11.5px]"
        :class="live ? 'text-text-2' : 'text-text-4'"
        >{{ formatCpu(live ? row.cpuPct : null) }}</span
      >

      <span class="@max-[760px]:hidden">
        <SystemMonitorSpark v-if="live" :values="history" :width="72" :height="14" />
      </span>

      <span class="flex min-w-0 items-center justify-end gap-2">
        <span class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <SystemMonitorState :row="row" :companion="companion" />
        </span>
        <SystemMonitorActions
          :show-park="showPark"
          :show-ping="showPing"
          @park="emit('park')"
          @close="emit('close')"
          @ping-channel="emit('pingChannel')"
        />
      </span>
    </div>

    <template v-if="expanded && hasChildren">
      <div
        v-for="c in children"
        :key="c.key"
        class="min-h-7 items-center gap-3 border-t border-border bg-[color-mix(in_srgb,var(--fh)_4%,var(--color-sidebar))] px-3 text-[11.5px] text-text-3"
        :class="TABLE_GRID"
        data-testid="child-entry"
      >
        <span class="flex items-center gap-2 whitespace-nowrap pl-[46px]">
          <span class="inline-block w-3.5 font-mono text-text-disabled" aria-hidden="true">{{
            c.isSelf ? '•' : '└'
          }}</span>
          <em
            v-if="c.isSelf"
            class="italic text-text-4"
            :title="t('systemMonitor.ownMemoryHint')"
            >{{ t('systemMonitor.ownMemory') }}</em
          >
          <template v-else>{{ c.name }}</template>
        </span>
        <span class="flex items-center gap-2.5">
          <span class="w-[60px] shrink-0 text-right font-mono text-[11.5px] text-text-2">{{
            formatBytes(c.rssBytes)
          }}</span>
          <span
            v-if="!c.isSelf"
            class="relative h-[3px] flex-1 overflow-hidden rounded-sm bg-border-2"
          >
            <span
              class="absolute inset-y-0 left-0 rounded-sm bg-[var(--fh)]"
              :style="{ width: `${relativePct(c.rssBytes, row.rssBytes ?? 0)}%` }"
            />
          </span>
        </span>
        <span class="text-right font-mono text-[11.5px] text-text-2">{{
          c.isSelf ? '' : formatCpu(c.cpuPct)
        }}</span>
        <span class="@max-[760px]:hidden" />
        <span />
      </div>
    </template>
  </div>
</template>
