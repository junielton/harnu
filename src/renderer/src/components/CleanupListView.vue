<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleHelp, Lock } from 'lucide-vue-next'
import type { Bucket } from '../../../main/gc/bundle-core'
import type { GcBlock, GcModel } from '../lib/gc-model'
import type { BlockJobState } from '../lib/gc-jobs'
import { formatBytes } from './system-monitor-format'
import { reasonKey } from './cleanup-gc-copy'

/**
 * The List fallback of the Cleanup map (design.md "Treemap / List fallback"): the same data grouped
 * by bucket, for people and systems where area is the wrong encoding — and the only view where the
 * system reports no disk sizes. Rows open the same side panel as a map block.
 */

const props = defineProps<{
  model: GcModel
  blockState: (id: string) => BlockJobState | null
}>()

const emit = defineEmits<{ select: [id: string] }>()

const { t } = useI18n()

const ICON = { ready: CircleCheck, review: CircleHelp, 'in-use': Lock } as const
const INK: Record<Bucket, string> = {
  ready: 'text-green',
  review: 'text-warning',
  'in-use': 'text-text-3'
}
const FILL: Record<Bucket, string> = {
  ready: 'bg-green',
  review: 'bg-warning',
  'in-use': 'bg-text-4'
}

const bigFirst = (a: GcBlock, b: GcBlock): number => b.bytes - a.bytes

const groups = computed(() => {
  const m = props.model
  const buckets: Array<{ bucket: Bucket; blocks: GcBlock[] }> = [
    { bucket: 'ready', blocks: m.ready },
    // Needs review includes the orphan volumes, as the "Needs review" list does.
    { bucket: 'review', blocks: m.review },
    { bucket: 'in-use', blocks: m.blocks.filter((b) => b.bucket === 'in-use').sort(bigFirst) }
  ]
  return buckets
    .filter((g) => g.blocks.length > 0)
    .map((g) => {
      const max = Math.max(...g.blocks.map((b) => b.bytes), 1)
      return { ...g, max, bytes: g.blocks.reduce((a, b) => a + b.bytes, 0) }
    })
})

const sizeOf = (b: GcBlock): string => (b.hasBytes ? formatBytes(b.bytes) : '—')

function note(b: GcBlock): string {
  if (b.bucket === 'review') return t(reasonKey(b.reasonCode))
  return t(`cleanup.gc.bucket.header.${b.bucket}`)
}

function sub(b: GcBlock): string {
  return b.kind === 'volume' ? (b.project ?? '') : (b.repoLabel ?? '')
}

function stateWord(id: string): string | null {
  const st = props.blockState(id)
  return st ? t(`cleanup.gc.map.state.${st}`) : null
}
</script>

<template>
  <div
    class="flex flex-col gap-3"
    role="group"
    :aria-label="t('cleanup.gc.list.label')"
    data-testid="list-view"
  >
    <p v-if="groups.length === 0" class="py-8 text-center text-[12px] text-text-3">
      {{ t('cleanup.gc.list.empty') }}
    </p>

    <section
      v-for="g in groups"
      :key="g.bucket"
      class="rounded border border-border bg-surface pb-1.5"
      :data-testid="`list-group-${g.bucket}`"
    >
      <header
        class="flex items-center gap-2 border-b border-border px-3 py-2.5"
        :class="INK[g.bucket]"
      >
        <component :is="ICON[g.bucket]" :size="14" :stroke-width="1.7" />
        <span class="text-[10.5px] font-medium uppercase tracking-[0.07em]">
          {{ t(`cleanup.gc.bucket.header.${g.bucket}`) }}
        </span>
        <span class="ml-auto text-[11px] text-text-3">
          {{ g.blocks.length }} ·
          {{ g.blocks.some((b) => b.hasBytes) ? formatBytes(g.bytes) : '—' }}
        </span>
      </header>

      <button
        v-for="b in g.blocks"
        :key="b.id"
        type="button"
        class="grid w-full grid-cols-[20px_260px_160px_1fr_70px] items-center gap-3.5 px-3 py-2 text-left transition hover:bg-surface-2"
        :class="{ 'opacity-45': blockState(b.id) === 'done' }"
        :disabled="blockState(b.id) === 'done'"
        :data-id="b.id"
        data-testid="list-row"
        @click="emit('select', b.id)"
      >
        <component :is="ICON[g.bucket]" :size="14" :stroke-width="1.7" :class="INK[g.bucket]" />
        <span class="flex min-w-0 flex-col">
          <span class="truncate text-[12.5px] text-text">{{ b.name }}</span>
          <span class="truncate text-[11px] text-text-4">{{ sub(b) }}</span>
        </span>
        <span class="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <span
            class="block h-full rounded-full"
            :class="FILL[g.bucket]"
            :style="{ width: (b.hasBytes ? (b.bytes / g.max) * 100 : 0) + '%' }"
            data-testid="list-bar"
          />
        </span>
        <span class="truncate text-[12px] text-text-2">
          {{ note(b) }}
          <span v-if="stateWord(b.id)" class="text-text-3" data-testid="list-state">
            · {{ stateWord(b.id) }}
          </span>
        </span>
        <span class="text-right text-[12.5px] tabular-nums text-text">{{ sizeOf(b) }}</span>
      </button>
    </section>
  </div>
</template>
