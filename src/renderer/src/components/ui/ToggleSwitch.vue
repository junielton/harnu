<script setup lang="ts">
/**
 * Canonical boolean toggle — the ONE on/off control for the whole app.
 * Slider (track + knob); the track fills with `--accent` when on so the state
 * reads without depending on colour alone. design.md §6 "Toggle".
 *
 * Replaces every hand-rolled toggle (the old Enabled/Disabled pills and the
 * bespoke Claude-config switch). If the toggle look needs to change, it changes
 * here and nowhere else.
 */
const model = defineModel<boolean>({ required: true })
withDefaults(defineProps<{ disabled?: boolean; ariaLabel?: string }>(), {
  disabled: false,
  ariaLabel: undefined
})

function toggle(): void {
  model.value = !model.value
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    :aria-label="ariaLabel"
    :disabled="disabled"
    class="relative shrink-0 rounded-full border border-border-2 disabled:cursor-not-allowed disabled:opacity-40"
    :class="model ? 'bg-accent' : 'bg-surface-2'"
    style="width: 34px; height: 20px; transition: background-color var(--dur) var(--ease)"
    @click="toggle"
  >
    <span
      class="absolute rounded-full"
      :class="model ? 'bg-accent-ink' : 'bg-text-3'"
      style="top: 2px; width: 14px; height: 14px; transition: left var(--dur) var(--ease)"
      :style="{ left: model ? '16px' : '2px' }"
    />
  </button>
</template>
