<script setup lang="ts">
/**
 * The A- / A+ text-size control of the guided walk pane and the Walks library header (T807, design.md §6 "Guided
 * test walk" → Text size). Two compact buttons that step `walkTextScale` through `WALK_TEXT_SCALES`; each is
 * disabled at its end of the range. The setting is shared, so both panes show the same step.
 */
import { computed } from 'vue'
import { WALK_TEXT_SCALES } from '../lib/walk-view'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()
const atMin = computed(() => settings.walkTextScale <= WALK_TEXT_SCALES[0])
const atMax = computed(
  () => settings.walkTextScale >= WALK_TEXT_SCALES[WALK_TEXT_SCALES.length - 1]
)
</script>

<template>
  <span class="flex shrink-0 items-center" data-test="walk-text-size">
    <button
      class="flex shrink-0 items-center justify-center rounded text-[11px] font-semibold text-text-3 transition hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3"
      style="width: 18px; height: 18px"
      :title="$t('testWalk.textSize.smaller')"
      :aria-label="$t('testWalk.textSize.smaller')"
      :disabled="atMin"
      data-test="walk-text-smaller"
      @mousedown.stop
      @click="settings.stepWalkTextScale('smaller')"
    >
      A-
    </button>
    <button
      class="flex shrink-0 items-center justify-center rounded text-[11px] font-semibold text-text-3 transition hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-3"
      style="width: 18px; height: 18px"
      :title="$t('testWalk.textSize.bigger')"
      :aria-label="$t('testWalk.textSize.bigger')"
      :disabled="atMax"
      data-test="walk-text-bigger"
      @mousedown.stop
      @click="settings.stepWalkTextScale('bigger')"
    >
      A+
    </button>
  </span>
</template>
