<script setup lang="ts">
/**
 * T297 U2 (T299) — the single host every main-pane takeover renders through.
 *
 * `App.vue` used to hold a `v-else-if` branch per takeover (six of them); this
 * component replaces all six with one `<component :is>` driven by
 * `ui.activeView`. A view absent from `VIEW_COMPONENTS` below has no way to
 * reach the screen — there is no branch left to add, and so none left to
 * forget (design.md §6 "Takeover dismissal").
 *
 * `VIEW_COMPONENTS` — the `ViewId → Component` map — lives HERE rather than in
 * `stores/ui.ts`'s `VIEW_REGISTRY` deliberately: every one of the seven
 * components already imports `useUiStore`, so importing them back from the
 * store would open a store↔component cycle — exactly what `lib/pane-
 * components.ts`'s header comment calls out avoiding (`HelperStack.vue`, a
 * leaf nothing imports, holds that map for the same reason). Nothing imports
 * `TakeoverHost.vue` besides `App.vue`, so it is safe to be that leaf here too.
 *
 * T300 (U3): every view now renders wrapped in `TakeoverShell` — the shared
 * root + header (design.md §6 "TakeoverShell — shared chrome"). This is the
 * ONLY place that wraps it; a view never imports `TakeoverShell` itself.
 */
import { computed } from 'vue'
import type { Component } from 'vue'
import TakeoverShell from './TakeoverShell.vue'
import RoadmapBoard from './RoadmapBoard.vue'
import PrStackCanvas from './PrStackCanvas.vue'
import CleanupView from './CleanupView.vue'
import UsageDashboard from './UsageDashboard.vue'
import SystemMonitor from './SystemMonitor.vue'
import ReviewPane from './ReviewPane.vue'
import SchedulerView from './SchedulerView.vue'
import ContainersView from './ContainersView.vue'
import { useUiStore } from '../stores/ui'
import type { ViewId } from '../stores/ui'

const ui = useUiStore()

const VIEW_COMPONENTS: Record<ViewId, Component> = {
  roadmap: RoadmapBoard,
  prStack: PrStackCanvas,
  cleanup: CleanupView,
  usageDashboard: UsageDashboard,
  systemMonitor: SystemMonitor,
  review: ReviewPane,
  scheduler: SchedulerView,
  containers: ContainersView
}

const activeComponent = computed<Component | null>(() =>
  ui.activeView ? VIEW_COMPONENTS[ui.activeView.id] : null
)

/**
 * None of the seven components actually declare props today — each reads its
 * own params straight off `stores/ui.ts`'s backward-compat computed getters
 * (e.g. `ui.roadmap.folderPath`). `v-bind` here is still correct to carry per
 * the registry's shape (T297's design): it costs nothing when unused (an
 * undeclared prop just becomes an inert fallthrough attribute), and it is
 * what a future component built against `ViewParams` directly would need.
 */
const activeParams = computed(() => ui.activeView?.params ?? {})
</script>

<template>
  <TakeoverShell
    v-if="activeComponent && ui.activeViewTitleKey"
    :title-key="ui.activeViewTitleKey"
    @close="ui.closeAllTakeovers()"
  >
    <component :is="activeComponent" v-bind="activeParams" />
  </TakeoverShell>
</template>
