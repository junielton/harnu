<script setup lang="ts">
/**
 * Browser pane (T564 U1, design.md §6 "Browser pane"): a real Chromium page in the helper stack. The page is a
 * native `WebContentsView` that MAIN positions over this pane's host `<div>`; this component only reports that
 * div's rectangle and draws the chrome around it: header, connection chip, address bar, notice strip, the ⋯
 * menu, and the frozen frame shown while an app layer overlaps the native view.
 *
 * It owns no page logic: navigation, policy and every agent-access decision live in main
 * (`src/main/browser/`), and every presentation decision in `lib/browser-pane.ts`.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bug,
  Globe,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pause,
  Play,
  RotateCw,
  TriangleAlert,
  Unplug,
  X
} from 'lucide-vue-next'
import { browserPayload, useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useBrowserStore } from '../stores/browser'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import { sessionTitle } from '../lib/session-label'
import {
  chipFor,
  formatCountdown,
  headerTitle,
  normalizeAddressInput,
  originBadgeKey
} from '../lib/browser-pane'
import type { BrowserPaneState } from '../../../preload'

interface Props {
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

const { t } = useI18n()
const helpers = useHelpersStore()
const browser = useBrowserStore()
const sessions = useSessionsStore()
const ui = useUiStore()

const paneId = props.pane.id
const payload = computed(() => browserPayload(props.pane))

/** Before main's first push the pane shows what it was created with. */
const state = computed<BrowserPaneState>(
  () =>
    browser.states[paneId] ?? {
      paneId,
      url: payload.value.url,
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      origin: 'blank',
      openedBy: payload.value.openedBy,
      partition: payload.value.partition,
      flagged: null,
      pausedUntil: null,
      disconnected: false,
      ownerSessionId: payload.value.ownerSessionId,
      notice: null
    }
)

/* ---- Header ---------------------------------------------------------------------------------- */

const title = computed(
  () => headerTitle(state.value) || payload.value.name || t('browserPane.newTab')
)

const isMaximized = computed(() => helpers.maximizedPaneId(props.worktreePath) === paneId)
const onToggleMaximize = (): void => helpers.toggleMaximizePane(props.worktreePath, paneId)
const onClose = (): void => {
  browser.forget(paneId)
  helpers.removeHelper(props.worktreePath, paneId)
}
function onHeaderMouseDown(ev: MouseEvent): void {
  if (props.resizable) emit('headerMouseDown', ev)
}

/* ---- Connection chip -------------------------------------------------------------------------- */

const chip = computed(() => chipFor(state.value, browser.words[paneId] ?? null, browser.clock))
const ownerTitle = computed(() => {
  const id = chip.value?.ownerSessionId
  if (!id) return ''
  const s = sessions.findSessionById(id)
  return s ? sessionTitle(s, sessions.allSessions, t) || id.slice(0, 8) : id.slice(0, 8)
})
const chipLabel = computed(() => {
  const c = chip.value
  if (!c) return ''
  if (c.kind === 'disconnected') return t('browserPane.chip.disconnected')
  if (c.kind === 'paused') {
    return t('browserPane.chip.paused', { time: formatCountdown(c.pausedMs) })
  }
  if (c.kind === 'connected')
    return t('browserPane.chip.connectedTo', { session: ownerTitle.value })
  return t('browserPane.chip.connectedToAgent')
})
const wordText = computed(() => (chip.value?.word ? t(`browserPane.chip.${chip.value.word}`) : ''))

async function onDisconnect(): Promise<void> {
  const ok = await browser.disconnect(paneId)
  ui.pushToast(
    ok
      ? { kind: 'info', title: t('browserPane.chip.disconnectedToast') }
      : { kind: 'danger', title: t('browserPane.chip.disconnectFailed') }
  )
}

/* ---- Address bar ------------------------------------------------------------------------------ */

const addressEl = ref<HTMLInputElement | null>(null)
const address = ref(state.value.url)
const editing = ref(false)

// Mirror the live URL unless the operator is typing; `about:blank` shows an empty field.
watch(
  () => state.value.url,
  (url) => {
    if (!editing.value) address.value = url === 'about:blank' ? '' : url
  },
  { immediate: true }
)

const originKey = computed(() => originBadgeKey(state.value.origin))

async function onAddressEnter(): Promise<void> {
  const url = normalizeAddressInput(address.value)
  if (url === null) {
    addressEl.value?.select()
    return
  }
  editing.value = false
  await browser.navigate(paneId, { url })
  addressEl.value?.blur()
}
function onAddressEscape(): void {
  editing.value = false
  address.value = state.value.url === 'about:blank' ? '' : state.value.url
  addressEl.value?.blur()
}
function focusAddress(): void {
  addressEl.value?.focus()
  addressEl.value?.select()
}
watch(
  () => browser.focusAddressNonce[paneId],
  (n) => {
    if (n && browser.takeFocusAddressPending(paneId)) focusAddress()
  }
)

const onDismissFlag = (): Promise<boolean> => window.api.browserDismissFlag(paneId)
const onDismissNotice = (): Promise<boolean> => window.api.browserDismissNotice(paneId)

const onBack = (): Promise<unknown> => browser.navigate(paneId, { action: 'back' })
const onForward = (): Promise<unknown> => browser.navigate(paneId, { action: 'forward' })
const onReloadOrStop = (): Promise<unknown> =>
  browser.navigate(paneId, { action: state.value.loading ? 'stop' : 'reload' })

/* ---- Notice strip and the agent flag ------------------------------------------------------------ */

const noticeText = computed(() => {
  const n = state.value.notice
  if (!n) return ''
  if (n.kind === 'blocked') {
    return n.scheme
      ? t('browserPane.notice.blocked', { scheme: n.scheme })
      : t('browserPane.notice.blockedAny')
  }
  if (n.kind === 'certificate') return t('browserPane.notice.certificate', { host: n.host })
  if (n.kind === 'dialog') return t('browserPane.notice.dialog', { dialog: n.dialog })
  return t('browserPane.notice.crashed')
})

/* ---- The ⋯ menu ------------------------------------------------------------------------------- */

const menuOpen = ref(false)
const menuEl = ref<HTMLElement | null>(null)
// An in-app layer, so it registers with the native-overlay freeze explicitly (spec §2.4).
useNativeOverlay(`browser-menu-${paneId}`, menuEl)

const paused = computed(() => chip.value?.kind === 'paused')
const canPause = computed(() => payload.value.openedBy === 'agent' && !state.value.disconnected)

function onPauseToggle(): void {
  menuOpen.value = false
  void (paused.value ? browser.resume(paneId) : browser.pause(paneId))
}
function onDevtools(): void {
  menuOpen.value = false
  void window.api.browserDevtools(paneId)
}
function onWindowPointerDown(ev: MouseEvent): void {
  if (!menuOpen.value) return
  const target = ev.target as Node | null
  if (target && menuEl.value?.contains(target)) return
  menuOpen.value = false
}

/* ---- Host rectangle: what main positions the native view over ------------------------------------ */

const hostEl = ref<HTMLElement | null>(null)
let rafId = 0
let last = ''

/**
 * Report the host div's rectangle whenever it moves or resizes (spec §2.3). A `ResizeObserver` misses a pane
 * that moves without changing size (a splitter, a sidebar collapse, a maximize of its neighbour), so the rect
 * is read each animation frame and sent only when it changed: one cheap read per frame per pane.
 */
function pump(): void {
  rafId = requestAnimationFrame(pump)
  const el = hostEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const visible = r.width >= 1 && r.height >= 1
  const key = `${r.x},${r.y},${r.width},${r.height},${visible}`
  if (key === last) return
  last = key
  window.api.browserBounds({
    paneId,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    visible
  })
}

onMounted(() => {
  browser.start()
  // A request made before this pane mounted (Split → Browser creates the pane, then asks for focus).
  void nextTick(() => {
    if (browser.takeFocusAddressPending(paneId)) focusAddress()
  })
  void browser.refresh(paneId)
  window.addEventListener('mousedown', onWindowPointerDown, true)
  rafId = requestAnimationFrame(pump)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  window.removeEventListener('mousedown', onWindowPointerDown, true)
  // Hidden, not destroyed: switching folders never disposes a pane (spec §2.3).
  const r = hostEl.value?.getBoundingClientRect()
  window.api.browserBounds({
    paneId,
    rect: { x: r?.x ?? 0, y: r?.y ?? 0, width: r?.width ?? 0, height: r?.height ?? 0 },
    visible: false
  })
})

/* ---- Frozen frame ------------------------------------------------------------------------------ */

const isFrozen = computed(() => paneId in browser.frozen)
const frozenSrc = computed(() => browser.frozen[paneId] ?? null)

/** Tell main the still image is on screen so it can hide the native view without a flash. */
function ackFreezePainted(): void {
  requestAnimationFrame(() => requestAnimationFrame(() => window.api.browserFreezePainted(paneId)))
}
watch(isFrozen, async (frozen) => {
  if (!frozen) return
  await nextTick()
  // A failed capture paints a blank rect of the pane background: nothing to wait for.
  if (frozenSrc.value === null) ackFreezePainted()
})
</script>

<template>
  <div
    class="flex h-full w-full flex-col overflow-hidden bg-bg"
    :aria-label="$t('browserPane.label')"
    data-testid="browser-pane"
  >
    <header
      class="@container flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      @mousedown="onHeaderMouseDown"
    >
      <Globe :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
      <span class="min-w-[2.5rem] flex-1 truncate" :title="state.url" data-testid="browser-title">{{
        title
      }}</span>

      <span
        v-if="chip"
        class="flex min-w-0 shrink items-center gap-1"
        data-testid="browser-chip"
        :data-chip="chip.kind"
      >
        <span
          class="flex min-w-0 shrink items-center gap-1 overflow-hidden rounded-full border"
          :class="
            chip.kind === 'disconnected'
              ? 'border-red/40 bg-red-soft text-red'
              : chip.kind === 'paused'
                ? 'border-warning/30 bg-warning/10 text-warning'
                : 'border-accent-line bg-accent-soft text-accent'
          "
          style="padding: 1px 7px; font-size: 10px"
          :title="chipLabel"
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full"
            :class="[
              chip.kind === 'disconnected'
                ? 'bg-red'
                : chip.kind === 'paused'
                  ? 'bg-warning'
                  : 'bg-accent',
              chip.word ? 'anim-pulse-dot anim-pulse-dot--accent' : ''
            ]"
            aria-hidden="true"
          />
          <Bot
            v-if="chip.kind === 'connected' || chip.kind === 'connectedAgent'"
            :size="10"
            :stroke-width="1.6"
            class="shrink-0"
            aria-hidden="true"
          />
          <!-- A paused chip keeps its countdown at every width: only the words around it give way. -->
          <span
            v-if="chip.kind === 'paused'"
            class="min-w-0 truncate"
            data-testid="browser-chip-label"
            ><span class="@max-[300px]:hidden">{{ $t('browserPane.chip.pausedLabel') }} · </span
            >{{ formatCountdown(chip.pausedMs) }}</span
          >
          <span
            v-else
            class="min-w-0 truncate @max-[180px]:hidden"
            data-testid="browser-chip-label"
            >{{ chipLabel }}</span
          >
          <span v-if="wordText" class="shrink-0 text-text-3 @max-[180px]:hidden"
            >· {{ wordText }}</span
          >
        </span>
        <span class="sr-only" aria-live="polite">{{ wordText }}</span>
        <button
          v-if="chip.kind === 'paused'"
          type="button"
          class="flex shrink-0 items-center gap-0.5 rounded text-warning transition-colors hover:bg-surface-2"
          style="padding: 0 4px; font-size: 10px"
          :aria-label="$t('browserPane.chip.resume')"
          :title="$t('browserPane.chip.resume')"
          data-testid="browser-resume"
          @mousedown.stop
          @click="browser.resume(paneId)"
        >
          <Play :size="10" :stroke-width="1.6" aria-hidden="true" />
          <span class="@max-[300px]:hidden">{{ $t('browserPane.chip.resume') }}</span>
        </button>
        <button
          v-if="chip.disconnectable"
          type="button"
          class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded text-text-3 transition-colors hover:bg-surface-2 hover:text-text"
          :title="$t('browserPane.chip.disconnectHint')"
          :aria-label="$t('browserPane.chip.disconnect')"
          data-testid="browser-disconnect"
          @mousedown.stop
          @click="onDisconnect"
        >
          <Unplug :size="12" :stroke-width="1.6" />
        </button>
      </span>

      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('browserPane.menu')"
        :aria-label="$t('browserPane.menu')"
        data-testid="browser-menu-button"
        @mousedown.stop
        @click="menuOpen = !menuOpen"
      >
        <MoreHorizontal :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        :aria-label="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        @mousedown.stop
        @click="onToggleMaximize"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('helperPane.close')"
        :aria-label="$t('helperPane.close')"
        data-testid="browser-close"
        @mousedown.stop
        @click="onClose"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>

    <!-- Address bar (design.md "Address bar"). -->
    <div class="@container flex h-7 shrink-0 items-center gap-1 border-b border-border bg-bg px-2">
      <button
        type="button"
        class="flex shrink-0 items-center justify-center rounded transition hover:bg-surface-2"
        :class="
          state.canGoBack ? 'text-text-3 hover:text-text' : 'cursor-default text-text-disabled'
        "
        style="width: 18px; height: 18px"
        :disabled="!state.canGoBack"
        :title="$t('browserPane.back')"
        :aria-label="$t('browserPane.back')"
        data-testid="browser-back"
        @click="onBack"
      >
        <ArrowLeft :size="12" :stroke-width="1.5" />
      </button>
      <button
        type="button"
        class="flex shrink-0 items-center justify-center rounded transition hover:bg-surface-2"
        :class="
          state.canGoForward ? 'text-text-3 hover:text-text' : 'cursor-default text-text-disabled'
        "
        style="width: 18px; height: 18px"
        :disabled="!state.canGoForward"
        :title="$t('browserPane.forward')"
        :aria-label="$t('browserPane.forward')"
        data-testid="browser-forward"
        @click="onForward"
      >
        <ArrowRight :size="12" :stroke-width="1.5" />
      </button>
      <button
        type="button"
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="state.loading ? $t('browserPane.stop') : $t('browserPane.reload')"
        :aria-label="state.loading ? $t('browserPane.stop') : $t('browserPane.reload')"
        data-testid="browser-reload"
        @click="onReloadOrStop"
      >
        <X v-if="state.loading" :size="12" :stroke-width="1.5" />
        <RotateCw v-else :size="12" :stroke-width="1.5" />
      </button>

      <span
        v-if="originKey"
        class="shrink-0 rounded-full border @max-[200px]:hidden"
        :class="
          originKey === 'local'
            ? 'border-green/30 bg-green-soft text-green'
            : originKey === 'page'
              ? 'border-accent-line bg-accent-soft text-accent'
              : 'border-border bg-surface-2 text-text-3'
        "
        style="padding: 1px 6px; font-size: 10px"
        data-testid="browser-origin"
        >{{ $t(`browserPane.origin.${originKey}`) }}</span
      >

      <span
        v-if="state.flagged"
        class="flex max-w-[50%] min-w-0 shrink items-center gap-1 rounded-full border border-warning/30 bg-warning/10 text-warning"
        style="padding: 1px 6px; font-size: 10px"
        data-testid="browser-flag"
      >
        <TriangleAlert :size="10" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 truncate @max-[300px]:hidden">{{
          $t('browserPane.flag.label', { host: state.flagged.host })
        }}</span>
        <button
          type="button"
          class="grid shrink-0 place-items-center rounded hover:bg-surface-2"
          style="width: 12px; height: 12px"
          :aria-label="$t('browserPane.flag.dismiss')"
          :title="$t('browserPane.flag.dismiss')"
          @click="onDismissFlag"
        >
          <X :size="10" :stroke-width="1.6" />
        </button>
      </span>

      <input
        ref="addressEl"
        v-model="address"
        type="text"
        spellcheck="false"
        autocomplete="off"
        class="h-5 min-w-[56px] flex-1 rounded-sm border border-border bg-surface px-1.5 font-mono text-[11px] text-text outline-none focus:border-accent-line"
        :placeholder="$t('browserPane.addressPlaceholder')"
        :aria-label="$t('browserPane.address')"
        data-testid="browser-address"
        @focus="editing = true"
        @blur="editing = false"
        @keydown.enter.prevent="onAddressEnter"
        @keydown.esc.prevent="onAddressEscape"
      />
    </div>

    <!-- Notice strip: one refusal or intercepted event at a time (design.md "Notice strip"). -->
    <div
      v-if="state.notice"
      class="flex h-[22px] shrink-0 items-center gap-1.5 bg-warning/10 px-2 text-[11px] text-warning"
      role="status"
      data-testid="browser-notice"
    >
      <TriangleAlert :size="11" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate" :title="noticeText">{{ noticeText }}</span>
      <button
        type="button"
        class="grid shrink-0 place-items-center rounded hover:bg-surface-2"
        style="width: 16px; height: 16px"
        :aria-label="$t('browserPane.notice.dismiss')"
        @click="onDismissNotice"
      >
        <X :size="11" :stroke-width="1.6" />
      </button>
    </div>

    <!-- The host: EMPTY in the DOM. Main draws the page in a native view bounded to this rectangle. -->
    <div ref="hostEl" class="relative min-h-0 flex-1 bg-bg" data-testid="browser-host">
      <!-- Frozen frame (spec §2.4): a still of the page while an app layer overlaps the native view. -->
      <img
        v-if="isFrozen && frozenSrc"
        :src="frozenSrc"
        alt=""
        draggable="false"
        class="absolute inset-0 h-full w-full select-none"
        style="object-fit: fill"
        data-testid="browser-frozen"
        @load="ackFreezePainted"
        @error="ackFreezePainted"
      />
      <div v-else-if="isFrozen" class="absolute inset-0 bg-bg" data-testid="browser-frozen" />

      <!-- ⋯ menu: over the host, above the frozen frame. -->
      <div
        v-if="menuOpen"
        ref="menuEl"
        class="anim-fade-in absolute right-1 top-1 z-10 min-w-[190px] rounded border border-border bg-surface py-1 text-[12px] text-text-2"
        style="box-shadow: var(--shadow-pop)"
        role="menu"
        data-testid="browser-menu"
      >
        <button
          v-if="canPause"
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 hover:text-text"
          data-testid="browser-menu-pause"
          @click="onPauseToggle"
        >
          <component :is="paused ? Play : Pause" :size="13" :stroke-width="1.5" />
          {{ paused ? $t('browserPane.resumeAgent') : $t('browserPane.pauseAgent') }}
        </button>
        <button
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 hover:text-text"
          data-testid="browser-menu-devtools"
          @click="onDevtools"
        >
          <Bug :size="13" :stroke-width="1.5" />
          {{ $t('browserPane.devtools') }}
        </button>
      </div>
    </div>
  </div>
</template>
