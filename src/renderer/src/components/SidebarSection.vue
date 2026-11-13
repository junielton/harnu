<script setup lang="ts">
/**
 * SidebarSection (T702, design.md §6 "Sidebar sections") — the generic shell of a section stacked
 * between the folder-list island and the dock: an eyebrow with a collapse chevron, a body that
 * scrolls, and a horizontal resize handle on the top edge. It knows nothing about what a section
 * shows; the eyebrow content and the body come in through slots, the section's own attributes
 * (`data-island`, `data-testid`) land on the island.
 *
 * Mounting a second section is just this (the host decides when it renders, e.g. `v-if`, and the
 * size / collapsed state survives that because it is keyed by `id`, see `useSidebarSections.ts`):
 *
 *   <SidebarSection id="queue" :label="$t('sidebar.queue.title')" data-island="sidebar-queue">
 *     <template #eyebrow>{{ $t('sidebar.queue.title') }} · {{ n }}</template>
 *     <QueueRows />
 *   </SidebarSection>
 *
 * Height: until the operator drags the handle the section is content-sized and capped at
 * `autoMaxHeight` (exactly what it was before it was resizable). A dragged height is stored per id
 * and clamped to `[minHeight, maxHeight]` and to what leaves the folder list its minimum
 * (`lib/sidebar-section.ts`). Double-click on the handle forgets it again. Collapsed, the section
 * is its eyebrow row only and has no handle.
 */
import { computed, onBeforeUnmount, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight } from 'lucide-vue-next'
import {
  SECTION_MAX_HEIGHT,
  SECTION_MIN_HEIGHT,
  SIDEBAR_LIST_MIN_HEIGHT,
  dragCeiling,
  heightFromDrag
} from '../lib/sidebar-section'
import { useSidebarSection } from '../composables/useSidebarSections'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    /** Stable id: the persistence key (`om2tab.sidebarSection.<id>`). */
    id: string
    /** The section's name as the operator reads it; used in the chevron and handle labels. */
    label: string
    /** `warning` paints the eyebrow in `--color-warning`; the default is `--text-4`. */
    tone?: 'default' | 'warning'
    /** Drag floor: the eyebrow plus one row. */
    minHeight?: number
    /** Drag ceiling, before the folder list's own minimum is taken into account. */
    maxHeight?: number
    /** CSS `max-height` while the operator has not dragged (any CSS length expression). */
    autoMaxHeight?: string
    /** The flex-filling island above, which keeps `SIDEBAR_LIST_MIN_HEIGHT` while this one grows. */
    listSelector?: string
  }>(),
  {
    tone: 'default',
    minHeight: SECTION_MIN_HEIGHT,
    maxHeight: SECTION_MAX_HEIGHT,
    autoMaxHeight: '168px',
    listSelector: '[data-island="sidebar-list"]'
  }
)

const { t } = useI18n()
const section = useSidebarSection(props.id)
const bodyId = useId()
const rootEl = ref<HTMLElement | null>(null)

const collapsed = section.collapsed
const sized = computed(() => section.height.value !== null)

/** Wrapper sizing. Content-sized and capped until dragged (as before T702); then an explicit height
 *  that yields to the folder list's minimum when the window gets shorter. */
const rootStyle = computed(() => {
  if (collapsed.value) return { flex: '0 0 auto' }
  if (section.height.value !== null) {
    return {
      flex: '0 1 auto',
      height: `${section.height.value}px`,
      minHeight: `${props.minHeight}px`
    }
  }
  return { flex: '0 0 auto', maxHeight: props.autoMaxHeight }
})

const toggleLabel = computed(() =>
  t(collapsed.value ? 'sidebar.section.expand' : 'sidebar.section.collapse', { name: props.label })
)

/** Mirrors the CSS the list island carries (`min(160px, 40vh)`), so JS and CSS agree. */
function listMinHeight(): number {
  return Math.min(SIDEBAR_LIST_MIN_HEIGHT, window.innerHeight * 0.4)
}

// ── Resize handle ─────────────────────────────────────────────────────────────────────────────
// Same mold as the sidebar / helper-stack dividers (mousedown → document mousemove/mouseup, 1:1
// with the pointer, no easing), on the Y axis. The handle is on the TOP edge, so up = taller.
interface Drag {
  startY: number
  startHeight: number
  ceiling: number
}
let drag: Drag | null = null

function onHandleMouseDown(ev: MouseEvent): void {
  const root = rootEl.value
  if (!root) return
  ev.preventDefault()
  const startHeight = root.offsetHeight
  const list = root.parentElement?.querySelector<HTMLElement>(props.listSelector)
  const ceiling = list
    ? dragCeiling({
        startHeight,
        listHeight: list.offsetHeight,
        listMin: listMinHeight(),
        max: props.maxHeight
      })
    : props.maxHeight
  drag = { startY: ev.clientY, startHeight, ceiling }
  document.addEventListener('mousemove', onHandleMouseMove)
  document.addEventListener('mouseup', stopDrag)
}

function onHandleMouseMove(ev: MouseEvent): void {
  if (!drag) return
  section.setHeight(
    heightFromDrag({
      startHeight: drag.startHeight,
      startY: drag.startY,
      y: ev.clientY,
      min: props.minHeight,
      max: props.maxHeight,
      ceiling: drag.ceiling
    })
  )
}

function stopDrag(): void {
  drag = null
  document.removeEventListener('mousemove', onHandleMouseMove)
  document.removeEventListener('mouseup', stopDrag)
}

onBeforeUnmount(stopDrag)
</script>

<template>
  <div
    ref="rootEl"
    class="relative flex flex-col"
    :style="rootStyle"
    :data-section="id"
    :data-section-sized="sized ? '' : undefined"
  >
    <!-- Resize handle: the horizontal variant of the T627 divider, on the section's top edge, just
         above the island (in the gap with Floating panels on). Transparent at rest: the island's
         own top rule already draws the edge; the line shows on hover. -->
    <div
      v-if="!collapsed"
      class="group absolute inset-x-0 bottom-full z-10 flex h-1.5 cursor-row-resize items-end"
      data-float-divider
      data-section-handle
      role="separator"
      aria-orientation="horizontal"
      :aria-label="$t('sidebar.section.resize', { name: label })"
      @mousedown="onHandleMouseDown"
      @dblclick="section.reset()"
    >
      <div class="h-px w-full bg-transparent transition-colors group-hover:bg-accent-line" />
    </div>

    <div v-bind="$attrs" class="flex min-h-0 flex-auto flex-col">
      <!-- 1px zone divider (--border) separating the folder list from the section. Off, it is the
           rule above the section (the dock draws its own below); Floating panels hides it, the
           island gap does that job. -->
      <div data-section-divider class="shrink-0 border-t border-border" aria-hidden="true" />

      <!-- Section-label eyebrow (design.md §6): uppercase 10.5px / 500 / 0.06em, --text-4 (or
           --color-warning). The slot is the title and whatever sits beside it; the chevron is
           pushed to the right end and always stays visible, collapsed or not. -->
      <div
        class="flex shrink-0 items-center"
        :class="tone === 'warning' ? 'text-warning' : 'text-text-4'"
        style="
          padding: 8px 12px 4px 12px;
          gap: 4px;
          font-size: 10.5px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        "
      >
        <slot name="eyebrow" />
        <button
          type="button"
          class="ml-auto flex shrink-0 cursor-pointer items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
          style="width: 16px; height: 16px"
          :aria-expanded="!collapsed"
          :aria-controls="bodyId"
          :aria-label="toggleLabel"
          :title="toggleLabel"
          data-section-toggle
          @click="section.toggleCollapsed()"
        >
          <component :is="collapsed ? ChevronRight : ChevronDown" :size="12" :stroke-width="1.8" />
        </button>
      </div>

      <!-- Body: the only part that scrolls. `v-show`, not `v-if`: collapsing must not throw away what
           the section keeps in it (a card the operator expanded). -->
      <div
        v-show="!collapsed"
        :id="bodyId"
        class="scrollable min-h-0 flex-1 overflow-y-auto"
        data-section-body
      >
        <slot />
      </div>
    </div>
  </div>
</template>
