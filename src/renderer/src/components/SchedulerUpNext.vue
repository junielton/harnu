<script setup lang="ts">
/**
 * The Scheduler list's "Up next" strip (T590 — approved mockup
 * `pastas--combinada`, states `default` / `upnext-recolhido`): the next few due
 * runs across every folder. The header toggles it; collapsed it keeps a one-line
 * summary of the single next run. Each row wears its folder's hue through `--fh`
 * (design.md §2 "Folder hue") — chrome only, never a status.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import { formatCountdown } from './scheduler-format'
import { folderHue, upNextSummaryOf, type UpNextItem } from './scheduler-list'

const props = defineProps<{
  items: readonly UpNextItem[]
  collapsed: boolean
  folderName: (path: string) => string
}>()

const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()

function timeLabel(item: UpNextItem): string {
  return item.now ? t('scheduler.list.upNextNow') : formatCountdown(item.inMs)
}

const summary = computed(() => {
  if (props.collapsed) {
    const next = upNextSummaryOf(props.items)
    return next
      ? `${timeLabel(next)} · ${next.worker.name} · ${props.folderName(next.worker.folder)}`
      : ''
  }
  const span = Math.max(0, ...props.items.map((i) => i.inMs))
  return span <= 0
    ? t('scheduler.list.upNextDueNow', { n: props.items.length })
    : t('scheduler.list.upNextSummary', { n: props.items.length, span: formatCountdown(span) })
})
</script>

<template>
  <div
    v-if="items.length > 0"
    class="flex-none border-b border-border py-2 pl-3 pr-2.5"
    data-up-next
  >
    <button
      type="button"
      class="group mb-1 flex w-full items-center gap-[5px] p-0 text-left"
      :class="collapsed ? 'mb-0' : ''"
      :aria-expanded="!collapsed"
      data-up-next-toggle
      @click="emit('toggle')"
    >
      <ChevronDown
        :size="11"
        :stroke-width="1.8"
        class="shrink-0 text-text-4 transition-transform duration-[var(--dur-fast)] ease-[var(--ease)]"
        :class="collapsed ? '-rotate-90' : ''"
        aria-hidden="true"
      />
      <h4
        class="m-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-3 group-hover:text-text-2"
      >
        {{ t('scheduler.list.upNext') }}
      </h4>
      <span class="ml-auto min-w-0 truncate text-[10px] text-text-4" data-up-next-summary>{{
        summary
      }}</span>
    </button>

    <div v-if="!collapsed" data-up-next-rows>
      <div
        v-for="item in items"
        :key="item.worker.id"
        class="flex h-5 items-center gap-[7px] text-[11px]"
        :class="`fh-${folderHue(item.worker.folder)}`"
        data-up-next-row
      >
        <span
          class="w-7 shrink-0 text-left tabular-nums"
          :class="item.now ? 'font-semibold text-green' : 'text-text-3'"
          >{{ timeLabel(item) }}</span
        >
        <span class="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-[var(--fh)]" aria-hidden="true" />
        <span class="min-w-0 truncate text-text">{{ item.worker.name }}</span>
        <span class="ml-auto shrink-0 whitespace-nowrap text-[var(--fh)]">{{
          folderName(item.worker.folder)
        }}</span>
      </div>
    </div>
  </div>
</template>
