<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNow } from '@vueuse/core'
import {
  Trash2,
  RefreshCw,
  Loader2,
  House,
  GitBranch,
  Archive,
  Cloud,
  TriangleAlert,
  History,
  Copy,
  ChevronRight,
  Search,
  PackageMinus,
  PackagePlus
} from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useReaperStore } from '../stores/reaper'
import { relativeTime } from '../composables/useRelativeTime'
import { formatBytes } from './system-monitor-format'
import { identText, identTitle } from './cleanup-ident'
import {
  canDehydrate,
  canRehydrate,
  hydrationMarker,
  reasonLine,
  SKIP_REASON_KEYS,
  type HydrationMarker
} from './cleanup-row'
import CleanupTimeline from './CleanupTimeline.vue'
import SweepConfirmDialog from './SweepConfirmDialog.vue'
import DehydrateConfirmDialog from './DehydrateConfirmDialog.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import Button from './ui/Button.vue'
import type { ReapItem, ReapItemKind, Tombstone } from '../../../preload'

/**
 * Cleanup takeover (design.md "Cleanup takeover") — main-pane view for the
 * Reaper engine's guarded deletion pipeline. Follows the `UsageDashboard`
 * takeover pattern: fixed 40px header, a toolbar row, a scrollable body.
 *
 * Sweep and per-item trash both open `SweepConfirmDialog` (plan Task 10) —
 * one confirm path, no destructive action fires without it.
 */
const ui = useUiStore()
const store = useReaperStore()
const { t } = useI18n()
const now = useNow({ interval: 60_000 })

const loading = ref(true)

onMounted(async () => {
  await store.init()
  if (!store.snapshot) await store.scanNow()
  loading.value = false
})

/** Explicit user rescan (T158) — clears the row selection, since the
 * harvestable set it was built against is about to be replaced. */
async function rescan(): Promise<void> {
  clearSelection()
  await store.scanNow()
}

// Repo-group context-menu entry point (plan T11): scroll to the requested
// group once its row exists in the DOM, then clear the one-shot signal.
const groupRefs = new Map<string, HTMLElement>()
function setGroupRef(repoPath: string, el: unknown): void {
  if (el instanceof HTMLElement) groupRefs.set(repoPath, el)
  else groupRefs.delete(repoPath)
}
watch(
  () => store.repoGroups,
  async () => {
    const target = ui.cleanupScrollTarget
    if (!target) return
    await nextTick()
    const el = groupRefs.get(target)
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      ui.cleanupScrollTarget = null
    }
  },
  { immediate: true }
)

// Repo-group collapse (T156) — same Set-swap idiom as SystemMonitor.vue's
// `expandedKeys`, inverted: membership means *collapsed* so a group new to
// `store.repoGroups` (freshly scanned repo) defaults to expanded without
// needing to be seeded into the set.
const collapsedGroups = ref<Set<string>>(new Set())
function isGroupCollapsed(repoPath: string): boolean {
  return collapsedGroups.value.has(repoPath)
}
function toggleGroup(repoPath: string): void {
  const next = new Set(collapsedGroups.value)
  if (next.has(repoPath)) next.delete(repoPath)
  else next.add(repoPath)
  collapsedGroups.value = next
}

// Search + verdict filters (T157) — same idiom as RoadmapBoard.vue's
// `searchQuery`/`activeKinds`: local, ephemeral (not persisted), composed
// with AND. Search matches branch or path, case-insensitive substring.
type VerdictFilter = 'all' | 'harvestable' | 'blocked' | 'unknown'
const VERDICT_FILTERS: VerdictFilter[] = ['all', 'harvestable', 'blocked', 'unknown']
const searchQuery = ref('')
const verdictFilter = ref<VerdictFilter>('all')

function matchesSearch(item: ReapItem, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return (
    (item.branch?.toLowerCase().includes(q) ?? false) ||
    (item.path?.toLowerCase().includes(q) ?? false)
  )
}

function matchesVerdictFilter(item: ReapItem, filter: VerdictFilter): boolean {
  return filter === 'all' || item.verdict === filter
}

const hasActiveFilter = computed(
  () => searchQuery.value.trim() !== '' || verdictFilter.value !== 'all'
)

/** Rows actually rendered — `store.repoGroups` items narrowed by both filters,
 * with any group left empty by the filter dropped entirely (no empty headers). */
const filteredGroups = computed(() =>
  store.repoGroups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          matchesSearch(item, searchQuery.value) && matchesVerdictFilter(item, verdictFilter.value)
      )
    }))
    .filter((group) => group.items.length > 0)
)

/** KPI strip mirrors the filtered set (RoadmapBoard's "header counts after
 * filters" convention) — recomputed straight from the snapshot so an
 * unfiltered view (query empty, verdict 'all') reproduces `store.totals`
 * exactly, including the `active`-verdict items the row list never shows. */
const filteredTotals = computed(() => {
  const totals = { items: 0, harvestable: 0, reclaimableBytes: 0 }
  if (!store.snapshot) return totals
  for (const repo of store.snapshot.repos) {
    for (const item of repo.items) {
      if (
        !matchesSearch(item, searchQuery.value) ||
        !matchesVerdictFilter(item, verdictFilter.value)
      )
        continue
      totals.items++
      if (item.verdict === 'harvestable') {
        totals.harvestable++
        totals.reclaimableBytes += item.diskBytes ?? 0
      }
    }
  }
  return totals
})

/** Per-group KPI breakdown so the header stays informative while collapsed. */
function groupSummaryText(items: ReapItem[]): string {
  let worktrees = 0
  let branches = 0
  let folders = 0
  for (const item of items) {
    // A detached worktree counts under `worktrees` — it is one, it just has no
    // branch. Leaving it out of every bucket would under-report the group and
    // reintroduce the invisibility BUG-95 exists to end; the per-row `detached
    // worktree` label is what distinguishes it. A dedicated breakdown slot is
    // row-rendering work and belongs to T255.
    if (item.kind === 'worktree' || item.kind === 'detached-worktree') worktrees++
    else if (item.kind === 'local-branch' || item.kind === 'remote-branch') branches++
    else if (item.kind === 'hidden-folder') folders++
  }
  return t('cleanup.groupSummary', { worktrees, branches, folders })
}

// Sweep confirm dialog — snapshot of items at open time (Sweep button = every
// currently-harvestable item; per-item trash = a single-item array). Both
// entry points share the same dialog instance, one confirm path.
//
// Guarded against re-entry: `v-if="sweepItems"` mounts the SAME dialog
// instance for as long as `sweepItems` stays non-null, so reassigning it
// while a dialog is already open reactively swaps the `items` prop out from
// under a possibly in-flight clean/sweep instead of opening a fresh dialog.
// Both openers therefore no-op while one is already open.
const sweepItems = ref<ReapItem[] | null>(null)
// Dehydrate confirm (T250) — same one-instance re-entry guard as the sweep
// dialog, and the two are mutually exclusive: `dialogOpen` gates every opener.
const dehydrateItems = ref<ReapItem[] | null>(null)
const dialogOpen = computed(() => sweepItems.value !== null || dehydrateItems.value !== null)
function openSweepAll(): void {
  if (dialogOpen.value) return
  sweepItems.value = [...store.harvestable]
}
function openSweepOne(item: ReapItem): void {
  if (dialogOpen.value) return
  sweepItems.value = [item]
}

/** Every harvestable item in one repo group — unfiltered by the search/verdict
 * bar, same "acts on real state, not a view" rule the toolbar Sweep button
 * follows (see `sweepSize` below). */
function repoHarvestableItems(repoPath: string): ReapItem[] {
  const group = store.repoGroups.find((g) => g.repoPath === repoPath)
  return group ? group.items.filter((item) => item.verdict === 'harvestable') : []
}
function openSweepGroup(repoPath: string): void {
  if (dialogOpen.value) return
  const items = repoHarvestableItems(repoPath)
  if (items.length === 0) return
  sweepItems.value = items
}

// Row multi-select (T158) — hand-picked sweep across repos. Harvestable-only;
// blocked/unknown/active rows never carry a checkbox.
const selectedIds = ref<Set<string>>(new Set())
function isSelected(itemId: string): boolean {
  return selectedIds.value.has(itemId)
}
function toggleSelect(itemId: string): void {
  const next = new Set(selectedIds.value)
  if (next.has(itemId)) next.delete(itemId)
  else next.add(itemId)
  selectedIds.value = next
}
function clearSelection(): void {
  selectedIds.value = new Set()
}
/** Derived from `store.harvestable` rather than trusted verbatim off the Set,
 * so a selected item that stops being harvestable (swept elsewhere, blocked
 * by a fresh scan) drops out on its own. */
const selectedItems = computed<ReapItem[]>(() =>
  store.harvestable.filter((item) => selectedIds.value.has(item.id))
)
function openSweepSelected(): void {
  if (dialogOpen.value || selectedItems.value.length === 0) return
  sweepItems.value = [...selectedItems.value]
}

/** Both scoped sweep entry points (per-repo, per-selection) and the
 * unscoped one share this dialog instance; only a genuinely successful sweep
 * clears the selection — a cancel or a partial failure leaves it as-is so
 * the user can retry. */
function handleSweepDialogClose(success: boolean): void {
  if (success) clearSelection()
  sweepItems.value = null
}

const KIND_ICON: Record<ReapItemKind, Component> = {
  worktree: House,
  'local-branch': GitBranch,
  'hidden-folder': Archive,
  'remote-branch': Cloud,
  'detached-worktree': House
}

const KIND_LABEL_KEYS: Record<ReapItemKind, string> = {
  worktree: 'worktree',
  'local-branch': 'localBranch',
  'hidden-folder': 'hiddenFolder',
  'remote-branch': 'remoteBranch',
  'detached-worktree': 'detachedWorktree'
}

function kindIcon(kind: ReapItemKind): Component {
  return KIND_ICON[kind]
}

function kindLabel(kind: ReapItemKind): string {
  return t(`cleanup.kind.${KIND_LABEL_KEYS[kind]}`)
}

/** `{ago}` slot for `scannedAgo`/`sweptAgo` — reads `now` so it ticks every minute. */
function agoText(atMs: number): string {
  void now.value
  return relativeTime(new Date(atMs).toISOString())
}

/** Row meta ages don't carry a raw timestamp (`ReapItem.ageDays` is day-granular
 * only), so this mirrors `relativeTime`'s terse untranslated style rather than
 * bucketing into weeks — the approved spec always shows a literal day count. */
function ageAgo(ageDays: number): string {
  return ageDays <= 0 ? 'today' : `${ageDays}d ago`
}

/** design.md "The meta line", slot 3 — in-flight state wins over the at-rest marker. */
function rowMarker(item: ReapItem): HydrationMarker | null {
  return hydrationMarker(item, store.hydrationOps.get(item.id), t)
}

/**
 * The meta line's full, untruncated text for its `title` — `truncate` eats from
 * the right, so this is where a clipped age/size, every file a rehydrate
 * changed, and every ephemeral path the guards kept remain readable.
 */
function metaTitle(item: ReapItem): string {
  const marker = rowMarker(item)
  const parts = [kindLabel(item.kind)]
  if (marker) parts.push(marker.text)
  if (item.ageDays !== null) parts.push(ageAgo(item.ageDays))
  if (item.diskBytes !== null) parts.push(formatBytes(item.diskBytes))
  const lines = [parts.join(' · ')]
  if (marker && marker.files.length > 0) {
    lines.push(t('cleanup.state.rehydrateChangedTitle', { files: marker.files.join(', ') }))
  }
  const kept = item.hydration?.skipped ?? []
  if (kept.length > 0) {
    const items = kept
      .map((s) => `${s.path} — ${t(`cleanup.dehydrateConfirm.skip.${SKIP_REASON_KEYS[s.reason]}`)}`)
      .join('; ')
    lines.push(t('cleanup.state.kept', { items }))
  }
  return lines.join('\n')
}

function trashTitle(item: ReapItem): string {
  return t('cleanup.trashTitle', { what: identText(item) })
}

/**
 * Dehydrate's accessible name and `title` (design.md "Accessible labels"). The
 * no-`setup` warning wins over the size: an operator must learn that Harnu
 * cannot bring the folders back BEFORE dehydrating, not after.
 */
function dehydrateLabel(item: ReapItem): string {
  const what = identText(item)
  const h = item.hydration
  if (h && !h.canRehydrate) return t('cleanup.a11y.dehydrateNoSetup', { what })
  if (h && h.reclaimableBytes !== null) {
    return t('cleanup.a11y.dehydrateSize', { what, size: formatBytes(h.reclaimableBytes) })
  }
  return t('cleanup.a11y.dehydrate', { what })
}

/** A row's cluster disables while a confirm is open or its own operation runs. */
function clusterDisabled(item: ReapItem): boolean {
  return dialogOpen.value || store.hydrationOps.has(item.id)
}

function openDehydrateOne(item: ReapItem): void {
  if (clusterDisabled(item)) return
  dehydrateItems.value = [item]
}
function openDehydrateGroup(repoPath: string): void {
  if (dialogOpen.value) return
  const items = store.idleDehydratable(repoPath)
  if (items.length > 0) dehydrateItems.value = items
}

/**
 * Rehydrate needs no confirm — it re-runs the repo's own committed `setup`,
 * exactly as creating the worktree did — but its outcome is always reported: a
 * rewritten lockfile turns a clean row `blocked`, and Harnu caused it.
 */
async function rehydrateRow(item: ReapItem): Promise<void> {
  if (clusterDisabled(item)) return
  const what = identText(item)
  try {
    const result = await store.rehydrate(item.id)
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
}

function tombIcon(kind: string): Component {
  return (KIND_ICON as Record<string, Component>)[kind] ?? GitBranch
}

async function copyRestoreHint(hint: string): Promise<void> {
  await navigator.clipboard.writeText(hint)
}

const kpiSize = computed(() => formatBytes(filteredTotals.value.reclaimableBytes))
/** Sweep always acts on every harvestable item regardless of the view filter
 * — it's a destructive action on real state, not a view, so its size/count
 * stay unfiltered. */
const sweepSize = computed(() => formatBytes(store.totals.reclaimableBytes))
const sweepDisabled = computed(() => store.harvestable.length === 0 || dialogOpen.value)

function tombKey(tomb: Tombstone, index: number): string {
  return `${tomb.at}-${tomb.branch ?? tomb.repoPath}-${index}`
}
</script>

<template>
  <div class="flex items-center gap-3.5 border-b border-border px-[22px] py-3">
    <span class="text-[12px] text-text-3">
      <i18n-t keypath="cleanup.kpis" scope="global">
        <template #items>
          <b class="font-semibold text-text-2">{{ filteredTotals.items }}</b>
        </template>
        <template #harvestable>
          <b class="font-semibold text-text-2">{{ filteredTotals.harvestable }}</b>
        </template>
        <template #size>
          <b class="font-semibold text-text-2">{{ kpiSize }}</b>
        </template>
      </i18n-t>
    </span>

    <!-- Search + verdict filter (T157) — same idiom as RoadmapFilterBar.vue. -->
    <div
      class="flex h-[26px] w-[180px] items-center gap-1.5 rounded-sm border border-border-2 bg-surface px-2 text-text-3 focus-within:border-accent-line"
    >
      <Search :size="13" :stroke-width="1.8" class="shrink-0" />
      <input
        v-model="searchQuery"
        type="text"
        class="h-full w-full min-w-0 bg-transparent text-[12px] text-text outline-none placeholder:text-text-4"
        :placeholder="t('cleanup.filterBar.searchPlaceholder')"
        :aria-label="t('cleanup.filterBar.searchLabel')"
      />
    </div>
    <SegmentedControl
      v-model="verdictFilter"
      :options="
        VERDICT_FILTERS.map((v) => ({ value: v, label: t(`cleanup.filterBar.verdict.${v}`) }))
      "
      size="sm"
      :aria-label="t('cleanup.filterBar.verdictLabel')"
    />

    <div class="ml-auto flex items-center gap-2">
      <span v-if="store.snapshot" class="text-[11px] text-text-4">
        {{ t('cleanup.scannedAgo', { ago: agoText(store.snapshot.scannedAt) }) }}
      </span>
      <Button variant="soft" :disabled="store.scanning" @click="rescan()">
        <Loader2
          v-if="store.scanning"
          :size="13"
          :stroke-width="1.7"
          class="shrink-0 animate-spin"
        />
        <RefreshCw v-else :size="13" :stroke-width="1.7" />
        {{ t('cleanup.scanNow') }}
      </Button>
      <Button
        :variant="sweepDisabled ? 'soft' : 'success'"
        :disabled="sweepDisabled"
        @click="openSweepAll()"
      >
        {{ t('cleanup.sweep', { count: store.harvestable.length, size: sweepSize }) }}
      </Button>
    </div>
  </div>

  <!-- Selection bar (T158) — alongside, never replacing, the toolbar's
         global Sweep button; shown only while ≥1 row is checked. -->
  <div
    v-if="selectedItems.length > 0"
    class="flex items-center gap-3 border-b border-border bg-surface-2 px-[22px] py-2"
  >
    <span class="text-[12px] text-text-2">
      {{ t('cleanup.selection.count', { count: selectedItems.length }) }}
    </span>
    <Button variant="success" :disabled="dialogOpen" @click="openSweepSelected()">
      {{ t('cleanup.selection.sweep', { count: selectedItems.length }) }}
    </Button>
    <button
      class="ml-auto text-[11.5px] text-text-3 transition hover:text-text"
      @click="clearSelection()"
    >
      {{ t('cleanup.selection.clear') }}
    </button>
  </div>

  <div class="scrollable min-h-0 flex-1 overflow-x-auto overflow-y-auto">
    <div class="min-w-[1096px] px-[22px] pb-[22px] pt-1.5">
      <div v-if="!loading && store.repoGroups.length === 0" class="py-16 text-center">
        <p class="mx-auto max-w-[420px] text-[12px] leading-relaxed text-text-3">
          {{ t('cleanup.emptyState') }}
        </p>
      </div>
      <div
        v-else-if="!loading && hasActiveFilter && filteredGroups.length === 0"
        class="py-16 text-center"
      >
        <p class="mx-auto max-w-[420px] text-[12px] leading-relaxed text-text-3">
          {{ t('cleanup.filterEmptyState') }}
        </p>
      </div>

      <div
        v-for="group in filteredGroups"
        :key="group.repoPath"
        :ref="(el) => setGroupRef(group.repoPath, el)"
      >
        <div
          role="button"
          tabindex="0"
          class="flex w-full items-center gap-2.5 py-3.5 pb-2 text-left"
          :aria-expanded="!isGroupCollapsed(group.repoPath)"
          @click="toggleGroup(group.repoPath)"
          @keydown.enter="toggleGroup(group.repoPath)"
          @keydown.space.prevent="toggleGroup(group.repoPath)"
        >
          <ChevronRight
            :size="13"
            :stroke-width="1.8"
            class="shrink-0 text-text-4 transition-transform"
            :style="{
              transform: isGroupCollapsed(group.repoPath) ? 'rotate(0deg)' : 'rotate(90deg)',
              transitionDuration: 'var(--dur)',
              transitionTimingFunction: 'var(--ease)'
            }"
          />
          <span class="font-mono text-[12.5px] font-semibold text-text-2">{{ group.label }}</span>
          <span class="text-[10.5px] text-text-4 tabular-nums">{{
            groupSummaryText(group.items)
          }}</span>
          <span class="ml-auto flex shrink-0 items-center gap-1.5">
            <!-- Neutral chrome, never green or red: dehydration is reversible and
                 is not a sweep (design.md "Repo-group Dehydrate pill"). -->
            <button
              v-if="store.idleDehydratable(group.repoPath).length > 0"
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-2 bg-surface px-2.5 py-1 text-[10.5px] font-semibold text-text-2 transition hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              :aria-label="
                t('cleanup.a11y.dehydrateGroup', {
                  count: store.idleDehydratable(group.repoPath).length,
                  repo: group.label
                })
              "
              :disabled="dialogOpen"
              @click.stop="openDehydrateGroup(group.repoPath)"
            >
              <PackageMinus :size="11" :stroke-width="1.8" />
              {{
                t('cleanup.dehydrateGroup', {
                  count: store.idleDehydratable(group.repoPath).length
                })
              }}
            </button>
            <button
              v-if="repoHarvestableItems(group.repoPath).length > 0"
              type="button"
              class="shrink-0 rounded-sm border border-green/40 bg-green-soft px-2.5 py-1 text-[10.5px] font-semibold text-green transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="dialogOpen"
              @click.stop="openSweepGroup(group.repoPath)"
            >
              {{ t('cleanup.sweepGroup', { count: repoHarvestableItems(group.repoPath).length }) }}
            </button>
          </span>
        </div>

        <template v-if="!isGroupCollapsed(group.repoPath)">
          <div
            v-for="item in group.items"
            :key="item.id"
            class="group/row mt-0.5 grid min-h-[57px] grid-cols-[20px_240px_1fr_150px_86px] items-center gap-3.5 rounded border border-transparent p-2.5 hover:border-border hover:bg-surface"
            data-testid="cleanup-row"
          >
            <span class="flex items-center justify-center text-text-4">
              <span
                v-if="item.verdict === 'harvestable'"
                class="relative flex h-[14px] w-[14px] items-center justify-center"
                :title="kindLabel(item.kind)"
              >
                <component
                  :is="kindIcon(item.kind)"
                  :size="14"
                  :stroke-width="1.6"
                  class="transition-opacity"
                  :class="
                    isSelected(item.id) ? 'opacity-0' : 'opacity-100 group-hover/row:opacity-0'
                  "
                />
                <input
                  type="checkbox"
                  class="absolute inset-0 h-[14px] w-[14px] cursor-pointer transition-opacity"
                  :class="
                    isSelected(item.id) ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100'
                  "
                  :checked="isSelected(item.id)"
                  :aria-label="t('cleanup.selectRow', { what: identText(item) })"
                  @click.stop
                  @change="toggleSelect(item.id)"
                />
              </span>
              <span v-else :title="kindLabel(item.kind)">
                <component :is="kindIcon(item.kind)" :size="14" :stroke-width="1.6" />
              </span>
            </span>

            <span class="flex min-w-0 flex-col gap-[3px]" :title="identTitle(item)">
              <span class="truncate font-mono text-[12px] text-text">{{ identText(item) }}</span>
              <!-- design.md "The meta line": kind · hydration · age · size, in
                   priority order because `truncate` eats from the right. -->
              <span
                class="block truncate text-[10.5px] text-text-4"
                :title="metaTitle(item)"
                data-testid="cleanup-meta"
              >
                {{ kindLabel(item.kind)
                }}<template v-if="rowMarker(item)">
                  ·
                  <span
                    :class="rowMarker(item)!.tone === 'warning' ? 'text-warning' : ''"
                    data-testid="cleanup-hydration"
                    >{{ rowMarker(item)!.text }}</span
                  ></template
                ><template v-if="item.ageDays !== null"> · {{ ageAgo(item.ageDays) }}</template
                ><template v-if="item.diskBytes !== null">
                  · <span class="text-text-3">{{ formatBytes(item.diskBytes) }}</span>
                </template>
              </span>
            </span>

            <CleanupTimeline :checkpoints="item.checkpoints" />

            <!-- Verdict cell: the chip, then the reason line — which is what
                 retired the padlock (design.md "The reason line"). -->
            <span class="flex min-w-0 flex-col items-end gap-1" :title="reasonLine(item, t)?.title">
              <span
                v-if="item.verdict === 'harvestable'"
                class="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-green-soft px-2.5 py-[3px] text-[10.5px] font-semibold text-green"
              >
                {{
                  item.needsRemoteDelete
                    ? t('cleanup.verdict.harvestableRemote')
                    : t('cleanup.verdict.harvestable')
                }}
                <TriangleAlert
                  v-if="item.needsRemoteDelete"
                  :size="10"
                  :stroke-width="2"
                  class="text-warning"
                />
              </span>
              <span
                v-else-if="item.verdict === 'blocked'"
                class="whitespace-nowrap rounded-full bg-red-soft px-2.5 py-[3px] text-[10.5px] font-semibold text-red"
              >
                {{ t('cleanup.verdict.blocked') }}
              </span>
              <span
                v-else-if="item.verdict === 'unknown'"
                class="whitespace-nowrap rounded-full bg-surface-2 px-2.5 py-[3px] text-[10.5px] font-semibold text-text-3"
              >
                {{ t('cleanup.verdict.unknown') }}
              </span>
              <span
                v-else
                class="whitespace-nowrap rounded-full bg-accent-soft px-2.5 py-[3px] text-[10.5px] font-semibold text-accent"
              >
                {{ t('cleanup.verdict.active') }}
              </span>
              <span
                v-if="reasonLine(item, t)"
                class="block max-w-full truncate text-right text-[10px] text-text-4"
                data-testid="cleanup-reason"
                >{{ reasonLine(item, t)!.text }}</span
              >
            </span>

            <!-- Action cluster (design.md "The action cluster replaces the single
                 action slot"): highest rank rightmost, slots fill right to left,
                 an illegal action is absent — never disabled. -->
            <span class="flex items-center justify-end gap-1" data-testid="cleanup-actions">
              <button
                v-if="canDehydrate(item)"
                class="flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:border-border hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                :aria-label="dehydrateLabel(item)"
                :title="dehydrateLabel(item)"
                :disabled="clusterDisabled(item)"
                data-testid="cleanup-dehydrate"
                @click="openDehydrateOne(item)"
              >
                <Loader2
                  v-if="store.hydrationOps.get(item.id) === 'dehydrating'"
                  :size="13"
                  :stroke-width="1.7"
                  class="animate-spin"
                />
                <PackageMinus v-else :size="13" :stroke-width="1.7" />
              </button>
              <button
                v-else-if="canRehydrate(item)"
                class="flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:border-border hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                :aria-label="t('cleanup.a11y.rehydrate', { what: identText(item) })"
                :title="t('cleanup.a11y.rehydrate', { what: identText(item) })"
                :disabled="clusterDisabled(item)"
                data-testid="cleanup-rehydrate"
                @click="rehydrateRow(item)"
              >
                <Loader2
                  v-if="store.hydrationOps.get(item.id) === 'rehydrating'"
                  :size="13"
                  :stroke-width="1.7"
                  class="animate-spin"
                />
                <PackagePlus v-else :size="13" :stroke-width="1.7" />
              </button>
              <button
                v-if="item.verdict === 'harvestable'"
                class="flex h-[26px] w-[26px] items-center justify-center rounded-sm border border-border-2 text-text-3 transition hover:border-red hover:bg-red-soft hover:text-red disabled:cursor-not-allowed disabled:opacity-40"
                :aria-label="trashTitle(item)"
                :title="trashTitle(item)"
                :disabled="clusterDisabled(item)"
                data-testid="cleanup-trash"
                @click="openSweepOne(item)"
              >
                <Trash2 :size="13" :stroke-width="1.7" />
              </button>
            </span>
          </div>
        </template>
      </div>

      <template v-if="store.journal.length > 0">
        <div
          class="flex items-center gap-2 pb-2.5 pt-[22px] text-[11px] font-semibold uppercase tracking-wide text-text-4"
        >
          <History :size="12" :stroke-width="1.7" />
          {{ t('cleanup.recent') }}
        </div>
        <div class="flex flex-col gap-1.5">
          <div
            v-for="(tomb, index) in store.journal"
            :key="tombKey(tomb, index)"
            class="flex items-center gap-3 rounded-sm border border-border bg-surface px-3 py-[9px] text-[11.5px] text-text-3"
          >
            <component
              :is="tombIcon(tomb.kind)"
              :size="12"
              :stroke-width="1.6"
              class="text-text-4"
            />
            <span class="font-mono text-[11px] text-text-2">{{
              tomb.branch ?? tomb.repoPath
            }}</span>
            <span class="truncate">
              {{ t('cleanup.sweptAgo', { ago: agoText(tomb.at) }) }}
              <template v-if="tomb.sha"> · {{ t('cleanup.was', { sha: tomb.sha }) }}</template>
            </span>
            <button
              v-if="tomb.restoreHint"
              class="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-[3px] font-mono text-[10px] text-text-4 transition hover:border-border-2 hover:text-text-2"
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

  <SweepConfirmDialog v-if="sweepItems" :items="sweepItems" @close="handleSweepDialogClose" />
  <DehydrateConfirmDialog
    v-if="dehydrateItems"
    :items="dehydrateItems"
    @close="dehydrateItems = null"
  />

  <!-- T300/U3: header markup rendered into the shared TakeoverShell (design.md §6
       "TakeoverShell — shared chrome") via Teleport, since a dynamically swapped
       view can't fill a named slot of the ancestor wrapping it. Placed after the
       real body content (not first) so this stays a component whose first root
       node is a real element — Vue Test Utils resolves `wrapper.element` off the
       first root, and a Teleport placeholder there breaks every `find`/`get`. -->
  <Teleport to="#takeover-shell-icon" defer>
    <Trash2 :size="16" :stroke-width="1.6" class="shrink-0 text-accent" />
  </Teleport>
</template>
