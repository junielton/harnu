<script setup lang="ts">
/**
 * The folder avatar (design.md "System Monitor (takeover)" → "Folder avatar"): the
 * folder's initial in a rounded square tinted with the folder hue (`--fh`, set by the
 * owning `.fh-*` class). 30px on a card, 18px in a table row.
 */
defineProps<{ initial: string; size: 'lg' | 'sm' }>()
</script>

<template>
  <span
    class="flex shrink-0 items-center justify-center bg-[color-mix(in_srgb,var(--fh)_18%,transparent)] font-bold text-[var(--fh)]"
    :class="
      size === 'lg'
        ? 'h-[30px] w-[30px] rounded text-[13px]'
        : 'h-[18px] w-[18px] rounded-sm text-[10px]'
    "
    aria-hidden="true"
    >{{ initial }}</span
  >
</template>
