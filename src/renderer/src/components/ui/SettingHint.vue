<script setup lang="ts">
/**
 * Canonical "info text" — the muted description line under a setting label.
 * One source of truth for the help-copy colour/size so it can never drift back
 * to the unreadable `--text-4` tier on some screens. design.md §3/§6.
 *
 * Sits one step above the quietest tier (`--text-3`, not `--text-4`) so it stays
 * legible in low-contrast themes. Callers may still pass `style`/`class` to tune
 * margins — they merge with the base.
 */
withDefaults(defineProps<{ size?: 'sm' | 'md' }>(), { size: 'md' })
</script>

<template>
  <p
    class="text-text-3"
    :style="{
      fontSize: size === 'sm' ? '10.5px' : '11px',
      lineHeight: 1.5,
      marginTop: '3px'
    }"
  >
    <slot />
  </p>
</template>
