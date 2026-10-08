<script setup lang="ts">
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleCheck, CircleHelp, Lock } from 'lucide-vue-next'
import { formatBytes } from './system-monitor-format'
import { relativeTime } from '../composables/useRelativeTime'
import type { GcModel } from '../lib/gc-model'
import type { CycleRecord } from '../../../main/gc/gc-wire'

/**
 * The split bar of the Cleanup screen (design.md "Workspace GC — unified Cleanup / Page anatomy" #5):
 * one 32px bar, three segments sized by bytes — ready to clean (ready items), needs review
 * (plus orphan volumes, hatched), in use. A bucket is never colour alone: every segment
 * carries an icon and a word, and Needs review adds the hatch. Without byte sizes (Windows) the segments
 * show counts and share the width equally.
 */
const props = defineProps<{
  totals: GcModel['totals']
  hasBytes: boolean
  lastCycle: CycleRecord | null
}>()
const { t } = useI18n()

interface Segment {
  key: 'auto' | 'needsYou' | 'untouched'
  bucket: 'ready' | 'review' | 'in-use'
  icon: Component
  count: number
  bytes: number
}

const segments = computed<Segment[]>(() => {
  const all: Segment[] = [
    {
      key: 'auto',
      bucket: 'ready',
      icon: CircleCheck,
      count: props.totals.ready.count,
      bytes: props.totals.ready.bytes + props.totals.docker.bytes
    },
    {
      key: 'needsYou',
      bucket: 'review',
      icon: CircleHelp,
      count: props.totals.review.count + props.totals.orphanVolumes.count,
      bytes: props.totals.review.bytes + props.totals.orphanVolumes.bytes
    },
    {
      key: 'untouched',
      bucket: 'in-use',
      icon: Lock,
      count: props.totals['in-use'].count,
      bytes: props.totals['in-use'].bytes
    }
  ]
  return all.filter((s) => s.count > 0 || s.bytes > 0)
})

/** Grow by bytes; counts-only mode (and a zero-byte segment) fall back to an equal share. */
function grow(s: Segment): number {
  return props.hasBytes && s.bytes > 0 ? s.bytes : 1
}

const SEGMENT_CLASS: Record<Segment['bucket'], string> = {
  ready: 'border-green-line bg-green-soft text-green',
  review: 'border-warning-line bg-warning-soft text-warning',
  'in-use': 'border-border bg-surface-2 text-text-3'
}
/** The Needs review hatch: diagonal 4px stripes over the soft fill (design.md "Buckets"). */
const HATCH =
  'repeating-linear-gradient(135deg, transparent 0 4px, var(--color-warning-soft) 4px 8px)'

const lastLine = computed(() => {
  const c = props.lastCycle
  if (!c) return ''
  const ago = relativeTime(new Date(c.at).toISOString())
  if (c.mode === 'report') {
    return t('cleanup.gc.split.lastCycleReport', c.found, {
      named: { ago, n: c.found, size: formatBytes(c.foundBytes) }
    })
  }
  const cleaned = c.cleaned.filter((r) => r.ok).length
  return t('cleanup.gc.split.lastCycle', { ago, n: cleaned, size: formatBytes(c.freedBytes) })
})
</script>

<template>
  <div
    class="flex flex-col gap-1"
    role="group"
    :aria-label="t('cleanup.gc.split.label')"
    data-testid="split-bar"
  >
    <div v-if="segments.length > 0" class="flex gap-0.5">
      <div
        v-for="s in segments"
        :key="s.key"
        class="flex min-w-[112px] flex-col gap-1"
        :style="{ flexGrow: grow(s), flexShrink: 1, flexBasis: '0px' }"
        :data-testid="`split-${s.key}`"
      >
        <span
          class="truncate text-[10.5px] font-medium uppercase leading-[14px] tracking-[0.07em] text-text-4"
        >
          {{ t(`cleanup.gc.split.${s.key}`) }}
        </span>
        <span
          class="flex h-8 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-[3px] border px-2.5 text-[11px]"
          :class="SEGMENT_CLASS[s.bucket]"
          :style="s.bucket === 'review' ? { backgroundImage: HATCH } : undefined"
        >
          <component :is="s.icon" :size="12" :stroke-width="1.6" class="shrink-0" />
          <span class="truncate">{{ t(`cleanup.gc.split.${s.key}`) }}</span>
          <span class="ml-auto tabular-nums">
            {{
              hasBytes
                ? formatBytes(s.bytes)
                : t('cleanup.gc.split.count', s.count, { named: { n: s.count } })
            }}
          </span>
        </span>
      </div>
    </div>
    <div v-if="lastLine" class="text-[11px] leading-4 text-text-4" data-testid="split-last-cycle">
      {{ lastLine }}
    </div>
  </div>
</template>
