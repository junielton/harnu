<script setup lang="ts">
/**
 * Canonical drop-to-pin affordance — shown while a folder dragged out of the
 * OS file manager hovers a surface that accepts it. design.md §6 "Dropping a
 * folder onto the sidebar".
 *
 * A scrim over the host's own content framing a pulsing dashed drop-target box
 * with a centered icon and label. `pointer-events-none` keeps it out of the
 * drag hit-testing, so appearing under the cursor never fires a spurious
 * `dragleave`. Pair it with `useFolderDrop()`, which owns the handlers.
 *
 * The host must be `position: relative`. `scrim` names the token to dim
 * against — whichever surface the overlay actually sits on.
 */
import { ArrowDownToLine } from 'lucide-vue-next'
import { computed } from 'vue'

const props = withDefaults(defineProps<{ scrim?: 'sidebar' | 'bg' }>(), { scrim: 'sidebar' })

const background = computed(
  () =>
    `color-mix(in srgb, var(--color-${props.scrim === 'bg' ? 'bg' : 'sidebar'}) 94%, transparent)`
)
</script>

<template>
  <div
    class="anim-overlay-fade pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2.5"
    :style="{ background }"
  >
    <div
      class="anim-drop-pulse absolute rounded-lg border-2 border-dashed border-accent"
      style="inset: 10px"
    />
    <ArrowDownToLine :size="30" :stroke-width="1.6" class="text-accent" />
    <span
      class="text-text-2"
      style="max-width: calc(100% - 40px); text-align: center; font-size: 13px; font-weight: 500"
    >
      {{ $t('sidebar.dropHint') }}
    </span>
  </div>
</template>
