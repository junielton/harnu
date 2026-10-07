<script lang="ts">
/**
 * Should the Pasted-images pill bump? Exported (and pure) so the trigger
 * condition is testable without mounting the whole footer.
 *
 * The rule is deliberately narrower than "the count changed": it fires only
 * when the count went UP for the session **already on screen**. A session
 * switch (`uuid` change) is not news even if the new session has more images,
 * and 0→1 is already covered by the pill's own hide-when-zero fade-in — so
 * neither bumps. Every real increment while looking at the same session
 * (1→2, 2→3, …) does.
 *
 * Biased toward silence on purpose: the caller only records `lastUuid`/
 * `lastCount` when the COUNT changes, so switching between two sessions that
 * happen to hold the same number of images swallows exactly one bump in the new
 * session. That's the safe side of the trade — the alternative (also recording
 * on a uuid change) would bump falsely on every switch into a session with more
 * images, since the count lands one tick after the uuid does.
 */
export function shouldBumpImagePill(args: {
  uuid: string | null
  count: number
  lastUuid: string | null
  lastCount: number
}): boolean {
  return args.uuid === args.lastUuid && args.count > args.lastCount && args.lastCount > 0
}
</script>

<script setup lang="ts">
/**
 * Footer / status bar (design.md §6 — Footer / status bar).
 *
 * Full-width bottom bar. LEFT = the active session's telemetry (model · context
 * · branch · effort · cost · lines + near-/compact), RIGHT = the fleet summary
 * (5h/7d rate-limit + cost · tabs). Presentational only: reads the existing
 * `usage` + `sessions` stores — no IPC, no token cost. Reactive on BOTH session
 * switch (`selectedId`) and live telemetry pushes (the store reassigns the map).
 * The fleet popover is added in a follow-up step.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { onClickOutside, onKeyStroke, useNow } from '@vueuse/core'
import {
  Cpu,
  Gauge,
  GitBranch,
  Zap,
  DollarSign,
  TriangleAlert,
  Image,
  ExternalLink,
  Recycle,
  Clock
} from 'lucide-vue-next'
import { useUsageStore } from '../stores/usage'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useClaudeStatusStore } from '../stores/claude-status'
import { useReaperStore } from '../stores/reaper'
import { useSchedulerStore } from '../stores/scheduler'
import { useContainersStore } from '../stores/containers'
import { useGcStore } from '../stores/gc'
import { useUiStore } from '../stores/ui'
import { useSessionImages } from '../composables/useSessionImages'
import UsagePanel from './UsagePanel.vue'
import ClaudeStatusPanel from './ClaudeStatusPanel.vue'
import FooterImagePopover from './FooterImagePopover.vue'
import ImageLightbox from './ImageLightbox.vue'
import HeapGauge from './HeapGauge.vue'
import { severityDotClass, severityLabelKey } from './claude-status-format'
import {
  footerSessionChips,
  nearCompactReason,
  type FooterChip,
  type FooterChipKey
} from './footer-format'
import { footerPctClass, footerWindowCountdown, formatCostUsd } from './usage-format'
import { formatBytes } from './system-monitor-format'

const { t } = useI18n()
const usage = useUsageStore()
const sessions = useSessionsStore()
const status = useClaudeStatusStore()
const reaper = useReaperStore()
const scheduler = useSchedulerStore()
const containers = useContainersStore()
const gc = useGcStore()
const ui = useUiStore()

// Cleanup footer pill (T443, design.md "Workspace GC — unified Cleanup / Footer pill"): ONE pill
// replaces the old Cleanup and Containers pills and is fed by the Workspace GC store, so the footer
// needs it live even when the takeover has never been opened; `gc.init()` is idempotent.
//
// The Reaper and Containers stores are still initialised here, because their `init()` also
// subscribes the quiet Activity-bell alerts (new harvestable items, new zombie stacks) that must
// fire while the takeovers are closed. Only their footer pills are gone.
//
// Scheduler footer pill (T295, design.md "Scheduler footer pill") — same
// reasoning: the footer needs `runningIds` live even when the takeover has
// never been opened, so it inits the store here too. `init()` re-subscribes
// (rather than double-subscribing) on a second call, so SchedulerView.vue
// calling it again on its own mount is harmless.
onMounted(() => {
  reaper.init()
  void scheduler.init()
  void containers.init()
  void gc.init()
})

/** The single Cleanup pill's content; null hides it (nothing to reclaim, nothing running or failed). */
const cleanupPill = computed(() => {
  const pill = gc.pill
  if (pill.kind === 'running') {
    return {
      kind: 'running' as const,
      text: t('cleanup.gc.footer.running', { done: pill.done, total: pill.total }),
      aria: t('cleanup.gc.footer.a11yRunning', { done: pill.done, total: pill.total })
    }
  }
  if (pill.kind === 'attention') {
    return {
      kind: 'attention' as const,
      text: t('cleanup.gc.footer.attention', pill.count, { named: { n: pill.count } }),
      aria: t('cleanup.gc.footer.a11yAttention', pill.count, { named: { n: pill.count } })
    }
  }
  if (gc.reclaimableBytes <= 0) return null
  const size = formatBytes(gc.reclaimableBytes)
  return {
    kind: 'idle' as const,
    text: size,
    aria: t('cleanup.gc.footer.a11yIdle', { size })
  }
})

/**
 * What a screen reader hears: only a CHANGE of pill state is announced (design.md: "one
 * announcement per finished item"), so the live region holds the last announced text and is
 * updated when the running count or the state moves, never on a mere size refresh.
 */
const cleanupAnnouncement = ref('')
watch(
  () => {
    const p = gc.pill
    return p.kind === 'running'
      ? `running:${p.done}/${p.total}`
      : p.kind === 'attention'
        ? `attention:${p.count}`
        : 'idle'
  },
  () => {
    cleanupAnnouncement.value = cleanupPill.value?.aria ?? ''
  }
)
const schedulerRunningCount = computed(() => scheduler.runningIds.length)

const sess = computed(() => sessions.selectedSession)
// Correlate by the Session object, not the raw id: a still-synthetic new session
// has telemetry keyed by the real Claude uuid, so a fallback-by-cwd inside
// `telemetryForSession` surfaces the footer chips before the synth→real migration
// (BUG-8 — otherwise the footer is empty until the first turn).
const tele = computed(() => usage.telemetryForSession(sess.value))
const chips = computed(() => footerSessionChips(tele.value, sess.value))
// Which `/compact`-proximity condition fired (or null) — drives the warning
// chip's visible label, color, and tooltip. `'pct'` → red "near /compact",
// `'over200k'` → accent ">200k tokens".
const warnReason = computed(() => nearCompactReason(tele.value))
const warnLabel = computed(() =>
  warnReason.value === 'pct' ? t('footer.nearCompact') : t('footer.over200k')
)
const warnAria = computed(() =>
  warnReason.value === 'pct' ? t('footer.a11yNearCompactPct') : t('footer.a11yNearCompactOver200k')
)

/** Muted fallback label when a session is selected but has no telemetry yet. */
const fallbackLabel = computed(
  () =>
    (sess.value && sessionTitle(sess.value, sessions.allSessions, t)) || t('session.newPlaceholder')
)

const ICONS: Partial<Record<FooterChipKey, Component>> = {
  model: Cpu,
  context: Gauge,
  branch: GitBranch,
  effort: Zap,
  cost: DollarSign
}
const MONO: Partial<Record<FooterChipKey, boolean>> = { branch: true }

function chipClass(key: FooterChipKey): string {
  // The footer is a HUD — it reads brighter than the sidebar chips by design.
  // Every chip sits at the model tone (`text-text-2`); context only diverges to
  // a signal color (accent/red) near the `/compact` ceiling — same rule as the
  // 5h/7d fleet chips on the right (`footerPctClass`).
  if (key === 'context') return footerPctClass(tele.value?.contextPercent ?? 0)
  return 'text-text-2'
}
function chipAria(chip: FooterChip): string {
  switch (chip.key) {
    case 'model':
      return t('footer.a11yModel', { model: chip.value })
    case 'context':
      return t('footer.a11yContext', { pct: tele.value?.contextPercent ?? 0 })
    case 'branch':
      return t('footer.a11yBranch', { branch: chip.value })
    case 'effort':
      return t('footer.a11yEffort', { level: chip.value })
    case 'cost':
      return t('footer.a11yCost', { cost: chip.value })
    case 'lines':
      return t('footer.a11yLines', {
        added: tele.value?.linesAdded ?? 0,
        removed: tele.value?.linesRemoved ?? 0
      })
  }
}

// ── Fleet (right) ──────────────────────────────────────────────────────────
const fleetVisible = computed(() => usage.status !== 'unavailable')
const fleet = computed(() => usage.fleetSummary)
const rl = computed(() => usage.rateLimits)
const fiveHourPct = computed(() => rl.value?.fiveHour?.usedPercent ?? null)
const sevenDayPct = computed(() => rl.value?.sevenDay?.usedPercent ?? null)
// Tick once a minute so the fleet-chip countdowns stay live-ish — same
// granularity UsagePanel's "resets in X" lines use, no second timer.
const now = useNow({ interval: 60_000 })
const fiveHourCountdown = computed(() =>
  footerWindowCountdown(rl.value?.fiveHour?.resetsAtMs ?? null, now.value.getTime())
)
const sevenDayCountdown = computed(() =>
  footerWindowCountdown(rl.value?.sevenDay?.resetsAtMs ?? null, now.value.getTime())
)
function windowAria(window: string, pct: number, countdown: string | null): string {
  return countdown
    ? t('footer.a11yWindow', { window, pct: Math.round(pct), time: countdown })
    : t('footer.a11yWindowNoReset', { window, pct: Math.round(pct) })
}
const fiveHourAria = computed(() =>
  fiveHourPct.value != null
    ? windowAria(t('footer.fiveHour'), fiveHourPct.value, fiveHourCountdown.value)
    : ''
)
const sevenDayAria = computed(() =>
  sevenDayPct.value != null
    ? windowAria(t('footer.sevenDay'), sevenDayPct.value, sevenDayCountdown.value)
    : ''
)
const fleetCost = computed(() =>
  fleet.value
    ? t('usage.fleetCost', {
        cost: formatCostUsd(fleet.value.totalCostUsd),
        tabs: fleet.value.sessionCount
      })
    : null
)

// Fleet popover: the full UsagePanel meters (5h/7d + countdown). Closes on
// click-outside (the ref wraps button + popover, so inner clicks are ignored)
// and on Esc.
const popoverOpen = ref(false)
const fleetRef = ref<HTMLElement | null>(null)
onClickOutside(fleetRef, () => (popoverOpen.value = false))
onKeyStroke('Escape', () => (popoverOpen.value = false))

// ── Claude service status (issue #17) ───────────────────────────────────────
// Always-visible health dot left of the fleet block; click → the status panel
// popover. A clicked OS alert bumps `openSignal`, which opens the panel here.
const statusDotClass = computed(() => severityDotClass(status.severity))
const statusLabel = computed(() => t(severityLabelKey(status.severity)))
const statusOpen = ref(false)
const statusRef = ref<HTMLElement | null>(null)
onClickOutside(statusRef, () => (statusOpen.value = false))
onKeyStroke('Escape', () => (statusOpen.value = false))
watch(
  () => status.openSignal,
  () => (statusOpen.value = true)
)

// ── Pasted-images gallery (footer pill + popover) ────────────────────────────
// The active session's real transcript UUID, or null for a synthetic/unselected
// session — `~/.claude/image-cache/<uuid>/` is keyed by that same UUID. A null
// uuid → count 0 → the pill hides (hide-when-zero, design.md §6).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const imagesUuid = computed<string | null>(() => {
  const s = sessions.selectedSession
  return s && !s.synthetic && UUID_RE.test(s.sessionId) ? s.sessionId : null
})
// Re-attach needs a live PTY; this also gates the background poll (only a
// running session can receive a new paste, so dormant sessions don't poll).
const canReattach = computed(
  () => !!sessions.selectedId && sessions.isSessionLive(sessions.selectedId)
)
const {
  count: imageCount,
  entries: imageEntries,
  refresh: refreshImages,
  loadThumbs: loadImageThumbs,
  clearThumbs: clearImageThumbs
} = useSessionImages(imagesUuid, canReattach)
const imageFolderAlias = computed(() => sessions.selectedPath?.folder ?? '')

const imagesPopoverOpen = ref(false)
const imagesRef = ref<HTMLElement | null>(null)
// Lightbox state is component-local, like the popovers around it — it has a
// single entry point (a tile in `FooterImagePopover`) so it doesn't need the
// `ui` store's cross-component mutex (design.md §6 — Floating surfaces).
const lightboxIndex = ref<number | null>(null)
// While the lightbox is open it OWNS Esc and outside-clicks: it's teleported to
// `body`, so every click inside it (prev/next, the filmstrip) reads as "outside"
// to the footer — without this guard those clicks would close the popover and
// `clearThumbs()` the very data-URLs the lightbox is displaying.
onClickOutside(imagesRef, () => {
  if (lightboxIndex.value === null) imagesPopoverOpen.value = false
})
onKeyStroke('Escape', () => {
  if (lightboxIndex.value === null) imagesPopoverOpen.value = false
})
// Free the loaded base64 whenever the popover closes (any path: toggle, Esc,
// click-outside) — a big gallery is tens of MB not worth keeping resident.
watch(imagesPopoverOpen, (open) => {
  if (!open) clearImageThumbs()
})

/** One clean exit out of the whole image flow: lightbox AND popover behind it. */
function closeImageFlow(): void {
  lightboxIndex.value = null
  imagesPopoverOpen.value = false
}

// Pill "pop" when a genuinely new screenshot lands (design.md §7 — "Pasted-images
// pill bump"). `setTimeout` outlives the 300ms animation so the class is removed
// only after it finished, and a re-add on the next increment restarts it.
const pillBump = ref(false)
let lastBumpUuid: string | null = null
let lastBumpCount = 0
let bumpTimer: ReturnType<typeof setTimeout> | null = null
watch(imageCount, (count) => {
  const uuid = imagesUuid.value
  if (shouldBumpImagePill({ uuid, count, lastUuid: lastBumpUuid, lastCount: lastBumpCount })) {
    pillBump.value = true
    if (bumpTimer) clearTimeout(bumpTimer)
    bumpTimer = setTimeout(() => (pillBump.value = false), 320)
  }
  lastBumpUuid = uuid
  lastBumpCount = count
})
onBeforeUnmount(() => {
  if (bumpTimer) clearTimeout(bumpTimer)
})

// Re-list on open (v1 lists on-open — no live watcher) then fill thumbnails.
async function toggleImagesPopover(): Promise<void> {
  imagesPopoverOpen.value = !imagesPopoverOpen.value
  if (!imagesPopoverOpen.value) {
    lightboxIndex.value = null
    return
  }
  // Local footer mutex: opening the images popover closes the usage one.
  popoverOpen.value = false
  await refreshImages()
  await loadImageThumbs()
}

// Mutex the other way: opening the usage popover closes the images one.
function toggleFleetPopover(): void {
  popoverOpen.value = !popoverOpen.value
  if (popoverOpen.value) imagesPopoverOpen.value = false
}

// T47 P6 S2: "Open full dashboard" link at the foot of the fleet popover —
// closes the popover and takes over the main pane with the Usage Dashboard.
function openFullDashboard(): void {
  popoverOpen.value = false
  ui.openUsageDashboard()
}
</script>

<template>
  <footer
    class="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[11px] text-text-2"
  >
    <!-- Left: active session -->
    <template v-if="chips.length">
      <span
        v-for="chip in chips"
        :key="chip.key"
        class="flex items-center gap-1 whitespace-nowrap"
        :class="[chipClass(chip.key), MONO[chip.key] ? 'font-mono' : '']"
        :aria-label="chipAria(chip)"
        :title="chipAria(chip)"
      >
        <component
          :is="ICONS[chip.key]"
          v-if="ICONS[chip.key]"
          :size="12"
          :stroke-width="1.6"
          class="shrink-0"
        />
        <span
          :class="
            chip.key === 'cost' || chip.key === 'context' || chip.key === 'lines'
              ? 'tabular-nums'
              : ''
          "
          >{{ chip.value }}</span
        >
      </span>
      <span
        v-if="warnReason"
        class="flex items-center gap-1 whitespace-nowrap"
        :class="warnReason === 'pct' ? 'text-red' : 'text-accent'"
        :aria-label="warnAria"
        :title="warnAria"
      >
        <TriangleAlert :size="12" :stroke-width="1.6" class="shrink-0" />
        <span>{{ warnLabel }}</span>
      </span>
    </template>
    <span v-else-if="sessions.selectedId" class="truncate text-text-4">{{ fallbackLabel }}</span>
    <span v-else class="text-text-4">{{ t('footer.noSession') }}</span>

    <!-- Pasted-images pill (hide-when-zero) — left of the ml-auto cluster -->
    <div v-if="imageCount > 0" ref="imagesRef" class="relative">
      <button
        type="button"
        class="flex items-center gap-1 rounded border px-1 transition-colors"
        :class="[
          imagesPopoverOpen
            ? 'border-accent-line bg-accent-soft text-accent'
            : 'border-border bg-surface-2 text-text-2 hover:border-border-2 hover:text-text',
          pillBump ? 'anim-pill-bump' : ''
        ]"
        :aria-label="t('images.pillAria', { count: imageCount })"
        :title="t('images.pillAria', { count: imageCount })"
        :aria-expanded="imagesPopoverOpen"
        @click="toggleImagesPopover"
      >
        <Image :size="12" :stroke-width="1.6" class="shrink-0" />
        <span class="tabular-nums">{{ imageCount }}</span>
      </button>
      <div
        v-if="imagesPopoverOpen"
        class="anim-fade-in-scale absolute bottom-full left-0 z-50 mb-1.5 w-[320px] rounded-lg border border-border-2 bg-surface-2 shadow-pop"
      >
        <FooterImagePopover
          :entries="imageEntries"
          :uuid="imagesUuid ?? ''"
          :folder-alias="imageFolderAlias"
          :count="imageCount"
          :can-reattach="canReattach"
          @open-lightbox="lightboxIndex = $event"
        />
      </div>
    </div>

    <!-- Image lightbox (z-60, teleported to body) — opened from a popover tile -->
    <ImageLightbox
      v-if="lightboxIndex !== null"
      :entries="imageEntries"
      :index="lightboxIndex"
      :uuid="imagesUuid ?? ''"
      :folder-alias="imageFolderAlias"
      :can-reattach="canReattach"
      @close="closeImageFlow"
      @update:index="lightboxIndex = $event"
      @reattached="closeImageFlow"
    />

    <!-- Right cluster: service-status dot + fleet summary -->
    <div class="ml-auto flex items-center gap-3">
      <!-- Supervision load (T67 §3) — how many live sessions are working or need
           you right now. A discreet number, no alarm/ceiling in v1; the tooltip
           cites the ~4–5 comfortable-supervision ceiling from the study. -->
      <div
        v-if="sessions.supervisionLoad > 0"
        class="flex items-center gap-1.5 whitespace-nowrap text-text-2"
        :title="t('footer.supervisionLoadHint', { count: sessions.supervisionLoad })"
      >
        <span class="shrink-0 rounded-full bg-green" style="width: 7px; height: 7px" />
        <span class="tabular-nums">{{
          t('footer.supervisionLoad', { count: sessions.supervisionLoad })
        }}</span>
      </div>

      <!-- Claude service status — always visible health dot + panel popover -->
      <div ref="statusRef" class="relative">
        <button
          type="button"
          class="flex items-center rounded text-text-2 transition-colors hover:text-text"
          :aria-label="t('claudeStatus.a11yDot', { status: statusLabel })"
          :title="t('claudeStatus.a11yDot', { status: statusLabel })"
          :aria-expanded="statusOpen"
          @click="statusOpen = !statusOpen"
        >
          <span
            class="shrink-0 rounded-full"
            :class="statusDotClass"
            style="width: 8px; height: 8px"
          />
        </button>
        <div
          v-if="statusOpen"
          class="anim-fade-in-scale absolute bottom-full right-0 z-50 mb-1.5 w-[300px] rounded-lg border border-border-2 bg-surface-2 shadow-pop"
        >
          <ClaudeStatusPanel />
        </div>
      </div>

      <!-- Heap gauge (T127 S3) — the always-on early-warning signal, grafted
           into the fleet pill; opens the System Monitor takeover on click -->
      <HeapGauge />

      <!-- Cleanup pill (T443) — ONE pill for Workspace GC, replacing the old Cleanup and
           Containers pills. Idle shows what is reclaimable, running mirrors the hero's progress
           chip, attention counts the items that need the operator. Hidden when there is nothing
           to reclaim, nothing running and nothing failed. -->
      <button
        v-if="cleanupPill"
        type="button"
        data-dsqa="cleanup-footer-pill"
        :data-state="cleanupPill.kind"
        class="flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 text-[11px] transition-colors"
        :class="
          ui.cleanupOpen
            ? 'text-accent'
            : cleanupPill.kind === 'running'
              ? 'text-accent'
              : cleanupPill.kind === 'attention'
                ? 'text-warning'
                : 'text-text-2 hover:bg-surface-2 hover:text-text'
        "
        :aria-label="cleanupPill.aria"
        :title="cleanupPill.aria"
        :aria-pressed="ui.cleanupOpen"
        @click="ui.toggleCleanup()"
      >
        <Recycle :size="12" :stroke-width="1.6" class="shrink-0" />
        <span
          v-if="cleanupPill.kind === 'running'"
          class="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          style="box-shadow: 0 0 0 3px var(--color-accent-soft)"
          aria-hidden="true"
        />
        <span class="tabular-nums">{{ cleanupPill.text }}</span>
      </button>
      <span class="sr-only" aria-live="polite" data-testid="cleanup-footer-live">{{
        cleanupAnnouncement
      }}</span>

      <!-- Scheduler pill (T295, design.md "Scheduler footer pill") — always visible
           (no hide-when-zero): quiet with a Clock glyph when nothing is running, a
           pulsing green dot + live count when a tick is in flight. -->
      <button
        type="button"
        data-dsqa="scheduler-footer-pill"
        class="flex h-5 items-center gap-1.5 whitespace-nowrap rounded-sm px-1.5 text-[11px] transition-colors hover:bg-surface-2"
        :class="schedulerRunningCount > 0 ? 'text-green' : 'text-text-4 hover:text-text-2'"
        :aria-label="
          schedulerRunningCount > 0
            ? t('scheduler.footerRunning', { n: schedulerRunningCount })
            : t('scheduler.footerPill')
        "
        :title="
          schedulerRunningCount > 0
            ? t('scheduler.footerRunning', { n: schedulerRunningCount })
            : t('scheduler.footerPill')
        "
        :aria-pressed="ui.schedulerOpen"
        @click="ui.toggleScheduler()"
      >
        <template v-if="schedulerRunningCount > 0">
          <span
            class="anim-pulse-dot shrink-0 rounded-full bg-green"
            style="width: 7px; height: 7px; --pulse-from: 0.47"
          />
          <span class="tabular-nums">{{
            t('scheduler.footerRunning', { n: schedulerRunningCount })
          }}</span>
        </template>
        <template v-else>
          <Clock :size="12" :stroke-width="1.6" class="shrink-0" />
          <span>{{ t('scheduler.footerPill') }}</span>
        </template>
      </button>

      <!-- Fleet summary (click → full meters popover) -->
      <div v-if="fleetVisible" ref="fleetRef" class="relative">
        <button
          type="button"
          class="flex items-center gap-2 whitespace-nowrap rounded text-text-2 transition-colors hover:text-text"
          :aria-label="t('footer.a11yFleet')"
          :aria-expanded="popoverOpen"
          @click="toggleFleetPopover"
        >
          <span
            v-if="fiveHourPct != null"
            class="flex items-center gap-1"
            :aria-label="fiveHourAria"
            :title="fiveHourAria"
          >
            <span class="flex items-center"
              ><span class="text-text-3">{{ t('footer.fiveHour') }}</span
              ><span v-if="fiveHourCountdown" class="text-text-2 tabular-nums">{{
                t('footer.windowCountdown', { time: fiveHourCountdown })
              }}</span></span
            >
            <span class="tabular-nums" :class="footerPctClass(fiveHourPct)"
              >{{ Math.round(fiveHourPct) }}%</span
            >
          </span>
          <span
            v-if="sevenDayPct != null"
            class="flex items-center gap-1"
            :aria-label="sevenDayAria"
            :title="sevenDayAria"
          >
            <span class="flex items-center"
              ><span class="text-text-3">{{ t('footer.sevenDay') }}</span
              ><span v-if="sevenDayCountdown" class="text-text-2 tabular-nums">{{
                t('footer.windowCountdown', { time: sevenDayCountdown })
              }}</span></span
            >
            <span class="tabular-nums" :class="footerPctClass(sevenDayPct)"
              >{{ Math.round(sevenDayPct) }}%</span
            >
          </span>
          <span v-if="fleetCost" class="tabular-nums">{{ fleetCost }}</span>
        </button>
        <div
          v-if="popoverOpen"
          class="anim-fade-in-scale absolute bottom-full right-0 z-50 mb-1.5 w-[280px] rounded-lg border border-border-2 bg-surface-2 p-2 shadow-pop"
        >
          <UsagePanel />
          <button
            type="button"
            class="mt-1 flex w-full items-center justify-end gap-1 rounded px-1 py-1 text-[11px] text-accent transition-colors hover:bg-surface"
            @click="openFullDashboard"
          >
            {{ t('footer.openFullDashboard') }}
            <ExternalLink :size="12" :stroke-width="1.8" />
          </button>
        </div>
      </div>
    </div>
  </footer>
</template>
