<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bookmark,
  CircleHelp,
  PackageMinus,
  SquareCheck,
  Sparkles,
  Trash2,
  TriangleAlert
} from 'lucide-vue-next'
import type { GcBlock } from '../lib/gc-model'
import type { BlockJobState, ItemFailure } from '../lib/gc-jobs'
import { formatBytes } from './system-monitor-format'
import { canDehydrate } from './cleanup-row'
import { reasonKey } from './cleanup-gc-copy'
import Button from './ui/Button.vue'

/**
 * "Needs you": the ranked list of Decide items under the map (design.md "Workspace GC — unified
 * Cleanup / Needs you list"). Biggest first; most decisions are taken here, the map is the overview.
 * Hovering a row outlines its block (the `hover` emit), a checkbox in the leading slot multi-selects.
 */

const ROW_CAP = 50

const props = defineProps<{
  blocks: GcBlock[]
  checked: ReadonlySet<string>
  linkedId: string | null
  blockState: (id: string) => BlockJobState | null
  failureOf: (id: string) => ItemFailure | null
}>()

const emit = defineEmits<{
  toggle: [id: string]
  select: [id: string]
  hover: [id: string | null]
  remove: [id: string]
  dehydrate: [id: string]
  keep: [id: string]
}>()

const { t } = useI18n()

const showAll = ref(false)
const visible = computed(() => (showAll.value ? props.blocks : props.blocks.slice(0, ROW_CAP)))
const hiddenCount = computed(() => Math.max(props.blocks.length - ROW_CAP, 0))

function failed(b: GcBlock): boolean {
  return props.blockState(b.id) === 'failed' || props.failureOf(b.id) !== null
}

function reasonOf(b: GcBlock): string {
  if (props.failureOf(b.id)?.changedSinceConfirm)
    return t('cleanup.gc.needsYou.changedSinceConfirm')
  return t(reasonKey(b.reasonCode))
}

function canDehydrateBlock(b: GcBlock): boolean {
  return !!b.bundle && canDehydrate(b.bundle.item) && props.blockState(b.id) !== 'busy'
}

function sub(b: GcBlock): string {
  if (b.kind === 'volume') {
    return b.project
      ? t('cleanup.gc.needsYou.volumeProject', { project: b.project })
      : t('cleanup.gc.needsYou.volumeUnknown')
  }
  return b.repoLabel ?? ''
}

const sizeOf = (b: GcBlock): string => (b.hasBytes ? formatBytes(b.bytes) : '—')

function onRowKey(e: KeyboardEvent, id: string): void {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter') emit('select', id)
}
</script>

<template>
  <section class="rounded border border-border bg-surface" data-testid="needs-you">
    <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
      <span class="text-[10.5px] font-medium uppercase tracking-[0.07em] text-warning">
        {{ t('cleanup.gc.needsYou.title') }}
      </span>
      <span class="text-[11px] text-text-3" data-testid="needs-you-count">{{ blocks.length }}</span>
      <span class="ml-auto" :title="t('cleanup.gc.needsYou.askSoon')">
        <Button
          variant="soft"
          :disabled="true"
          :title="t('cleanup.gc.needsYou.askSoon')"
          data-testid="needs-you-ask-all"
        >
          <Sparkles :size="13" :stroke-width="1.7" />
          {{ t('cleanup.gc.needsYou.askAll', { count: blocks.length }) }}
        </Button>
      </span>
    </header>

    <p v-if="blocks.length === 0" class="px-3 py-6 text-center text-[12px] text-text-3">
      {{ t('cleanup.gc.needsYou.empty') }}
    </p>

    <div v-else class="px-3 py-1.5">
      <div
        v-for="b in visible"
        :key="b.id"
        class="group/row grid cursor-pointer grid-cols-[20px_220px_1fr_64px_auto] items-center gap-3.5 rounded-sm border border-transparent px-2.5 py-3"
        :class="{
          'border-accent-line bg-accent-soft': checked.has(b.id),
          'border-red-line bg-red-soft': failed(b) && !checked.has(b.id),
          'border-border bg-surface-2': linkedId === b.id && !checked.has(b.id) && !failed(b),
          'opacity-45': blockState(b.id) === 'done'
        }"
        tabindex="0"
        role="button"
        :aria-label="t('cleanup.gc.needsYou.rowAria', { name: b.name, size: sizeOf(b) })"
        :data-id="b.id"
        data-testid="needs-you-row"
        @click="emit('select', b.id)"
        @keydown="onRowKey($event, b.id)"
        @mouseenter="emit('hover', b.id)"
        @mouseleave="emit('hover', null)"
        @focusin="emit('hover', b.id)"
        @focusout="emit('hover', null)"
      >
        <!-- leading slot: the bucket icon, swapped for a checkbox on hover or when checked -->
        <span class="relative flex h-[16px] w-[16px] items-center justify-center">
          <TriangleAlert
            v-if="failed(b)"
            :size="14"
            :stroke-width="1.7"
            class="text-red transition-opacity"
            :class="checked.has(b.id) ? 'opacity-0' : 'opacity-100 group-hover/row:opacity-0'"
          />
          <CircleHelp
            v-else
            :size="14"
            :stroke-width="1.7"
            class="text-warning transition-opacity"
            :class="checked.has(b.id) ? 'opacity-0' : 'opacity-100 group-hover/row:opacity-0'"
          />
          <SquareCheck
            v-if="checked.has(b.id)"
            :size="14"
            :stroke-width="1.7"
            class="pointer-events-none absolute text-accent"
          />
          <input
            type="checkbox"
            class="absolute inset-0 h-[16px] w-[16px] cursor-pointer transition-opacity"
            :class="checked.has(b.id) ? 'opacity-0' : 'opacity-0 group-hover/row:opacity-100'"
            :checked="checked.has(b.id)"
            :aria-label="t('cleanup.gc.needsYou.selectRow', { name: b.name })"
            data-testid="needs-you-check"
            @click.stop
            @change="emit('toggle', b.id)"
          />
        </span>

        <span class="flex min-w-0 flex-col">
          <span class="truncate text-[12.5px] text-text" :title="b.name">{{ b.name }}</span>
          <span class="truncate text-[11px] text-text-4" data-testid="needs-you-sub">{{
            sub(b)
          }}</span>
        </span>

        <span class="min-w-0 text-[12.5px] text-text-2" data-testid="needs-you-reason">
          {{ reasonOf(b) }}
        </span>

        <span class="text-right text-[12.5px] tabular-nums text-text">{{ sizeOf(b) }}</span>

        <span class="flex items-center justify-end gap-1" @click.stop>
          <button
            v-if="canDehydrateBlock(b)"
            type="button"
            class="flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:bg-surface-2 hover:text-text"
            :aria-label="t('cleanup.gc.needsYou.dehydrateAria', { name: b.name })"
            :title="t('cleanup.gc.needsYou.dehydrateAria', { name: b.name })"
            data-testid="needs-you-dehydrate"
            @click="emit('dehydrate', b.id)"
          >
            <PackageMinus :size="13" :stroke-width="1.7" />
          </button>
          <button
            v-if="b.kind === 'worktree'"
            type="button"
            class="flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:bg-surface-2 hover:text-text"
            :aria-label="t('cleanup.gc.needsYou.keepAria', { name: b.name })"
            :title="t('cleanup.gc.needsYou.keepAria', { name: b.name })"
            data-testid="needs-you-keep"
            @click="emit('keep', b.id)"
          >
            <Bookmark :size="13" :stroke-width="1.7" />
          </button>
          <button
            type="button"
            class="flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:border-red hover:bg-red-soft hover:text-red"
            :aria-label="t('cleanup.gc.needsYou.removeAria', { name: b.name })"
            :title="t('cleanup.gc.needsYou.removeAria', { name: b.name })"
            data-testid="needs-you-remove"
            @click="emit('remove', b.id)"
          >
            <Trash2 :size="13" :stroke-width="1.7" />
          </button>
        </span>
      </div>

      <div v-if="!showAll && hiddenCount > 0" class="flex justify-center py-2">
        <Button variant="ghost" data-testid="needs-you-show-all" @click="showAll = true">
          {{ t('cleanup.gc.needsYou.showAll', { count: blocks.length }) }}
        </Button>
      </div>
    </div>

    <footer
      class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2.5 text-[11px] text-text-3"
    >
      <span class="inline-flex items-center gap-1">
        <kbd class="rounded-[3px] border border-border bg-surface-2 px-1.5 font-mono text-[10.5px]"
          >⇧</kbd
        >
        {{ t('cleanup.gc.needsYou.hintShift') }}
      </span>
      <span class="inline-flex items-center gap-1">
        <kbd class="rounded-[3px] border border-border bg-surface-2 px-1.5 font-mono text-[10.5px]"
          >↩</kbd
        >
        {{ t('cleanup.gc.needsYou.hintOpen') }}
      </span>
    </footer>
  </section>
</template>
