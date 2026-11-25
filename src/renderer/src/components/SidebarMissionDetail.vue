<script setup lang="ts">
import { TONE_TEXT_CLASS } from '../lib/mission-view'
import type { ChipModel } from '../stores/missions'

defineProps<{ chip: ChipModel }>()
</script>

<template>
  <span
    data-mission-full
    aria-hidden="true"
    class="sidebar-mission-full absolute inset-y-0 flex items-center pl-2 text-[10.5px] whitespace-nowrap tabular-nums opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease) pointer-events-none group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-within:opacity-100 group-data-[focused=true]:opacity-100"
    :class="TONE_TEXT_CLASS[chip.tone]"
    >{{ chip.text }}</span
  >
</template>
