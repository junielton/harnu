<script setup lang="ts">
/**
 * Mission dropdown — the shell (Missions v4; design.md §6 "Mission dropdown" → "Anchoring, size, scroll"
 * and "Keyboard and focus"; mockup `docs/design/mission-dropdown/`).
 *
 * A teleported, non-modal `role="dialog"` layer that hangs under the Topbar pill: `position: fixed` on
 * `--z-dialog`, 6px under the Topbar's bottom edge, its left edge on the pill's (flipped to the right edge
 * near the window's), 8px clear of every window edge (`lib/mission-dropdown-position.ts`). It is a column:
 * the **body** is the one scroller (`.scrollable`, a size container), the **footer** is pinned under it —
 * and under 420px of window height it scrolls with the body instead.
 *
 * Its open state is the existing `ui.popovers.missionProgress` flag, so the App's Esc binding and
 * `anyPopoverOpen` order it with the other popovers. It closes on Esc (focus goes back to the pill), on a
 * click outside it (one that lands on a dialog does not count), and on the pill again — the pill and the
 * `view.missionProgress` chord flip the same flag, so a click on the pill is left to the pill. A door that
 * ends the mission calls the `close` this component exposes.
 *
 * This slice (S-1) draws no content: the body and the footer are slots the next slices fill. The pill
 * still opens the Mission pane; nothing here is reachable by a user until S-7 switches the pill over.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFocusTrap } from '../composables/useFocusTrap'
import {
  DROPDOWN_SHORT_WINDOW,
  placeMissionDropdown,
  type DropdownAnchor
} from '../lib/mission-dropdown-position'
import { useUiStore } from '../stores/ui'

const props = defineProps<{
  /**
   * The pill's rectangle, when the caller knows it. Without it the dropdown reads the Topbar pill from
   * the page (`PILL_SELECTOR`), and with no pill at all it sits on the left margin.
   */
  anchorRect?: DropdownAnchor | null
}>()

const { t } = useI18n()
const ui = useUiStore()

/** The Topbar pill (`MissionPill.vue` draws `data-dsqa="topbar-pill--<tone>"`). */
const PILL_SELECTOR = '[data-dsqa^="topbar-pill--"]'

const open = computed(() => ui.popovers.missionProgress)
const root = ref<HTMLElement | null>(null)

/** The window's size, kept current while the layer is up. */
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
/** The pill's rectangle, read when the layer opens and when the window resizes. */
const pillRect = ref<DropdownAnchor | null>(null)

function pill(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PILL_SELECTOR)
}

function measure(): void {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  const el = pill()
  if (el) {
    const r = el.getBoundingClientRect()
    pillRect.value = { left: r.left, right: r.right }
  } else {
    pillRect.value = null
  }
}

const placement = computed(() =>
  placeMissionDropdown({
    anchor: props.anchorRect ?? pillRect.value,
    viewport: viewport.value
  })
)

/** Under 420px of window height the footer scrolls with the body instead of staying pinned. */
const footerInBody = computed(() => viewport.value.height < DROPDOWN_SHORT_WINDOW)

/** Close it. What a door that ends the mission calls (AC-17). */
function close(): void {
  ui.closePopover('missionProgress')
}
defineExpose({ close })

// ---- focus -----------------------------------------------------------------------------------------
// Tab and Shift+Tab cycle inside it; initial focus is on the dropdown itself (`tabindex="-1"`) while no
// card is owed (S-2 hands it to the card's button).
useFocusTrap({ active: open, containerRef: root, initialFocusRef: root })

/** Set by Esc: when the layer has gone, focus goes back to the pill. */
let returnFocusToPill = false

watch(
  open,
  async (isOpen) => {
    if (isOpen) {
      measure()
      await nextTick()
      document.addEventListener('click', onClickOutside, true)
      window.addEventListener('keydown', onKeydown)
      window.addEventListener('resize', measure)
    } else {
      detach()
    }
  },
  { immediate: true }
)
// After the trap has given focus back to whatever held it, Esc puts it on the pill.
watch(
  open,
  (isOpen) => {
    if (isOpen || !returnFocusToPill) return
    returnFocusToPill = false
    pill()?.focus()
  },
  { flush: 'post' }
)

function detach(): void {
  document.removeEventListener('click', onClickOutside, true)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', measure)
}
onBeforeUnmount(detach)

/** Another dialog is on top of this one (a close confirm): it owns Esc and clicks. */
function dialogOnTop(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"]')).some((d) => d !== root.value)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || !open.value) return
  if (dialogOnTop()) return
  returnFocusToPill = true
  close()
}

function onClickOutside(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target
  if (!(target instanceof Node)) return
  if (root.value?.contains(target)) return
  // The pill toggles the flag itself; closing here too would reopen it on the same click.
  if (pill()?.contains(target)) return
  // A click that lands on a dialog (the close confirm opened from here) does not close it.
  const el = target instanceof Element ? target : target.parentElement
  if (el?.closest('[role="dialog"]')) return
  close()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="root"
      role="dialog"
      tabindex="-1"
      :aria-label="t('missionDropdown.shell.label')"
      data-test="mission-dropdown"
      data-dsqa="mission-dropdown"
      class="anim-fade-in-scale fixed z-(--z-dialog) flex max-h-[min(640px,calc(100vh-56px))] w-[min(420px,calc(100vw-16px))] origin-top-left flex-col rounded-lg border border-border-2 bg-surface text-text shadow-pop outline-none [-webkit-app-region:no-drag]"
      :style="{ top: `${placement.top}px`, left: `${placement.left}px` }"
    >
      <div
        class="scrollable @container min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        data-test="mission-dropdown-body"
      >
        <slot />
        <div v-if="footerInBody" data-test="mission-dropdown-footer">
          <slot name="footer" />
        </div>
      </div>
      <div v-if="!footerInBody" class="shrink-0" data-test="mission-dropdown-footer">
        <slot name="footer" />
      </div>
    </div>
  </Teleport>
</template>
