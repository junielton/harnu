<script setup lang="ts">
import { ChevronDown, ChevronUp } from 'lucide-vue-next'

// `open` undefined means the row cannot fold, so no chevron. The explicit default
// matters: Vue would otherwise cast an absent boolean prop to `false` ("folded").
withDefaults(
  defineProps<{
    count?: number
    open?: boolean
    label?: string
  }>(),
  { count: undefined, open: undefined, label: undefined }
)

defineEmits<{ toggle: [] }>()
</script>

<template>
  <!-- The count sits half a pixel down, on the baseline of the larger row label beside it. -->
  <span
    data-value-slot
    data-dsqa-part="value-slot"
    class="relative flex h-4 w-6 shrink-0 items-center justify-end"
  >
    <span
      data-value-count
      class="relative top-[0.5px] text-[10.5px] leading-none text-text-4 tabular-nums transition-opacity duration-(--dur-fast) ease-(--ease)"
      :class="
        open !== undefined &&
        'group-hover:opacity-0 group-focus-visible:opacity-0 group-has-focus-visible:opacity-0 group-data-[focused=true]:opacity-0'
      "
      >{{ count }}</span
    >
    <component
      :is="label ? 'button' : 'span'"
      v-if="open !== undefined"
      data-value-chevron
      :data-folder-chevron="label ? '' : undefined"
      :type="label ? 'button' : undefined"
      :aria-expanded="label ? open : undefined"
      :aria-label="label"
      :aria-hidden="label ? undefined : true"
      class="absolute -top-1 right-0 grid size-6 place-items-center justify-items-end text-text-4 opacity-0 transition-opacity duration-(--dur-fast) ease-(--ease) group-hover:opacity-100 group-focus-visible:opacity-100 group-has-focus-visible:opacity-100 group-data-[focused=true]:opacity-100"
      :class="label && 'cursor-pointer rounded-[var(--float-radius)] hover:bg-border-2'"
      @click="
        (event) => {
          if (label) {
            event.stopPropagation()
            $emit('toggle')
          }
        }
      "
    >
      <component
        :is="open ? ChevronUp : ChevronDown"
        :size="label ? 14 : 13"
        :stroke-width="1.6"
        :class="label ? '-mr-[3.5px]' : '-mr-[3.25px]'"
      />
    </component>
  </span>
</template>
