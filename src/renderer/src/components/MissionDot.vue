<script setup lang="ts">
/**
 * One state glyph of the mission UI (Missions v4 mission dropdown S-3, card BUG-285; design.md §6 "Mission
 * dropdown" → "Dots and glyphs"; mockup `docs/design/mission-dropdown/`, state `dots`).
 *
 * A 12px circle (a square for a criterion) that says its state in words, never by colour alone: a
 * `role="img"` with an `aria-label`, and the same words in a tooltip on hover and on focus. The tooltip is
 * teleported to `body` (`position: fixed`, so the dropdown's scroller never clips it): `11px`,
 * `bg-surface-2`, `border-border-2`, `shadow-pop`, above the glyph, or below it when there is no room above.
 *
 * Focus: a glyph is not a tab stop. It shows its label when the row that holds it (the closest
 * `role="treeitem"`) takes focus, so an arrow key through the tree reads every state aloud and on screen.
 *
 * It computes no state: it draws the one the server gave (a milestone's, a step's, a criterion's), plus the
 * blocked mark, which replaces the step's own glyph.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Flag } from 'lucide-vue-next'
import { glyphOf, stateKeyOf, type DotKind } from '../lib/mission-dropdown-tree'

const props = withDefaults(
  defineProps<{
    kind: DotKind
    /** The server's identifier for the level: a milestone's, a step's, or `open` / `settled` for a criterion. */
    state: string
    /** A blocked step draws the flag in place of its state's glyph. */
    blocked?: boolean
    /** The current milestone keeps its halo. */
    current?: boolean
  }>(),
  { blocked: false, current: false }
)

const { t } = useI18n()

const glyph = computed(() => glyphOf(props.kind, props.state, props.blocked))
const label = computed(() =>
  t(`missionDropdown.state.${props.kind}.${stateKeyOf(props.kind, props.state, props.blocked)}`)
)

// ---- the tooltip -------------------------------------------------------------------------------------
const tipId = `mission-dot-tip-${useId()}`

const el = ref<HTMLElement | null>(null)
const tip = ref<HTMLElement | null>(null)
const hovered = ref(false)
const focused = ref(false)
const shown = computed(() => hovered.value || focused.value)

const GAP = 6
const EDGE = 8

/**
 * Put the tooltip next to the glyph once it is drawn (a post-flush watcher, so a test or a reader sees it placed
 * when the tick is over): above it, centred and kept 8px inside the window; below when there is no room above.
 */
function place(): void {
  const g = el.value?.getBoundingClientRect()
  const node = tip.value
  if (!g || !node) return
  const r = node.getBoundingClientRect()
  const above = g.top - r.height - GAP >= EDGE
  const top = above ? g.top - r.height - GAP : g.bottom + GAP
  const left = Math.min(
    Math.max(g.left + g.width / 2 - r.width / 2, EDGE),
    Math.max(EDGE, window.innerWidth - r.width - EDGE)
  )
  node.style.top = `${top}px`
  node.style.left = `${left}px`
  node.dataset.placement = above ? 'above' : 'below'
}
watch(shown, (isShown) => isShown && place(), { flush: 'post' })

// The row that holds the glyph: its focus is the glyph's focus.
let host: HTMLElement | null = null
const onFocusIn = (e: Event): void => {
  if (e.target === host) focused.value = true
}
const onFocusOut = (e: Event): void => {
  if (e.target === host) focused.value = false
}
onMounted(() => {
  host = el.value?.closest<HTMLElement>('[role="treeitem"]') ?? null
  host?.addEventListener('focusin', onFocusIn)
  host?.addEventListener('focusout', onFocusOut)
})
onBeforeUnmount(() => {
  host?.removeEventListener('focusin', onFocusIn)
  host?.removeEventListener('focusout', onFocusOut)
})
</script>

<template>
  <span
    ref="el"
    class="relative flex shrink-0 cursor-help items-center justify-center"
    :class="[
      kind === 'criterion' ? 'rounded-sm' : 'rounded-full',
      current ? 'ring-3 ring-accent-soft' : ''
    ]"
    style="width: 12px; height: 12px"
    role="img"
    :aria-label="label"
    :aria-describedby="shown ? tipId : undefined"
    :data-dot="kind"
    :data-glyph="glyph"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <span
      v-if="glyph === 'done'"
      class="flex items-center justify-center rounded-full bg-green"
      style="width: 12px; height: 12px"
      ><Check :size="8" :stroke-width="3" class="text-bg"
    /></span>
    <span
      v-else-if="glyph === 'settled'"
      class="flex items-center justify-center rounded-sm bg-green"
      style="width: 12px; height: 12px"
      ><Check :size="8" :stroke-width="3" class="text-bg"
    /></span>
    <span
      v-else-if="glyph === 'running'"
      class="rounded-full bg-accent"
      style="width: 8px; height: 8px"
    />
    <span
      v-else-if="glyph === 'review'"
      class="rounded-full border-[1.5px] border-accent"
      style="width: 8px; height: 8px"
    />
    <Flag v-else-if="glyph === 'blocked'" :size="12" :stroke-width="2" class="text-red" />
    <span
      v-else-if="glyph === 'box'"
      class="rounded-sm border-[1.5px] border-text-3"
      style="width: 12px; height: 12px"
    />
    <span
      v-else
      class="rounded-full border-[1.5px] border-text-4"
      style="width: 8px; height: 8px"
    />
    <Teleport to="body">
      <span
        v-if="shown"
        :id="tipId"
        ref="tip"
        role="tooltip"
        class="pointer-events-none fixed top-0 left-0 z-(--z-palette) whitespace-nowrap rounded-sm border border-border-2 bg-surface-2 text-text shadow-pop"
        style="font-size: 11px; line-height: 1.3; padding: 3px 7px"
        data-test="dot-tooltip"
        >{{ label }}</span
      >
    </Teleport>
  </span>
</template>
