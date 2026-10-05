<script setup lang="ts">
/**
 * Canonical segmented / radio button group — the ONE "pick one of N" control.
 * The selected option fills with `--accent-soft` (design.md §9 "selected"); the
 * idle options stay quiet. Replaces every copy-pasted pill row AND the old
 * `<select>` dropdowns (a native select is uglier and off-system — we always
 * prefer buttons when the option count is small).
 *
 * Tri-state support (for the Claude-launch defaults): pass `allowDefault` to get
 * a leading neutral pill that maps to `undefined`, and `inheritedValue` to give
 * the option matching an inherited (not locally-set) value a softer accent.
 *
 * An option may carry a leading `icon` (a lucide component), and a `#trailing`
 * slot renders an extra action after the options (e.g. "Manage…") inside the
 * same wrap group — so the provider picker reuses this instead of forking the
 * pill logic.
 */
import { computed, type Component } from 'vue'

type SegValue = string | number | boolean

interface SegOption {
  value: SegValue
  label: string
  mono?: boolean
  title?: string
  danger?: boolean
  icon?: Component
  /**
   * Disable this ONE option while the rest of the group stays interactive — the
   * documented disabled treatment (opacity 0.4, non-interactive) applied per pill
   * instead of to the whole control. For a choice that is unavailable in the
   * CURRENT context rather than unavailable outright (design.md §6 → "Bundled
   * skills": "This project" with no project selected).
   */
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    options: SegOption[]
    inheritedValue?: SegValue
    allowDefault?: boolean
    defaultLabel?: string
    size?: 'sm' | 'md'
    ariaLabel?: string
    disabled?: boolean
  }>(),
  {
    size: 'md',
    allowDefault: false,
    defaultLabel: 'Default',
    inheritedValue: undefined,
    ariaLabel: undefined,
    disabled: false
  }
)

const model = defineModel<SegValue | undefined>({ required: true })

const ACCENT = 'bg-accent-soft border-accent-line text-accent'
const DANGER = 'bg-red-soft border-red text-red'
const INHERITED = 'bg-surface border-accent-line text-text-2'
const IDLE = 'bg-surface border-border text-text-3'

function optionClass(opt: SegOption): string {
  if (model.value !== undefined && opt.value === model.value) return opt.danger ? DANGER : ACCENT
  if (
    model.value === undefined &&
    props.inheritedValue !== undefined &&
    opt.value === props.inheritedValue
  )
    return INHERITED
  return IDLE
}

const neutralClass = (): string =>
  model.value === undefined && props.inheritedValue === undefined ? ACCENT : IDLE

// Render the catalog options plus, when the current value isn't among them, a
// synthetic pill for it — so an out-of-catalog / orphaned value (legacy config,
// a value from a newer Claude, a deleted-but-still-referenced endpoint) still
// surfaces as selected instead of showing nothing. Single shared mechanism, so
// every call site gets it without each adapter re-implementing the fallback.
const renderedOptions = computed<SegOption[]>(() => {
  const v = model.value
  if (v === undefined || props.options.some((o) => o.value === v)) return props.options
  return [...props.options, { value: v, label: String(v), mono: props.options[0]?.mono }]
})

const iconSize = computed(() => (props.size === 'sm' ? 11 : 13))

function select(v: SegValue | undefined): void {
  if (props.disabled) return
  model.value = v
}

/** Whether one pill is unavailable — the control's own `disabled` wins over it. */
function optionDisabled(opt: SegOption): boolean {
  return props.disabled || opt.disabled === true
}
</script>

<template>
  <div class="flex flex-wrap items-center" style="gap: 4px">
    <!-- role=radiogroup wraps ONLY the radios (display:contents keeps them in the
         outer wrap flow); the #trailing action stays a sibling, not a fake radio. -->
    <div class="contents" role="radiogroup" :aria-label="ariaLabel" :aria-disabled="disabled">
      <button
        v-if="allowDefault"
        type="button"
        role="radio"
        :aria-checked="model === undefined"
        :disabled="disabled"
        class="inline-flex items-center border transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface"
        :class="[neutralClass(), size === 'sm' ? 'seg-sm' : 'seg-md']"
        @click="select(undefined)"
      >
        {{ defaultLabel }}
      </button>
      <button
        v-for="opt in renderedOptions"
        :key="String(opt.value)"
        type="button"
        role="radio"
        :aria-checked="opt.value === model"
        :title="opt.title"
        :disabled="optionDisabled(opt)"
        class="inline-flex items-center border transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface"
        :class="[
          optionClass(opt),
          opt.mono ? 'font-mono' : '',
          size === 'sm' ? 'seg-sm' : 'seg-md'
        ]"
        @click="optionDisabled(opt) ? undefined : select(opt.value)"
      >
        <component
          :is="opt.icon"
          v-if="opt.icon"
          :size="iconSize"
          :stroke-width="1.7"
          class="shrink-0"
          :style="{ marginRight: size === 'sm' ? '5px' : '6px' }"
        />
        {{ opt.label }}
      </button>
    </div>
    <slot name="trailing" />
  </div>
</template>

<style scoped>
/* Sizes mirror the original inline pills (design.md §6). */
.seg-md {
  height: 28px;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 5px;
}
.seg-sm {
  height: 26px;
  padding: 5px 9px;
  font-size: 11.5px;
  border-radius: 5px;
}
</style>
