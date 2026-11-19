<script setup lang="ts">
/**
 * The browser pane's tab strip (browser-tabs spec S-4, design.md §6 "Browser pane" → "Tab strip"). With one tab it
 * draws only the `+` button; with two or more it takes the place of the header's globe and title and draws the tabs,
 * the `+N` button for the tabs that do not fit, and `+`. It holds no page state: it draws the tabs main sent and
 * emits what the operator did (`activate`, `close`, `add`, `menu`); `BrowserPane.vue` relays those to the store.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, Copy, Globe, PanelRight, Plus, RotateCw, X } from 'lucide-vue-next'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import {
  TAB_MENU_ACTIONS,
  TAB_PLUS_PX,
  layoutTabStrip,
  moreListLeft,
  tabFaviconView,
  tabMenuState,
  type TabMenuAction,
  type TabOriginClass
} from '../lib/browser-tabs-view'

interface TabIcon {
  host: string
  origin: TabOriginClass
  letter: string
  src: string | null
}
import { MAX_TABS_PER_PANE, type BrowserTabState } from '../../../shared/browser-tabs'

interface Props {
  tabs: BrowserTabState[]
  activeTabId: string
  /** `false` for a live panel (`page` pane): it keeps one tab, with no `+`. */
  canAdd: boolean
  /** The rendered chords of "New tab" and "Close tab" for their labels (`Ctrl+T`, `Ctrl+W`), or empty. */
  newKeys?: string
  closeKeys?: string
  /** The pane is an agent pane and its folder is at the agent-pane cap: "Move to a new pane" is off. */
  agentPaneAtCap?: boolean
  /** The strip width the layout fits the tabs into. Measured from the strip itself when absent (tests set it). */
  stripWidth?: number
  /** Names this pane's overlays for the native-overlay freeze. */
  paneId?: string
}
const props = withDefaults(defineProps<Props>(), {
  newKeys: '',
  closeKeys: '',
  agentPaneAtCap: false,
  stripWidth: undefined,
  paneId: 'pane'
})
const emit = defineEmits<{
  activate: [tabId: string]
  close: [tabId: string]
  add: []
  menu: [action: TabMenuAction, tabId: string]
}>()

const { t } = useI18n()

const rootEl = ref<HTMLElement | null>(null)
const measured = ref(0)
let observer: ResizeObserver | null = null
// The strip's root only exists from the second tab on, so the observer follows the element, not the mount.
watch(
  rootEl,
  (el) => {
    observer?.disconnect()
    observer = null
    if (!el || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(() => {
      measured.value = el.clientWidth
    })
    observer.observe(el)
    measured.value = el.clientWidth
  },
  { flush: 'post' }
)
onMounted(() => window.addEventListener('pointerdown', onWindowPointerDown, true))
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('pointerdown', onWindowPointerDown, true)
})

const stripW = computed(() => {
  if (props.stripWidth !== undefined) return props.stripWidth
  return measured.value > 0 ? Math.max(0, measured.value - TAB_PLUS_PX) : Number.POSITIVE_INFINITY
})
const layout = computed(() =>
  layoutTabStrip(
    stripW.value,
    props.tabs.map((tab) => tab.tabId),
    props.activeTabId
  )
)
const visibleTabs = computed(() => {
  const keep = new Set(layout.value.visible)
  return props.tabs.filter((tab) => keep.has(tab.tabId))
})
const overflowCount = computed(() => layout.value.overflow.length)
const iconOnly = (tab: BrowserTabState): boolean =>
  layout.value.mode === 'icons' && tab.tabId !== props.activeTabId
const widthPx = (tab: BrowserTabState): number =>
  tab.tabId === props.activeTabId ? layout.value.activeWidth : layout.value.inactiveWidth
const widthOf = (tab: BrowserTabState): string => `${widthPx(tab)}px`
/**
 * The tab list is as wide as its tabs together: a flex container sized by its content would measure the tabs'
 * text, not the widths the layout gives them. It still shrinks when the strip is narrower than that.
 */
const listWidth = computed(
  () => `${visibleTabs.value.reduce((sum, tab) => sum + widthPx(tab), 0)}px`
)

const atLimit = computed(() => props.tabs.length >= MAX_TABS_PER_PANE)
const newTitle = computed(() => {
  if (atLimit.value) return t('browserPane.tabs.limit')
  return props.newKeys
    ? t('browserPane.tabs.new', { keys: props.newKeys })
    : t('browserPane.tabs.newPlain')
})

const titleOf = (tab: BrowserTabState): string => {
  if (tab.hostView === 'start') return t('browserPane.tabs.untitled')
  if (tab.title) return tab.title
  return tabFaviconView(tab).host || t('browserPane.tabs.untitled')
}

/** Favicon images that failed to load: the tab falls back to the host's first letter. */
const brokenIcons = ref<Set<string>>(new Set())
const onIconError = (tabId: string): void => {
  brokenIcons.value = new Set(brokenIcons.value).add(tabId)
}
const faviconOf = (tab: BrowserTabState): TabIcon => {
  const view = tabFaviconView(tab)
  // The host's first letter (spec "Tab strip"), the title's only when the address has no host.
  const letter = view.host.charAt(0) || titleOf(tab).charAt(0)
  return {
    ...view,
    letter,
    src: tab.favicon && !brokenIcons.value.has(tab.tabId) ? tab.favicon : null
  }
}

/* ---- The tab menu and the +N list: two standard context menus over the native view ------------------- */

const menuFor = ref<{ tabId: string; left: number } | null>(null)
const menuEl = ref<HTMLElement | null>(null)
useNativeOverlay(`browser-tab-menu-${props.paneId}`, menuEl)
const moreOpen = ref(false)
const moreLeft = ref(0)
const moreListEl = ref<HTMLElement | null>(null)
useNativeOverlay(`browser-tab-more-${props.paneId}`, moreListEl)

const menuState = computed(() =>
  tabMenuState({ tabCount: props.tabs.length, agentPaneAtCap: props.agentPaneAtCap })
)
const menuRows: Record<TabMenuAction, { icon: typeof Plus | null }> = {
  newRight: { icon: Plus },
  reload: { icon: RotateCw },
  duplicate: { icon: Copy },
  move: { icon: PanelRight },
  closeOthers: { icon: null },
  close: { icon: X }
}
const rowDisabled = (action: TabMenuAction): boolean =>
  (action === 'move' && menuState.value.move.disabled) ||
  (action === 'newRight' && atLimit.value) ||
  (action === 'duplicate' && atLimit.value) ||
  (action === 'closeOthers' && props.tabs.length < 2)

function openMenu(tabId: string, ev: MouseEvent): void {
  moreOpen.value = false
  const el = (ev.currentTarget as HTMLElement | null) ?? null
  // The menu hangs 4px right of the tab's left edge (the mockup's anchor).
  menuFor.value = { tabId, left: (el?.offsetLeft ?? 0) + 4 }
}
function pickMenu(action: TabMenuAction): void {
  const id = menuFor.value?.tabId
  menuFor.value = null
  if (id && !rowDisabled(action)) emit('menu', action, id)
}
async function toggleMore(): Promise<void> {
  menuFor.value = null
  moreOpen.value = !moreOpen.value
  if (!moreOpen.value) return
  const root = rootEl.value
  moreLeft.value = root ? moreListLeft(root.clientWidth, 220) : 4
  // Placed again with the list's real width (it grows with a long title), once it is drawn.
  await nextTick()
  const list = moreListEl.value
  if (root && list) moreLeft.value = moreListLeft(root.clientWidth, list.offsetWidth)
}
function pickMore(tabId: string): void {
  moreOpen.value = false
  emit('activate', tabId)
}
function onWindowPointerDown(ev: PointerEvent): void {
  const target = ev.target as Node | null
  if (menuFor.value && !(target && menuEl.value?.contains(target))) menuFor.value = null
  if (moreOpen.value) {
    const onTrigger = target instanceof Element && target.closest('[data-tab-more-trigger]')
    if (!(target && moreListEl.value?.contains(target)) && !onTrigger) moreOpen.value = false
  }
}
function onMenuKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    menuFor.value = null
    moreOpen.value = false
  }
}
const hostBadge = (tab: BrowserTabState): string => {
  const cls = tabFaviconView(tab).origin
  if (cls === 'local') return 'bg-green-soft text-green'
  if (cls === 'page') return 'bg-accent-soft text-accent'
  return 'bg-surface-2 text-text-2'
}
</script>

<template>
  <!-- One tab (or a live panel): just `+`. -->
  <button
    v-if="tabs.length < 2 && canAdd"
    type="button"
    class="flex shrink-0 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:text-text-disabled disabled:hover:bg-transparent"
    style="width: 18px; height: 18px"
    :disabled="atLimit"
    :title="newTitle"
    :aria-label="$t('browserPane.tabs.newPlain')"
    data-testid="browser-tab-new"
    @mousedown.stop
    @click="emit('add')"
  >
    <Plus :size="12" :stroke-width="1.6" />
  </button>

  <!-- Two or more: the strip takes the place of the globe and the title. -->
  <div
    v-else-if="tabs.length >= 2"
    ref="rootEl"
    class="relative flex min-w-0 flex-1 items-stretch self-stretch"
    role="tablist"
    :aria-label="$t('browserPane.tabs.strip')"
    data-testid="browser-tab-strip"
    data-dsqa-part="tab-strip"
    @keydown="onMenuKeydown"
  >
    <div
      class="flex min-w-0 shrink items-stretch"
      :style="{ width: listWidth }"
      data-testid="browser-tab-list"
    >
      <div
        v-for="tab in visibleTabs"
        :key="tab.tabId"
        class="relative flex cursor-default items-center border-r border-border text-[11px] transition-colors"
        :class="[
          tab.tabId === activeTabId
            ? 'z-[1] bg-bg text-text'
            : 'text-text-3 hover:bg-surface-2 hover:text-text-2',
          iconOnly(tab) ? 'justify-center' : 'gap-[5px] pl-2 pr-1',
          menuFor?.tabId === tab.tabId && tab.tabId !== activeTabId
            ? 'bg-surface-2 text-text-2'
            : '',
          'group'
        ]"
        :style="{
          width: widthOf(tab),
          flex: `0 1 ${widthOf(tab)}`,
          minWidth: '28px',
          ...(tab.tabId === activeTabId ? { boxShadow: '0 1px 0 var(--color-bg)' } : {})
        }"
        role="tab"
        tabindex="0"
        :aria-selected="tab.tabId === activeTabId"
        :title="iconOnly(tab) ? titleOf(tab) : tab.url"
        :data-tab-id="tab.tabId"
        :data-active="tab.tabId === activeTabId"
        data-testid="browser-tab"
        @mousedown.stop
        @click="tab.tabId !== activeTabId && emit('activate', tab.tabId)"
        @keydown.enter.prevent="emit('activate', tab.tabId)"
        @keydown.space.prevent="emit('activate', tab.tabId)"
        @contextmenu.prevent="openMenu(tab.tabId, $event)"
      >
        <!-- Favicon: the live tab shows its dot (S-7), a start tab the globe, else the page icon or the host's letter. -->
        <span
          v-if="tab.agentActive"
          class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          style="box-shadow: 0 0 0 3px var(--color-accent-soft)"
          role="img"
          :title="$t('browserPane.tabs.agentDriving')"
          :aria-label="$t('browserPane.tabs.agentDriving')"
          data-testid="browser-tab-agent-dot"
        />
        <Globe
          v-else-if="tab.hostView === 'start'"
          :size="12"
          :stroke-width="1.6"
          class="shrink-0 text-text-3"
        />
        <img
          v-else-if="faviconOf(tab).src"
          :src="faviconOf(tab).src!"
          alt=""
          class="h-3 w-3 shrink-0 rounded-xs"
          @error="onIconError(tab.tabId)"
        />
        <span
          v-else
          class="grid h-3 w-3 shrink-0 place-items-center rounded-xs text-[8px] font-semibold"
          :class="hostBadge(tab)"
          aria-hidden="true"
          >{{ faviconOf(tab).letter }}</span
        >
        <template v-if="!iconOnly(tab)">
          <span class="min-w-0 flex-1 truncate" data-testid="browser-tab-title">{{
            titleOf(tab)
          }}</span>
          <button
            type="button"
            class="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-xs text-text-3 hover:bg-border-2 hover:text-text"
            :class="tab.tabId === activeTabId ? 'visible' : 'invisible group-hover:visible'"
            :aria-label="$t('browserPane.tabs.closeNamed', { title: titleOf(tab) })"
            :title="$t('browserPane.tabs.close')"
            data-testid="browser-tab-close"
            @mousedown.stop
            @click.stop="emit('close', tab.tabId)"
          >
            <X :size="10" :stroke-width="1.6" />
          </button>
        </template>
      </div>
    </div>

    <!-- The tabs that do not fit. -->
    <button
      v-if="overflowCount > 0"
      type="button"
      class="flex h-[18px] shrink-0 items-center gap-0.5 self-center rounded-sm px-[5px] font-mono text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
      style="font-size: 10.5px"
      :title="$t('browserPane.tabs.more', { count: overflowCount })"
      :aria-expanded="moreOpen"
      data-tab-more-trigger
      data-testid="browser-tab-more"
      data-dsqa-part="overflow-button"
      @mousedown.stop
      @click="toggleMore"
    >
      +{{ overflowCount }}
      <ChevronDown :size="10" :stroke-width="1.6" />
    </button>

    <button
      v-if="canAdd"
      type="button"
      class="mx-1 flex shrink-0 items-center justify-center self-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:text-text-disabled disabled:hover:bg-transparent"
      style="width: 18px; height: 18px"
      :disabled="atLimit"
      :title="newTitle"
      :aria-label="$t('browserPane.tabs.newPlain')"
      data-testid="browser-tab-new"
      @mousedown.stop
      @click="emit('add')"
    >
      <Plus :size="12" :stroke-width="1.6" />
    </button>

    <!-- Tab menu (right-click a tab). -->
    <div
      v-if="menuFor"
      ref="menuEl"
      class="anim-fade-in absolute top-[23px] z-20 min-w-[196px] p-1 text-[12px] text-text-2"
      :style="{
        left: `${menuFor.left}px`,
        boxShadow: 'var(--shadow-pop)',
        borderRadius: 'var(--radius)'
      }"
      style="background: var(--color-surface); border: 1px solid var(--color-border-2)"
      role="menu"
      data-testid="browser-tab-menu"
      data-dsqa-part="tab-menu"
      @mousedown.stop
    >
      <template v-for="action in TAB_MENU_ACTIONS" :key="action">
        <div
          v-if="action === 'closeOthers'"
          class="mx-0.5 my-1 border-t border-border"
          role="separator"
        />
        <button
          type="button"
          role="menuitem"
          class="flex h-[26px] w-full items-center gap-2 rounded-sm px-2 text-left whitespace-nowrap hover:bg-surface-2 hover:text-text disabled:cursor-default disabled:text-text-disabled disabled:hover:bg-transparent"
          :disabled="rowDisabled(action)"
          :data-testid="`browser-tab-menu-${action}`"
          @click="pickMenu(action)"
        >
          <component
            :is="menuRows[action].icon"
            v-if="menuRows[action].icon"
            :size="12"
            :stroke-width="1.6"
            class="shrink-0"
          />
          <span>{{ $t(`browserPane.tabs.menu.${action}`) }}</span>
          <span
            v-if="action === 'close' && closeKeys"
            class="ml-auto font-mono text-text-4"
            style="font-size: 10.5px"
            >{{ closeKeys }}</span
          >
        </button>
      </template>
    </div>

    <!-- The +N list: every tab in order, the open one marked. -->
    <div
      v-if="moreOpen"
      ref="moreListEl"
      class="anim-fade-in absolute top-[23px] z-20 min-w-[220px] p-1 text-[12px] text-text-2"
      :style="{
        left: `${moreLeft}px`,
        boxShadow: 'var(--shadow-pop)',
        borderRadius: 'var(--radius)'
      }"
      style="background: var(--color-surface); border: 1px solid var(--color-border-2)"
      role="menu"
      :aria-label="$t('browserPane.tabs.moreList')"
      data-testid="browser-tab-more-list"
      data-dsqa-part="overflow-list"
      @mousedown.stop
    >
      <template v-for="tab in tabs" :key="tab.tabId">
        <button
          type="button"
          role="menuitem"
          class="flex h-[26px] w-full items-center gap-2 rounded-sm px-2 text-left whitespace-nowrap hover:bg-surface-2 hover:text-text"
          :class="tab.tabId === activeTabId ? 'text-text' : ''"
          :aria-current="tab.tabId === activeTabId ? 'true' : undefined"
          :data-tab-id="tab.tabId"
          data-testid="browser-tab-more-item"
          @click="pickMore(tab.tabId)"
        >
          <Globe
            v-if="tab.hostView === 'start'"
            :size="12"
            :stroke-width="1.6"
            class="shrink-0 text-text-3"
          />
          <span
            v-else
            class="grid h-3 w-3 shrink-0 place-items-center rounded-xs text-[8px] font-semibold"
            :class="hostBadge(tab)"
            aria-hidden="true"
            >{{ faviconOf(tab).letter }}</span
          >
          <span class="min-w-0 truncate">{{ titleOf(tab) }}</span>
          <span
            v-if="tab.tabId === activeTabId"
            class="ml-auto font-mono text-text-4"
            style="font-size: 10.5px"
            >{{ $t('browserPane.tabs.open') }}</span
          >
        </button>
      </template>
    </div>
  </div>
</template>
