<script setup lang="ts">
/**
 * One section of the sidebar's bottom dock (design.md §6 "Bottom dock"): a one-line head
 * (label · count · age · chevron) over a body that is capped and scrolls. It knows nothing about
 * what it holds. With nothing in it, it renders nothing and folds itself, so it never comes back
 * already open; whether it is open belongs to the caller, so only an operator gesture opens it.
 */
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { formatClock } from '../lib/your-move-view'

const props = defineProps<{
  /** `data-dock` value and the Floating panels island name. */
  dock: 'needs-you' | 'return-here'
  island: 'sidebar-needs-you' | 'sidebar-return'
  label: string
  count: number
  /** When the oldest item arrived (epoch ms). */
  oldestAt: number
  open: boolean
  /** `data-testid` of the head's text line (label, count, age). */
  lineTestid?: string
}>()
const emit = defineEmits<{ toggle: []; fold: [] }>()

const bodyId = useId()

// One clock per section, running only while it is on screen.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
function stop(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}
watch(
  () => props.count > 0,
  (shown) => {
    stop()
    if (!shown) return
    now.value = Date.now()
    timer = setInterval(() => (now.value = Date.now()), 1000)
  },
  { immediate: true }
)
onBeforeUnmount(stop)

// An empty section is folded, also when a gesture asks for it while there is nothing to show.
watch(
  [() => props.count, () => props.open],
  ([count, open]) => {
    if (count === 0 && open) emit('fold')
  },
  { immediate: true, flush: 'post' }
)

const age = computed(() => formatClock(now.value - props.oldestAt))
</script>

<template>
  <!-- `min-h` is the head's own height: on a short window an open body gives way, never the head. -->
  <section
    v-if="count > 0"
    :data-dock="dock"
    :data-dsqa-part="dock"
    :data-island="island"
    class="flex min-h-[34px] flex-col border-t border-border"
  >
    <button
      type="button"
      data-dock-head
      class="flex w-full min-w-0 shrink-0 cursor-pointer items-baseline whitespace-nowrap text-left tabular-nums text-text-2 transition hover:bg-surface-2"
      style="gap: 6px; padding: 8px 12px; font-size: 12px; font-weight: 500; line-height: 17px"
      :aria-expanded="open"
      :aria-controls="bodyId"
      @click="$emit('toggle')"
    >
      <span class="contents" :data-testid="lineTestid">
        <span class="min-w-0 truncate">{{ label }}</span>
        {{ ' ' }}
        <span class="shrink-0 text-warning" style="font-weight: 600">{{ count }}</span>
        {{ ' ' }}
        <span class="shrink-0 text-text-4" style="font-size: 11px; font-weight: 400">{{
          age
        }}</span>
      </span>
      <ChevronRight
        data-dock-chevron
        :size="12"
        :stroke-width="1.8"
        class="ml-auto shrink-0 self-center text-text-4 transition-transform"
        :class="open && 'rotate-90'"
        aria-hidden="true"
      />
    </button>
    <!-- `v-show`, not `v-if`: folding must not throw away what a row keeps (an expanded card). -->
    <div
      v-show="open"
      :id="bodyId"
      data-dock-body
      class="scrollable min-h-0 flex-1 overflow-y-auto"
      style="max-height: min(380px, 45vh); padding: 2px 0 6px"
    >
      <slot />
    </div>
  </section>
</template>
