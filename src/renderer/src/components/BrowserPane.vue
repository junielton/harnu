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
  Check,
  Download,
  Globe,
  Laptop,
  Maximize2,
  Minimize2,
  Minus,
  Monitor,
  MoreHorizontal,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCcwSquare,
  RotateCw,
  Smartphone,
  Sun,
  Tablet,
  TriangleAlert,
  Unplug,
  Wind,
  X
} from 'lucide-vue-next'
import { browserPayload, useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useBrowserStore } from '../stores/browser'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import { createFrameScheduler } from '../lib/frame-scheduler'
import { sessionTitle } from '../lib/session-label'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import {
  FRAME_BEZEL_PX,
  FRAME_RING_PX,
  BACKDROP_PAD_PX,
  chipFor,
  deviceChipText,
  deviceIconName,
  deviceLayout,
  formatCountdown,
  frameCaption,
  freeSizePatch,
  headerTitle,
  networkRemainingMs,
  noticeTone,
  normalizeAddressInput,
  originBadgeKey,
  presetRows,
  splitAddress,
  zoomView
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
      notice: null,
      networkUntil: null,
      zoom: 1,
      emulation: {},
      downloadPrompt: null
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
  if (c.kind === 'operatorLease') return t('browserPane.chip.canDrive')
  if (c.kind === 'operatorRead') return t('browserPane.chip.canRead')
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

/* ---- Network counter (design.md "Network counter") ------------------------------------------- */

const networkMs = computed(() => networkRemainingMs(state.value, browser.clock))

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
/** The address in three runs: the host is brighter than the scheme and the path (design.md "Address bar"). */
const addressParts = computed(() => splitAddress(address.value))

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
  // The keyboard may still be inside the page (a chord came from it): the app takes it back first.
  void window.api.browserFocusApp()
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
  if (n.kind === 'downloaded') return t('browserPane.noticeDownloaded', { name: n.name })
  if (n.kind === 'download-cancelled') return t('browserPane.noticeDownloadCancelled')
  if (n.kind === 'download-failed') return t('browserPane.noticeDownloadFailed')
  return t('browserPane.notice.crashed')
})
const noticeIsInfo = computed(() =>
  state.value.notice ? noticeTone(state.value.notice) === 'info' : false
)

/* ---- Zoom (design.md "Zoom controls") ----------------------------------------------------------- */

const zv = computed(() => zoomView(state.value))
const onZoom = (action: 'in' | 'out' | 'reset'): void => void browser.zoom(paneId, action)

/* ---- Download prompt (design.md "Download prompt", Q16) ------------------------------------------ */

const downloadPrompt = computed(() => state.value.downloadPrompt)
const onDownloadAnswer = (allow: boolean): void => void browser.answerDownload(paneId, allow)

/* ---- Device mode (design.md "Device picker", "Device bar", "Device frame") ------------------------ */

const device = computed(() => state.value.emulation.device)
const deviceIcon = computed(() =>
  device.value
    ? ({ smartphone: Smartphone, tablet: Tablet, laptop: Laptop, monitor: Monitor } as const)[
        deviceIconName(device.value)
      ]
    : Smartphone
)
const pickerOpen = ref(false)
const pickerMode = ref<'list' | 'custom'>('list')
const pickerEl = ref<HTMLElement | null>(null)
useNativeOverlay(`browser-device-${paneId}`, pickerEl)
const presets = computed(() => presetRows(device.value))
const freeSize = ref({ width: '390', height: '844', dpr: '2' })
const freeMobile = ref(true)
const freeSizeValid = computed(() => freeSizePatch(freeSize.value, freeMobile.value) !== null)
const deviceFailed = ref(false)

function togglePicker(): void {
  menuOpen.value = false
  pickerOpen.value = !pickerOpen.value
  pickerMode.value = 'list'
  const d = device.value
  if (pickerOpen.value && d) {
    freeSize.value = { width: String(d.width), height: String(d.height), dpr: String(d.dpr) }
    freeMobile.value = d.mobile
  }
}

/** Send a patch to main (the same shape `browser_emulate` takes) and surface a refusal inline. */
async function sendDevice(patch: Parameters<typeof browser.emulate>[1]): Promise<boolean> {
  deviceFailed.value = false
  const res = await browser.emulate(paneId, patch)
  if (!res.ok) deviceFailed.value = true
  return res.ok
}
async function pickPreset(name: string): Promise<void> {
  if (await sendDevice({ device: name })) pickerOpen.value = false
}
async function applyFreeSize(): Promise<void> {
  const patch = freeSizePatch(freeSize.value, freeMobile.value)
  if (!patch) return
  if (await sendDevice(patch)) pickerOpen.value = false
}
const onRotate = (): Promise<boolean> => sendDevice({ rotate: true })
const onToggleScheme = (): Promise<boolean> =>
  sendDevice({ colorScheme: state.value.emulation.colorScheme === 'dark' ? 'light' : 'dark' })
const onToggleReducedMotion = (): Promise<boolean> =>
  sendDevice({ reducedMotion: state.value.emulation.reducedMotion !== true })
async function onResetDevice(): Promise<void> {
  pickerOpen.value = false
  await sendDevice({ reset: true })
}

/** The area under the bars. In device mode it holds the frame; its size is what the fit scale is measured in. */
const areaEl = ref<HTMLElement | null>(null)
const areaSize = ref({ width: 0, height: 0 })
const layout = computed(() => (device.value ? deviceLayout(device.value, areaSize.value) : null))
const caption = computed(() => (layout.value ? frameCaption(state.value, layout.value.fit) : ''))
const frameRadius = computed(() =>
  device.value && Math.max(device.value.width, device.value.height) <= 1100
    ? 'var(--radius-lg)'
    : 'var(--radius)'
)
let areaObserver: ResizeObserver | null = null

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
  const target = ev.target as Node | null
  if (pickerOpen.value) {
    const trigger = target instanceof Element && target.closest('[data-device-trigger]')
    if (!(target && pickerEl.value?.contains(target)) && !trigger) pickerOpen.value = false
  }
  if (!menuOpen.value) return
  if (target && menuEl.value?.contains(target)) return
  menuOpen.value = false
}

/* ---- Host rectangle: what main positions the native view over ------------------------------------ */

const hostEl = ref<HTMLElement | null>(null)
let last = ''
/** Frames still to check after the last change, so a transition that moves the pane is followed to its end. */
let settleFrames = 0

/** Read the host rect and tell main if it changed. @returns whether it changed. */
function report(): boolean {
  const el = hostEl.value
  if (!el) return false
  const r = el.getBoundingClientRect()
  const visible = r.width >= 1 && r.height >= 1
  const key = `${r.x},${r.y},${r.width},${r.height},${visible}`
  if (key === last) return false
  last = key
  window.api.browserBounds({
    paneId,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    visible
  })
  return true
}

function frame(): void {
  // While the rect keeps changing (a drag, a transition) keep following it; stop a few frames after it settles.
  settleFrames = report() ? 6 : settleFrames - 1
  if (settleFrames > 0) scheduler.schedule()
}

/**
 * Ask for a rect check soon. Nothing runs while the layout is idle: the checks are driven by what can move the
 * pane (below), throttled to one per frame, instead of a perpetual rAF loop that would keep the renderer awake.
 * A `ResizeObserver` alone misses a pane that moves without changing size (a sidebar collapse), which is why the
 * triggers also include style/class mutations and transitions ending.
 *
 * The scheduler is NOT rAF alone: with the window occluded or minimized rAF stops, and a report that never
 * goes out leaves the pane parked at 1×1 in main. It falls back to a timer after ~100 ms, or at once when the
 * document is not visible.
 */
const scheduler = createFrameScheduler(
  {
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    isVisible: () => document.visibilityState === 'visible'
  },
  frame
)

function schedule(): void {
  scheduler.schedule()
}

let resizeObserver: ResizeObserver | null = null
let mutationObserver: MutationObserver | null = null

function startTracking(): void {
  settleFrames = 6
  schedule()
  resizeObserver = new ResizeObserver(() => {
    settleFrames = Math.max(settleFrames, 2)
    schedule()
  })
  if (hostEl.value) resizeObserver.observe(hostEl.value)
  resizeObserver.observe(document.documentElement)
  mutationObserver = new MutationObserver(() => {
    settleFrames = Math.max(settleFrames, 2)
    schedule()
  })
  mutationObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['style', 'class'],
    childList: true,
    subtree: true
  })
  window.addEventListener('resize', onLayoutEvent)
  window.addEventListener('transitionend', onLayoutEvent, true)
  window.addEventListener('animationend', onLayoutEvent, true)
  document.addEventListener('visibilitychange', onLayoutEvent)
}

function onLayoutEvent(): void {
  settleFrames = Math.max(settleFrames, 2)
  schedule()
}

function stopTracking(): void {
  scheduler.cancel()
  resizeObserver?.disconnect()
  mutationObserver?.disconnect()
  resizeObserver = null
  mutationObserver = null
  window.removeEventListener('resize', onLayoutEvent)
  window.removeEventListener('transitionend', onLayoutEvent, true)
  window.removeEventListener('animationend', onLayoutEvent, true)
  document.removeEventListener('visibilitychange', onLayoutEvent)
}

// The host div is replaced when a device frame comes or goes: follow whichever one is on screen.
watch(
  hostEl,
  (el, old) => {
    if (!resizeObserver) return
    if (old) resizeObserver.unobserve(old)
    if (el) resizeObserver.observe(el)
    settleFrames = Math.max(settleFrames, 6)
    schedule()
  },
  { flush: 'post' }
)

onMounted(() => {
  areaObserver = new ResizeObserver(() => {
    const el = areaEl.value
    if (el) areaSize.value = { width: el.clientWidth, height: el.clientHeight }
  })
  if (areaEl.value) {
    areaObserver.observe(areaEl.value)
    areaSize.value = { width: areaEl.value.clientWidth, height: areaEl.value.clientHeight }
  }
  browser.start()
  // A request made before this pane mounted (Split → Browser creates the pane, then asks for focus).
  void nextTick(() => {
    if (browser.takeFocusAddressPending(paneId)) focusAddress()
  })
  void browser.refresh(paneId)
  window.addEventListener('mousedown', onWindowPointerDown, true)
  startTracking()
})

onBeforeUnmount(() => {
  areaObserver?.disconnect()
  areaObserver = null
  stopTracking()
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
    class="@container relative flex h-full w-full flex-col overflow-hidden bg-bg"
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
      <span class="min-w-[2rem] flex-1 truncate" :title="state.url" data-testid="browser-title">{{
        title
      }}</span>

      <span
        v-if="chip"
        class="flex min-w-0 shrink items-center gap-1"
        :class="chip.kind === 'paused' ? '@max-[300px]:hidden' : ''"
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
          <!-- Paused: "Agent paused · m:ss", always whole (on a narrow pane the chip moves to the strip below). -->
          <span
            v-if="chip.kind === 'paused'"
            class="min-w-0 truncate"
            data-testid="browser-chip-label"
            >{{ chipLabel }}</span
          >
          <!-- Connected: the session name is what matters, so "Connected to" gives way first. -->
          <span
            v-else-if="chip.kind === 'connected'"
            class="flex min-w-0 items-baseline"
            data-testid="browser-chip-label"
          >
            <span class="truncate @max-[300px]:hidden" style="flex-shrink: 8"
              >{{ $t('browserPane.chip.connectedPrefix') }}&nbsp;</span
            >
            <span class="flex min-w-0 items-baseline"
              ><span class="min-w-0 truncate">‹{{ ownerTitle }}</span
              ><span class="shrink-0">›</span></span
            >
          </span>
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
          class="flex shrink-0 items-center gap-0.5 rounded border border-warning/40 text-warning transition-colors hover:bg-surface-2"
          style="padding: 0 6px; font-size: 10px; line-height: 16px"
          data-testid="browser-resume"
          @mousedown.stop
          @click="browser.resume(paneId)"
        >
          <Play :size="10" :stroke-width="1.6" aria-hidden="true" />
          {{ $t('browserPane.chip.resume') }}
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

      <span
        v-if="networkMs !== null"
        class="flex shrink-0 items-center gap-1 font-mono text-red"
        style="padding: 0 4px; font-size: 10.5px"
        :title="$t('browserPane.network.hint')"
        data-testid="browser-network"
      >
        <span
          class="anim-pulse-dot anim-pulse-dot--red h-1.5 w-1.5 shrink-0 rounded-full bg-red"
          aria-hidden="true"
        />
        <span class="@max-[300px]:hidden">{{ $t('browserPane.network.label') }}</span>
        <span data-testid="browser-network-time">{{ formatCountdown(networkMs) }}</span>
      </span>

      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('browserPane.menu')"
        :aria-label="$t('browserPane.menu')"
        data-testid="browser-menu-button"
        @mousedown.stop
        @click="((menuOpen = !menuOpen), (pickerOpen = false))"
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

    <!-- Paused chip on a narrow pane (below 300px the header has no room for the words): the same chip, full
         width, as a strip under the header. -->
    <div
      v-if="chip && chip.kind === 'paused'"
      class="hidden h-[22px] shrink-0 items-center gap-1.5 border-b border-border bg-warning/10 px-2 text-[11px] text-warning @max-[300px]:flex"
      data-testid="browser-paused-strip"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate" :title="chipLabel">{{ chipLabel }}</span>
      <button
        type="button"
        class="flex shrink-0 items-center gap-0.5 rounded border border-warning/40 hover:bg-surface-2"
        style="padding: 0 6px; font-size: 10px; line-height: 16px"
        data-testid="browser-resume-strip"
        @click="browser.resume(paneId)"
      >
        <Play :size="10" :stroke-width="1.6" aria-hidden="true" />
        {{ $t('browserPane.chip.resume') }}
      </button>
      <button
        type="button"
        class="grid h-[18px] w-[18px] shrink-0 place-items-center rounded text-text-3 hover:bg-surface-2 hover:text-text"
        :title="$t('browserPane.chip.disconnectHint')"
        :aria-label="$t('browserPane.chip.disconnect')"
        @click="onDisconnect"
      >
        <Unplug :size="12" :stroke-width="1.6" />
      </button>
    </div>

    <!-- Address bar (design.md "Address bar"). -->
    <div
      class="@container relative flex h-7 shrink-0 items-center gap-1 border-b border-border bg-bg px-2"
    >
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
        v-if="originKey && !state.flagged"
        class="shrink-0 rounded-full border @max-[300px]:hidden"
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
        class="flex max-w-[35%] min-w-0 shrink items-center gap-1 rounded-full border border-warning/30 bg-warning/10 text-warning"
        style="padding: 1px 6px; font-size: 10px"
        data-testid="browser-flag"
      >
        <TriangleAlert :size="10" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
        <span
          class="min-w-0 truncate"
          :title="$t('browserPane.flag.label', { host: state.flagged.host })"
          ><span class="@max-[330px]:hidden">{{ $t('browserPane.flag.prefix') }} · </span
          ><span class="@max-[250px]:hidden">{{ state.flagged.host }}</span></span
        >
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

      <div class="relative h-5 min-w-[70px] flex-1">
        <input
          ref="addressEl"
          v-model="address"
          type="text"
          spellcheck="false"
          autocomplete="off"
          class="h-5 w-full rounded-sm border border-border bg-surface px-1.5 font-mono text-[11px] outline-none focus:border-accent-line"
          :class="editing ? 'text-text' : 'text-transparent'"
          :placeholder="$t('browserPane.addressPlaceholder')"
          :aria-label="$t('browserPane.address')"
          data-testid="browser-address"
          @focus="editing = true"
          @blur="editing = false"
          @keydown.enter.prevent="onAddressEnter"
          @keydown.esc.prevent="onAddressEscape"
        />
        <!-- Not editing: the same text, drawn in two tones. The input stays the interactive element. -->
        <div
          v-if="!editing && address"
          class="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-nowrap font-mono text-[11px]"
          style="padding: 0 calc(0.375rem + 1px)"
          aria-hidden="true"
          data-testid="browser-address-view"
        >
          <span class="text-text-2 @max-[360px]:hidden">{{ addressParts.scheme }}</span
          ><span class="text-text" data-testid="browser-address-host">{{ addressParts.host }}</span
          ><span class="text-text-2">{{ addressParts.rest }}</span>
        </div>
      </div>

      <!-- Device mode button (design.md "Device button and picker"). -->
      <button
        type="button"
        class="flex shrink-0 items-center justify-center rounded transition hover:bg-surface-2"
        :class="
          device
            ? 'bg-surface-2 text-accent'
            : pickerOpen
              ? 'bg-surface-2 text-text'
              : 'text-text-3 hover:text-text'
        "
        style="width: 18px; height: 18px"
        :title="$t('browserPane.device.button')"
        :aria-label="$t('browserPane.device.button')"
        :aria-expanded="pickerOpen"
        data-device-trigger
        data-testid="browser-device-button"
        @click="togglePicker"
      >
        <component :is="deviceIcon" :size="12" :stroke-width="1.5" />
      </button>

      <!-- Zoom (design.md "Zoom controls"): off, not hidden, in device mode (Q15). -->
      <div
        class="flex shrink-0 items-center"
        :title="zv.disabled ? $t('browserPane.zoom.offInDevice') : $t('browserPane.zoom.label')"
        data-testid="browser-zoom"
        :data-disabled="zv.disabled"
      >
        <button
          type="button"
          class="flex items-center justify-center rounded transition"
          :class="
            zv.canZoomOut
              ? 'text-text-3 hover:bg-surface-2 hover:text-text'
              : 'cursor-default text-text-disabled'
          "
          style="width: 18px; height: 18px"
          :disabled="!zv.canZoomOut"
          :title="$t('browserPane.zoom.out')"
          :aria-label="$t('browserPane.zoom.out')"
          data-testid="browser-zoom-out"
          @click="onZoom('out')"
        >
          <Minus :size="12" :stroke-width="1.5" />
        </button>
        <button
          type="button"
          class="min-w-[34px] rounded text-center font-mono transition @max-[330px]:hidden"
          :class="
            zv.canReset
              ? 'text-text-3 hover:bg-surface-2 hover:text-text'
              : zv.disabled
                ? 'cursor-default text-text-disabled'
                : 'cursor-default text-text-3'
          "
          style="font-size: 10.5px; line-height: 18px"
          :disabled="!zv.canReset"
          :title="$t('browserPane.zoom.reset')"
          data-testid="browser-zoom-percent"
          @click="onZoom('reset')"
        >
          {{ zv.percent }}%
        </button>
        <button
          type="button"
          class="flex items-center justify-center rounded transition"
          :class="
            zv.canZoomIn
              ? 'text-text-3 hover:bg-surface-2 hover:text-text'
              : 'cursor-default text-text-disabled'
          "
          style="width: 18px; height: 18px"
          :disabled="!zv.canZoomIn"
          :title="$t('browserPane.zoom.in')"
          :aria-label="$t('browserPane.zoom.in')"
          data-testid="browser-zoom-in"
          @click="onZoom('in')"
        >
          <Plus :size="12" :stroke-width="1.5" />
        </button>
      </div>

      <!-- Device picker: presets, the free-size editor, reset (design.md "Device button and picker"). -->
      <div
        v-if="pickerOpen"
        ref="pickerEl"
        class="anim-fade-in-scale absolute right-2 top-full z-20 min-w-[220px] rounded border border-border-2 bg-surface py-1 text-[12px] text-text-2"
        style="box-shadow: var(--shadow-pop); border-radius: var(--radius)"
        role="menu"
        data-testid="browser-device-picker"
      >
        <template v-if="pickerMode === 'list'">
          <button
            v-for="row in presets"
            :key="row.name"
            type="button"
            role="menuitemradio"
            :aria-checked="row.active"
            class="flex h-6 w-full items-center gap-2 px-3 text-left font-mono text-[11px] hover:bg-surface-2"
            :class="row.active ? 'bg-accent-soft' : ''"
            :data-testid="`browser-device-preset-${row.name}`"
            @click="pickPreset(row.name)"
          >
            <span class="text-text">{{ row.name }}</span>
            <span class="flex-1 text-text-3">{{ row.size }}</span>
            <Check v-if="row.active" :size="12" :stroke-width="1.8" class="text-accent" />
          </button>
          <div class="my-1 border-t border-border" />
          <button
            type="button"
            role="menuitem"
            class="flex h-6 w-full items-center px-3 text-left hover:bg-surface-2 hover:text-text"
            data-testid="browser-device-custom"
            @click="pickerMode = 'custom'"
          >
            {{ $t('browserPane.device.custom') }}
          </button>
          <button
            v-if="device"
            type="button"
            role="menuitem"
            class="flex h-6 w-full items-center gap-2 px-3 text-left text-text-2 hover:bg-surface-2 hover:text-text"
            data-testid="browser-device-reset-menu"
            @click="onResetDevice"
          >
            <RotateCcw :size="12" :stroke-width="1.5" />
            {{ $t('browserPane.device.reset') }}
          </button>
        </template>
        <form v-else class="flex flex-col gap-2 px-3 py-2" @submit.prevent="applyFreeSize">
          <div class="flex items-center gap-2 font-mono text-[11px]">
            <label class="flex flex-col gap-0.5 text-[10px] text-text-3"
              >{{ $t('browserPane.device.width') }}
              <input
                v-model="freeSize.width"
                inputmode="numeric"
                class="h-5 w-14 rounded-sm border border-border bg-bg px-1.5 text-[11px] text-text outline-none focus:border-accent-line"
                data-testid="browser-device-width"
              />
            </label>
            <label class="flex flex-col gap-0.5 text-[10px] text-text-3"
              >{{ $t('browserPane.device.height') }}
              <input
                v-model="freeSize.height"
                inputmode="numeric"
                class="h-5 w-14 rounded-sm border border-border bg-bg px-1.5 text-[11px] text-text outline-none focus:border-accent-line"
                data-testid="browser-device-height"
              />
            </label>
            <label class="flex flex-col gap-0.5 text-[10px] text-text-3"
              >{{ $t('browserPane.device.dpr') }}
              <input
                v-model="freeSize.dpr"
                inputmode="decimal"
                class="h-5 w-12 rounded-sm border border-border bg-bg px-1.5 text-[11px] text-text outline-none focus:border-accent-line"
                data-testid="browser-device-dpr"
              />
            </label>
          </div>
          <label class="flex items-center justify-between gap-2 text-[11px]">
            {{ $t('browserPane.device.mobile') }}
            <ToggleSwitch v-model="freeMobile" :aria-label="$t('browserPane.device.mobile')" />
          </label>
          <p
            v-if="!freeSizeValid"
            class="text-[11px] text-red"
            data-testid="browser-device-invalid"
          >
            {{ $t('browserPane.device.invalid') }}
          </p>
          <div class="flex items-center justify-end gap-2">
            <button
              type="button"
              class="h-5 rounded px-2 text-[11px] text-text-3 hover:bg-surface-2 hover:text-text"
              @click="pickerMode = 'list'"
            >
              {{ $t('browserPane.device.back') }}
            </button>
            <button
              type="submit"
              class="h-5 rounded bg-accent px-2 text-[11px] text-accent-ink disabled:cursor-default disabled:opacity-45"
              :disabled="!freeSizeValid"
              data-testid="browser-device-apply"
            >
              {{ $t('browserPane.device.apply') }}
            </button>
          </div>
        </form>
        <p
          v-if="deviceFailed"
          class="px-3 pb-1 text-[11px] text-red"
          data-testid="browser-device-failed"
        >
          {{ $t('browserPane.device.failed') }}
        </p>
      </div>
    </div>

    <!-- Device bar: only while a device is active (design.md "Device bar"). -->
    <div
      v-if="device"
      class="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-bg px-2"
      data-testid="browser-device-bar"
    >
      <button
        type="button"
        class="flex min-w-0 shrink items-center gap-1 rounded-full border border-accent-line bg-accent-soft font-mono text-text-2"
        style="padding: 1px 8px; font-size: 10.5px"
        :title="$t('browserPane.device.chipHint')"
        data-device-trigger
        data-testid="browser-device-chip"
        @click="togglePicker"
      >
        <component :is="deviceIcon" :size="12" :stroke-width="1.5" class="shrink-0" />
        <span class="truncate">{{ deviceChipText(device) }}</span>
      </button>
      <div class="flex-1" />
      <button
        type="button"
        class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('browserPane.device.rotate')"
        :aria-label="$t('browserPane.device.rotate')"
        data-testid="browser-device-rotate"
        @click="onRotate"
      >
        <RotateCcwSquare :size="12" :stroke-width="1.5" />
      </button>
      <button
        type="button"
        class="flex items-center justify-center rounded transition hover:bg-surface-2 hover:text-text"
        :class="state.emulation.colorScheme === 'dark' ? 'bg-surface-2 text-text' : 'text-text-3'"
        style="width: 18px; height: 18px"
        :title="
          $t('browserPane.device.scheme') +
          ' · ' +
          (state.emulation.colorScheme === 'dark'
            ? $t('browserPane.device.schemeDark')
            : $t('browserPane.device.schemeLight'))
        "
        :aria-label="$t('browserPane.device.scheme')"
        :aria-pressed="state.emulation.colorScheme === 'dark'"
        data-testid="browser-device-scheme"
        @click="onToggleScheme"
      >
        <Moon v-if="state.emulation.colorScheme === 'dark'" :size="12" :stroke-width="1.5" />
        <Sun v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        type="button"
        class="flex items-center justify-center rounded transition hover:bg-surface-2 hover:text-text"
        :class="state.emulation.reducedMotion === true ? 'bg-surface-2 text-text' : 'text-text-3'"
        style="width: 18px; height: 18px"
        :title="$t('browserPane.device.reducedMotion')"
        :aria-label="$t('browserPane.device.reducedMotion')"
        :aria-pressed="state.emulation.reducedMotion === true"
        data-testid="browser-device-motion"
        @click="onToggleReducedMotion"
      >
        <Wind :size="12" :stroke-width="1.5" />
      </button>
      <button
        type="button"
        class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('browserPane.device.reset')"
        :aria-label="$t('browserPane.device.reset')"
        data-testid="browser-device-reset"
        @click="onResetDevice"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </div>

    <!-- Download prompt: the operator's own download waits for a yes (design.md "Download prompt", Q16). -->
    <div
      v-if="downloadPrompt"
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-accent-line bg-accent-soft px-2 text-[11px] text-text-2"
      role="alertdialog"
      data-testid="browser-download-prompt"
    >
      <Download :size="12" :stroke-width="1.6" class="shrink-0 text-accent" aria-hidden="true" />
      <span
        class="min-w-0 flex-1 truncate"
        :title="$t('browserPane.download.prompt', { name: downloadPrompt.name })"
        >{{ $t('browserPane.download.prompt', { name: downloadPrompt.name }) }}</span
      >
      <button
        type="button"
        class="shrink-0 rounded px-1.5 text-accent hover:bg-surface-2"
        style="line-height: 18px"
        data-testid="browser-download-save"
        @click="onDownloadAnswer(true)"
      >
        {{ $t('browserPane.download.save') }}
      </button>
      <button
        type="button"
        class="shrink-0 rounded px-1.5 text-text-3 hover:bg-surface-2 hover:text-text"
        style="line-height: 18px"
        data-testid="browser-download-cancel"
        @click="onDownloadAnswer(false)"
      >
        {{ $t('browserPane.download.cancel') }}
      </button>
    </div>

    <!-- Notice strip: one refusal or intercepted event at a time (design.md "Notice strip"). -->
    <div
      v-if="state.notice"
      class="flex h-[22px] shrink-0 items-center gap-1.5 px-2 text-[11px]"
      :class="noticeIsInfo ? 'bg-accent-soft text-text-2' : 'bg-warning/10 text-warning'"
      role="status"
      data-testid="browser-notice"
    >
      <TriangleAlert
        v-if="!noticeIsInfo"
        :size="11"
        :stroke-width="1.6"
        class="shrink-0"
        aria-hidden="true"
      />
      <Download
        v-else
        :size="11"
        :stroke-width="1.6"
        class="shrink-0 text-accent"
        aria-hidden="true"
      />
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

    <!-- The area under the bars. Normally it IS the host; in device mode it holds the frame, and the host is the
         frame's screen (design.md "Device frame"). The host is EMPTY in the DOM: main draws the page in a native
         view bounded to its rectangle. -->
    <div
      ref="areaEl"
      class="relative min-h-0 flex-1 bg-bg"
      :class="layout ? 'overflow-auto' : ''"
      data-testid="browser-area"
    >
      <div
        v-if="layout && device"
        class="flex min-h-full min-w-full flex-col items-center justify-center"
        :style="{ padding: `${BACKDROP_PAD_PX}px`, gap: '8px' }"
        data-testid="browser-device-backdrop"
      >
        <div
          class="shrink-0"
          :style="{
            padding: `${FRAME_BEZEL_PX}px`,
            background: 'var(--color-surface-2)',
            boxShadow: `0 0 0 ${FRAME_RING_PX}px var(--color-border-2), var(--shadow-pop)`,
            borderRadius: frameRadius
          }"
          data-testid="browser-device-frame"
        >
          <div
            ref="hostEl"
            class="relative bg-bg"
            :style="{ width: `${layout.screenWidth}px`, height: `${layout.screenHeight}px` }"
            data-testid="browser-host"
          >
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
          </div>
        </div>
        <div
          class="shrink-0 truncate text-center font-mono text-text-3"
          style="font-size: 10.5px; line-height: 16px"
          data-testid="browser-device-caption"
        >
          {{ caption }}
        </div>
      </div>
      <div v-else ref="hostEl" class="absolute inset-0 bg-bg" data-testid="browser-host">
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
      </div>
    </div>

    <!-- ⋯ menu: over the pane, above the frozen frame. -->
    <div
      v-if="menuOpen"
      ref="menuEl"
      class="anim-fade-in absolute right-1 top-7 z-20 min-w-[190px] rounded border border-border bg-surface py-1 text-[12px] text-text-2"
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
</template>
