<script setup lang="ts">
/**
 * The step rail's glyph (design.md §6 "Mission progress" → Step rail) as a component, so the
 * Campaign popover draws a chapter or an objective with exactly the glyph the chapter popover
 * draws for its step. One of eight visuals; tokens only. The 12px slot, ring and `title` follow
 * the rail's anatomy. `label` overrides the tooltip (a chapter says "in review", not "waiting").
 */
import { Check, CircleCheck, Contrast, Lock, TriangleAlert, Undo2 } from 'lucide-vue-next'
import type { StepVisual } from '../lib/mission-view'

defineProps<{
  visual: StepVisual
  /** The current marker on a `todo` / `waiting` visual adds the accent ring. */
  current?: boolean
  label: string
}>()
</script>

<template>
  <span
    class="relative flex shrink-0 items-center justify-center rounded-full bg-surface"
    :class="current && (visual === 'todo' || visual === 'waiting') ? 'ring-3 ring-accent-soft' : ''"
    style="width: 12px; height: 12px"
    data-glyph
    :data-visual="visual"
    :title="label"
    role="img"
    :aria-label="label"
  >
    <span
      v-if="visual === 'verified'"
      class="flex items-center justify-center rounded-full bg-green"
      style="width: 12px; height: 12px"
    >
      <Check :size="8" :stroke-width="3" class="text-bg" />
    </span>
    <CircleCheck v-else-if="visual === 'done'" :size="12" :stroke-width="2" class="text-text-3" />
    <span
      v-else-if="visual === 'running'"
      class="anim-pulse-dot rounded-full bg-accent"
      style="width: 8px; height: 8px; --pulse-from: 0.5"
    />
    <Contrast v-else-if="visual === 'waiting'" :size="12" :stroke-width="2" class="text-text-3" />
    <TriangleAlert
      v-else-if="visual === 'blocked'"
      :size="12"
      :stroke-width="2"
      class="text-warning"
    />
    <Lock v-else-if="visual === 'locked'" :size="10" :stroke-width="2" class="text-text-4" />
    <Undo2 v-else-if="visual === 'left-behind'" :size="12" :stroke-width="2" class="text-warning" />
    <span
      v-else
      class="rounded-full border-[1.5px] border-text-4"
      style="width: 8px; height: 8px"
    />
  </span>
</template>
