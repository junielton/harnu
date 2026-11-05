<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Network, Pause, Trash2 } from 'lucide-vue-next'
import { ageParts } from '../lib/docker-card-format'
import type { ActionRow } from '../lib/docker-card-view'

/**
 * "Automatic actions" block of the Docker card (design.md, U3.7): the newest automatic Docker
 * actions with their reasons, or, during the report-only first cycle, what the first pass WOULD do.
 */
const props = defineProps<{ rows: readonly ActionRow[]; reporting: boolean; now: number }>()
const emit = defineEmits<{ showAll: [] }>()
const { t } = useI18n()

const ICONS = { network: Network, orphan: Trash2, pause: Pause } as const

function title(row: ActionRow): string {
  if (row.kind === null) return row.raw
  return t(`cleanup.gc.docker.actions.${row.would ? 'would' : 'done'}.${row.kind}`, {
    target: row.target
  })
}

function detail(row: ActionRow): string | null {
  if (row.kind === 'network') return t('cleanup.gc.docker.actions.detail.network')
  if (row.kind === 'orphan') {
    return row.volumes.length > 0
      ? t('cleanup.gc.docker.actions.detail.orphan', { volumes: row.volumes.join(', ') })
      : t('cleanup.gc.docker.actions.detail.orphanNone')
  }
  if (row.kind === 'pause' && row.idle) {
    return t('cleanup.gc.docker.actions.detail.pause', { idle: row.idle })
  }
  return null
}

function when(row: ActionRow): string | null {
  if (row.at === null) return null
  const a = ageParts(Math.max(0, props.now - row.at))
  return t('cleanup.gc.docker.actions.ago', {
    age: t(`cleanup.gc.docker.age.${a.unit}`, { n: a.n })
  })
}

const caption = computed(() =>
  props.reporting
    ? t('cleanup.gc.docker.actions.nothingChanged')
    : t('cleanup.gc.docker.actions.lastCycle')
)
</script>

<template>
  <div
    class="col-span-full flex flex-col gap-1 rounded-xs border border-border bg-surface-2 px-3 py-2"
    data-testid="docker-actions"
  >
    <div class="flex items-center gap-2">
      <span class="text-ui font-medium text-text">{{ t('cleanup.gc.docker.actions.title') }}</span>
      <span class="text-caption text-text-4">{{ caption }}</span>
    </div>

    <div
      v-if="rows.length === 0"
      class="py-1.5 text-caption leading-4 text-text-3"
      data-testid="docker-actions-empty"
    >
      {{ t('cleanup.gc.docker.actions.empty') }}
    </div>

    <template v-else>
      <ul class="flex flex-col">
        <li
          v-for="row in rows"
          :key="row.id"
          class="flex items-start gap-2 border-t border-border py-1.5 first:border-t-0"
          data-testid="docker-action-row"
        >
          <component
            :is="ICONS[row.kind ?? 'network']"
            :size="14"
            :stroke-width="1.6"
            class="mt-0.5 shrink-0 text-text-3"
            aria-hidden="true"
          />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="flex items-center gap-1.5">
              <span
                v-if="row.would"
                class="inline-flex shrink-0 items-center rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-caption text-accent"
                data-testid="docker-action-would"
                >{{ t('cleanup.gc.docker.actions.wouldHave') }}</span
              >
              <span class="text-ui text-text" data-testid="docker-action-title">{{
                title(row)
              }}</span>
            </span>
            <span v-if="detail(row)" class="text-caption leading-4 text-text-3">{{
              detail(row)
            }}</span>
          </span>
          <span v-if="when(row)" class="shrink-0 text-caption tabular-nums text-text-4">{{
            when(row)
          }}</span>
        </li>
      </ul>
      <button
        v-if="!reporting"
        type="button"
        class="w-fit text-caption font-medium text-text-2 transition hover:text-text"
        data-testid="docker-actions-show-all"
        @click="emit('showAll')"
      >
        {{ t('cleanup.gc.docker.actions.showAll') }}
      </button>
    </template>
  </div>
</template>
