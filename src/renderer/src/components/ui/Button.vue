<script setup lang="ts">
import { computed } from 'vue'

/**
 * Canonical action-trigger button — the ONE clickable command box for the
 * whole app (design.md §6 "Buttons" + "Form controls — canonical components").
 * Implements the 5 documented variants and the icon-only size exactly.
 *
 * Content is a default slot (call sites keep their own loading-spinner-swap
 * and disabled logic); this component only owns the box: padding, radius,
 * font, gap, hover/active/disabled treatment, per-variant color triple.
 */
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'soft' | 'ghost' | 'danger' | 'success'
    size?: 'md' | 'icon'
    disabled?: boolean
    type?: 'button' | 'submit'
  }>(),
  {
    variant: 'soft',
    size: 'md',
    disabled: false,
    type: 'button'
  }
)

interface VariantClasses {
  border: string
  fill: string
}

const VARIANT: Record<string, VariantClasses> = {
  primary: { border: 'border-transparent', fill: 'bg-accent text-accent-ink hover:brightness-110' },
  soft: { border: 'border-border', fill: 'bg-surface text-text hover:bg-surface-2' },
  ghost: { border: 'border-border', fill: 'bg-transparent text-text-2 hover:bg-surface-2' },
  danger: { border: 'border-red-line', fill: 'bg-transparent text-red hover:bg-red-soft' },
  success: { border: 'border-green-line', fill: 'bg-green-soft text-green hover:brightness-110' }
}

/** An icon-only trigger is always a bare glyph — no border, even for variants
 * that show one at the text-bearing `md` size (design.md §6 "Icon-only size"). */
const borderClass = computed(() =>
  props.size === 'icon' ? 'border-transparent' : VARIANT[props.variant].border
)
const fillClass = computed(() => VARIANT[props.variant].fill)
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    class="btn-base inline-flex shrink-0 items-center justify-center border transition disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98]"
    :class="[borderClass, fillClass, size === 'icon' ? 'btn-icon' : 'btn-md']"
  >
    <slot />
  </button>
</template>

<style scoped>
.btn-base {
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
}
.btn-md {
  padding: 7px 14px;
  gap: 7px;
}
.btn-icon {
  width: 22px;
  height: 22px;
  padding: 0;
}
</style>
