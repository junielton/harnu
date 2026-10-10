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
import type { GcOpinion } from '../../../main/gc/gc-wire'
import type { GcBlock } from '../lib/gc-model'
import type { BlockJobState, ItemFailure } from '../lib/gc-jobs'
import { formatBytes } from './system-monitor-format'
import { canDehydrate } from './cleanup-row'
import { reasonKey, refusalKey, removalKey, stepKey } from './cleanup-gc-copy'
import { removability } from '../lib/gc-removability'
import { resumeHint } from '../lib/gc-resume'
import type { GcStep } from '../../../main/gc/pipeline-core'
import Button from './ui/Button.vue'
import CleanupOpinionChip from './CleanupOpinionChip.vue'

/**
 * "Needs review": the ranked list of Needs review items under the map (design.md "Workspace GC — unified
 * Cleanup / Needs review list"). Biggest first; most decisions are taken here, the map is the overview.
 * Hovering a row outlines its block (the `hover` emit), a checkbox in the leading slot multi-selects.
 */

const ROW_CAP = 50

const props = defineProps<{
  blocks: GcBlock[]
  checked: ReadonlySet<string>
  linkedId: string | null
  blockState: (id: string) => BlockJobState | null
  failureOf: (id: string) => ItemFailure | null
  opinionOf: (id: string) => GcOpinion | null
  isAsking: (id: string) => boolean
  /** How many current opinions say safe: "Remove the {n} marked safe" shows only above zero. */
  safeCount: number
}>()

const emit = defineEmits<{
  toggle: [id: string]
  select: [id: string]
  hover: [id: string | null]
  remove: [id: string]
  dehydrate: [id: string]
  keep: [id: string]
  askAll: []
  removeSafe: []
}>()

const { t } = useI18n()

const showAll = ref(false)
const allAsking = computed(
  () => props.blocks.length > 0 && props.blocks.every((b) => props.isAsking(b.id))
)
const visible = computed(() => (showAll.value ? props.blocks : props.blocks.slice(0, ROW_CAP)))
const hiddenCount = computed(() => Math.max(props.blocks.length - ROW_CAP, 0))

function failed(b: GcBlock): boolean {
  return props.blockState(b.id) === 'failed' || props.failureOf(b.id) !== null
}

function reasonOf(b: GcBlock): string {
  const refusal = props.failureOf(b.id)?.refusal
  if (refusal) return t(refusalKey(refusal))
  // Demoted after repeated refusals: say what main kept refusing.
  const v = removability(b)
  if (b.bundle?.reprobeRefusal && !v.ok) return t(removalKey(v.reason))
  return t(reasonKey(b.reasonCode))
}

/** Why Remove is not offered for this row, or null when it is. Main would refuse it, so it is not a button. */
function removeBlockedText(b: GcBlock): string | null {
  const v = removability(b)
  return v.ok ? null : t(removalKey(v.reason))
}

function canDehydrateBlock(b: GcBlock): boolean {
  return !!b.bundle && canDehydrate(b.bundle.item) && props.blockState(b.id) !== 'busy'
}

function sub(b: GcBlock): string {
  if (b.kind === 'volume') {
    return b.project
      ? t('cleanup.gc.review.volumeProject', { project: b.project })
      : t('cleanup.gc.review.volumeUnknown')
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
  <section class="rounded border border-border bg-surface" data-testid="review-list">
    <header class="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
      <span class="eyebrow text-warning">
        {{ t('cleanup.gc.review.title') }}
      </span>
      <span class="text-caption text-text-3" data-testid="review-count">{{ blocks.length }}</span>
      <span class="ml-auto flex flex-wrap items-center gap-2">
        <Button
          v-if="safeCount > 0"
          variant="success"
          data-testid="review-remove-safe"
          @click="emit('removeSafe')"
        >
          <Trash2 :size="13" :stroke-width="1.7" />
          {{ t('cleanup.gc.review.removeSafe', { count: safeCount }, safeCount) }}
        </Button>
        <span :title="t('cleanup.gc.opinion.hint')" class="inline-flex">
          <Button
            variant="soft"
            :disabled="blocks.length === 0 || allAsking"
            data-testid="review-ask-all"
            @click="emit('askAll')"
          >
            <Sparkles :size="13" :stroke-width="1.7" />
            {{ t('cleanup.gc.review.askAll', { count: blocks.length }) }}
          </Button>
        </span>
      </span>
    </header>

    <p v-if="blocks.length === 0" class="px-3 py-6 text-center text-ui text-text-3">
      {{ t('cleanup.gc.review.empty') }}
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
        :aria-label="t('cleanup.gc.review.rowAria', { name: b.name, size: sizeOf(b) })"
        :data-id="b.id"
        data-testid="review-row"
        @click="emit('select', b.id)"
        @keydown="onRowKey($event, b.id)"
        @mouseenter="emit('hover', b.id)"
        @mouseleave="emit('hover', null)"
        @focusin="emit('hover', b.id)"
        @focusout="emit('hover', null)"
      >
        <!-- leading slot: the bucket icon, swapped for a checkbox on hover or when checked -->
        <span class="relative flex h-4 w-4 items-center justify-center">
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
            class="absolute inset-0 h-4 w-4 cursor-pointer transition-opacity"
            :class="checked.has(b.id) ? 'opacity-0' : 'opacity-0 group-hover/row:opacity-100'"
            :checked="checked.has(b.id)"
            :aria-label="t('cleanup.gc.review.selectRow', { name: b.name })"
            data-testid="review-check"
            @click.stop
            @change="emit('toggle', b.id)"
          />
        </span>

        <span class="flex min-w-0 flex-col">
          <span class="truncate text-ui text-text" :title="b.name">{{ b.name }}</span>
          <span class="truncate text-caption text-text-4" data-testid="review-sub">{{
            sub(b)
          }}</span>
        </span>

        <span class="flex min-w-0 flex-col items-start gap-1">
          <span class="min-w-0 text-ui text-text-2" data-testid="review-reason">
            {{ reasonOf(b) }}
          </span>
          <span
            v-if="resumeHint(b)"
            class="text-caption leading-4 text-text-3"
            data-testid="review-resume"
          >
            {{ t('cleanup.gc.review.resume', { step: t(stepKey(resumeHint(b)!.step as GcStep)) }) }}
          </span>
          <CleanupOpinionChip :opinion="opinionOf(b.id)" :pending="isAsking(b.id)" />
        </span>

        <span class="text-right text-ui tabular-nums text-text">{{ sizeOf(b) }}</span>

        <span class="flex items-center justify-end gap-1" @click.stop>
          <button
            v-if="canDehydrateBlock(b) && !resumeHint(b)"
            type="button"
            class="flex h-6.5 w-6.5 items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:bg-surface-2 hover:text-text"
            :aria-label="t('cleanup.gc.review.dehydrateAria', { name: b.name })"
            :title="t('cleanup.gc.review.dehydrateAria', { name: b.name })"
            data-testid="review-dehydrate"
            @click="emit('dehydrate', b.id)"
          >
            <PackageMinus :size="13" :stroke-width="1.7" />
          </button>
          <button
            v-if="b.kind === 'worktree'"
            type="button"
            class="flex h-6.5 w-6.5 items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:bg-surface-2 hover:text-text"
            :aria-label="t('cleanup.gc.review.keepAria', { name: b.name })"
            :title="t('cleanup.gc.review.keepAria', { name: b.name })"
            data-testid="review-keep"
            @click="emit('keep', b.id)"
          >
            <Bookmark :size="13" :stroke-width="1.7" />
          </button>
          <button
            v-if="removeBlockedText(b) === null"
            type="button"
            class="flex h-6.5 w-6.5 items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:border-red hover:bg-red-soft hover:text-red"
            :aria-label="t('cleanup.gc.review.removeAria', { name: b.name })"
            :title="t('cleanup.gc.review.removeAria', { name: b.name })"
            data-testid="review-remove"
            @click="emit('remove', b.id)"
          >
            <Trash2 :size="13" :stroke-width="1.7" />
          </button>
          <!-- A gone folder's row already says how to finish it: no Remove, dimmed or not. -->
          <span
            v-else-if="!resumeHint(b)"
            class="flex h-6.5 w-6.5 cursor-not-allowed items-center justify-center rounded-sm border border-border text-text-disabled"
            role="img"
            :aria-label="removeBlockedText(b) ?? undefined"
            :title="removeBlockedText(b) ?? undefined"
            data-testid="review-remove-blocked"
          >
            <Trash2 :size="13" :stroke-width="1.7" />
          </span>
        </span>
      </div>

      <div v-if="!showAll && hiddenCount > 0" class="flex justify-center py-2">
        <Button variant="ghost" data-testid="review-show-all" @click="showAll = true">
          {{ t('cleanup.gc.review.showAll', { count: blocks.length }) }}
        </Button>
      </div>
    </div>

    <footer
      class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-2.5 text-caption text-text-3"
    >
      <span class="inline-flex items-center gap-1">
        <kbd class="rounded-xs border border-border bg-surface-2 px-1.5 font-mono text-eyebrow"
          >⇧</kbd
        >
        {{ t('cleanup.gc.review.hintShift') }}
      </span>
      <span class="inline-flex items-center gap-1">
        <kbd class="rounded-xs border border-border bg-surface-2 px-1.5 font-mono text-eyebrow"
          >↩</kbd
        >
        {{ t('cleanup.gc.review.hintOpen') }}
      </span>
    </footer>
  </section>
</template>
