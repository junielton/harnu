<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import type { Dot } from './session-dot'

/**
 * T790 — the edge strip left where a tucked session was (design.md §6 "Tucking the session away").
 * Vertical on the left edge when the split is side by side, horizontal along the top when stacked.
 * 14px at rest, 20px on hover or keyboard focus; the state dot says what the session is doing and the
 * strip turns amber (blinking dot, "Needs you" tag) when it needs the operator.
 *
 * It only reports gestures: `restore` for a click, Enter or Space; `drag-start` for a mousedown the
 * parent turns into a drag-out (a plain click then still ends in `restore`).
 */
const props = defineProps<{
  orientation: 'vertical' | 'horizontal'
  /** The session's title, or the folder's name when no session is selected. */
  name: string
  dot: Dot
  /** The state in words, as the chip shows it ("Idle", "Waiting for your approval"). */
  stateLabel: string
  /** The folder or branch the session lives in, shown after the state. */
  where: string
  /** The bound chord, rendered for this platform (`Ctrl+Shift+J`), or '' when unbound. */
  chord: string
}>()

const emit = defineEmits<{
  restore: []
  'drag-start': [ev: MouseEvent]
}>()

const horizontal = computed(() => props.orientation === 'horizontal')
const needs = computed(() => props.dot === 'needs-input')

/** The chip shows while the pointer is over the strip or focus is on it. */
const hovered = ref(false)
const focused = ref(false)
const open = computed(() => hovered.value || focused.value)

// The chip can overlap a browser pane's native view: register it so main freezes the view under it.
const chipEl = ref<HTMLElement | null>(null)
useNativeOverlay('session-tuck-chip', chipEl)

const chordKeys = computed(() => (props.chord ? props.chord.split('+') : []))

const DOT_CLASS: Record<Dot, string> = {
  working: 'anim-pulse-dot bg-green',
  'needs-input': 'anim-attention-dot bg-warning',
  failed: 'bg-red',
  stuck: 'border border-red',
  completed: 'bg-text-4',
  archived: 'bg-text-4',
  idle: 'bg-text-4'
}
</script>

<template>
  <button
    type="button"
    class="session-tuck-strip group/tuck relative z-30 flex shrink-0 items-center gap-2.5 border-border bg-sidebar transition-[width,height,background-color,border-color] duration-[var(--dur)] ease-[var(--ease)] hover:bg-surface-2 hover:border-accent-line focus-visible:bg-surface-2 focus-visible:border-accent-line"
    :class="[
      horizontal
        ? 'h-[14px] w-full flex-row border-b px-3 hover:h-[20px] focus-visible:h-[20px] cursor-row-resize'
        : 'w-[14px] h-full flex-col border-r py-3 hover:w-[20px] focus-visible:w-[20px] cursor-col-resize',
      needs
        ? [
            'bg-warning-soft border-warning-line hover:bg-warning-soft focus-visible:bg-warning-soft hover:border-warning-line focus-visible:border-warning-line',
            horizontal ? 'h-[20px]' : 'w-[20px]'
          ]
        : ''
    ]"
    data-test="session-tuck-strip"
    :data-orientation="orientation"
    :data-state="needs ? 'needs' : 'idle'"
    :aria-label="$t('sessionTuck.strip', { name })"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focus="focused = true"
    @blur="focused = false"
    @mousedown="emit('drag-start', $event)"
    @click="emit('restore')"
  >
    <span
      class="shrink-0 rounded-full"
      :class="DOT_CLASS[dot]"
      style="width: 6px; height: 6px"
      data-test="session-tuck-dot"
      aria-hidden="true"
    />
    <!-- The grip gives way to the chevron on hover, and to the "Needs you" tag when amber. -->
    <span
      v-if="!needs"
      class="flex gap-[3px] group-hover/tuck:hidden group-focus-visible/tuck:hidden"
      :class="horizontal ? 'mx-auto flex-row' : 'my-auto flex-col'"
      aria-hidden="true"
    >
      <i
        v-for="n in 3"
        :key="n"
        class="block rounded-full bg-text-disabled"
        style="width: 2px; height: 2px"
      />
    </span>
    <ChevronRight
      v-if="!needs"
      :size="12"
      :stroke-width="2"
      class="hidden text-text-2 group-hover/tuck:block group-focus-visible/tuck:block"
      :class="horizontal ? 'mx-auto rotate-90' : 'my-auto'"
      aria-hidden="true"
    />
    <span
      v-if="needs"
      class="font-semibold uppercase text-warning"
      :class="horizontal ? 'mx-auto' : 'my-auto [writing-mode:vertical-rl] rotate-180'"
      style="font-size: 10px; letter-spacing: 0.06em"
      data-test="session-tuck-tag"
    >
      {{ $t('sessionTuck.needsYou') }}
    </span>

    <span
      v-if="open"
      ref="chipEl"
      class="absolute z-40 w-max cursor-default rounded border border-border-2 bg-surface-2 text-left shadow-pop"
      :class="horizontal ? 'left-2.5 top-[calc(100%+8px)]' : 'left-[calc(100%+8px)] top-2.5'"
      style="max-width: 280px; padding: 8px 10px"
      data-test="session-tuck-chip"
      role="tooltip"
    >
      <span class="flex items-center gap-1.5 font-medium text-text" style="font-size: 12px">
        <span
          class="shrink-0 rounded-full"
          :class="DOT_CLASS[dot]"
          style="width: 6px; height: 6px"
          aria-hidden="true"
        />
        <span class="truncate">{{ name }}</span>
      </span>
      <span class="mt-0.5 block text-text-3" style="font-size: 11px">
        {{ where ? `${stateLabel} · ${where}` : stateLabel }}
      </span>
      <span class="mt-1.5 block text-text-2" style="font-size: 11px">{{
        $t('sessionTuck.hint')
      }}</span>
      <span v-if="chordKeys.length" class="mt-1 flex items-center gap-1 text-text-4">
        <kbd
          v-for="k in chordKeys"
          :key="k"
          class="rounded-xs border border-border-2 bg-bg px-1 font-mono text-text-2"
          style="font-size: 10px; line-height: 1; padding-top: 2px; padding-bottom: 2px"
          >{{ k }}</kbd
        >
      </span>
    </span>
  </button>
</template>
