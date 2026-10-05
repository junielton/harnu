<script setup lang="ts">
/**
 * T198 — PR Stack Canvas takeover.
 *
 * A pan/zoom infinite canvas drawing the merge chain of a repo's open PRs, so
 * the deployable tip of each stack is readable without opening a PR page.
 * Fifth main-pane takeover; same shell as UsageDashboard / SystemMonitor /
 * CleanupView. design.md §6 "PR Stack Canvas".
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  GitPullRequest,
  GitBranch,
  RefreshCw,
  TriangleAlert,
  Scan,
  Plus,
  Minus,
  LayoutGrid,
  Brush,
  ChevronUp,
  ChevronDown
} from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { usePrStackStore } from '../stores/pr-stack'
import { useReaperStore } from '../stores/reaper'
import { useSessionsStore } from '../stores/sessions'
import PrStackCard from './PrStackCard.vue'
import PrStackEdges, { type NodeBox } from './PrStackEdges.vue'
import PrStackFilterBar from './PrStackFilterBar.vue'
import Button from './ui/Button.vue'
import { formatBytes, prEmptyStateKind, refreshFailureKeys, shortAgo } from './pr-stack-format'
import { GHOST_HEIGHT, GHOST_WIDTH, presetActive, type KpiPreset } from './pr-stack-filter'
import { CARD_WIDTH, type WorktreeNode } from '../../../main/pr-stack-core'

const { t } = useI18n()
const ui = useUiStore()
const store = usePrStackStore()
const reaper = useReaperStore()
const sessions = useSessionsStore()

const host = ref<HTMLElement | null>(null)
/** One clock for every card, so none of them owns a timer. */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const repoPath = computed(() => ui.prStack.folderPath ?? '')
const repoLabel = computed(() => ui.prStack.repoLabel ?? '')

/**
 * Worktrees come from the Reaper's snapshot, never from a second probe: its
 * `ReapVerdict` is the single source of truth for "is this worktree done
 * with", and the canvas must not contradict the Cleanup view.
 */
const worktrees = computed<WorktreeNode[]>(() => {
  const group = reaper.snapshot?.repos.find((r) => r.repoPath === repoPath.value)
  return (group?.items ?? [])
    .filter((i) => i.kind === 'worktree' && !!i.path)
    .map((i) => {
      const folder = sessions.folders.find((f) => f.path === i.path)
      return {
        path: i.path as string,
        branch: i.branch ?? '',
        title: i.branch ?? (i.path as string).split('/').pop() ?? '',
        bornFrom: folder?.bornFrom ?? null,
        sessionLive: i.verdict === 'active',
        harvestable: i.verdict === 'harvestable',
        mergedPr: null,
        sizeBytes: i.diskBytes ?? 0
      }
    })
})

const snapshot = computed(() => store.snapshot)

/**
 * The header's KPI line, as buttons (T387): `ready to merge`, `with unresolved
 * threads` and `needs retarget` are one-click presets. T275's thread count joins
 * the line only when threads were read: `null` means the GraphQL call failed, and
 * printing `0 with unresolved threads` there would be a claim the app cannot
 * support. A KPI at zero is plain text — a preset that matches nothing is a dead
 * button.
 */
interface KpiItem {
  id: string
  label: string
  preset: KpiPreset | null
}
const kpiItems = computed<KpiItem[]>(() => {
  const k = snapshot.value?.kpis
  if (!k) return []
  const items: KpiItem[] = [
    { id: 'open', label: t('prStack.kpiOpen', { n: k.open }), preset: null },
    { id: 'chains', label: t('prStack.kpiChains', { n: k.chains }), preset: null },
    {
      id: 'ready',
      label: t('prStack.kpiReady', { n: k.readyToMerge }),
      preset: k.readyToMerge > 0 ? 'ready' : null
    }
  ]
  if (k.withUnresolvedThreads != null) {
    items.push({
      id: 'threads',
      label: t('prStack.kpiThreads', { n: k.withUnresolvedThreads }),
      preset: k.withUnresolvedThreads > 0 ? 'threads' : null
    })
  }
  items.push({
    id: 'retarget',
    label: t('prStack.kpiRetarget', { n: k.needsRetarget }),
    preset: k.needsRetarget > 0 ? 'retarget' : null
  })
  return items
})
/** The whole line as one sentence, for the group's accessible name. */
const kpiLine = computed(() => {
  const k = snapshot.value?.kpis
  if (!k) return ''
  const counts = {
    open: k.open,
    chains: k.chains,
    ready: k.readyToMerge,
    retarget: k.needsRetarget
  }
  return k.withUnresolvedThreads == null
    ? t('prStack.kpis', counts)
    : t('prStack.kpisWithThreads', { ...counts, threads: k.withUnresolvedThreads })
})
const graphNodes = computed(() => snapshot.value?.graph.nodes ?? [])
const isEmpty = computed(() => !store.loading && graphNodes.value.length === 0)
const emptyKind = computed(() => prEmptyStateKind(snapshot.value, store.refreshFailure))

/**
 * The last refresh failed but a good snapshot is still on the canvas (BUG-148).
 * A failed snapshot with nothing behind it is the empty state's business, not
 * the refresh button's.
 */
const staleFailure = computed(() =>
  store.refreshFailure && snapshot.value && !snapshot.value.ghFailure ? store.refreshFailure : null
)
const failureKeys = computed(() => {
  const f = store.refreshFailure ?? snapshot.value?.ghFailure
  return f ? refreshFailureKeys(f) : null
})
/** Hide mode with nothing left to draw — Dim keeps the (fully dimmed) canvas. */
const noMatch = computed(() => !isEmpty.value && store.hideActive && store.matchCount === 0)
/** Ids the filter keeps at full strength; `null` outside Dim mode. */
const matchedIds = computed<Set<string> | null>(() =>
  store.dimActive && store.matchedNumbers ? new Set([...store.matchedNumbers].map(String)) : null
)
const isDimmed = (id: string): boolean => matchedIds.value !== null && !matchedIds.value.has(id)

/** `N hidden · #a #b` — the list is capped so a long run still fits the pill. */
function ghostLabel(hidden: number[]): string {
  const shown = hidden.slice(0, 2)
  const list = shown.map((n) => `#${n}`).join(' ')
  return hidden.length > shown.length
    ? t('prStack.filter.hiddenPillMore', {
        n: hidden.length,
        list,
        more: hidden.length - shown.length
      })
    : t('prStack.filter.hiddenPill', { n: hidden.length, list })
}

/** Card height by LOD and whether the node earns a marker strip. */
function heightOf(id: string): number {
  if (store.lod === 'far') return 32
  const node = graphNodes.value.find((n) => String(n.pr.number) === id)
  const hasMarker = !!node && (node.isStagingTip || node.isMergeNext || node.baseKind === 'merged')
  if (store.lod === 'compact') return 62
  return hasMarker ? 125 : 101
}

/** World grows past the layout so the base node and tray have clear air. */
const world = computed(() => {
  const w = store.activeWorld
  return { width: Math.max(w.width, CARD_WIDTH + 80), height: w.height + 80 }
})

const baseBox = computed<NodeBox>(() => ({
  x: world.value.width / 2 - 46,
  y: world.value.height - 56,
  w: 92,
  h: 34
}))

const boxes = computed<Record<string, NodeBox>>(() => {
  const out: Record<string, NodeBox> = { base: baseBox.value }
  for (const p of store.visiblePlacements) {
    out[p.id] = { x: p.x, y: p.y, w: CARD_WIDTH, h: heightOf(p.id) }
  }
  for (const g of store.ghosts) {
    out[g.id] = { x: g.x, y: g.y, w: GHOST_WIDTH, h: GHOST_HEIGHT }
  }
  return out
})

const edges = computed(() => store.visibleEdges)

/**
 * The local worktree checked out on a PR's branch, when Harnu manages one.
 *
 * Read from the SNAPSHOT rather than from `worktrees` above, so a card can
 * never disagree with the graph that was drawn from the same payload. A
 * harvestable worktree is deliberately excluded: its PR already merged, the
 * harvest tray owns it, and offering "open the worktree" on a card would put
 * two different views in charge of the same leftover.
 */
const worktreeByBranch = computed(() => {
  const out = new Map<string, { path: string; sessionLive: boolean }>()
  for (const wt of snapshot.value?.worktrees ?? []) {
    if (wt.harvestable || !wt.branch) continue
    out.set(wt.branch, { path: wt.path, sessionLive: wt.sessionLive })
  }
  return out
})

const worldStyle = computed(() => ({
  transform: `translate(${store.panX}px, ${store.panY}px) scale(${store.scale})`,
  transformOrigin: '0 0'
}))

const zoomLabel = computed(() => `${Math.round(store.scale * 100)}%`)
const fetchedLabel = computed(() =>
  snapshot.value ? shortAgo(new Date(snapshot.value.fetchedAt).toISOString(), now.value) : ''
)

// ── Pan (drag the background) and node drag (drag a card) ─────────────────

type DragState =
  | { mode: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { mode: 'node'; id: string; startX: number; startY: number; nodeX: number; nodeY: number }
  | null
let drag: DragState = null

function onCanvasPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  drag = { mode: 'pan', startX: e.clientX, startY: e.clientY, panX: store.panX, panY: store.panY }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onNodePointerDown(e: PointerEvent, id: string): void {
  if (e.button !== 0) return
  // A pointerdown on a control is not the start of a drag. Capturing the
  // pointer would retarget the following mouseup to the capture element, and
  // the browser then fires `click` on the nearest common ancestor of down and
  // up — the host, never the button. So every card control would be dead.
  // `stopPropagation` is what makes bailing out safe: without it the event
  // reaches the canvas, which captures the pointer for a pan and breaks the
  // click the exact same way.
  if ((e.target as Element).closest('button, a')) {
    e.stopPropagation()
    return
  }
  // Hide mode ignores position overrides, so a card dragged there would not
  // move. Let the press fall through to the canvas and pan instead.
  if (store.hideActive) return
  const box = boxes.value[id]
  if (!box) return
  e.stopPropagation()
  drag = { mode: 'node', id, startX: e.clientX, startY: e.clientY, nodeX: box.x, nodeY: box.y }
  // Capture on the HOST, not on the card. The card's wrapper is re-rendered by
  // the v-for on every drag frame, and capture held by an element the diff can
  // replace is capture you can lose halfway through a gesture.
  host.value?.setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!drag) return
  const dx = e.clientX - drag.startX
  const dy = e.clientY - drag.startY
  if (drag.mode === 'pan') {
    store.panX = drag.panX + dx
    store.panY = drag.panY + dy
  } else {
    // Divide by scale: the pointer moves in screen px, the card lives in world px.
    store.moveNode(drag.id, drag.nodeX + dx / store.scale, drag.nodeY + dy / store.scale)
  }
}

function onPointerUp(): void {
  // Persist only here: moveNode runs per frame, and writing localStorage at
  // that rate is a stutter for no benefit.
  if (drag?.mode === 'node') store.commitMove()
  drag = null
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const rect = host.value?.getBoundingClientRect()
  const anchor = rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined
  store.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, anchor)
}

// ── Card actions (all read-only) ──────────────────────────────────────────

function openGithub(url: string): void {
  if (url) void window.api.shellOpenExternal(url)
}

function openWorktree(path: string): void {
  // Reveal it in the sidebar rather than force-selecting a session: the
  // operator asked to SEE the worktree, not to have their current session
  // swapped out from under them.
  sessions.revealFolder(path)
  ui.closePrStack()
}

/**
 * Open the review takeover on the PR's own worktree (T164, PRD §9 Q3).
 *
 * `openReview`, not `toggleReview`: this is a card asking for a specific
 * branch, the way `openWorktree` above is — the toggle semantics belong to a
 * persistent affordance that has to close what it opened (the Topbar button).
 * `openReview` closes this canvas itself via the takeover mutex.
 *
 * No `cardSlug`: the canvas is a read model of GitHub PRs and knows nothing
 * about the board. The pane resolves its own bound card from the folder.
 *
 * `prNumber` is set only when no worktree holds the branch (T246): the pane
 * then fetches `refs/pull/<n>/head` and runs in the repo's main worktree, which
 * it resolves itself from git rather than trusting whichever folder this canvas
 * was opened from.
 */
function openReview(target: { folder: string; prNumber: number | null }): void {
  if (!target?.folder) return
  ui.openReview(target.folder, null, target.prNumber)
}

function copyRetarget(command: string): void {
  void navigator.clipboard.writeText(command)
}

/**
 * Copy a branch name for a local checkout. Unlike the retarget command — which
 * lands in a monospace button that visibly IS the copied text — the branch name
 * is copied from a 16px icon, so it toasts: a silent clipboard write there is
 * indistinguishable from a dead click.
 */
async function copyBranch(branch: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(branch)
    ui.pushToast({ kind: 'success', title: t('prStack.branchCopied'), persist: false })
  } catch {
    ui.pushToast({ kind: 'danger', title: t('prStack.copyFailed') })
  }
}

const filterBar = ref<InstanceType<typeof PrStackFilterBar> | null>(null)

/** `/` jumps to the filter field; Esc (field already blurred) clears the filter. */
function onCanvasKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement
  if (target.closest('input, textarea')) return
  if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault()
    filterBar.value?.focus()
  } else if (e.key === 'Escape' && store.filterActive) {
    store.clearFilter()
  }
}

function measure(): void {
  if (!host.value) return
  store.setViewport(host.value.clientWidth, host.value.clientHeight)
}

let ro: ResizeObserver | null = null

onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 30_000)
  measure()
  if (host.value) {
    ro = new ResizeObserver(measure)
    ro.observe(host.value)
  }
  if (repoPath.value) store.start(repoPath.value, worktrees.value)
})

watch(repoPath, (path) => {
  if (path) store.start(path, worktrees.value)
})

onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
  ro?.disconnect()
  store.stop()
})
</script>

<template>
  <!-- Canvas viewport. The dot grid is the only affordance that makes
       panning legible. -->
  <div
    ref="host"
    class="pr-stack-canvas relative min-h-0 flex-1 cursor-grab overflow-hidden bg-bg outline-none active:cursor-grabbing"
    tabindex="0"
    @keydown="onCanvasKeydown"
    @pointerdown="onCanvasPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
  >
    <div class="absolute inset-0" :style="worldStyle">
      <PrStackEdges :edges="edges" :boxes="boxes" :world="world" :matched="matchedIds" />

      <div
        v-for="placement in store.visiblePlacements"
        :key="placement.id"
        class="absolute cursor-grab active:cursor-grabbing"
        :class="isDimmed(placement.id) ? 'opacity-40' : ''"
        :style="{ left: `${placement.x}px`, top: `${placement.y}px` }"
        @pointerdown="onNodePointerDown($event, placement.id)"
      >
        <PrStackCard
          v-if="graphNodes.find((n) => String(n.pr.number) === placement.id)"
          :node="graphNodes.find((n) => String(n.pr.number) === placement.id)!"
          :behind="snapshot?.behind[Number(placement.id)]"
          :lod="store.lod"
          :expanded="store.expandedId === placement.id"
          :moved="!store.hideActive && placement.id in store.overrides"
          :highlighted="store.highlightedId === placement.id"
          :now="now"
          :worktree="
            worktreeByBranch.get(
              graphNodes.find((n) => String(n.pr.number) === placement.id)?.pr.branch ?? ''
            ) ?? null
          "
          :repo-folder="repoPath || null"
          @toggle="store.toggleExpanded"
          @open-github="openGithub"
          @open-worktree="openWorktree"
          @open-review="openReview"
          @copy-retarget="copyRetarget"
          @copy-branch="copyBranch"
        />
      </div>

      <!-- Hide mode: one dashed pill per run of skipped ancestors, so a match
             never reads as sitting straight on the base. -->
      <button
        v-for="g in store.ghosts"
        :key="g.id"
        type="button"
        class="absolute flex items-center justify-center truncate rounded-full border border-dashed border-border-2 bg-bg px-2 text-[10px] text-text-4 transition-colors hover:border-accent-line hover:text-text-2"
        :style="{
          left: `${g.x}px`,
          top: `${g.y}px`,
          width: `${GHOST_WIDTH}px`,
          height: `${GHOST_HEIGHT}px`
        }"
        :title="t('prStack.filter.revealChain')"
        @pointerdown.stop
        @click="store.revealChain(g.matches[0])"
      >
        {{ ghostLabel(g.hidden) }}
      </button>

      <!-- The one terminal node every chain converges on. Not a card: it is
             not work, it is the destination. -->
      <div
        v-if="snapshot"
        class="absolute inline-flex h-[34px] items-center gap-[7px] rounded-full border border-border-2 bg-surface-2 px-3.5 font-mono text-xs font-semibold text-text"
        :style="{ left: `${baseBox.x}px`, top: `${baseBox.y}px` }"
      >
        <GitBranch :size="13" class="text-text-3" />
        {{ snapshot.defaultBranch }}
      </div>
    </div>

    <!-- Floating controls: absolute to the VIEWPORT, so they neither pan nor
           scale. Background job and manual button share one refreshing state. -->
    <div class="pointer-events-none absolute left-3 right-3 top-3 flex flex-wrap items-start gap-2">
      <div
        class="pointer-events-auto inline-flex shrink-0 items-center gap-0.5 rounded border border-border bg-surface p-1 shadow-pop"
        @pointerdown.stop
      >
        <div class="group relative">
          <button
            class="inline-flex h-[26px] min-w-[26px] items-center justify-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium transition-colors"
            :class="
              staleFailure
                ? 'bg-warning-soft text-warning shadow-[inset_0_0_0_1px_var(--color-warning-line)]'
                : 'text-text-3 hover:bg-surface-2 hover:text-text'
            "
            :data-dsqa="staleFailure ? 'pr-stack-refresh--stale' : undefined"
            :title="staleFailure ? undefined : t('prStack.refresh')"
            :aria-label="t('prStack.refresh')"
            @click="store.load(repoPath, worktrees)"
          >
            <TriangleAlert v-if="staleFailure" :size="13" />
            <span :class="['tabular-nums', staleFailure ? '' : 'text-text-4']">{{
              fetchedLabel
            }}</span>
            <RefreshCw :size="13" :class="store.refreshing ? 'animate-spin' : ''" />
          </button>
          <!-- Why the age is amber, shown on hover/focus like a tooltip. -->
          <div
            v-if="staleFailure && failureKeys"
            role="tooltip"
            class="pointer-events-none absolute left-0 top-[calc(100%+6px)] z-10 hidden w-[250px] rounded border border-border bg-surface px-2.5 py-2 text-[11px] leading-[1.45] text-text-2 shadow-pop group-focus-within:block group-hover:block"
          >
            <b class="mb-0.5 block font-semibold text-text">{{ t(failureKeys.title) }}</b>
            {{ t(failureKeys.body, { age: fetchedLabel }) }}
          </div>
        </div>
        <span class="mx-0.5 h-4 w-px bg-border" />
        <Button variant="ghost" size="icon" :title="t('prStack.fit')" @click="store.fit()">
          <Scan :size="13" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          :title="t('prStack.zoomOut')"
          @click="store.zoomBy(1 / 1.2)"
        >
          <Minus :size="13" />
        </Button>
        <span
          class="grid h-[22px] min-w-[34px] place-items-center text-[11px] tabular-nums text-text-4"
        >
          {{ zoomLabel }}
        </span>
        <Button variant="ghost" size="icon" :title="t('prStack.zoomIn')" @click="store.zoomBy(1.2)">
          <Plus :size="13" />
        </Button>
        <!-- Shown only while the operator's arrangement differs from the
             computed one — there is nothing to undo otherwise. -->
        <template v-if="store.movedCount > 0">
          <span class="mx-0.5 h-4 w-px bg-border" />
          <button
            class="inline-flex h-[26px] items-center gap-1.5 rounded-sm px-1.5 text-[11px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
            :title="t('prStack.relayoutHint')"
            @click="store.relayout()"
          >
            <LayoutGrid :size="13" />
            {{ t('prStack.relayout', { n: store.movedCount }) }}
          </button>
        </template>
      </div>
      <PrStackFilterBar v-if="snapshot && !isEmpty" ref="filterBar" />
    </div>

    <!-- Harvest tray: a worktree whose PR already merged has no place in a
           merge chain, so it leaves the graph and lands here. -->
    <div
      v-if="store.harvestable.length > 0"
      class="absolute bottom-3 left-3 overflow-hidden rounded border border-border bg-surface"
      @pointerdown.stop
    >
      <div class="flex h-[30px] items-center gap-2 pl-2.5 pr-2 text-[11px] text-text-3">
        <Brush :size="12" class="text-text-4" />
        <span>
          {{ t('prStack.harvestable', { n: store.harvestable.length }) }}
        </span>
        <span class="tabular-nums text-text-4">· {{ formatBytes(store.harvestableBytes) }}</span>
        <button
          class="ml-1 inline-flex h-5 items-center rounded-sm border border-green/40 bg-green-soft px-2 text-[10.5px] font-semibold text-green transition-colors hover:bg-green/25"
          @click="ui.openCleanup(repoPath)"
        >
          {{ t('prStack.sweepInCleanup') }}
        </button>
        <button
          class="grid h-5 w-5 place-items-center rounded-sm text-text-4 transition-colors hover:bg-surface-2 hover:text-text"
          :aria-label="store.trayOpen ? t('prStack.collapse') : t('prStack.expand')"
          @click="store.trayOpen = !store.trayOpen"
        >
          <ChevronDown v-if="store.trayOpen" :size="12" />
          <ChevronUp v-else :size="12" />
        </button>
      </div>
      <div v-if="store.trayOpen" class="w-[420px]">
        <div
          v-for="wt in store.harvestable"
          :key="wt.path"
          class="flex items-center gap-2 border-t border-border px-2.5 py-[7px] text-[11px] text-text-3"
        >
          <span class="truncate font-mono text-text-2">{{ wt.branch || wt.title }}</span>
          <span class="ml-auto flex-none text-text-4">{{ t('prStack.merged') }}</span>
          <span class="w-[52px] flex-none text-right tabular-nums text-text-4">
            {{ formatBytes(wt.sizeBytes) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Legend — four signals, non-interactive. -->
    <div
      v-if="!isEmpty"
      class="absolute bottom-3 right-3 inline-flex flex-col gap-[5px] rounded border border-border bg-surface px-2.5 py-2"
    >
      <div class="flex items-center gap-[7px] text-[10.5px] text-text-3">
        <span class="h-2 w-2 flex-none rounded-[2px] bg-accent" />{{ t('prStack.legendTip') }}
      </div>
      <div class="flex items-center gap-[7px] text-[10.5px] text-text-3">
        <span class="h-2 w-2 flex-none rounded-[2px] bg-green" />{{ t('prStack.legendMerge') }}
      </div>
      <div class="flex items-center gap-[7px] text-[10.5px] text-text-3">
        <span class="h-2 w-2 flex-none rounded-[2px] bg-warning" />{{ t('prStack.legendWarn') }}
      </div>
      <div class="flex items-center gap-[7px] text-[10.5px] text-text-3">
        <span class="h-2 w-2 flex-none rounded-[2px] bg-red" />{{ t('prStack.legendBlocked') }}
      </div>
    </div>

    <div v-if="noMatch" class="absolute inset-0 grid place-items-center px-8 text-center">
      <div
        data-dsqa="pr-stack-empty--no-match"
        class="flex w-[420px] flex-col items-center gap-2.5 py-7"
      >
        <p class="text-[13px] text-text-3">{{ t('prStack.filter.noMatch') }}</p>
        <button
          type="button"
          class="h-[26px] rounded-sm border border-border-2 bg-surface px-2.5 text-[11px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          @pointerdown.stop
          @click="store.clearFilter()"
        >
          {{ t('prStack.filter.clear') }}
        </button>
      </div>
    </div>

    <div v-if="isEmpty" class="grid h-full place-items-center px-8 text-center">
      <div class="flex max-w-[46ch] flex-col items-center gap-2.5">
        <p v-if="emptyKind === 'unavailable'" class="text-[13px] text-text-3">
          {{ t('prStack.ghMissing') }}
        </p>
        <template v-else-if="emptyKind === 'failed'">
          <p v-if="failureKeys" class="text-[13px] font-semibold text-text-2">
            {{ t(failureKeys.title) }}
          </p>
          <p class="text-[13px] text-text-3">{{ t('prStack.refreshFailedEmpty') }}</p>
          <Button @click="store.load(repoPath, worktrees)">
            {{ t('prStack.retry') }}
          </Button>
        </template>
        <p v-else class="text-[13px] text-text-3">{{ t('prStack.emptyState') }}</p>
      </div>
    </div>
  </div>

  <!-- T300/U3: header markup rendered into the shared TakeoverShell (design.md §6
       "TakeoverShell — shared chrome") via Teleport, since a dynamically swapped
       view can't fill a named slot of the ancestor wrapping it. Placed after the
       real body content (not first) so this stays a component whose first root
       node is a real element — Vue Test Utils resolves `wrapper.element` off the
       first root, and a Teleport placeholder there breaks every `find`/`get`. -->
  <Teleport to="#takeover-shell-icon" defer>
    <GitPullRequest :size="16" class="text-accent" />
  </Teleport>
  <Teleport to="#takeover-shell-actions" defer>
    <div
      data-dsqa="pr-stack-kpis"
      role="group"
      :aria-label="kpiLine"
      class="inline-flex items-center gap-0.5 text-[11px] text-text-3"
    >
      <span class="mr-2 font-mono text-text-4">{{ repoLabel }}</span>
      <template v-for="(item, i) in kpiItems" :key="item.id">
        <span v-if="i > 0" class="text-text-4">·</span>
        <button
          v-if="item.preset"
          type="button"
          class="h-5 rounded-sm px-1.5 transition-colors"
          :class="
            presetActive(store.filterQuery, item.preset)
              ? 'bg-accent-soft text-text ring-1 ring-inset ring-accent-line'
              : 'hover:bg-surface-2 hover:text-text'
          "
          :aria-pressed="presetActive(store.filterQuery, item.preset)"
          :title="t('prStack.kpiPresetHint')"
          @click="store.toggleKpiPreset(item.preset)"
        >
          {{ item.label }}
        </button>
        <span v-else class="inline-flex h-5 items-center px-0.5">{{ item.label }}</span>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
/* The dot grid is a background, not a component — it has no anatomy to live in
   design.md beyond the pitch, and Tailwind has no utility for a radial tile. */
.pr-stack-canvas {
  background-image: radial-gradient(circle, var(--color-border-2) 1px, transparent 1px);
  background-size: 22px 22px;
  background-position: -1px -1px;
}
</style>
