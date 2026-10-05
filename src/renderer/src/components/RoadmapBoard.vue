<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Bot,
  ChevronLeft,
  GitBranch,
  KanbanSquare,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Terminal,
  User
} from 'lucide-vue-next'
import SegmentedControl from './ui/SegmentedControl.vue'
import Button from './ui/Button.vue'
import CardDetailModal from './CardDetailModal.vue'
import CardCreateModal from './CardCreateModal.vue'
import RoadmapFilterBar from './RoadmapFilterBar.vue'
import {
  useRoadmapStore,
  COLUMN_ORDER,
  lintCardReadiness,
  artifactRequirements,
  type ArtifactRequirement
} from '../stores/roadmap'
import { useRoadmapDrainStore } from '../stores/roadmap-drain'
import {
  CARD_SUBSTRATES,
  planCardDispatch,
  resolveCardSubstrate
} from '../stores/dispatch-substrate'
import { resolveDocPath, unansweredQuestionCount } from '../lib/card-detail'
import {
  DEFAULT_FILTER_STATE,
  deriveExecutedBranch,
  filterCards,
  filterStorageKey,
  groupCards,
  kindChipClass,
  parsePersistedFilters,
  serializeFilters,
  sessionShortId,
  type CardGroup,
  type GroupMode
} from '../lib/board-filters'
import { useSessionsStore } from '../stores/sessions'
import { useHelpersStore } from '../stores/helpers'
import { useUiStore } from '../stores/ui'
import { useMissionGrants } from '../composables/useMissionGrants'
import type { FleetState } from '../stores/fleet-state'
import type {
  RoadmapCard,
  ColumnKey,
  BootPromptLabels,
  RoadmapMergeEvidence,
  RoadmapWriteCode,
  DispatchConfirmReason,
  ResolvedRouting,
  ArtifactKey,
  GeneratorPromptLabels
} from '../../../preload'

/** Model/effort catalogs for the dispatch override picker — mirror `ClaudeBootForm`'s. */
const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku', 'fable']
const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The `dispatched-with` audit line (T97 §10.1 Q13) — renderer-local mirror of
 * `routing-policy.ts#formatDispatchedWith` (main is a node module; the
 * codebase's convention is to mirror the wire shape rather than cross-import).
 */
function formatDispatchedWith(r: ResolvedRouting): string {
  return `dispatched-with: ${r.model}·${r.effort}`
}

/**
 * Roadmap Kanban board (T80 S1 §4). A WIDE, per-repo main-pane view over
 * `.harnu/memory/roadmap/` — NOT a sidebar mode (design.md §6 reserves the
 * sidebar Fleet board for a narrow vertical stack; side-by-side columns are this
 * surface). It renders the roadmap store's column projection, lets the operator
 * drag cards between columns (each drop writes `status` via the serialized human
 * IPC), and dispatches an agent from a card — with the boot prompt disclosed
 * VERBATIM before any spawn (§6.3). No path here writes `status` for an agent,
 * and nothing moves a card to Done except the explicit human Close (§0).
 */

const { t } = useI18n()
const roadmap = useRoadmapStore()
const sessions = useSessionsStore()
const helpers = useHelpersStore()
const ui = useUiStore()
const missionGrants = useMissionGrants()

/** Cummings supervision ceiling as a board rule (§3.5) — soft cap on In Progress. */
const WIP_LIMIT = 5

// ---- Mission-grant strip (T80 S2 §3.4) -------------------------------------
// A board grant is just a T44 grant scoped to this repo. The AUTHORITATIVE
// scope match (does a live grant cover create_session here?) is decided in main
// (`roadmap:grantStatus`, where the full folder paths live); the renderer only
// resolves the returned id against the canonical `useMissionGrants()` list to
// render budget/TTL/revoke. Re-queried on open + whenever the grant list ticks
// (create / spend / revoke / expire), so the strip stays honest.
const coveringGrantId = ref<string | null>(null)
const coveringGrant = computed(() =>
  coveringGrantId.value
    ? (missionGrants.grants.value.find((g) => g.id === coveringGrantId.value) ?? null)
    : null
)

async function refreshGrant(): Promise<void> {
  if (!roadmap.folderPath) {
    coveringGrantId.value = null
    return
  }
  try {
    coveringGrantId.value = (await roadmap.grantStatus()).grantId
  } catch {
    coveringGrantId.value = null
  }
}

watch(missionGrants.grants, () => void refreshGrant())

/** Revoke the board's covering grant (§3.4 — one click; in-flight finish, new escalate). */
async function onRevokeGrant(): Promise<void> {
  const id = coveringGrantId.value
  if (!id) return
  await missionGrants.revoke(id)
  void refreshGrant()
}

// ---- Live cards (T80 S3 §3.6) ----------------------------------------------
// A bound card shows its session's CANONICAL fleet-state dot (the same
// `classifyFleetState` the sidebar/bento dot reads — never a fork), so a card's
// dot can't disagree with the session's dot elsewhere. `null` = unbound / a
// session Harnu hasn't loaded yet.
type DotKind = 'working' | 'needs-you' | 'stuck' | 'idle'

function fleetStateOf(card: RoadmapCard): FleetState | null {
  return card.session ? sessions.fleetStateFor(card.session) : null
}

/** Fold a FleetState onto the 4 dot kinds the card renders (return-here → needs-you). */
function dotKindOf(card: RoadmapCard): DotKind | null {
  const s = fleetStateOf(card)
  if (!s) return null
  if (s === 'working') return 'working'
  if (s === 'stuck') return 'stuck'
  if (s === 'needs-you' || s === 'return-here') return 'needs-you'
  return 'idle'
}

/** Dot classes per live state — reuses the FleetBoardCard tokens (§3.6, design.md §6). */
function dotClass(card: RoadmapCard): string {
  switch (dotKindOf(card)) {
    case 'working':
      return 'anim-pulse-dot bg-green'
    case 'needs-you':
      return 'anim-attention-dot bg-warning'
    case 'stuck':
      return 'border border-red'
    case 'idle':
      return 'bg-text-4'
    default:
      // No live state: unbound card = hollow ring; bound-but-not-loaded = solid grey.
      return card.session ? 'bg-text-4' : 'border border-text-4'
  }
}

/** Tooltip for the live dot (localized state name, or the unbound placeholder). */
function dotTitle(card: RoadmapCard): string {
  const kind = dotKindOf(card)
  return kind ? t(`roadmap.card.state.${kind}`) : t('roadmap.card.liveState')
}

/** Readiness lint gaps (T105 §3.3) — badge only, never a refusal. */
function readinessGaps(card: RoadmapCard): string[] {
  return lintCardReadiness(card).map((g) => g.code)
}

/** Artifact-shaped gap codes (T130 S3) — these render as per-artifact badges below,
 *  not the numeric gap count, so a card never double-reports the same gap. */
const ARTIFACT_GAP_CODES = new Set(['missing-spec', 'missing-prd', 'missing-adr'])

/** Non-artifact readiness gaps (e.g. a missing `## Acceptance criteria`) — the
 *  ONLY gaps the numeric badge below still counts (T130 S3, B10). */
function nonArtifactGaps(card: RoadmapCard): string[] {
  return readinessGaps(card).filter((code) => !ARTIFACT_GAP_CODES.has(code))
}

/** Tooltip listing every non-artifact readiness gap, localized. */
function readinessTitle(card: RoadmapCard): string {
  const gaps = nonArtifactGaps(card).map((code) => t(`roadmap.card.readiness.${code}`))
  return `${t('roadmap.card.readinessHint')} ${gaps.join('; ')}`
}

/**
 * Per-artifact badges (B10, T130 S3): ONLY the artifacts this tier (or the
 * card's own ADR declaration) actually requires — the SAME `artifactRequirements`
 * predicate the modal's Docs rows and the footer readiness hint read, so a
 * badge can never disagree with them. Not-required artifacts render nothing
 * (mockup-canonical: "artifacts the tier does NOT require are not rendered").
 */
function artifactBadges(card: RoadmapCard): ArtifactRequirement[] {
  return artifactRequirements(card).filter((req) => req.required)
}

/** Tooltip for one artifact badge — present vs. required-and-missing. */
function artifactBadgeTitle(card: RoadmapCard, req: ArtifactRequirement): string {
  return req.present
    ? t('roadmap.card.artifact.okTitle', { artifact: req.key })
    : t('roadmap.card.artifact.missTitle', { artifact: req.key, tier: card.complexity })
}

// Merge-evidence per in-progress bound card (commits ahead of origin/main + refs),
// fetched lazily: only when the card's session ISN'T actively working (so we don't
// churn git mid-commit). Keyed by slug; pruned as cards leave In Progress.
const mergeEvidence = ref<Map<string, RoadmapMergeEvidence>>(new Map())

const inProgressBound = computed(() => roadmap.columns['in-progress'].filter((c) => c.session))

async function refreshEvidence(): Promise<void> {
  const cards = inProgressBound.value
  const alive = new Set(cards.map((c) => c.slug))
  // Prune evidence for cards that left In Progress / unbound.
  if ([...mergeEvidence.value.keys()].some((k) => !alive.has(k))) {
    const next = new Map<string, RoadmapMergeEvidence>()
    for (const [k, v] of mergeEvidence.value) if (alive.has(k)) next.set(k, v)
    mergeEvidence.value = next
  }
  for (const card of cards) {
    if (!card.session) continue
    // Don't probe a session that's mid-work — wait until it pauses (termination).
    if (fleetStateOf(card) === 'working') continue
    const branch = sessions.findSessionById(card.session)?.gitBranch || ''
    try {
      const res = await roadmap.mergeEvidence(branch)
      const next = new Map(mergeEvidence.value)
      next.set(card.slug, res)
      mergeEvidence.value = next
    } catch {
      /* probe failed — leave last-known / no suggestion */
    }
  }
}

// Re-probe when the in-progress bound set OR any of their fleet-states change
// (the signature only changes on a real transition, so this doesn't fire per tick).
watch(
  () =>
    inProgressBound.value.map((c) => `${c.slug}:${c.session}:${fleetStateOf(c) ?? ''}`).join('|'),
  () => void refreshEvidence(),
  { immediate: true }
)

/**
 * Whether to SUGGEST moving a bound In Progress card to Review (§3.5). Mirrors the
 * pure `suggestReviewTransition` in `roadmap-core` (kept renderer-local per the
 * store's "mirror the wire shape" convention): unmerged commits are the strong
 * artifact; a bare session completion is the fallback. A working session is never
 * nagged. Returns the evidence kind, or null.
 */
function reviewSuggestion(card: RoadmapCard): 'commits' | 'completed' | null {
  if (card.column !== 'in-progress' || !card.session) return null
  if (fleetStateOf(card) === 'working') return null
  const ahead = mergeEvidence.value.get(card.slug)?.ahead ?? 0
  if (ahead > 0) return 'commits'
  const completed = sessions.findSessionById(card.session)?.taskState === 'completed'
  return completed ? 'completed' : null
}

/** Label for the review-suggestion button ("Move to Review · N commits" / "· finished"). */
function reviewSuggestionLabel(card: RoadmapCard): string {
  const kind = reviewSuggestion(card)
  if (kind === 'commits') {
    return t('roadmap.card.suggestReviewCommits', {
      count: mergeEvidence.value.get(card.slug)?.ahead ?? 0
    })
  }
  return t('roadmap.card.suggestReviewDone')
}

/** Human approves the suggestion → move In Progress → Review with evidence (§3.5). */
async function onMoveToReview(card: RoadmapCard): Promise<void> {
  const refs = mergeEvidence.value.get(card.slug)?.refs ?? []
  const res = await roadmap.moveToReview(card.slug, refs)
  if (!res.ok) ui.pushToast({ kind: 'danger', title: writeError(res.code) })
}

/** Localized labels handed to the SERVER-SIDE boot-prompt builder (§6.2/§3.5). */
function bootLabels(): BootPromptLabels {
  return {
    heading: t('roadmap.boot.heading'),
    framing: t('roadmap.boot.framing'),
    specLabel: t('roadmap.boot.specLabel'),
    specFileHint: t('roadmap.boot.specFileHint'),
    closure: t('roadmap.boot.closure')
  }
}

const columns = computed(() => roadmap.columns)
function columnLabel(key: ColumnKey): string {
  return t(`roadmap.columns.${key}`)
}

// ---- Filter bar + group-by + Done rail (T80 S2 PR2) ------------------------
const searchQuery = ref('')
const activeKinds = ref<string[]>([...DEFAULT_FILTER_STATE.kinds])
const groupMode = ref<GroupMode>(DEFAULT_FILTER_STATE.group)
const hideDone = ref<boolean>(DEFAULT_FILTER_STATE.hideDone)

// ---- Worktree scope (T190) — EPHEMERAL: never persisted (D6), resets on every
// board open. `worktreeScope` is the operator's/auto-preset selection;
// `localBranches` backs the runtime-only derived-owner fallback (D4) for the
// card face + detail modal, refetched whenever the board's folder changes.
const worktreeScope = ref<string | null>(null)
const localBranches = ref<string[]>([])

async function loadLocalBranches(repoPath: string): Promise<void> {
  try {
    const refs = await window.api.worktreeBranches({ repoPath })
    localBranches.value = refs.filter((b) => !b.remote).map((b) => b.name)
  } catch {
    localBranches.value = []
  }
}

/** Distinct origin/owner branches across the loaded cards — the dropdown's options. */
const worktreeOptions = computed(() => {
  const set = new Set<string>()
  for (const card of roadmap.cards) {
    if (card.provenance.branch) set.add(card.provenance.branch)
    if (card.executedIn) set.add(card.executedIn)
  }
  return [...set].sort()
})

/**
 * D2 — opening the board from a folder that is NOT the repo's main checkout
 * resets the scope to that folder's branch (visible in the dropdown, one click
 * to clear). Opening from the main checkout never auto-scopes.
 */
function autoScopeFor(folder: string): void {
  const f = sessions.findFolderByPath(folder)
  worktreeScope.value = f && f.isMainWorktree === false && f.gitBranch ? f.gitBranch : null
}

/** T190: the branch-chip precedence (§3, D5) — `executedIn` solid, else a
 *  derived guess (dashed), else origin solid, else nothing. */
function branchChipFor(card: RoadmapCard): { branch: string; derived: boolean } | null {
  if (card.executedIn) return { branch: card.executedIn, derived: false }
  const derived = deriveExecutedBranch(card.id, localBranches.value)
  if (derived) return { branch: derived, derived: true }
  if (card.provenance.branch) return { branch: card.provenance.branch, derived: false }
  return null
}

/** Every card keyed by BOTH `id` and `slug` — `parent` refs may use either (mirrors `linkedRefsOf`'s lookup). */
const cardsById = computed(() => {
  const map = new Map<string, RoadmapCard>()
  for (const card of roadmap.cards) {
    map.set(card.id, card)
    map.set(card.slug, card)
  }
  return map
})

const activeKindSet = computed(() => new Set(activeKinds.value))

/** Search + kind + worktree-scope filtered cards per column (all ephemeral, never persisted). */
const filteredColumns = computed<Record<ColumnKey, RoadmapCard[]>>(() => {
  const out = {} as Record<ColumnKey, RoadmapCard[]>
  for (const col of COLUMN_ORDER) {
    out[col] = filterCards(
      columns.value[col].map((c) => ({ ...c, originBranch: c.provenance.branch })),
      {
        search: searchQuery.value,
        kinds: activeKindSet.value,
        scope: { branch: worktreeScope.value }
      }
    )
  }
  return out
})

/** Filtered cards bucketed per `groupMode` (E9's third persisted preference). */
const groupedColumns = computed<Record<ColumnKey, CardGroup<RoadmapCard>[]>>(() => {
  const out = {} as Record<ColumnKey, CardGroup<RoadmapCard>[]>
  for (const col of COLUMN_ORDER) {
    out[col] = groupCards(filteredColumns.value[col], groupMode.value, cardsById.value)
  }
  return out
})

const NON_DONE_COLUMNS: readonly ColumnKey[] = ['backlog', 'ready', 'in-progress', 'review']

/** Header eyebrow (B7): every non-done card left after search+kind filters. */
const headerCardsCount = computed(() =>
  NON_DONE_COLUMNS.reduce((sum, col) => sum + filteredColumns.value[col].length, 0)
)
/** Bound sessions currently `working` (fleet fact — unaffected by the filter bar). */
const headerWorkingCount = computed(
  () => roadmap.cards.filter((c) => dotKindOf(c) === 'working').length
)

/** Load the three persisted preferences for a repo (E9); falls back to the default on any miss. */
function loadFiltersFor(key: string): void {
  const state =
    parsePersistedFilters(localStorage.getItem(filterStorageKey(key))) ?? DEFAULT_FILTER_STATE
  activeKinds.value = [...state.kinds]
  groupMode.value = state.group
  hideDone.value = state.hideDone
}
watch(
  () => roadmap.repoKey,
  (key) => {
    if (key) loadFiltersFor(key)
  },
  { immediate: true }
)
watch([activeKinds, groupMode, hideDone], () => {
  const key = roadmap.repoKey
  if (!key) return
  try {
    localStorage.setItem(
      filterStorageKey(key),
      serializeFilters({
        kinds: activeKinds.value,
        group: groupMode.value,
        hideDone: hideDone.value
      })
    )
  } catch {
    /* quota / private mode — filters stay in-memory only, same degrade as `persistedRef` */
  }
})

// Load the board for the folder the operator opened it on; re-load if the store's
// target folder changes while the board stays mounted (re-open on another repo).
onMounted(() => {
  if (ui.roadmap.folderPath) {
    void roadmap.open(ui.roadmap.folderPath)
    autoScopeFor(ui.roadmap.folderPath)
    void loadLocalBranches(ui.roadmap.folderPath)
  }
  void refreshGrant()
})
watch(
  () => ui.roadmap.folderPath,
  (path) => {
    if (path && path !== roadmap.folderPath) {
      void roadmap.open(path)
      // T190/D6: every (re)open resets the ephemeral scope — either to the
      // newly opened folder's own branch, or back to "All worktrees".
      autoScopeFor(path)
      void loadLocalBranches(path)
    }
    void refreshGrant()
  }
)

// ---- Drag + drop (native HTML5) --------------------------------------------
const dragSlug = ref<string | null>(null)
const dragOverCol = ref<ColumnKey | null>(null)

function onDragStart(card: RoadmapCard, ev: DragEvent): void {
  dragSlug.value = card.slug
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('text/plain', card.slug)
  }
}
function onDragEnd(): void {
  dragSlug.value = null
  dragOverCol.value = null
}
function onDragOver(col: ColumnKey, ev: DragEvent): void {
  // Accept the drop everywhere so `onDrop` can respond — but Done shows NO
  // highlight and rejects with a steer: Done is reached only by the human Close
  // action after Review, never by dragging (§0). Non-highlight signals that.
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  dragOverCol.value = col === 'done' ? null : col
}
function onDragLeave(col: ColumnKey): void {
  if (dragOverCol.value === col) dragOverCol.value = null
}

/**
 * WIP soft-cap check (§3.5 / S4): would adding one more card to In Progress breach
 * the supervision ceiling? `inProgressCount` is the count BEFORE the incoming card
 * (it isn't in the column yet), so this mirrors the pure `wouldExceedWip`. Soft:
 * the move always proceeds — this only warns (an explicit, visible override).
 */
function wipWouldExceed(): boolean {
  return roadmap.inProgressCount + 1 > WIP_LIMIT
}
function warnWip(): void {
  ui.pushToast({
    kind: 'warning',
    title: t('roadmap.wipExceeded', { limit: WIP_LIMIT }),
    description: t('roadmap.wipExceededHint')
  })
}

async function onDrop(col: ColumnKey): Promise<void> {
  const slug = dragSlug.value
  dragOverCol.value = null
  dragSlug.value = null
  if (!slug) return
  const card = roadmap.findCard(slug)
  if (!card) return
  if (col === 'done') {
    // Drag → Done is blocked; Done is a human Close after Review (§4 drop rules).
    ui.pushToast({ kind: 'warning', title: t('roadmap.dropBlockedDone') })
    return
  }
  if (card.column === col) return
  // Soft cap (§3.5): warn — but never block — a drop that pushes In Progress over
  // the supervision ceiling. Measured before the optimistic move commits.
  const breachesWip = col === 'in-progress' && wipWouldExceed()
  const res = await roadmap.setStatus(slug, col)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  if (breachesWip) warnWip()
  // Moving a card into Ready is the dispatch signal (§3.3): offer a spawn.
  if (col === 'ready' && !card.session) void offerDispatch(card)
}

// ---- Dispatch (auto under grant, else human-confirmed) ---------------------
interface DispatchConfirm {
  card: RoadmapCard
  prompt: string
  provenanceAuthor: 'human' | 'agent'
  /** Why this dispatch asks a human instead of auto-running (S2 disclosure copy). */
  reason: DispatchConfirmReason
  /** T104: for `reason: 'manifest-stale'` — which fingerprinted fields changed. */
  staleFields?: ('title' | 'spec' | 'body')[]
  /**
   * T97: the routing table's resolution for this card's kind, prefilled and
   * mutable — the confirm's override picker edits this object directly
   * (v-model), so `confirmDispatch` just reads whatever is here on Allow.
   */
  routing: ResolvedRouting
  /**
   * T102: the resolved substrate (default or on-disk), prefilled and mutable —
   * the confirm's override picker edits this directly (v-model), so
   * `confirmDispatch` reads whatever is here on Allow, exactly like `routing`.
   * Plain `string` (not the narrow union) because `SegmentedControl`'s v-model
   * emits the broader `SegValue` — `planCardDispatch` validates it leniently.
   */
  substrate: string
  /**
   * T130 S4 (M8-Generate, E8): true for a Generate dispatch (vs. dispatching
   * the card itself) — SAME confirm overlay, SAME gate, but the spawned
   * session is never bound to the card (`session:`/`in-progress`), since
   * Generate is a side-task on a card that may already be dispatched
   * elsewhere or still sitting in Backlog.
   */
  isGenerate?: boolean
  /** T130 S4: the artifact being generated — set only when `isGenerate`. */
  artifact?: ArtifactKey
}
const dispatchConfirm = ref<DispatchConfirm | null>(null)
const dispatching = ref(false)

function writeError(code: RoadmapWriteCode): string {
  return t(`roadmap.dispatch.error.${code}`)
}

/**
 * Spawn a fresh HUMAN full-permission session with the card's boot prompt and
 * bind it to the card (`session:` + in-progress). Returns the session id or
 * null (spawn failure, or the card resolved to `internal` — which never
 * spawns a Harnu session at all, T102). The bind is best-effort — the session
 * is already spawning; a failed bind only misses the link (S3 re-binds on the
 * synth→real migrate).
 *
 * `routing` (T97) is the resolved `{ model, effort }` — from the per-repo
 * routing table (kind → table → hardcoded default), possibly overridden by the
 * operator in the confirm dialog. Forwarded as the synthetic's one-shot
 * `bootOverride` AND recorded as a `dispatched-with` audit line on the card
 * body, so the two paths (manual confirm, manifest drain) can never disagree
 * about what actually launched.
 *
 * `substrateOverride` (T102) is the operator's per-card pick from the confirm
 * dialog, when present — absent on the auto-drain path, which always reads
 * whatever is already on disk (any manifest-checklist override was persisted
 * BEFORE the drain runs, see `stampManifestApprovals`). `planCardDispatch`
 * resolves WHERE this spawns: same folder (`session`/`teammate`), a fresh
 * `create_worktree` (`worktree` — born inheriting agent control, fixing the
 * live-dogfood FINDING, since `worktreeCreate` is a disclosed human surface),
 * or nowhere (`internal`).
 *
 * `bind` (T130 S4, default `true`) — a Generate dispatch passes `false`: the
 * spawned session runs a side-task (draft the missing artifact), NOT the
 * card's own dispatch, so it must never overwrite the card's `session:`/
 * `in-progress` — a card already in-flight elsewhere (or still in Backlog)
 * keeps its own status untouched.
 */
async function spawnAndBind(
  card: RoadmapCard,
  prompt: string,
  routing: ResolvedRouting,
  substrateOverride?: string,
  bind = true
): Promise<string | null> {
  const folder = roadmap.folderPath
  if (!folder) return null
  const target = planCardDispatch(card, folder, substrateOverride)
  if (target.kind === 'skip-internal') return null

  let spawnFolder = folder
  if (target.kind === 'worktree') {
    try {
      const created = await window.api.worktreeCreate({
        repoPath: target.repoPath,
        branch: target.branch,
        // A board dispatch is always a DISCLOSED human surface (the per-card
        // confirm, or a manifest the operator already Allowed) — never opt out,
        // so the new worktree inherits agent control (gated on the existing
        // setting + parent-allowed checks in `createWorktree`).
        optOutInherit: false
      })
      spawnFolder = created.path
      // BUG-40 §3.1: register the folder from THIS call's own `adopted` payload
      // BEFORE dispatching into it — closes the race where `dispatchCardSession`
      // used to run its `findFolderByPath` lookup at ~0ms while the folder only
      // landed in the model via the 250ms `onFolderAdopted` debounce, guaranteeing
      // a miss that orphaned the freshly-seeded worktree on every retry.
      sessions.registerFolderImmediate(created.adopted)
    } catch (err) {
      // BUG-40 §3.2: surface the real cause instead of a bare `catch {}`.
      ui.pushToast({
        kind: 'danger',
        title: t('roadmap.dispatch.error.worktreeFailed'),
        description: err instanceof Error ? err.message : String(err)
      })
      return null
    }
  }

  const dispatch = sessions.dispatchCardSession(spawnFolder, prompt, routing)
  if (!dispatch.ok) {
    // BUG-40 §3.2: surface the real cause instead of a bare `null`.
    ui.pushToast({
      kind: 'danger',
      title: t('roadmap.dispatch.error.spawnFailed'),
      description: dispatch.reason
    })
    return null
  }
  const sessionId = dispatch.sessionId
  if (!bind) return sessionId
  const teammateOf = target.kind === 'same-folder' ? target.teammateOf : undefined
  const note = teammateOf
    ? `${formatDispatchedWith(routing)}\nteammate-of: ${teammateOf}`
    : formatDispatchedWith(routing)
  // T190: the OWNER stamp — the worktree case already knows its branch
  // synchronously (the name it was just created with); the same-folder case
  // reads the live folder model's `gitBranch` (empty/detached ⇒ omitted, never
  // written as an empty string).
  const executedIn =
    target.kind === 'worktree'
      ? target.branch
      : (sessions.findFolderByPath(spawnFolder)?.gitBranch ?? undefined) || undefined
  await roadmap.bindSession(card.slug, sessionId, note, target.substrate, executedIn)
  return sessionId
}

/**
 * The dispatch gesture (§3.3/§3.4): ask main to PLAN the dispatch. Main decides
 * auto-under-grant vs human confirm (fail-closed on agent provenance) and, on the
 * auto path, has already reserved a grant budget unit. `auto` spawns immediately
 * (no confirm); everything else opens the S1 disclosure carrying WHY.
 */
async function offerDispatch(card: RoadmapCard): Promise<void> {
  // T102: an `internal` card is never dispatched as a new Harnu session — the
  // orchestrator resolves it with its own subagents (Claude Code Task tool)
  // and moves it along via `propose_move`. Short-circuit BEFORE `planDispatch`
  // so no grant budget is ever reserved for a card that will never spawn.
  if (resolveCardSubstrate(card) === 'internal') {
    ui.pushToast({ kind: 'info', title: t('roadmap.dispatch.internalNote') })
    return
  }
  // A dispatch flips the card into In Progress — warn (soft cap) if that breaches
  // the supervision ceiling, before we spawn another agent to review (§3.5).
  if (wipWouldExceed()) warnWip()
  const res = await roadmap.planDispatch(card.slug, bootLabels())
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  // T97: resolve the routing table BEFORE branching — both the auto path and
  // the confirm dialog need the same resolution, kind → table → default.
  const routing = await roadmap.resolveRouting(card.kind)
  if (res.mode === 'auto') {
    await autoDispatch(card, res.prompt, res.grantId, res.grantBudgetRemaining, routing)
    return
  }
  dispatchConfirm.value = {
    card,
    prompt: res.prompt,
    provenanceAuthor: res.provenanceAuthor,
    reason: res.reason,
    ...(res.staleFields ? { staleFields: res.staleFields } : {}),
    routing,
    substrate: resolveCardSubstrate(card)
  }
}

/**
 * Auto-dispatch under a live grant (no per-card confirm, §3.4). The budget unit
 * was reserved server-side by `planDispatch`; refund it if the spawn fails so
 * budget commits only for a session that actually launched. On success the board
 * STAYS open (fan-out: drop several cards under one grant) and toasts the spend.
 */
async function autoDispatch(
  card: RoadmapCard,
  prompt: string,
  grantId: string | null,
  budgetLeft: number | null,
  routing: ResolvedRouting
): Promise<void> {
  if (dispatching.value) return
  dispatching.value = true
  try {
    const sessionId = await spawnAndBind(card, prompt, routing)
    if (!sessionId) {
      if (grantId) await roadmap.releaseDispatch(grantId) // refund the reserved unit
      ui.pushToast({ kind: 'danger', title: t('roadmap.dispatch.error.spawnFailed') })
      return
    }
    ui.pushToast({
      kind: 'success',
      title: t('roadmap.dispatch.autoTitle', { id: card.id }),
      description:
        budgetLeft === null
          ? t('roadmap.dispatch.autoFree')
          : t('roadmap.dispatch.autoBudget', { count: budgetLeft })
    })
    if (grantId !== null) void refreshGrant()
  } finally {
    dispatching.value = false
  }
}

/** Localized labels handed to the SERVER-SIDE Generate-prompt builder (T130 S4, E8). */
function generatorLabels(): GeneratorPromptLabels {
  return {
    heading: t('roadmap.generate.heading'),
    framing: t('roadmap.generate.framing'),
    cardLabel: t('roadmap.generate.cardLabel'),
    tierDirect: t('roadmap.generate.tierDirect'),
    tierStandard: t('roadmap.generate.tierStandard'),
    tierComplex: t('roadmap.generate.tierComplex'),
    outputInstruction: t('roadmap.generate.outputInstruction'),
    fieldInstruction: t('roadmap.generate.fieldInstruction'),
    scopeInstruction: t('roadmap.generate.scopeInstruction'),
    closure: t('roadmap.generate.closure')
  }
}

/**
 * The Generate gesture (T130 S4, M8-Generate, E8): the SAME plan-then-branch
 * shape as `offerDispatch` — main decides auto-under-grant vs human confirm
 * through the identical gate — but for the 3-tier GENERATOR prompt of one
 * artifact. "No new free path": everything downstream (the confirm overlay,
 * `autoGenerate`/`confirmDispatch`'s spawn) reuses the card-dispatch machinery,
 * only skipping the session BIND (`spawnAndBind`'s `bind: false`).
 */
async function offerGenerate(card: RoadmapCard, artifact: ArtifactKey): Promise<void> {
  // T102: mirrors `offerDispatch`'s short-circuit — an `internal` card never
  // spawns a Harnu session, so no grant budget is reserved for one that can't run.
  if (resolveCardSubstrate(card) === 'internal') {
    ui.pushToast({ kind: 'info', title: t('roadmap.dispatch.internalNote') })
    return
  }
  const res = await roadmap.planGenerate(card.slug, artifact, generatorLabels())
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  const routing = await roadmap.resolveRouting(card.kind)
  if (res.mode === 'auto') {
    await autoGenerate(card, res.prompt, res.grantId, res.grantBudgetRemaining, routing)
    return
  }
  dispatchConfirm.value = {
    card,
    prompt: res.prompt,
    provenanceAuthor: res.provenanceAuthor,
    reason: res.reason,
    ...(res.staleFields ? { staleFields: res.staleFields } : {}),
    routing,
    substrate: resolveCardSubstrate(card),
    isGenerate: true,
    artifact
  }
}

/** Auto-Generate under a live grant (no per-card confirm) — mirrors `autoDispatch`,
 *  never binds the spawned session to the card (`spawnAndBind`'s `bind: false`). */
async function autoGenerate(
  card: RoadmapCard,
  prompt: string,
  grantId: string | null,
  budgetLeft: number | null,
  routing: ResolvedRouting
): Promise<void> {
  if (dispatching.value) return
  dispatching.value = true
  try {
    const sessionId = await spawnAndBind(card, prompt, routing, undefined, false)
    if (!sessionId) {
      if (grantId) await roadmap.releaseDispatch(grantId)
      ui.pushToast({ kind: 'danger', title: t('roadmap.dispatch.error.spawnFailed') })
      return
    }
    ui.pushToast({
      kind: 'success',
      title: t('roadmap.generate.autoTitle', { id: card.id }),
      description:
        budgetLeft === null
          ? t('roadmap.dispatch.autoFree')
          : t('roadmap.dispatch.autoBudget', { count: budgetLeft })
    })
    if (grantId !== null) void refreshGrant()
  } finally {
    dispatching.value = false
  }
}

// ---- Manifest drain (T104 §2.5 → T113) --------------------------------------
// The drain DRIVER moved to the main process (`src/main/manifest-drain.ts`,
// T113): stamped cards dispatch with or WITHOUT this board mounted — the loop
// that used to live here died with the component, which left the operator's
// first real manifest undrained for ~40 minutes. The board keeps only the
// batch-strip DISPLAY, mirrored from main's `roadmap:drainEvent` ticks by the
// app-wide `roadmap-drain` store (which also owns the confirm-needed toast).
const drainStore = useRoadmapDrainStore()
const manifestBatch = computed(() =>
  roadmap.folderPath ? (drainStore.batches[roadmap.folderPath] ?? null) : null
)

function cancelDispatch(): void {
  dispatchConfirm.value = null
}

/** On Allow: spawn a fresh session with the boot prompt, bind it, reveal it. */
async function confirmDispatch(): Promise<void> {
  const dc = dispatchConfirm.value
  if (!dc || !roadmap.folderPath || dispatching.value) return
  dispatching.value = true
  try {
    // T102: the operator can flip the substrate to `internal` right here (e.g.
    // "actually the orchestrator should resolve this itself") — that never
    // spawns a session, so close the dialog with an informational toast instead
    // of routing through spawnAndBind's generic failure path.
    if (dc.substrate === 'internal') {
      dispatchConfirm.value = null
      ui.pushToast({ kind: 'info', title: t('roadmap.dispatch.internalNote') })
      return
    }
    // dc.routing/dc.substrate carry whatever the operator left in the override
    // pickers — prefilled from the routing table / the card's substrate,
    // editable before Allow (T97/T102). `!dc.isGenerate` (T130 S4): a Generate
    // confirm never binds the spawned session to the card.
    const sessionId = await spawnAndBind(
      dc.card,
      dc.prompt,
      dc.routing,
      dc.substrate,
      !dc.isGenerate
    )
    if (!sessionId) {
      ui.pushToast({ kind: 'danger', title: t('roadmap.dispatch.error.spawnFailed') })
      return
    }
    dispatchConfirm.value = null
    // Reveal the freshly-spawned session so the operator watches the agent boot.
    ui.closeRoadmap()
  } finally {
    dispatching.value = false
  }
}

// ---- Card actions -----------------------------------------------------------
/** Click a bound card → open its session in the sidebar (leaves the board). */
function openSession(card: RoadmapCard): void {
  if (!card.session) return
  sessions.select(card.session)
  ui.closeRoadmap()
}

// ---- Card detail modal (card-detail PRD §2-S1) -------------------------------
// Click a card (anywhere except its action buttons) → the read-only dossier.
// Keyed by slug so live watcher updates flow through `findCard` reactively; a
// card removed from disk while open simply closes the modal (computed → null).
const detailSlug = ref<string | null>(null)
const detailCard = computed(() =>
  detailSlug.value ? (roadmap.findCard(detailSlug.value) ?? null) : null
)

function openDetail(card: RoadmapCard): void {
  detailSlug.value = card.slug
}
function closeDetail(): void {
  detailSlug.value = null
}

// ---- Create mode (T80 S2 PR3, M14/B8/E5) -------------------------------------
// `+ New card` opens a dedicated create-mode modal (sibling of the read/edit
// dossier — there's no RoadmapCard yet to back it). On success the modal
// closes and the board opens the fresh card straight into the detail dossier —
// the "look at what got written" instinct, same as after a Save.
const creatingCard = ref(false)
function openCreate(): void {
  creatingCard.value = true
}
function closeCreate(): void {
  creatingCard.value = false
}
function onCardCreated(slug: string): void {
  creatingCard.value = false
  detailSlug.value = slug
}
/** A linked-card chip click navigates the modal to that card (same board). */
function navigateDetail(slug: string): void {
  if (roadmap.findCard(slug)) detailSlug.value = slug
}
/**
 * Open a card doc (spec/prd/adr, T130 S3) through the SAME MarkdownPane flow
 * the FolderMenu uses (T74): pane anchored to the visible worktree, shown
 * ALONGSIDE the board (App.vue renders the helper stack next to any
 * main-content view, not just the terminal) — unlike `openSession`, there's no
 * reason to leave the board just to peek at a doc.
 */
function openDetailDoc(docPath: string): void {
  const folder = roadmap.folderPath
  if (!folder) return
  const worktree = sessions.selectedSession?.projectPath || folder
  helpers.addMarkdownHelper(worktree, resolveDocPath(folder, docPath), worktree)
  detailSlug.value = null
}

/**
 * S2: the modal's Dispatch button closes the modal into the SAME dispatch
 * flow the board row's own Dispatch button uses (§ card detail modal footer).
 */
function onDetailDispatch(card: RoadmapCard): void {
  detailSlug.value = null
  void offerDispatch(card)
}

/**
 * T130 S4 (M8-Generate): the modal's Generate button on a required-missing
 * Docs row closes the modal into the SAME confirm overlay `onDetailDispatch`
 * uses — one gesture, one gate, no second overlay stacked on top of the modal.
 */
function onDetailGenerate(card: RoadmapCard, artifact: ArtifactKey): void {
  detailSlug.value = null
  void offerGenerate(card, artifact)
}

/** Human Close (Review → Done). Warns — never blocks — when there's no evidence (§3.5). */
async function onClose(card: RoadmapCard): Promise<void> {
  if (card.evidence.length === 0) {
    ui.pushToast({
      kind: 'warning',
      title: t('roadmap.closeNoEvidenceTitle'),
      description: t('roadmap.closeNoEvidenceBody'),
      action: { label: t('roadmap.closeAnyway'), handler: () => void doClose(card) }
    })
    return
  }
  await doClose(card)
}
/**
 * T103: writes `status: done` + the mechanical memory append (`roadmap:closeCard`),
 * then auto-archives the card's bound session (spec §12.1 D3 — "auto-archive,
 * zero cost, UI state"; no confirm — reversible via the toast's Undo or the
 * sidebar's Unarchive, never a blocking gate per the epic's zero-friction
 * principle, §12.0).
 */
async function doClose(card: RoadmapCard): Promise<void> {
  const boundSession = card.session
  const res = await roadmap.closeCard(card.slug)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  if (boundSession && !sessions.isArchived(boundSession)) {
    sessions.archiveSession(boundSession)
    ui.pushToast({
      kind: 'info',
      title: t('roadmap.closeSessionArchived'),
      action: {
        label: t('roadmap.undoArchive'),
        handler: () => sessions.unarchiveSession(boundSession)
      }
    })
  }
}
</script>

<template>
  <!-- Mission-grant strip (§3.4): a live grant covering this repo auto-dispatches
         human-authored cards without a per-card confirm. Budget/TTL + revoke. -->
  <div
    v-if="coveringGrant && coveringGrant.live"
    class="flex shrink-0 items-center gap-2 border-b border-accent-line bg-accent-soft px-3 py-1.5 text-[11px] text-accent"
  >
    <ShieldCheck :size="13" :stroke-width="1.7" class="shrink-0" />
    <span class="min-w-0 truncate font-medium">{{ $t('roadmap.grant.active') }}</span>
    <span class="min-w-0 truncate text-accent/80">· {{ coveringGrant.goal }}</span>
    <span class="flex-1" />
    <span class="shrink-0 tabular-nums text-accent/80">
      {{
        $t('roadmap.grant.budget', {
          remaining: coveringGrant.remaining,
          budget: coveringGrant.budget
        })
      }}
      · {{ $t('roadmap.grant.ttl', { min: missionGrants.minutesLeft(coveringGrant) }) }}
    </span>
    <!-- T104 §3: the manifest drain counter — "N of M dispatched" for the batch
           currently draining. Hidden once the batch finishes/no drain is active. -->
    <span v-if="manifestBatch" class="shrink-0 tabular-nums text-accent/80">
      ·
      {{
        $t('roadmap.manifest.drainCounter', {
          done: manifestBatch.dispatched,
          total: manifestBatch.total
        })
      }}
    </span>
    <button
      class="shrink-0 rounded-sm px-1.5 py-0.5 font-medium text-accent transition hover:bg-accent hover:text-accent-ink"
      @click="onRevokeGrant"
    >
      {{ $t('roadmap.grant.revoke') }}
    </button>
  </div>

  <!-- Filter bar (T80 S2 PR2, design.md §6 "Filter bar"). Rendered even on an
         empty board (T80 S2 PR3) — `+ New card` must stay reachable to create
         the first one; the search/kind/group controls are harmless no-ops
         with zero cards. -->
  <RoadmapFilterBar
    v-if="!roadmap.loading && !roadmap.error"
    v-model:search="searchQuery"
    v-model:active-kinds="activeKinds"
    v-model:group="groupMode"
    v-model:hide-done="hideDone"
    v-model:worktree-scope="worktreeScope"
    :worktree-options="worktreeOptions"
    @new-card="openCreate"
  />

  <!-- Loading / error / empty -->
  <div
    v-if="roadmap.loading"
    class="flex flex-1 items-center justify-center text-[12px] text-text-3"
  >
    {{ $t('roadmap.loading') }}
  </div>
  <div
    v-else-if="roadmap.error"
    class="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-red"
  >
    {{ $t('roadmap.error') }}
  </div>
  <div
    v-else-if="roadmap.cards.length === 0"
    class="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center"
  >
    <p class="text-[13px] text-text-2">{{ $t('roadmap.empty') }}</p>
    <p class="max-w-md text-[12px] text-text-4">{{ $t('roadmap.emptyHint') }}</p>
  </div>

  <!-- Columns -->
  <div v-else class="scrollable flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
    <template v-for="col in COLUMN_ORDER" :key="col">
      <!-- Done rail (T80 S2 PR2, design.md §6 "Done rail") — collapsed while Hide done is ON -->
      <button
        v-if="col === 'done' && hideDone"
        type="button"
        class="flex w-9 shrink-0 flex-col items-center rounded-lg border border-border bg-sidebar transition-colors hover:bg-surface"
        :title="$t('roadmap.doneRail.expand')"
        @dragover="onDragOver(col, $event)"
        @dragleave="onDragLeave(col)"
        @drop.prevent="onDrop(col)"
        @click="hideDone = false"
      >
        <ChevronLeft :size="12" :stroke-width="2" class="mt-3 shrink-0 text-text-4" />
        <span
          class="mt-2 py-1.5 font-mono text-[10.5px] font-medium uppercase tracking-wide text-text-4"
          style="writing-mode: vertical-rl; transform: rotate(180deg)"
        >
          {{ $t('roadmap.doneRail.label', { count: filteredColumns[col].length }) }}
        </span>
      </button>

      <!-- Normal column (every column, or Done once expanded) -->
      <section
        v-else
        class="flex min-h-0 w-[272px] shrink-0 flex-col rounded-lg border transition-colors"
        :class="
          dragOverCol === col ? 'border-accent-line bg-surface' : 'border-border bg-surface/40'
        "
        @dragover="onDragOver(col, $event)"
        @dragleave="onDragLeave(col)"
        @drop.prevent="onDrop(col)"
      >
        <!-- Column header (eyebrow, §3) -->
        <div class="flex items-center gap-1.5 px-3 py-2">
          <span class="eyebrow text-text-3">{{ columnLabel(col) }}</span>
          <span class="text-[11px] tabular-nums text-text-4">{{
            filteredColumns[col].length
          }}</span>
          <button
            v-if="col === 'done'"
            type="button"
            class="ml-auto text-[10px] text-text-4 transition hover:text-text-2"
            :title="$t('roadmap.doneRail.collapse')"
            @click="hideDone = true"
          >
            {{ $t('roadmap.doneRail.collapse') }}
          </button>
        </div>

        <!-- Cards, bucketed per the Group segmented control -->
        <div class="scrollable flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          <template v-for="group in groupedColumns[col]" :key="group.key">
            <!-- Group-by eyebrow sub-header (epic/kind); no header for the unlabeled bucket -->
            <div v-if="group.label !== null" class="flex items-center gap-1.5 px-1 pb-1 pt-2">
              <span class="eyebrow text-text-4">{{ group.label }}</span>
              <span class="font-mono text-[10px] text-text-4">{{ group.count }}</span>
            </div>

            <article
              v-for="card in group.cards"
              :key="card.slug"
              class="group flex cursor-grab flex-col gap-1.5 rounded-md border border-border bg-surface p-2.5 transition-colors hover:border-border-2 active:cursor-grabbing"
              :class="dragSlug === card.slug ? 'opacity-50' : ''"
              draggable="true"
              @dragstart="onDragStart(card, $event)"
              @dragend="onDragEnd"
              @click="openDetail(card)"
            >
              <!-- Row 1: live fleet-state dot (S3) + title + provenance -->
              <div class="flex items-start gap-1.5">
                <span
                  class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="dotClass(card)"
                  :title="dotTitle(card)"
                />
                <span class="min-w-0 flex-1 text-[13px] leading-snug text-text">{{
                  card.title
                }}</span>
                <component
                  :is="card.provenance.author === 'agent' ? Bot : User"
                  :size="12"
                  :stroke-width="1.6"
                  class="mt-0.5 shrink-0"
                  :class="card.provenance.author === 'agent' ? 'text-warning' : 'text-text-4'"
                  :title="
                    card.provenance.author === 'agent'
                      ? $t('roadmap.card.provenanceAgent')
                      : $t('roadmap.card.provenanceHuman')
                  "
                />
              </div>

              <!-- Row 2: meta chips -->
              <div class="flex flex-wrap items-center gap-1.5 text-[11px] text-text-4">
                <span class="font-mono">{{ card.id }}</span>
                <span
                  v-if="card.blocked"
                  class="rounded-sm bg-red-soft px-1 py-px font-medium text-warning"
                >
                  {{ $t('roadmap.card.blocked') }}
                </span>
                <span v-if="card.deps.length" class="inline-flex items-center gap-0.5">
                  <GitBranch :size="10" :stroke-width="1.6" />{{ card.deps.length }}
                </span>
                <span v-if="card.evidence.length" class="text-text-3">
                  {{ $t('roadmap.card.evidence', { count: card.evidence.length }) }}
                </span>
                <!-- T105 schema v2 (T80 S2 PR2: colored per kindChipClass, B9) -->
                <span
                  v-if="card.kind"
                  class="rounded-sm border px-1 py-px"
                  :class="kindChipClass(card.kind)"
                  :title="$t('roadmap.card.kindHint')"
                >
                  {{ card.kind }}
                </span>
                <span v-if="card.complexity" :title="$t('roadmap.card.complexityHint')">
                  {{ card.complexity }}
                </span>
                <span
                  v-if="card.parent"
                  :title="$t('roadmap.card.parentHint', { slug: card.parent })"
                >
                  {{ $t('roadmap.card.parent', { slug: card.parent }) }}
                </span>
                <!-- T130 S3 (B10): per-artifact badges — ONLY what the tier/ADR declaration
                       requires; present = green ✓, required-missing = dashed warning. Not
                       rendered when not required (mockup-canonical). Same `artifactRequirements`
                       predicate the modal's Docs rows and footer readiness hint read. -->
                <span
                  v-for="req in artifactBadges(card)"
                  :key="req.key"
                  class="rounded-sm px-1 py-px font-mono"
                  :class="
                    req.present
                      ? 'bg-green-soft text-green'
                      : 'border border-dashed border-warning text-warning'
                  "
                  :title="artifactBadgeTitle(card, req)"
                >
                  {{ req.present ? `${req.key} ✓` : req.key }}
                </span>
                <!-- T130 S4 (B11): open-questions chip — unanswered count only (PRD OQ1),
                       the SAME predicate the modal's `{n} open` badge reads. Hidden at 0. -->
                <span
                  v-if="unansweredQuestionCount(card.body) > 0"
                  class="rounded-sm border border-accent-line bg-accent-soft px-1 py-px font-mono text-accent"
                  :title="
                    $t('roadmap.card.openQuestionsHint', {
                      count: unansweredQuestionCount(card.body)
                    })
                  "
                >
                  ? {{ unansweredQuestionCount(card.body) }}
                </span>
                <!-- T105 §3.3: readiness lint badge for NON-artifact gaps only (e.g. missing
                       AC) — artifact gaps now render as the per-key badges above, never both. -->
                <span
                  v-if="nonArtifactGaps(card).length"
                  class="rounded-sm bg-red-soft px-1 py-px font-medium text-warning"
                  :title="readinessTitle(card)"
                >
                  {{ nonArtifactGaps(card).length }}
                </span>
                <!-- T104: discreet "manifest ✓" badge — the card carries an operator go
                       (approved is written ONLY by the manifest flow, never a verb). -->
                <span
                  v-if="card.approved"
                  class="rounded-sm bg-green-soft px-1 py-px font-medium text-green"
                  :title="$t('roadmap.card.manifestApprovedHint')"
                >
                  {{ $t('roadmap.card.manifestApproved') }}
                </span>
                <!-- T80 S2 PR2 (B12): bound-session short-id chip — identity, not a button -->
                <span
                  v-if="card.session"
                  class="inline-flex items-center gap-0.5 rounded-sm border border-border-2 bg-surface-2 px-1 py-px font-mono text-green"
                  :title="$t('roadmap.card.sessionIdHint', { id: card.session })"
                >
                  <Terminal :size="10" :stroke-width="1.8" />{{ sessionShortId(card.session) }}
                </span>
                <!-- T190: the worktree chip — solid `executedIn`, dashed derived guess,
                       solid origin, precedence order, never more than one. -->
                <span
                  v-if="branchChipFor(card)"
                  class="inline-flex items-center gap-0.5 rounded-sm border bg-surface-2 px-1 py-px font-mono text-text-3"
                  :class="
                    branchChipFor(card)!.derived
                      ? 'border-dashed border-border-2'
                      : 'border-border-2'
                  "
                  :title="
                    branchChipFor(card)!.derived
                      ? $t('roadmap.card.branchDerivedHint', {
                          branch: branchChipFor(card)!.branch
                        })
                      : $t('roadmap.card.branchHint', { branch: branchChipFor(card)!.branch })
                  "
                >
                  <GitBranch :size="10" :stroke-width="1.6" />{{ branchChipFor(card)!.branch }}
                </span>
              </div>

              <!-- Row 3: actions -->
              <div class="flex items-center gap-1.5">
                <button
                  v-if="!card.session && (col === 'backlog' || col === 'ready')"
                  class="inline-flex items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent transition hover:brightness-110"
                  @click.stop="offerDispatch(card)"
                >
                  <Rocket :size="11" :stroke-width="1.7" />{{ $t('roadmap.card.dispatch') }}
                </button>
                <button
                  v-if="card.session"
                  class="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-text-3 transition hover:bg-surface-2 hover:text-text"
                  @click.stop="openSession(card)"
                >
                  {{ $t('roadmap.card.openSession') }}
                </button>
                <!-- Review suggestion (S3 §3.5): evidence says work landed → offer the
                       human-approved move to Review. Never auto-moves; never → Done. -->
                <button
                  v-if="reviewSuggestion(card)"
                  class="ml-auto inline-flex items-center gap-1 rounded-sm bg-green-soft px-1.5 py-0.5 text-[11px] font-medium text-green transition hover:brightness-110"
                  :title="$t('roadmap.card.suggestReviewHint')"
                  @click.stop="onMoveToReview(card)"
                >
                  <GitBranch :size="11" :stroke-width="1.7" />{{ reviewSuggestionLabel(card) }}
                </button>
                <button
                  v-if="col === 'review'"
                  class="ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-text-3 transition hover:bg-green-soft hover:text-green"
                  :title="$t('roadmap.card.closeHint')"
                  @click.stop="onClose(card)"
                >
                  {{ $t('roadmap.card.close') }}
                </button>
              </div>
            </article>
          </template>

          <p v-if="filteredColumns[col].length === 0" class="px-1 py-2 text-[11px] text-text-4">
            {{ $t('roadmap.columnEmpty') }}
          </p>
        </div>
      </section>
    </template>
  </div>

  <!-- Dispatch confirm (verbatim boot-prompt disclosure, §6.3) -->
  <Teleport to="body">
    <div
      v-if="dispatchConfirm"
      class="anim-overlay-fade fixed inset-0 z-[65] flex items-center justify-center bg-black/40"
      @click.self="cancelDispatch"
      @keydown.esc="cancelDispatch"
    >
      <div
        class="anim-fade-in-scale flex max-h-[80vh] w-[min(560px,92vw)] flex-col gap-3 rounded-lg border border-border bg-bg p-4 shadow-pop"
        role="dialog"
        aria-modal="true"
      >
        <div class="flex items-center gap-2">
          <component
            :is="dispatchConfirm.isGenerate ? Sparkles : Rocket"
            :size="15"
            :stroke-width="1.7"
            class="text-accent"
          />
          <h2 class="text-[14px] font-medium text-text">
            {{
              dispatchConfirm.isGenerate
                ? $t('roadmap.dispatch.generateTitle', { artifact: dispatchConfirm.artifact })
                : $t('roadmap.dispatch.title')
            }}
          </h2>
        </div>
        <p class="text-[12px] text-text-3">
          {{ $t('roadmap.dispatch.folder') }}:
          <span class="font-mono text-text-2">{{ roadmap.folderPath }}</span>
        </p>

        <!-- Why we're asking (§3.4). Agent-authored is the fail-closed red gate;
               a dead/exhausted grant escalates to this confirm (never silent). -->
        <p
          v-if="dispatchConfirm.reason === 'agent-provenance'"
          class="flex items-start gap-1.5 rounded-sm bg-red-soft px-2 py-1.5 text-[12px] text-warning"
        >
          <ShieldAlert :size="14" :stroke-width="1.7" class="mt-0.5 shrink-0" />
          <span>{{ $t('roadmap.dispatch.agentWarn') }}</span>
        </p>
        <p
          v-else-if="dispatchConfirm.reason !== 'no-grant'"
          class="flex items-start gap-1.5 rounded-sm bg-surface-2 px-2 py-1.5 text-[12px] text-text-3"
        >
          <ShieldAlert :size="14" :stroke-width="1.7" class="mt-0.5 shrink-0 text-warning" />
          <span>
            {{ $t(`roadmap.dispatch.reason.${dispatchConfirm.reason}`) }}
            <!-- T104: the "summarized diff" — which fingerprinted fields changed. -->
            <template
              v-if="
                dispatchConfirm.reason === 'manifest-stale' && dispatchConfirm.staleFields?.length
              "
            >
              {{
                $t('roadmap.dispatch.staleFields', {
                  fields: dispatchConfirm.staleFields
                    .map((f) => $t(`roadmap.dispatch.staleField.${f}`))
                    .join(', ')
                })
              }}
            </template>
          </span>
        </p>

        <!-- T97: the routing table's resolution (kind → table → hardcoded
               default), editable for this one dispatch only — the picked value is
               what actually launches AND what gets recorded on the card. -->
        <div class="flex flex-col gap-1.5">
          <span class="eyebrow text-text-4">{{ $t('roadmap.dispatch.routingLabel') }}</span>
          <div class="flex flex-wrap items-center gap-3">
            <SegmentedControl
              v-model="dispatchConfirm.routing.model"
              :options="MODEL_OPTIONS.map((m) => ({ value: m, label: m, mono: true }))"
              size="sm"
              :aria-label="$t('roadmap.dispatch.routingModel')"
            />
            <SegmentedControl
              v-model="dispatchConfirm.routing.effort"
              :options="EFFORT_OPTIONS.map((e) => ({ value: e, label: e, mono: true }))"
              size="sm"
              :aria-label="$t('roadmap.dispatch.routingEffort')"
            />
          </div>
        </div>

        <!-- T102: the resolved dispatch substrate (default `session`, or whatever
               is already on the card), editable for this one dispatch only — the
               picked value decides WHERE this launches and is recorded on the card. -->
        <div class="flex flex-col gap-1.5">
          <span class="eyebrow text-text-4">{{ $t('roadmap.dispatch.substrateLabel') }}</span>
          <SegmentedControl
            v-model="dispatchConfirm.substrate"
            :options="
              CARD_SUBSTRATES.map((s) => ({ value: s, label: $t(`roadmap.substrate.${s}`) }))
            "
            size="sm"
            :aria-label="$t('roadmap.dispatch.substrateLabel')"
          />
        </div>

        <div class="flex flex-col gap-1">
          <span class="eyebrow text-text-4">{{ $t('roadmap.dispatch.promptLabel') }}</span>
          <pre
            class="scrollable max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-text-2"
            >{{ dispatchConfirm.prompt }}</pre>
        </div>

        <p class="text-[11px] text-text-4">{{ $t('roadmap.dispatch.humanNote') }}</p>

        <div class="flex justify-end gap-2">
          <Button variant="ghost" @click="cancelDispatch">
            {{ $t('roadmap.dispatch.cancel') }}
          </Button>
          <Button variant="primary" :disabled="dispatching" @click="confirmDispatch">
            <Rocket :size="12" :stroke-width="1.8" />{{ $t('roadmap.dispatch.allow') }}
          </Button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- Card detail modal (read-only dossier, card-detail PRD §2-S1) -->
  <CardDetailModal
    v-if="detailCard"
    :card="detailCard"
    :local-branches="localBranches"
    @close="closeDetail"
    @navigate="navigateDetail"
    @open-session="openSession"
    @open-doc="openDetailDoc"
    @dispatch="onDetailDispatch"
    @generate="onDetailGenerate"
  />

  <!-- Create mode (T80 S2 PR3, M14/B8) -->
  <CardCreateModal v-if="creatingCard" @close="closeCreate" @created="onCardCreated" />

  <!-- T300/U3: header markup rendered into the shared TakeoverShell (design.md §6
       "TakeoverShell — shared chrome") via Teleport, since a dynamically swapped
       view can't fill a named slot of the ancestor wrapping it. Placed after the
       real body content (not first) so this stays a component whose first root
       node is a real element — Vue Test Utils resolves `wrapper.element` off the
       first root, and a Teleport placeholder there breaks every `find`/`get`. -->
  <Teleport to="#takeover-shell-icon" defer>
    <KanbanSquare :size="15" :stroke-width="1.7" class="shrink-0 text-accent" />
  </Teleport>
  <Teleport to="#takeover-shell-actions" defer>
    <span v-if="ui.roadmap.repoLabel" class="min-w-0 truncate text-[12px] text-text-3">
      · {{ ui.roadmap.repoLabel }}
    </span>
    <span class="flex-1" />
    <!-- Header counts (B7): non-done cards after filters · bound sessions working -->
    <span class="eyebrow text-text-4">
      {{ $t('roadmap.headerCounts', { cards: headerCardsCount, working: headerWorkingCount }) }}
    </span>
    <!-- WIP hint (In Progress vs the supervision ceiling, §3.5) -->
    <span
      class="rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums"
      :class="roadmap.inProgressCount > WIP_LIMIT ? 'bg-red-soft text-warning' : 'text-text-4'"
      :title="$t('roadmap.wipHint')"
    >
      {{ $t('roadmap.wip', { count: roadmap.inProgressCount, limit: WIP_LIMIT }) }}
    </span>
  </Teleport>
</template>
