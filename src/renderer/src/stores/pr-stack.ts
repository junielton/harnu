/**
 * T198 — PR Stack Canvas store.
 *
 * Owns the snapshot, the canvas viewport transform, the operator's position
 * overrides, and the two refresh clocks. Every graph decision (chains, roles,
 * layout, LOD thresholds, fit) lives in `src/main/pr-stack-core.ts` and is
 * imported here as pure functions — this store only holds state and schedules
 * effects.
 *
 * design.md §6 "PR Stack Canvas".
 */

import { defineStore } from 'pinia'
import { ref, computed, shallowRef, watch } from 'vue'
import type { PrStackPrefs } from '../../../main/pr-stack-prefs'
import {
  applyOverrides,
  pruneOverrides,
  clampScale,
  fitToView,
  focusOnBox,
  focusCardHeight,
  resolveFocusTarget,
  CARD_WIDTH,
  lodForScale,
  MIN_SCALE,
  MAX_SCALE,
  type GhFailure,
  type Lod,
  type Placement,
  type PrStackSnapshot,
  type WorktreeNode,
  type Edge
} from '../../../main/pr-stack-core'
import {
  KPI_PRESETS,
  buildFilterContext,
  isFilterActive,
  layoutHidden,
  matchNodes,
  parseQuery,
  presetActive,
  type GhostPill,
  type KpiPreset
} from '../components/pr-stack-filter'

/** Position overrides survive a restart; they are the operator's arrangement. */
const OVERRIDES_KEY = 'om2tab.prStack.overrides'

/**
 * Fallback used only until the real prefs land from main. The foreground
 * refresh is deliberately a far shorter clock than the Reaper's hourly
 * background scan: readiness rots on a different clock than debris does — an
 * hour is fine for "is this worktree still needed", and far too slow for "is
 * this PR green right now". Tunable in Settings → PR Stack
 * (`src/main/pr-stack-prefs.ts`).
 */
const FALLBACK_REFRESH_MS = 90_000

/** How long a focused card keeps its ring before it fades. */
const HIGHLIGHT_MS = 2_000
/** A focus request nobody picked up (canvas never opened) must not fire minutes later. */
const PENDING_FOCUS_TTL_MS = 15_000

type Overrides = Record<string, Record<string, { x: number; y: number }>>

/** T387 — how filtered-out PRs are shown: faded in place, or removed from the layout. */
export type FilterMode = 'dim' | 'hide'

/**
 * `query` holds the COMPLETE terms (the chips); `draft` is the term still being
 * typed. Keeping them apart is what lets a facet checkbox rewrite the chips
 * without trampling a half-typed term.
 */
export interface FilterState {
  query: string
  draft: string
  mode: FilterMode
}

const NO_FILTER: FilterState = { query: '', draft: '', mode: 'dim' }

function readOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Overrides) : {}
  } catch {
    return {}
  }
}

export const usePrStackStore = defineStore('prStack', () => {
  /** `shallowRef`: the snapshot is a large, wholly-replaced payload. */
  const snapshot = shallowRef<PrStackSnapshot | null>(null)
  const loading = ref(false)
  /** True while EITHER the manual button or the interval is fetching. */
  const refreshing = ref(false)
  const error = ref<string | null>(null)
  /**
   * Why the LAST refresh did not produce fresh data, or `null` when it did
   * (BUG-148). While set, `snapshot` is whatever the last good read left — it
   * may be hours old, and `fetchedAt` says so. `gh` being genuinely unavailable
   * is NOT a refresh failure: that is a state of the snapshot itself.
   */
  const refreshFailure = ref<GhFailure | null>(null)

  const scale = ref(1)
  const panX = ref(0)
  const panY = ref(0)
  const viewport = ref({ width: 0, height: 0 })

  const expandedId = ref<string | null>(null)
  const trayOpen = ref(false)

  /** Foreground-refresh prefs; `null` until the first read from main lands. */
  const prefs = ref<PrStackPrefs | null>(null)

  /**
   * A card the operator asked to be shown (a PR link clicked in a transcript).
   * Stays set until a snapshot containing it is on screen, so a request made
   * before the canvas has loaded still lands.
   */
  const pendingFocus = ref<number | null>(null)
  let pendingRepo: string | null = null
  let pendingAt = 0
  /** The card currently wearing the focus ring; clears itself after `HIGHLIGHT_MS`. */
  const highlightedId = ref<string | null>(null)
  let highlightTimer: ReturnType<typeof setTimeout> | null = null

  const overridesByRepo = ref<Overrides>(readOverrides())
  /** The shape key the view was last auto-fitted to. */
  const fittedShape = ref<string | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null
  /** Worktrees the live clock was armed with, so a pref change can re-arm it. */
  let timerArgs: WorktreeNode[] | null = null
  /**
   * MUST be a ref, not a plain `let`. As a plain variable it is invisible to
   * the reactivity system, and `overrides` below would evaluate once while it
   * was still null, short-circuit before ever touching `overridesByRepo`, and
   * end up with ZERO reactive dependencies — permanently frozen at `{}`. The
   * symptom was a drag that wrote to localStorage (imperative path, fine) and
   * moved nothing on screen (reactive path, dead).
   */
  const currentRepo = ref<string | null>(null)

  const lod = computed<Lod>(() => lodForScale(scale.value))

  const overrides = computed<Record<string, { x: number; y: number }>>(() => {
    // Read the map BEFORE branching, so the dependency is registered even on
    // the pass where no repo is open yet.
    const all = overridesByRepo.value
    const repo = currentRepo.value
    return repo ? (all[repo] ?? {}) : {}
  })

  /** Computed layout with the operator's overrides applied on top. */
  const placements = computed<Placement[]>(() =>
    snapshot.value ? applyOverrides(snapshot.value.placements, overrides.value).placements : []
  )

  const movedCount = computed(() => Object.keys(overrides.value).length)

  // ── Filter (T387) ───────────────────────────────────────────────────────
  //
  // Per repo and SESSION-ONLY: deliberately a plain ref, never persisted. It is
  // a question the operator is asking of today's snapshot, not an arrangement
  // worth keeping across restarts (contrast `overridesByRepo`).
  const filterByRepo = ref<Record<string, FilterState>>({})

  const filter = computed<FilterState>(() => {
    const all = filterByRepo.value
    const repo = currentRepo.value
    return (repo && all[repo]) || NO_FILTER
  })

  function patchFilter(patch: Partial<FilterState>): void {
    const repo = currentRepo.value
    if (!repo) return
    filterByRepo.value = { ...filterByRepo.value, [repo]: { ...filter.value, ...patch } }
  }

  /** The full query the matcher sees: the chips plus the term being typed. */
  const filterQuery = computed(() =>
    [filter.value.query, filter.value.draft].filter((p) => p !== '').join(' ')
  )
  const parsedFilter = computed(() => parseQuery(filterQuery.value))
  const filterActive = computed(() => isFilterActive(parsedFilter.value))

  const graphNodes = computed(() => snapshot.value?.graph.nodes ?? [])

  /** PR numbers matching the filter, or `null` while no filter is active. */
  const matchedNumbers = computed<Set<number> | null>(() => {
    if (!filterActive.value) return null
    return new Set(
      matchNodes(graphNodes.value, parsedFilter.value, buildFilterContext(graphNodes.value))
    )
  })
  const matchCount = computed(() => matchedNumbers.value?.size ?? graphNodes.value.length)
  const totalCount = computed(() => graphNodes.value.length)

  const dimActive = computed(() => filterActive.value && filter.value.mode === 'dim')
  const hideActive = computed(
    () => filterActive.value && filter.value.mode === 'hide' && !!snapshot.value
  )

  /** Hide mode's own layout. Only computed while Hide is on. */
  const hiddenLayout = computed(() =>
    hideActive.value && snapshot.value && matchedNumbers.value
      ? layoutHidden(snapshot.value.graph, matchedNumbers.value)
      : null
  )

  function setFilterQuery(query: string): void {
    patchFilter({ query })
  }
  function setFilterDraft(draft: string): void {
    patchFilter({ draft })
  }
  function setFilterMode(mode: FilterMode): void {
    patchFilter({ mode })
  }
  function clearFilter(): void {
    patchFilter({ query: '', draft: '' })
  }
  /** Clicking a KPI applies its preset; clicking the active one clears it. */
  function toggleKpiPreset(preset: KpiPreset): void {
    if (presetActive(filterQuery.value, preset)) clearFilter()
    else patchFilter({ query: KPI_PRESETS[preset], draft: '' })
  }
  /** A ghost pill's click: show the chain it stands in for, in context (Dim). */
  function revealChain(prNumber: number): void {
    const query = [filter.value.query, `chain:#${prNumber}`].filter((p) => p !== '').join(' ')
    patchFilter({ query, draft: '', mode: 'dim' })
  }

  /**
   * What the canvas actually draws. Hide mode swaps in its own layout and
   * IGNORES the operator's position overrides (they stay stored, so turning
   * Hide off restores the arrangement untouched).
   */
  const visiblePlacements = computed<Placement[]>(() =>
    hiddenLayout.value ? hiddenLayout.value.placements : placements.value
  )
  const visibleEdges = computed<Edge[]>(() =>
    hiddenLayout.value ? hiddenLayout.value.edges : (snapshot.value?.edges ?? [])
  )
  const ghosts = computed<GhostPill[]>(() => hiddenLayout.value?.ghosts ?? [])
  const activeWorld = computed(
    () => hiddenLayout.value?.world ?? snapshot.value?.world ?? { width: 800, height: 400 }
  )

  /** Worktrees whose PR already merged — they leave the graph for the tray. */
  const harvestable = computed<WorktreeNode[]>(() =>
    (snapshot.value?.worktrees ?? []).filter((w) => w.harvestable)
  )

  const harvestableBytes = computed(() =>
    harvestable.value.reduce((sum, w) => sum + (w.sizeBytes || 0), 0)
  )

  function persistOverrides(): void {
    try {
      localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overridesByRepo.value))
    } catch {
      /* quota or private mode — the arrangement is a convenience, not data */
    }
  }

  /**
   * Fits the world into the viewport. Called on open and on a graph SHAPE
   * change — never on a plain data refresh, which would move the view under
   * the operator mid-read.
   */
  function fit(): void {
    if (!snapshot.value || viewport.value.width === 0) return
    const next = fitToView(activeWorld.value, viewport.value)
    scale.value = next.scale
    panX.value = next.x
    panY.value = next.y
  }

  function setViewport(width: number, height: number): void {
    viewport.value = { width, height }
    if (fittedShape.value === null) fit()
    applyPendingFocus()
  }

  function zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    const before = scale.value
    const after = clampScale(before * factor)
    if (after === before) return
    // Keep the anchor point (cursor, or viewport centre) visually fixed.
    const ax = anchor?.x ?? viewport.value.width / 2
    const ay = anchor?.y ?? viewport.value.height / 2
    panX.value = ax - ((ax - panX.value) / before) * after
    panY.value = ay - ((ay - panY.value) / before) * after
    scale.value = after
  }

  function panBy(dx: number, dy: number): void {
    panX.value += dx
    panY.value += dy
  }

  /**
   * Records a card's operator-chosen position, in world coordinates. Called on
   * every pointermove frame, so it deliberately does NOT persist — writing
   * localStorage per frame is a stutter nobody asked for. `commitMove()` at
   * the end of the drag is what durably saves it.
   */
  function moveNode(id: string, x: number, y: number): void {
    const repo = currentRepo.value
    if (!repo) return
    const forRepo = { ...(overridesByRepo.value[repo] ?? {}) }
    forRepo[id] = { x, y }
    overridesByRepo.value = { ...overridesByRepo.value, [repo]: forRepo }
  }

  /** End of a drag — the arrangement is now worth keeping across restarts. */
  function commitMove(): void {
    persistOverrides()
  }

  /** Drops every override for this repo and returns to the computed layout. */
  function relayout(): void {
    const repo = currentRepo.value
    if (!repo) return
    const next = { ...overridesByRepo.value }
    delete next[repo]
    overridesByRepo.value = next
    persistOverrides()
    fit()
  }

  function toggleExpanded(id: string): void {
    expandedId.value = expandedId.value === id ? null : id
  }

  function setHighlight(id: string): void {
    if (highlightTimer !== null) clearTimeout(highlightTimer)
    highlightedId.value = id
    highlightTimer = setTimeout(() => {
      highlightedId.value = null
      highlightTimer = null
    }, HIGHLIGHT_MS)
  }

  /** Pans the card to the viewport centre (see `focusOnBox`) and rings it. */
  function centerOn(placement: { id: string; x: number; y: number }): void {
    if (viewport.value.width === 0) return
    const next = focusOnBox(
      { x: placement.x, y: placement.y, w: CARD_WIDTH, h: focusCardHeight(lod.value) },
      viewport.value,
      scale.value
    )
    scale.value = next.scale
    panX.value = next.x
    panY.value = next.y
    setHighlight(placement.id)
  }

  /**
   * Runs the pending focus if it can run now: a snapshot (and viewport) is
   * present and holds the card. Idempotent and cheap, so every event that could
   * make it runnable (a load landing, the viewport being measured, the request
   * itself) just calls it.
   */
  function applyPendingFocus(afterLoad = false): void {
    const n = pendingFocus.value
    if (n === null) return
    if (Date.now() - pendingAt > PENDING_FOCUS_TTL_MS) {
      pendingFocus.value = null
      return
    }
    if (!snapshot.value || viewport.value.width === 0) return
    const target = resolveFocusTarget(
      { number: n, repo: pendingRepo },
      currentRepo.value,
      placements.value
    )
    if (!target) {
      // A load that DID land on the right repo without the PR means it is not
      // on this canvas (merged since, or beyond the fetch window) — give up
      // rather than wait for a card that will not come.
      if (afterLoad && (pendingRepo === null || pendingRepo === currentRepo.value)) {
        pendingFocus.value = null
        pendingRepo = null
      }
      return
    }
    pendingFocus.value = null
    pendingRepo = null
    centerOn(target)
  }

  /**
   * Show PR `number` on the canvas: pan to it and ring it for a moment. Works
   * on an open canvas (re-focus) and before the first snapshot lands (the
   * request waits). `repoPath` pins the request to the canvas of that repo so a
   * stale snapshot of another repo can never satisfy it.
   */
  function focusPr(number: number, repoPath: string | null = null): void {
    pendingFocus.value = number
    pendingRepo = repoPath
    pendingAt = Date.now()
    applyPendingFocus()
  }

  /**
   * True when the snapshot ALREADY held for `repoPath` shows PR `number` as
   * open — the link-click fast path that skips the `gh` round-trip.
   */
  function holdsOpenPr(repoPath: string, number: number): boolean {
    if (currentRepo.value !== repoPath || !snapshot.value) return false
    return snapshot.value.graph.nodes.some((n) => n.pr.number === number && n.pr.state === 'OPEN')
  }

  // Hide mode is a different layout, so entering, leaving or changing what it
  // holds re-fits the view. A plain data refresh leaves the key — and the view —
  // alone, like the shape check in `load`.
  watch(
    () =>
      hiddenLayout.value
        ? `hide:${hiddenLayout.value.placements.map((p) => p.id).join(',')}|${hiddenLayout.value.ghosts
            .map((g) => g.id)
            .join(',')}`
        : 'full',
    () => fit()
  )

  async function load(repoPath: string, worktrees: WorktreeNode[] = []): Promise<void> {
    currentRepo.value = repoPath
    refreshing.value = true
    if (!snapshot.value) loading.value = true
    try {
      const next = await window.api.prStackLoad(repoPath, worktrees)
      // A transient `gh` failure comes back as an empty graph. Overwriting a
      // populated canvas with it is the bug: keep the last good snapshot (and
      // its `fetchedAt`) and record the failure. With nothing to keep, take the
      // failed snapshot so the empty state can say the refresh failed.
      const previous = snapshot.value
      if (next.ghFailure && previous && previous.ghAvailable && !previous.ghFailure) {
        refreshFailure.value = next.ghFailure
        error.value = null
        return
      }
      const shapeChanged = next.shape !== previous?.shape
      snapshot.value = next
      error.value = null
      refreshFailure.value = next.ghFailure

      // An override for a PR that closed or merged goes with it.
      const live = new Set(next.placements.map((p) => p.id))
      const forRepo = overridesByRepo.value[repoPath]
      if (forRepo) {
        const pruned = pruneOverrides(forRepo, live)
        if (Object.keys(pruned).length !== Object.keys(forRepo).length) {
          overridesByRepo.value = { ...overridesByRepo.value, [repoPath]: pruned }
          persistOverrides()
        }
      }

      if (shapeChanged) {
        const ringed = highlightedId.value
        fit()
        fittedShape.value = next.shape
        // A refit would undo a focus that just landed on the earlier snapshot.
        const again = ringed ? next.placements.find((p) => p.id === ringed) : null
        if (again) centerOn(again)
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      refreshFailure.value = 'other'
    } finally {
      refreshing.value = false
      loading.value = false
      applyPendingFocus(true)
    }
  }

  /**
   * (Re)arms the foreground clock from the current prefs. One place, so a
   * pref change and a fresh open can never disagree about the interval.
   * `autoRefresh: false` leaves the manual button as the only way in.
   */
  function armTimer(repoPath: string, worktrees: WorktreeNode[]): void {
    stopTimer()
    if (prefs.value && !prefs.value.autoRefresh) return
    const every = prefs.value?.intervalMs ?? FALLBACK_REFRESH_MS
    timer = setInterval(() => void load(repoPath, worktrees), every)
  }

  /**
   * Re-reads prefs and re-arms without disturbing the view. Called by the
   * Settings pane after a write, so changing the interval takes effect on the
   * canvas already behind the dialog rather than at the next open.
   */
  async function reloadPrefs(): Promise<void> {
    prefs.value = await window.api.prStackPrefs()
    const repo = currentRepo.value
    if (repo && timerArgs) armTimer(repo, timerArgs)
  }

  /**
   * Prefs for callers outside the canvas (the transcript's link handler), which
   * run before any canvas has ever been opened. Cached after the first read; a
   * failed read leaves them `null`, i.e. every opt-in stays off.
   */
  async function ensurePrefs(): Promise<PrStackPrefs | null> {
    if (prefs.value) return prefs.value
    try {
      prefs.value = await window.api.prStackPrefs()
    } catch {
      /* leave null — callers treat "unknown" as off */
    }
    return prefs.value
  }

  /** Opens the canvas on a repo: first load, then the foreground clock. */
  function start(repoPath: string, worktrees: WorktreeNode[] = []): void {
    if (currentRepo.value !== repoPath) {
      snapshot.value = null
      fittedShape.value = null
      expandedId.value = null
      trayOpen.value = false
    }
    timerArgs = worktrees
    void load(repoPath, worktrees)
    void (async () => {
      prefs.value = await window.api.prStackPrefs()
      armTimer(repoPath, worktrees)
    })()
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  /** Closing the takeover must not leave a `gh` poll running in the background. */
  function stop(): void {
    stopTimer()
    timerArgs = null
  }

  return {
    snapshot,
    loading,
    refreshing,
    error,
    refreshFailure,
    scale,
    panX,
    panY,
    lod,
    placements,
    visiblePlacements,
    visibleEdges,
    ghosts,
    activeWorld,
    filter,
    filterQuery,
    filterActive,
    matchedNumbers,
    matchCount,
    totalCount,
    dimActive,
    hideActive,
    setFilterQuery,
    setFilterDraft,
    setFilterMode,
    clearFilter,
    toggleKpiPreset,
    revealChain,
    overrides,
    movedCount,
    harvestable,
    harvestableBytes,
    expandedId,
    trayOpen,
    viewport,
    MIN_SCALE,
    MAX_SCALE,
    setViewport,
    fit,
    zoomBy,
    panBy,
    prefs,
    ensurePrefs,
    reloadPrefs,
    pendingFocus,
    highlightedId,
    focusPr,
    holdsOpenPr,
    applyPendingFocus,
    moveNode,
    commitMove,
    relayout,
    toggleExpanded,
    load,
    start,
    stop
  }
})
