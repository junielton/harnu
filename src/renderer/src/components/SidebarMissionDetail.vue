<script setup lang="ts">
/**
 * The mission text a session row draws on hover or keyboard focus (design.md §6 "Mission chip
 * (compact)"): progress, then the owed count behind the alert icon ("2/5 · ⚠ 7"). No words: the
 * full sentence is the chip's `title` and accessible name, so this overlay is hidden from them.
 */
import { TriangleAlert } from 'lucide-vue-next'
import { TONE_TEXT_CLASS } from '../lib/mission-view'
import type { ChipModel } from '../stores/missions'

defineProps<{
  chip: ChipModel
  /** The row's own `⚠ n` is already in view beside this overlay, so it is not drawn twice. */
  beside?: boolean
}>()
</script>

<template>
  <span
    data-mission-full
    aria-hidden="true"
    class="sidebar-mission-full absolute inset-y-0 flex items-center pl-2 text-[10.5px] whitespace-nowrap tabular-nums opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease) pointer-events-none group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100 group-data-[focused=true]:opacity-100"
    :class="[TONE_TEXT_CLASS[chip.tone], beside && 'pr-2']"
  >
    <template v-if="chip.progress">
      <!-- Half a pixel down, as the resting count: one baseline with the title. -->
      <span class="relative top-[0.5px] whitespace-pre">{{
        beside ? chip.progress : `${chip.progress} · `
      }}</span>
      <template v-if="!beside">
        <TriangleAlert :size="11" :stroke-width="1.7" aria-hidden="true" />
        <span data-mission-owed class="relative top-[0.5px] ml-[3px]">{{ chip.owed }}</span>
      </template>
    </template>
    <span v-else class="relative top-[0.5px]">{{ chip.text }}</span>
  </span>
</template>
