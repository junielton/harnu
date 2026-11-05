<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy } from 'lucide-vue-next'
import { pausedRows } from '../lib/docker-card-view'
import { ageParts } from '../lib/docker-card-format'
import type { PausedStack } from '../../../main/containers/containers-wire'

/**
 * "Paused stacks" block of the Docker card (design.md, U3.7): how many stacks Cleanup brought down,
 * the newest three with the time since the pause, and a button that copies each one's
 * `compose up -d` command (spec C5: the restore command IS the way back). While the first cycle is
 * report-only it counts what the plan would pause instead.
 */
const props = defineProps<{
  paused: readonly PausedStack[]
  now: number
  /** Report-only first cycle: the number of pauses the plan holds, or null when not reporting. */
  wouldPause: number | null
}>()
const { t } = useI18n()

const view = computed(() => pausedRows(props.paused, props.now))

async function copy(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command)
  } catch {
    /* clipboard unavailable: the command stays visible in Inspect stacks */
  }
}

const age = (ms: number): string => {
  const a = ageParts(ms)
  return t(`cleanup.gc.docker.age.${a.unit}`, { n: a.n })
}
</script>

<template>
  <div
    class="flex flex-col gap-1 rounded-xs border border-border bg-surface-2 px-3 py-2"
    data-testid="docker-paused"
  >
    <span class="text-ui font-medium text-text">{{ t('cleanup.gc.docker.paused.title') }}</span>
    <div
      v-if="wouldPause !== null"
      class="text-ui tabular-nums text-text-3"
      data-testid="docker-paused-count"
    >
      {{ t('cleanup.gc.docker.paused.would', { n: wouldPause }) }}
    </div>
    <div v-else-if="view.total === 0" class="text-ui text-text-3" data-testid="docker-paused-count">
      {{ t('cleanup.gc.docker.paused.none') }}
    </div>
    <div v-else class="text-ui tabular-nums text-text" data-testid="docker-paused-count">
      {{ t('cleanup.gc.docker.paused.count', view.total, { named: { n: view.total } }) }}
    </div>

    <ul v-if="wouldPause === null && view.rows.length > 0" class="flex flex-col">
      <li
        v-for="row in view.rows"
        :key="row.name"
        class="flex items-center gap-2 border-t border-border py-1 first:border-t-0"
        data-testid="docker-paused-row"
      >
        <span class="min-w-0 flex-1 truncate font-mono text-caption text-text" :title="row.name">{{
          row.name
        }}</span>
        <span class="text-caption tabular-nums text-text-4">{{
          t('cleanup.gc.docker.paused.idle', { age: age(row.ageMs) })
        }}</span>
        <button
          type="button"
          class="flex size-5.5 shrink-0 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface hover:text-text"
          :title="t('cleanup.gc.docker.paused.copy', { name: row.name })"
          :aria-label="t('cleanup.gc.docker.paused.copy', { name: row.name })"
          data-testid="docker-paused-copy"
          @click="copy(row.restoreCommand)"
        >
          <Copy :size="12" :stroke-width="1.7" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <div
      v-if="wouldPause === null && view.more > 0"
      class="text-caption text-text-4"
      data-testid="docker-paused-more"
    >
      {{ t('cleanup.gc.docker.paused.more', { n: view.more }) }}
    </div>
    <div class="text-caption leading-4 text-text-3">{{ t('cleanup.gc.docker.paused.note') }}</div>
  </div>
</template>
