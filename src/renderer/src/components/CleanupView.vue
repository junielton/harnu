<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useElementSize, useNow } from '@vueuse/core'
import {
  Trash2,
  Recycle,
  RefreshCw,
  Loader2,
  Settings,
  LayoutGrid,
  List,
  CircleCheck,
  History,
  Copy,
  GitBranch,
  House,
  Archive,
  Cloud
} from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useReaperStore } from '../stores/reaper'
import { useGcStore } from '../stores/gc'
import { relativeTime } from '../composables/useRelativeTime'
import { formatBytes } from './system-monitor-format'
import { canDehydrate, canRehydrate } from './cleanup-row'
import { identText } from './cleanup-ident'
import {
  captureConfirm,
  confirmChanged,
  selectionStats,
  toggleChecked,
  type CapturedConfirm
} from '../lib/gc-model'
import { nextCycleIn } from '../lib/gc-format'
import CleanupTreemap from './CleanupTreemap.vue'
import CleanupListView from './CleanupListView.vue'
import CleanupBlockPanel from './CleanupBlockPanel.vue'
import CleanupReviewList from './CleanupReviewList.vue'
import CleanupHeroButton from './CleanupHeroButton.vue'
import CleanupSelectionBar from './CleanupSelectionBar.vue'
import CleanupFirstCycleBanner from './CleanupFirstCycleBanner.vue'
import CleanupDockerCard from './CleanupDockerCard.vue'
import CleanupSplitBar from './CleanupSplitBar.vue'
import CleanupLegend from './CleanupLegend.vue'
import CleanupBulkConfirmDialog from './CleanupBulkConfirmDialog.vue'
import CleanupOtherItems from './CleanupOtherItems.vue'
import DehydrateConfirmDialog from './DehydrateConfirmDialog.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import Button from './ui/Button.vue'
import type { ReapItem, Tombstone } from '../../../preload'

/**
 * Cleanup takeover — the single home of cleaning (design.md "Workspace GC — unified Cleanup").
 * A disk-first treemap of every worktree (repo → bucket → block), one hero button for the proven
 * ready items, a selection bar for the Needs review items, a Docker card and the "Needs review" list. Cleaning
 * runs as a background job: the hero turns into a progress chip, cleaned blocks fade out and the map
 * re-flows, and the view stays usable throughout — it never awaits `gc:clean`.
 *
 * This shell only wires: every decision lives in `lib/gc-*` and `stores/gc.ts`, and main re-probes
 * every item before it touches anything.
 */
const ui = useUiStore()
const reaper = useReaperStore()
const gc = useGcStore()
const { t } = useI18n()
const now = useNow({ interval: 30_000 })

const loading = computed(() => gc.loading || !gc.snapshot)

/**
 * The gather reads the Reaper's last scan, which does not exist before the first scan. Until it does the
 * screen says it is scanning — an empty gather would otherwise read "All clean" (design.md "First scan").
 * `settling` keeps that state through the gather that follows the scan, so a stale empty snapshot never
 * paints in between.
 */
const scanError = ref<string | null>(null)
const settling = ref(false)
const awaitingScan = computed(() => (!reaper.snapshot && !scanError.value) || settling.value)

async function scanFirst(): Promise<void> {
  scanError.value = null
  settling.value = true
  try {
    await reaper.scanNow()
    await gc.refresh()
  } catch (e) {
    scanError.value = e instanceof Error ? e.message : String(e)
  } finally {
    settling.value = false
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  await Promise.all([gc.init(), reaper.init()])
  if (!reaper.snapshot) await scanFirst()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

const model = computed(() => gc.model)
const prefs = computed(() => gc.prefs)

// ---- view state ---------------------------------------------------------------------------------

const viewMode = ref<'map' | 'list'>('map')
const mode = computed<'map' | 'list'>(() =>
  model.value?.hasBytes === false ? 'list' : viewMode.value
)
const drillRepo = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const linkedId = ref<string | null>(null)
const checked = ref<Set<string>>(new Set())

const selectedBlock = computed(() =>
  selectedId.value && model.value ? (model.value.byId.get(selectedId.value) ?? null) : null
)
const stats = computed(() =>
  model.value ? selectionStats(model.value, checked.value) : { count: 0, bytes: 0 }
)

// A cleaned, kept or re-bucketed item leaves the selection and closes its panel on its own.
watch(model, (m) => {
  if (!m) return
  checked.value = gc.pruneSelection(checked.value)
  if (selectedId.value && !m.byId.has(selectedId.value)) selectedId.value = null
  if (drillRepo.value && !m.regions.some((r) => r.repoPath === drillRepo.value)) {
    drillRepo.value = null
  }
})

// Repo-group context-menu entry point: drill into the requested repo once it is on the map.
watch(
  () => [model.value, ui.cleanupScrollTarget] as const,
  ([m, target]) => {
    if (!m || !target) return
    if (m.regions.some((r) => r.repoPath === target)) drillRepo.value = target
    ui.cleanupScrollTarget = null
  },
  { immediate: true }
)

const body = ref<HTMLElement | null>(null)
const { width: bodyWidth } = useElementSize(body)
/** Below 1100px the panel overlays the map instead of docking beside it (design.md "Side panel"). */
const panelDocked = computed(() => bodyWidth.value >= 1100)

function onSelect(id: string): void {
  selectedId.value = selectedId.value === id ? null : id
}
function onToggle(id: string): void {
  if (model.value) checked.value = toggleChecked(model.value, checked.value, id)
}
function onSelectAllInRepo(repoPath: string): void {
  const m = model.value
  if (!m) return
  const next = new Set(checked.value)
  for (const b of m.blocks) if (b.repoPath === repoPath && b.bucket === 'review') next.add(b.id)
  checked.value = next
}
function clearSelection(): void {
  checked.value = new Set()
}

// ---- opinions -----------------------------------------------------------------------------------
// "Ask for an opinion" is advisory: it fills chips and nothing else. "Remove the ones marked safe"
// only pre-selects those items and opens the same remove dialog as Remove selected, so the confirm
// still sends each id as `confirmed` with its `expected` facts. Nothing here calls `gc:clean`.

const askingSelection = computed(
  () => checked.value.size > 0 && [...checked.value].every((id) => gc.isAsking(id))
)

function askOpinion(ids: readonly string[]): void {
  void gc.askOpinion(ids)
}
function askAllOpinions(): void {
  askOpinion(model.value?.review.map((b) => b.id) ?? [])
}
async function removeMarkedSafe(): Promise<void> {
  if (dialogOpen.value || gc.safeOpinionIds.length === 0) return
  // The chips were true when they were drawn. Main is asked again right now, under each item's
  // current key, and only the ones it still confirms as safe are pre-selected.
  const r = await gc.confirmSafe()
  if (r.failed) {
    ui.pushToast({ kind: 'warning', title: t('cleanup.gc.opinion.recheckFailed'), timeoutMs: 8000 })
    return
  }
  if (r.dropped.length > 0) {
    ui.pushToast({
      kind: 'warning',
      title: t('cleanup.gc.opinion.staleSafe', { count: r.dropped.length }, r.dropped.length),
      timeoutMs: 8000
    })
  }
  if (r.kept.length === 0 || dialogOpen.value) return
  checked.value = new Set(r.kept)
  openRemove(r.kept)
}

// ---- dialogs ------------------------------------------------------------------------------------

/** What the open dialog showed — rows AND the exact request — frozen at the moment it opened. */
const confirmDialog = ref<CapturedConfirm | null>(null)
const dehydrateItems = ref<ReapItem[] | null>(null)
const dialogOpen = computed(() => confirmDialog.value !== null || dehydrateItems.value !== null)

/** The data behind the open dialog moved (a cycle or a job refreshed it): block the confirm. */
const confirmStale = computed(
  () => !!confirmDialog.value && !!model.value && confirmChanged(model.value, confirmDialog.value)
)

function openReady(ids?: string[]): void {
  if (dialogOpen.value || !model.value) return
  const c = captureConfirm(model.value, ids ?? model.value.ready.map((b) => b.id), 'ready')
  if (c) confirmDialog.value = c
}
function openRemove(ids: string[]): void {
  if (dialogOpen.value || !model.value) return
  const c = captureConfirm(model.value, ids, 'review')
  if (c) confirmDialog.value = c
}
/** Retry re-opens the confirm for the item's CURRENT bucket — never a dialog that would send nothing. */
function retry(id: string): void {
  const bucket = model.value?.byId.get(id)?.bucket
  if (bucket === 'ready') openReady([id])
  else if (bucket === 'review') openRemove([id])
}
function errorToast(title: string, e: unknown): void {
  ui.pushToast({
    kind: 'danger',
    title,
    description: e instanceof Error ? e.message : String(e),
    timeoutMs: 8000
  })
}

/** True while a banner action is in flight: the buttons disable so a click always shows something. */
const firstCyclePending = ref(false)
/** Runs one first-cycle banner action; a failure is reported and the banner stays up to retry. */
async function runFirstCycle(action: () => Promise<void>, failureTitle: string): Promise<void> {
  if (firstCyclePending.value) return
  firstCyclePending.value = true
  try {
    await action()
  } catch (e) {
    errorToast(failureTitle, e)
  } finally {
    firstCyclePending.value = false
  }
}

async function confirmClean(): Promise<void> {
  const d = confirmDialog.value
  if (!d || confirmStale.value) return
  // Close first, then start: the clean is a background job, the view is never blocked on it.
  confirmDialog.value = null
  try {
    await gc.submit(d.request)
  } catch (e) {
    errorToast(t('cleanup.gc.error.clean'), e)
    return
  }
  const next = new Set(checked.value)
  for (const id of d.ids) next.delete(id)
  checked.value = next
}

/** Keep applies to worktrees; a rejected keep is reported and the screen refreshed, never swallowed. */
async function keepIds(ids: readonly string[]): Promise<void> {
  try {
    await gc.keepMany(ids)
  } catch (e) {
    errorToast(t('cleanup.gc.error.keep'), e)
  }
}
const canKeepSelection = computed(() =>
  [...checked.value].some((id) => model.value?.byId.get(id)?.kind === 'worktree')
)

function dehydratable(ids: readonly string[]): ReapItem[] {
  const m = model.value
  if (!m) return []
  return ids
    .map((id) => m.byId.get(id)?.bundle?.item)
    .filter((i): i is ReapItem => !!i && canDehydrate(i))
}
function openDehydrate(ids: string[]): void {
  if (dialogOpen.value) return
  const items = dehydratable(ids)
  if (items.length > 0) dehydrateItems.value = items
}
async function closeDehydrate(): Promise<void> {
  dehydrateItems.value = null
  await reaper.scanNow()
  await gc.refresh()
}

async function rehydrate(id: string): Promise<void> {
  const item = model.value?.byId.get(id)?.bundle?.item
  if (!item || !canRehydrate(item) || reaper.hydrationOps.has(item.id)) return
  const what = identText(item)
  try {
    const result = await reaper.rehydrate(item.id)
    const changed =
      result.changedTracked.length > 0
        ? t('cleanup.toast.rehydrateChanged', { files: result.changedTracked.join(', ') })
        : undefined
    if (result.ok) {
      ui.pushToast({
        kind: changed ? 'warning' : 'success',
        title: t('cleanup.toast.rehydrated', { what }),
        description: changed,
        timeoutMs: changed ? 8000 : 6000
      })
    } else {
      ui.pushToast({
        kind: 'danger',
        title: t('cleanup.toast.rehydrateFailed', { what }),
        description: [result.failure?.message ?? result.error, changed].filter(Boolean).join('\n'),
        timeoutMs: 8000
      })
    }
  } catch (e) {
    ui.pushToast({
      kind: 'danger',
      title: t('cleanup.toast.rehydrateFailed', { what }),
      description: e instanceof Error ? e.message : String(e),
      timeoutMs: 8000
    })
  }
  await reaper.scanNow()
  await gc.refresh()
}

function hydrationBusy(id: string): 'dehydrating' | 'rehydrating' | null {
  const item = model.value?.byId.get(id)?.bundle?.item
  const op = item ? reaper.hydrationOps.get(item.id) : undefined
  return op === 'dehydrating' || op === 'rehydrating' ? op : null
}

// ---- toolbar ------------------------------------------------------------------------------------

async function rescan(): Promise<void> {
  clearSelection()
  // Before any scan has ever worked, a rescan is the first scan: it owns the "Scanning…" state.
  if (!reaper.snapshot) return scanFirst()
  await reaper.scanNow()
  await gc.refresh()
}

const next = computed(() =>
  nextCycleIn(
    prefs.value?.autopilot ? (gc.snapshot?.nextCycleAt ?? null) : null,
    now.value.getTime()
  )
)
const intervalText = computed(() => {
  const ms = prefs.value?.intervalMs ?? 3_600_000
  return ms >= 86_400_000
    ? t('cleanup.gc.status.everyDay')
    : ms >= 3_600_000
      ? t('cleanup.gc.status.everyHours', { n: Math.round(ms / 3_600_000) })
      : t('cleanup.gc.status.everyMinutes', { n: Math.round(ms / 60_000) })
})
const nextText = computed(() => {
  const n = next.value
  if (!n) return null
  return t(`cleanup.gc.status.next.${n.unit}`, { n: n.n })
})

const showFirstCycle = computed(
  () =>
    !!prefs.value && !prefs.value.firstReportAcknowledged && (model.value?.ready.length ?? 0) > 0
)
const allClean = computed(() => {
  const tt = model.value?.totals
  return !!tt && tt.ready.count + tt.review.count + tt.orphanVolumes.count === 0
})
const lastChecked = computed(() => {
  const at = gc.snapshot?.lastCycle?.at
  void now.value
  return at ? relativeTime(new Date(at).toISOString()) : null
})

const modeOptions = computed(() => [
  { value: 'map', label: t('cleanup.gc.view.map'), icon: LayoutGrid },
  { value: 'list', label: t('cleanup.gc.view.list'), icon: List }
])

function openAutopilotSettings(): void {
  ui.openSettings('cleanup')
}

// ---- keyboard -----------------------------------------------------------------------------------

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || dialogOpen.value) return
  if (checked.value.size > 0) {
    clearSelection()
    e.stopPropagation()
  } else if (selectedId.value) {
    selectedId.value = null
    e.stopPropagation()
  }
}

// ---- recent cleanups (the tombstone journal) ------------------------------------------------------

const KIND_ICON: Record<string, Component> = {
  worktree: House,
  'detached-worktree': House,
  'local-branch': GitBranch,
  'hidden-folder': Archive,
  'remote-branch': Cloud
}
function tombIcon(kind: string): Component {
  return KIND_ICON[kind] ?? GitBranch
}
function tombKey(tomb: Tombstone, index: number): string {
  return `${tomb.at}-${tomb.branch ?? tomb.repoPath}-${index}`
}
function agoText(atMs: number): string {
  void now.value
  return relativeTime(new Date(atMs).toISOString())
}
async function copyRestoreHint(hint: string): Promise<void> {
  await navigator.clipboard.writeText(hint)
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-5.5 py-3"
    data-testid="cleanup-toolbar"
  >
    <span class="flex items-center gap-2 text-body text-text-2" data-testid="cleanup-summary">
      <Recycle :size="14" :stroke-width="1.6" class="shrink-0 text-green" />
      <span v-if="awaitingScan" data-testid="cleanup-summary-scanning">{{
        t('cleanup.gc.firstScan.title')
      }}</span>
      <template v-else>
        <i18n-t keypath="cleanup.gc.status.reclaimable" scope="global">
          <template #size>
            <b class="font-semibold text-text">{{ formatBytes(gc.reclaimableBytes) }}</b>
          </template>
        </i18n-t>
        <span class="text-text-4">·</span>
        <span>{{
          prefs?.autopilot
            ? t('cleanup.gc.status.autopilotOn')
            : t('cleanup.gc.status.autopilotOff')
        }}</span>
        <template v-if="nextText">
          <span class="text-text-4">·</span>
          <span>{{ nextText }}</span>
        </template>
      </template>
    </span>

    <CleanupHeroButton :hero="gc.hero" :scanning="awaitingScan" @click="openReady()" />

    <span
      class="inline-flex items-center rounded-full border px-2 py-0.5 text-caption"
      :class="
        prefs?.autopilot
          ? 'border-green-line bg-green-soft text-green'
          : 'border-border bg-surface text-text-3'
      "
      data-testid="cleanup-autopilot-badge"
    >
      {{
        prefs?.autopilot
          ? t('cleanup.gc.status.badgeOn', { every: intervalText })
          : t('cleanup.gc.status.badgeOff')
      }}
    </span>
    <Button
      variant="ghost"
      data-testid="cleanup-autopilot-settings"
      @click="openAutopilotSettings()"
    >
      <Settings :size="13" :stroke-width="1.7" />
      {{ t('cleanup.gc.toolbar.autopilotSettings') }}
    </Button>

    <div class="ml-auto flex items-center gap-2">
      <SegmentedControl
        v-model="viewMode"
        :options="modeOptions"
        size="sm"
        :disabled="model?.hasBytes === false"
        :title="model?.hasBytes === false ? t('cleanup.gc.view.noBytes') : undefined"
        :aria-label="t('cleanup.gc.view.label')"
      />
      <Button
        variant="ghost"
        size="icon"
        :disabled="reaper.scanning"
        :aria-label="t('cleanup.scanNow')"
        :title="t('cleanup.scanNow')"
        data-testid="cleanup-rescan"
        @click="rescan()"
      >
        <Loader2
          v-if="reaper.scanning"
          :size="14"
          :stroke-width="1.7"
          class="shrink-0 animate-spin"
        />
        <RefreshCw v-else :size="14" :stroke-width="1.7" />
      </Button>
    </div>
  </div>

  <CleanupSelectionBar
    :count="stats.count"
    :bytes="stats.bytes"
    :can-keep="canKeepSelection"
    :asking="askingSelection"
    @remove="openRemove([...checked])"
    @dehydrate="openDehydrate([...checked])"
    @keep="keepIds([...checked])"
    @ask="askOpinion([...checked])"
    @clear="clearSelection()"
  />

  <div ref="body" class="scrollable min-h-0 flex-1 overflow-y-auto" data-testid="cleanup-body">
    <div v-if="loading" class="py-16 text-center text-ui text-text-3" data-testid="cleanup-loading">
      <Loader2 :size="16" :stroke-width="1.6" class="mx-auto mb-2 animate-spin text-text-4" />
      {{ t('cleanup.gc.loading') }}
    </div>
    <div v-else-if="gc.loadError" class="px-5.5 py-8 text-ui text-red">
      {{ t('cleanup.gc.loadError', { error: gc.loadError }) }}
    </div>
    <div
      v-else-if="awaitingScan"
      class="flex flex-col items-center gap-1 py-16 text-center"
      role="status"
      data-testid="cleanup-scanning"
    >
      <Loader2 :size="20" :stroke-width="1.6" class="mb-2 animate-spin text-text-4" />
      <div class="text-body font-medium leading-5 text-text-2">
        {{ t('cleanup.gc.firstScan.title') }}
      </div>
      <div class="text-caption text-text-3">{{ t('cleanup.gc.firstScan.sub') }}</div>
    </div>
    <div
      v-else-if="scanError && !reaper.snapshot"
      class="px-5.5 py-8 text-ui text-red"
      data-testid="cleanup-scan-failed"
    >
      {{ t('cleanup.gc.firstScan.failed', { error: scanError }) }}
    </div>

    <div v-else-if="model && prefs" class="relative">
      <div class="px-5.5 pt-3">
        <CleanupFirstCycleBanner
          v-if="showFirstCycle"
          :count="model.ready.length"
          :bytes="model.totals.ready.bytes"
          :pending="firstCyclePending"
          @enable="runFirstCycle(() => gc.enableAutopilot(), t('cleanup.gc.error.autopilot'))"
          @dismiss="runFirstCycle(() => gc.dismissFirstReport(), t('cleanup.gc.error.dismiss'))"
        />
      </div>

      <div
        class="gap-4 px-5.5 pb-4 pt-3"
        :class="
          selectedBlock && panelDocked ? 'grid grid-cols-[minmax(0,1fr)_320px]' : 'flex flex-col'
        "
      >
        <div class="flex min-w-0 flex-col gap-3">
          <CleanupSplitBar
            :totals="model.totals"
            :has-bytes="model.hasBytes"
            :last-cycle="gc.snapshot?.lastCycle ?? null"
            :running="gc.hero.kind === 'running' ? { left: gc.hero.total - gc.hero.done } : null"
          />
          <CleanupLegend :has-bytes="model.hasBytes" />

          <div
            v-if="allClean"
            class="flex flex-col items-center gap-1 py-6 text-center"
            data-testid="cleanup-all-clean"
          >
            <CircleCheck :size="28" :stroke-width="1.5" class="mb-2 text-green" />
            <div class="text-title font-medium leading-7 tracking-title text-text">
              {{ t('cleanup.gc.empty.title') }}
            </div>
            <div class="text-body leading-5 text-text-2">
              {{
                lastChecked
                  ? t('cleanup.gc.empty.subtitleAgo', { ago: lastChecked })
                  : t('cleanup.gc.empty.subtitle')
              }}
            </div>
          </div>

          <CleanupTreemap
            v-if="mode === 'map'"
            :model="model"
            :block-state="gc.blockState"
            :checked="checked"
            :selected-id="selectedId"
            :linked-id="linkedId"
            :planned="showFirstCycle"
            :drill-repo="drillRepo"
            @select="onSelect"
            @toggle="onToggle"
            @select-all-in-repo="onSelectAllInRepo"
            @drill="drillRepo = $event"
            @open-aggregate="viewMode = 'list'"
          />
          <CleanupListView v-else :model="model" :block-state="gc.blockState" @select="onSelect" />

          <CleanupDockerCard
            :orphan-volumes="model.totals.orphanVolumes"
            :volumes="gc.snapshot?.orphanVolumes ?? []"
            :docker="model.docker"
            :last-cycle="gc.snapshot?.lastCycle ?? null"
            :prefs="prefs"
            @inspect="ui.openContainers()"
            @toggle="
              (category, value) =>
                gc.savePrefs({ categories: { ...prefs!.categories, [category]: value } })
            "
          />

          <CleanupReviewList
            v-if="model.review.length > 0"
            :blocks="model.review"
            :checked="checked"
            :linked-id="linkedId"
            :block-state="gc.blockState"
            :failure-of="gc.failureOf"
            :opinion-of="gc.opinionFor"
            :is-asking="gc.isAsking"
            :safe-count="gc.safeOpinionIds.length"
            @toggle="onToggle"
            @select="onSelect"
            @hover="linkedId = $event"
            @remove="openRemove([$event])"
            @dehydrate="openDehydrate([$event])"
            @keep="keepIds([$event])"
            @ask-all="askAllOpinions()"
            @remove-safe="removeMarkedSafe()"
          />
        </div>

        <aside
          v-if="selectedBlock"
          :class="
            panelDocked ? 'sticky top-3 self-start' : 'absolute right-5.5 top-3 z-10 shadow-pop'
          "
          data-testid="cleanup-panel"
        >
          <CleanupBlockPanel
            :block="selectedBlock"
            :state="gc.blockState(selectedBlock.id)"
            :failure="gc.failureOf(selectedBlock.id)"
            :dehydrate-idle-days="reaper.dehydrateIdleDays"
            :hydration-busy="hydrationBusy(selectedBlock.id)"
            :opinion="gc.opinionFor(selectedBlock.id)"
            :asking="gc.isAsking(selectedBlock.id)"
            @close="selectedId = null"
            @remove="openRemove([$event])"
            @retry="retry($event)"
            @clean-now="openReady([$event])"
            @dehydrate="openDehydrate([$event])"
            @rehydrate="rehydrate($event)"
            @keep="keepIds([$event])"
            @ask="askOpinion([$event])"
          />
        </aside>
      </div>

      <CleanupOtherItems />

      <template v-if="reaper.journal.length > 0">
        <div
          class="flex items-center gap-2 px-5.5 pb-2.5 pt-5.5 text-caption font-semibold uppercase tracking-wide text-text-4"
        >
          <History :size="12" :stroke-width="1.7" />
          {{ t('cleanup.recent') }}
        </div>
        <div class="flex flex-col gap-1.5 px-5.5 pb-5.5">
          <div
            v-for="(tomb, index) in reaper.journal"
            :key="tombKey(tomb, index)"
            class="flex items-center gap-3 rounded-sm border border-border bg-surface px-3 py-2.25 text-caption text-text-3"
          >
            <component
              :is="tombIcon(tomb.kind)"
              :size="12"
              :stroke-width="1.6"
              class="text-text-4"
            />
            <span class="font-mono text-caption text-text-2">{{
              tomb.branch ?? tomb.repoPath
            }}</span>
            <span class="truncate">
              {{ t('cleanup.sweptAgo', { ago: agoText(tomb.at) }) }}
              <template v-if="tomb.sha"> · {{ t('cleanup.was', { sha: tomb.sha }) }}</template>
            </span>
            <button
              v-if="tomb.restoreHint"
              class="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-0.75 font-mono text-eyebrow text-text-4 transition hover:border-border-2 hover:text-text-2"
              @click="copyRestoreHint(tomb.restoreHint)"
            >
              <Copy :size="10" :stroke-width="1.7" />
              {{ tomb.restoreHint }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>

  <CleanupBulkConfirmDialog
    v-if="confirmDialog"
    :rows="confirmDialog.rows"
    :mode="confirmDialog.mode"
    :stale="confirmStale"
    :opinion-of="gc.opinionFor"
    @confirm="confirmClean()"
    @cancel="confirmDialog = null"
  />
  <DehydrateConfirmDialog v-if="dehydrateItems" :items="dehydrateItems" @close="closeDehydrate()" />

  <!-- T300/U3: header markup rendered into the shared TakeoverShell (design.md §6
       "TakeoverShell — shared chrome") via Teleport. Placed after the real body content so this
       stays a component whose first root node is a real element. -->
  <Teleport to="#takeover-shell-icon" defer>
    <Trash2 :size="16" :stroke-width="1.6" class="shrink-0 text-accent" />
  </Teleport>
</template>
