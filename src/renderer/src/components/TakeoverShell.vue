<script setup lang="ts">
/**
 * T300 (T297 U3) — the one root + header every main-pane takeover renders
 * through. Applied by `TakeoverHost.vue`, never imported by the six views
 * themselves (design.md §6 "TakeoverShell — shared chrome"): a view cannot
 * render without it, and has no way to opt out.
 *
 * A view's own header content (its icon, a repo label, a KPI line, the WIP
 * chip, …) still lives in the view — it reaches the header via `<Teleport>`
 * to the two landing zones below, not via a `<slot>`. A dynamically swapped
 * child (`<component :is>` in `TakeoverHost`) cannot fill a named slot of the
 * ancestor wrapping it: Vue slots only flow parent → child, and the flow
 * needed here is the opposite. Singleton-safe: `stores/ui.ts`'s takeover
 * mutex guarantees exactly one `TakeoverShell` is ever mounted at a time, so
 * there is never a second instance to race for these landing zones.
 */
import { computed } from 'vue'
import { X } from 'lucide-vue-next'

const props = defineProps<{ titleKey: string }>()
defineEmits<{ close: [] }>()

/**
 * Every view's close-button i18n key has always followed this convention
 * (`roadmap.title` → `roadmap.close`, `review.title` → `review.close`, …) —
 * deriving it from `titleKey` reuses each view's exact existing close text
 * instead of inventing a new shared "Close" string (design.md §6, AC-7).
 */
const closeKey = computed(() => props.titleKey.replace(/\.title$/, '.close'))
</script>

<template>
  <div class="flex h-full w-full min-h-0 flex-col bg-bg" :aria-label="$t(titleKey)">
    <header
      class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-text-2"
    >
      <span id="takeover-shell-icon" class="contents" />
      <span class="text-[13px] font-medium text-text">{{ $t(titleKey) }}</span>
      <span id="takeover-shell-actions" class="contents" />
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 22px; height: 22px"
        :title="$t(closeKey)"
        :aria-label="$t(closeKey)"
        @click="$emit('close')"
      >
        <X :size="14" :stroke-width="1.6" />
      </button>
    </header>
    <slot />
  </div>
</template>
