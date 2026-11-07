<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Network, Pause, Trash2 } from 'lucide-vue-next'
import { ageParts } from '../lib/docker-card-format'
import { groupDetail, groupTitle } from '../lib/docker-card-copy'
import type { ActionGroup, ActionRow } from '../lib/docker-card-view'

/**
 * "Automatic actions" block of the Docker card (design.md, U3.7): the newest automatic Docker
 * actions, one row per pass and kind ("4 empty networks removed") with its time and source, each
 * expanding to the per-item journal lines with their reasons; during the report-only first cycle,
 * what the first pass WOULD do, folded the same way.
 */
const props = defineProps<{ groups: readonly ActionGroup[]; reporting: boolean; now: number }>()
const emit = defineEmits<{ showAll: [] }>()
const { t } = useI18n()

const ICONS = { network: Network, orphan: Trash2, pause: Pause } as const
const NAMES_SHOWN = 3

const open = ref<Set<string>>(new Set())
function toggle(id: string): void {
  const next = new Set(open.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  open.value = next
}

/** The names a row touched: the first three, then "+n more". */
function names(g: ActionGroup): string {
  const shown = g.names.slice(0, NAMES_SHOWN).join(', ')
  const more = g.names.length - NAMES_SHOWN
  return more > 0 ? `${shown} ${t('cleanup.gc.docker.more', { n: more })}` : shown
}

function agoOf(at: number): string {
  const a = ageParts(Math.max(0, props.now - at))
  return t('cleanup.gc.docker.actions.ago', {
    age: t(`cleanup.gc.docker.age.${a.unit}`, { n: a.n })
  })
}
const when = (g: ActionGroup): string | null =>
  g.at === null ? null : `${agoOf(g.at)} · ${t('cleanup.gc.docker.actions.groups.source')}`

/** One expanded line: the single action as the journal wrote it. */
function itemTitle(row: ActionRow): string {
  if (row.kind === null) return row.raw
  return t(`cleanup.gc.docker.actions.${row.would ? 'would' : 'done'}.${row.kind}`, {
    target: row.target
  })
}
function itemDetail(row: ActionRow): string | null {
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
      v-if="groups.length === 0"
      class="py-1.5 text-caption leading-4 text-text-3"
      data-testid="docker-actions-empty"
    >
      {{ t('cleanup.gc.docker.actions.empty') }}
    </div>

    <template v-else>
      <ul class="flex flex-col">
        <li
          v-for="g in groups"
          :key="g.id"
          class="flex flex-col border-t border-border py-1.5 first:border-t-0"
          data-testid="docker-action-row"
        >
          <div class="flex items-start gap-2">
            <component
              :is="ICONS[g.kind ?? 'network']"
              :size="14"
              :stroke-width="1.6"
              class="mt-0.5 shrink-0 text-text-3"
              aria-hidden="true"
            />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="flex items-center gap-1.5">
                <span
                  v-if="g.would"
                  class="inline-flex shrink-0 items-center rounded-full border border-accent-line bg-accent-soft px-2 py-0.5 text-caption text-accent"
                  data-testid="docker-action-would"
                  >{{ t('cleanup.gc.docker.actions.wouldHave') }}</span
                >
                <span class="text-ui text-text" data-testid="docker-action-title">{{
                  groupTitle(g, t)
                }}</span>
              </span>
              <span
                v-if="g.names.length > 0"
                class="truncate font-mono text-caption text-text-4"
                data-testid="docker-action-names"
                >{{ names(g) }}</span
              >
              <span v-if="groupDetail(g, t)" class="text-caption leading-4 text-text-3">{{
                groupDetail(g, t)
              }}</span>
            </span>
            <span
              v-if="when(g)"
              class="shrink-0 text-caption tabular-nums text-text-4"
              data-testid="docker-action-when"
              >{{ when(g) }}</span
            >
            <button
              v-if="g.count > 1"
              type="button"
              class="flex size-5.5 shrink-0 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface hover:text-text"
              :aria-expanded="open.has(g.id)"
              :title="
                open.has(g.id)
                  ? t('cleanup.gc.docker.actions.groups.collapse')
                  : t('cleanup.gc.docker.actions.groups.expand', { n: g.count })
              "
              :aria-label="
                open.has(g.id)
                  ? t('cleanup.gc.docker.actions.groups.collapse')
                  : t('cleanup.gc.docker.actions.groups.expand', { n: g.count })
              "
              data-testid="docker-action-toggle"
              @click="toggle(g.id)"
            >
              <ChevronDown
                :size="12"
                :stroke-width="1.7"
                class="transition"
                :class="open.has(g.id) ? 'rotate-180' : ''"
                aria-hidden="true"
              />
            </button>
          </div>
          <ul
            v-if="open.has(g.id)"
            class="ml-5.5 mt-1 flex flex-col gap-1 border-l border-border pl-3"
          >
            <li
              v-for="item in g.items"
              :key="item.id"
              class="flex items-start gap-2"
              data-testid="docker-action-item"
            >
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="text-caption text-text-2">{{ itemTitle(item) }}</span>
                <span v-if="itemDetail(item)" class="text-caption leading-4 text-text-4">{{
                  itemDetail(item)
                }}</span>
              </span>
              <span
                v-if="item.at !== null"
                class="shrink-0 text-caption tabular-nums text-text-4"
                >{{ agoOf(item.at) }}</span
              >
            </li>
          </ul>
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
