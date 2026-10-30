<script setup lang="ts">
/**
 * One folder group in the Scheduler takeover's worker list (T590 — design.md
 * "Scheduler (takeover)" → "Worker list"; approved mockup
 * `docs/specs/2026-10-29-scheduler-folders/`, screen `pastas--combinada`).
 *
 * The 44px header carries the folder's identity — a stripe, an avatar and a wash
 * in the folder hue — plus its health at a glance: branch, on/off counts, the
 * next run, failing / running pills and a proportional health bar. The rows are
 * the default slot, hidden while the group is collapsed. The hue is the single
 * custom property `--fh`, set by the `.fh-*` helper class on the root (design.md
 * §2 "Folder hue"); nothing in here names a raw colour.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, GitBranch } from 'lucide-vue-next'
import { formatCountdown } from './scheduler-format'
import type { FolderGroup } from './scheduler-list'

const props = defineProps<{
  group: FolderGroup
  collapsed: boolean
  nowMs: number
}>()

const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()

const nextLabel = computed(() => {
  const s = props.group.summary
  if (s.kind === 'running') return null
  if (s.kind === 'none') return t('scheduler.list.folderNothingScheduled')
  const ms = s.nextAt - props.nowMs
  return ms <= 0
    ? t('scheduler.list.folderDueNow')
    : t('scheduler.list.folderNextIn', { countdown: formatCountdown(ms) })
})

const pct = (fraction: number): string => `${fraction * 100}%`
</script>

<template>
  <div
    class="relative"
    :class="`fh-${group.hue}`"
    role="group"
    :aria-label="group.name"
    :data-folder-group="group.path"
    :data-collapsed="collapsed ? 'true' : 'false'"
  >
    <button
      type="button"
      class="relative flex h-11 w-full items-center gap-2 border-b border-border bg-[color-mix(in_srgb,var(--fh)_7%,var(--color-surface))] pl-3 pr-2.5 text-left"
      :aria-expanded="!collapsed"
      :aria-label="
        collapsed
          ? t('scheduler.list.folderExpand', { name: group.name })
          : t('scheduler.list.folderCollapse', { name: group.name })
      "
      :title="group.path"
      data-folder-header
      @click="emit('toggle')"
    >
      <span class="absolute inset-y-0 left-0 w-[3px] bg-[var(--fh)]" aria-hidden="true" />

      <span
        class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm bg-[color-mix(in_srgb,var(--fh)_18%,transparent)] text-[11px] font-bold text-[var(--fh)]"
        aria-hidden="true"
        data-folder-avatar
      >
        {{ group.initial }}
      </span>

      <span class="flex min-w-0 flex-1 flex-col gap-[2px]">
        <span class="flex min-w-0 items-baseline gap-1.5">
          <span class="truncate text-[12px] font-semibold text-text" data-folder-name>{{
            group.name
          }}</span>
          <span class="shrink-0 text-[11px] text-text-4" data-folder-count>{{ group.total }}</span>
        </span>
        <span
          class="flex items-center gap-1 overflow-hidden whitespace-nowrap text-[10px] text-text-4"
          data-folder-line2
        >
          <template v-if="group.branch">
            <span class="inline-flex min-w-0 items-center gap-[3px]">
              <GitBranch :size="9" :stroke-width="1.8" class="shrink-0" aria-hidden="true" />
              <span class="truncate">{{ group.branch }}</span>
            </span>
            <span class="shrink-0 text-text-disabled">·</span>
          </template>
          <span class="shrink-0">{{ t('scheduler.list.folderOn', { n: group.on }) }}</span>
          <template v-if="group.off > 0">
            <span class="shrink-0 text-text-disabled">·</span>
            <span class="shrink-0">{{ t('scheduler.list.folderOff', { n: group.off }) }}</span>
          </template>
          <span class="shrink-0 text-text-disabled">·</span>
          <span v-if="group.summary.kind === 'running'" class="shrink-0 text-green">{{
            t('scheduler.list.folderRunningNow')
          }}</span>
          <span v-else class="shrink-0">{{ nextLabel }}</span>
        </span>
      </span>

      <span class="flex shrink-0 items-center gap-1.5">
        <span
          v-if="group.failing > 0"
          class="inline-flex h-4 items-center gap-1 rounded-sm bg-red-soft px-[5px] text-[10px] text-red"
          data-pill="failing"
        >
          <span class="h-1.5 w-1.5 rounded-full bg-red" />
          {{ t('scheduler.list.folderFailing', { n: group.failing }) }}
        </span>
        <span
          v-if="group.running > 0"
          class="inline-flex h-4 items-center gap-1 rounded-sm bg-green-soft px-[5px] text-[10px] text-green"
          data-pill="running"
        >
          <span class="anim-tick-pulse h-1.5 w-1.5 rounded-full bg-green" />
          {{ t('scheduler.list.folderRunning', { n: group.running }) }}
        </span>
        <span
          class="flex h-[3px] w-10 shrink-0 overflow-hidden rounded-sm bg-border-2"
          data-health-bar
          aria-hidden="true"
        >
          <i
            v-if="group.health.running > 0"
            class="block h-full bg-green"
            :style="{ width: pct(group.health.running) }"
          />
          <i
            v-if="group.health.failing > 0"
            class="block h-full bg-red"
            :style="{ width: pct(group.health.failing) }"
          />
          <i
            v-if="group.health.waiting > 0"
            class="block h-full bg-text-4"
            :style="{ width: pct(group.health.waiting) }"
          />
          <i
            v-if="group.health.off > 0"
            class="block h-full bg-text-disabled"
            :style="{ width: pct(group.health.off) }"
          />
        </span>
        <ChevronDown
          :size="11"
          :stroke-width="1.6"
          class="shrink-0 text-text-4 transition-transform duration-[var(--dur-fast)] ease-[var(--ease)]"
          :class="collapsed ? '-rotate-90' : ''"
          aria-hidden="true"
        />
      </span>
    </button>

    <slot v-if="!collapsed" />
  </div>
</template>
