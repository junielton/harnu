<script setup lang="ts">
/**
 * Loading placeholder for one Plan-usage row (design.md §6 — Plan usage, estado
 * `loading`). Mirrors `UsageMeter`'s geometry — label line + 3px track + reset
 * line — with neutral `--surface-2` blocks that shimmer via the `.anim-shimmer-dot`
 * helper (§7) while the first `/usage` snapshot is fetched. Purely decorative:
 * `aria-hidden`, no fake numbers. Reduced-motion users get static blocks.
 */
defineProps<{
  /** Varies the label-placeholder width so the rows don't look identical. */
  labelWidth?: number
}>()
</script>

<template>
  <div class="anim-shimmer-dot flex flex-col" style="gap: 3px" aria-hidden="true">
    <div class="flex items-center justify-between">
      <span
        class="rounded-full bg-surface-2"
        :style="{ width: (labelWidth ?? 84) + 'px', height: '8px' }"
      />
      <span class="rounded-full bg-surface-2" style="width: 20px; height: 8px" />
    </div>
    <div class="rounded-full bg-surface-2" style="height: 3px" />
    <span class="rounded-full bg-surface-2" style="width: 52px; height: 8px" />
  </div>
</template>
