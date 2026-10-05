import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  RoadmapCard,
  ColumnKey,
  CardStatus,
  RoadmapWriteCode,
  GeneratorPromptLabels
} from '../../../preload'

/**
 * Roadmap Kanban store (T80 S1). The renderer projection of a repo's
 * `.harnu/memory/roadmap/` cards into columns. The `.md` files are the single
 * source of truth (T80 §3.1): this store RENDERS the watcher stream and every
 * mutation goes back through the serialized, human `roadmap:*` IPC — the store
 * never writes a file, and there is no path here (or anywhere in the renderer)
 * for an agent to change a card's `status`. That is the mechanical form of the
 * §0 invariant "an agent never moves a card".
 *
 * Cards arrive already parsed + column-derived by the pure `roadmap-core.ts` in
 * main (which normalizes status + fails provenance closed to `agent`). The store
 * only reconciles the flat card set by slug and buckets it into columns — the
 * column order + in-column sort mirror `roadmap-core` (kept renderer-local per the
 * codebase's "mirror the wire shape, don't cross-import main" convention).
 */

/** The five canonical columns, in board order. Mirror of `roadmap-core.COLUMN_ORDER`. */
export const COLUMN_ORDER: readonly ColumnKey[] = [
  'backlog',
  'ready',
  'in-progress',
  'review',
  'done'
]

/** Priority token → sortable rank (lower = higher priority). Mirror of the core. */
function priorityRank(priority: string | undefined): number {
  if (!priority) return Number.POSITIVE_INFINITY
  const named: Record<string, number> = { high: 1, medium: 2, med: 2, normal: 2, low: 3 }
  const t = priority.trim().toLowerCase()
  if (t in named) return named[t]
  const n = Number.parseFloat(t)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

/** Stable in-column order: priority rank, then id. Mirror of `roadmap-core.compareCards`. */
function compareCards(a: RoadmapCard, b: RoadmapCard): number {
  const pr = priorityRank(a.priority) - priorityRank(b.priority)
  return pr !== 0 ? pr : a.id.localeCompare(b.id)
}

// ---- Artifact model (T130 S3) — mirror of `roadmap-core`'s ONE requirement matrix.

/** The three artifacts the requirement matrix tracks — fixed render order. Mirror of `roadmap-core.ARTIFACT_KEYS`. */
export const ARTIFACT_KEYS = ['spec', 'prd', 'adr'] as const
export type ArtifactKey = (typeof ARTIFACT_KEYS)[number]

/** One artifact's required/present verdict for a card. Mirror of `roadmap-core.ArtifactRequirement`. */
export interface ArtifactRequirement {
  key: ArtifactKey
  required: boolean
  present: boolean
}

const ARCHITECTURAL_DECISION_HEADING_RE = /^##\s+Architectural decision\b/im

/**
 * Whether a card declares an architectural decision (design.md §6) — mirror of
 * `roadmap-core.declaresArchitecturalDecision`.
 */
export function declaresArchitecturalDecision(card: Pick<RoadmapCard, 'body' | 'adr'>): boolean {
  return Boolean(card.adr) || ARCHITECTURAL_DECISION_HEADING_RE.test(card.body ?? '')
}

/**
 * The ONE requirement matrix (T130 S3) — mirror of `roadmap-core.artifactRequirements`
 * (renderer-local per the module's mirroring convention; kept byte-identical in
 * behavior so the board badges, the modal Docs rows, and `lintCardReadiness`
 * below — all renderer-side — can never disagree with each other or with main).
 */
export function artifactRequirements(
  card: Pick<RoadmapCard, 'complexity' | 'body' | 'spec' | 'prd' | 'adr'>
): ArtifactRequirement[] {
  const requiresSpec = card.complexity === 'standard' || card.complexity === 'complex'
  const requiresPrd = card.complexity === 'complex'
  const requiresAdr = declaresArchitecturalDecision(card)
  return [
    { key: 'spec', required: requiresSpec, present: Boolean(card.spec) },
    { key: 'prd', required: requiresPrd, present: Boolean(card.prd) },
    { key: 'adr', required: requiresAdr, present: Boolean(card.adr) }
  ]
}

/** One non-blocking readiness gap code (T105 §3.3). Mirror of `roadmap-core.lintCardReadiness`. */
export interface ReadinessGap {
  code: string
}

const ACCEPTANCE_HEADING_RE = /^##\s+Acceptance criteria\b/im

/**
 * Pure, non-blocking readiness lint (T105 §3.3, extended T130 S3) — mirror of
 * `roadmap-core.lintCardReadiness` (renderer-local per the module's mirroring
 * convention). Drives the board's readiness badge; NEVER refuses a write.
 */
export function lintCardReadiness(
  card: Pick<RoadmapCard, 'complexity' | 'body' | 'spec' | 'prd' | 'adr'>
): ReadinessGap[] {
  const gaps: ReadinessGap[] = []
  const body = card.body ?? ''
  if (card.complexity === 'standard' || card.complexity === 'complex') {
    if (!ACCEPTANCE_HEADING_RE.test(body)) gaps.push({ code: 'missing-acceptance-criteria' })
  }
  for (const req of artifactRequirements(card)) {
    if (req.required && !req.present) gaps.push({ code: `missing-${req.key}` })
  }
  return gaps
}

/** The minimal shape the manifest-drain helpers need. Mirror of `roadmap-core.ManifestDrainCard`. */
export interface ManifestDrainCard {
  slug: string
  approved?: string
}

/**
 * Recover a manifest's declared order from the staggered `approved`
 * timestamps the go wrote (T104 §2.5). Mirror of `roadmap-core.sortManifestQueue`
 * (renderer-local per the module's mirroring convention).
 */
export function sortManifestQueue<T extends ManifestDrainCard>(cards: readonly T[]): T[] {
  return [...cards].sort((a, b) => {
    const aa = a.approved ?? ''
    const bb = b.approved ?? ''
    return aa < bb ? -1 : aa > bb ? 1 : 0
  })
}

/**
 * The single-step decision the drain loop repeats (T104 §2.5) — mirror of
 * `roadmap-core.nextManifestDrainTarget`. Pure: `wipHasRoom` must be
 * re-evaluated by the caller before every call (it isn't static — a
 * dispatch changes it, and a confirm-needed card must not consume a slot).
 */
export function nextManifestDrainTarget(
  queue: readonly ManifestDrainCard[],
  skipped: ReadonlySet<string>,
  wipHasRoom: boolean
): string | null {
  if (!wipHasRoom) return null
  const next = queue.find((c) => !skipped.has(c.slug))
  return next ? next.slug : null
}

export type ColumnMap = Record<ColumnKey, RoadmapCard[]>

function emptyColumns(): ColumnMap {
  return { backlog: [], ready: [], 'in-progress': [], review: [], done: [] }
}

export const useRoadmapStore = defineStore('roadmap', () => {
  /** Flat card set for the currently-open board (reconciled by slug). */
  const cards = ref<RoadmapCard[]>([])
  /** The repo memory dir the open board belongs to (guards stale watcher events). */
  const repoKey = ref<string | null>(null)
  /** The folder the board was opened for (the IPC anchor for writes/dispatch). */
  const folderPath = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  let subscribed = false

  /** Cards bucketed into the five columns, each sorted (the board's projection). */
  const columns = computed<ColumnMap>(() => {
    const cols = emptyColumns()
    for (const card of cards.value) cols[card.column].push(card)
    for (const key of COLUMN_ORDER) cols[key].sort(compareCards)
    return cols
  })

  /** Count of cards currently in the In Progress column (for the WIP hint, §3.5). */
  const inProgressCount = computed(() => columns.value['in-progress'].length)

  /** Reconcile a single card add/change (ignore events from a since-closed board). */
  function upsertCard(eventRepoKey: string, card: RoadmapCard): void {
    if (repoKey.value !== null && eventRepoKey !== repoKey.value) return
    const idx = cards.value.findIndex((c) => c.slug === card.slug)
    if (idx === -1) cards.value.push(card)
    else cards.value.splice(idx, 1, card)
  }

  function removeCard(eventRepoKey: string, slug: string): void {
    if (repoKey.value !== null && eventRepoKey !== repoKey.value) return
    cards.value = cards.value.filter((c) => c.slug !== slug)
  }

  /** Subscribe once to the watcher stream (guarded for an older preload). */
  function ensureSubscribed(): void {
    if (subscribed) return
    if (typeof window.api.onRoadmapCardAdded !== 'function') return
    subscribed = true
    window.api.onRoadmapCardAdded(({ repoKey: k, card }) => upsertCard(k, card))
    window.api.onRoadmapCardChanged(({ repoKey: k, card }) => upsertCard(k, card))
    window.api.onRoadmapCardRemoved(({ repoKey: k, slug }) => removeCard(k, slug))
  }

  /** Open (or re-open) the board for a folder: load the scan + arm live updates. */
  async function open(path: string): Promise<void> {
    ensureSubscribed()
    folderPath.value = path
    loading.value = true
    error.value = null
    // Drop the previous board's cards so a slow load doesn't show stale columns.
    cards.value = []
    repoKey.value = null
    try {
      const res = await window.api.roadmapLoad(path)
      repoKey.value = res.repoKey
      cards.value = res.cards
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      cards.value = []
    } finally {
      loading.value = false
    }
  }

  function findCard(slug: string): RoadmapCard | undefined {
    return cards.value.find((c) => c.slug === slug)
  }

  /**
   * Move a card to a new column. Optimistically updates the local card so the drop
   * feels instant, then writes via the human `roadmap:setStatus` IPC; the watcher
   * re-emits the authoritative card. On write failure we revert by reloading.
   */
  async function setStatus(
    slug: string,
    status: CardStatus
  ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const card = findCard(slug)
    const prev = card?.status
    if (card) {
      card.status = status
      card.column = status
    }
    const res = await window.api.roadmapSetStatus({ folder: path, slug, status })
    if (!res.ok) {
      // Revert the optimistic move — reload the authoritative disk state.
      if (card && prev) {
        card.status = prev
        card.column = prev
      }
      void open(path)
    }
    return res
  }

  /** Request the server-side boot prompt (authoritative + linted + capped, §6.4). */
  function bootPrompt(
    slug: string,
    labels: import('../../../preload').BootPromptLabels
  ): ReturnType<typeof window.api.roadmapBootPrompt> {
    return window.api.roadmapBootPrompt({ folder: folderPath.value ?? '', slug, labels })
  }

  /**
   * Plan a dispatch (T80 S2): main decides auto-under-grant vs human confirm and,
   * on the auto path, RESERVES one grant budget unit before returning. The board
   * spawns + binds on `auto`; on spawn failure it must `releaseDispatch(grantId)`.
   */
  function planDispatch(
    slug: string,
    labels: import('../../../preload').BootPromptLabels
  ): ReturnType<typeof window.api.roadmapPlanDispatch> {
    return window.api.roadmapPlanDispatch({ folder: folderPath.value ?? '', slug, labels })
  }

  /** Refund a grant unit reserved by `planDispatch` when the spawn failed (§3.4). */
  function releaseDispatch(grantId: string): Promise<{ ok: true }> {
    return window.api.roadmapReleaseDispatch(grantId)
  }

  /** The id of a live grant covering auto-dispatch for the open board (or null). */
  function grantStatus(): Promise<{ grantId: string | null }> {
    return window.api.roadmapGrantStatus(folderPath.value ?? '')
  }

  /** Merge-evidence (commits ahead of origin/main + refs) for a card's branch (S3). */
  function mergeEvidence(branch: string): ReturnType<typeof window.api.roadmapMergeEvidence> {
    return window.api.roadmapMergeEvidence({ folder: folderPath.value ?? '', branch })
  }

  /** Human-approved move of a bound In Progress card → Review with evidence (S3). */
  function moveToReview(
    slug: string,
    evidence: string[]
  ): ReturnType<typeof window.api.roadmapMoveToReview> {
    return window.api.roadmapMoveToReview({ folder: folderPath.value ?? '', slug, evidence })
  }

  /**
   * Human Close (Review → Done, T103): writes `status: done` and fires the
   * mechanical memory append (`roadmap:closeCard`) — never a raw `setStatus`,
   * so Close always carries its close-trigger side effects. Optimistic column
   * update mirrors `setStatus`; a failure reverts by reloading.
   */
  async function closeCard(
    slug: string
  ): Promise<{ ok: true; epic: boolean } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const card = findCard(slug)
    const prev = card?.status
    if (card) {
      card.status = 'done'
      card.column = 'done'
    }
    const res = await window.api.roadmapCloseCard({ folder: path, slug })
    if (!res.ok) {
      if (card && prev) {
        card.status = prev
        card.column = prev
      }
      void open(path)
    }
    return res
  }

  /**
   * Bind a dispatched session id to a card (writes `session:` + in-progress).
   * `dispatchedWith` (T97, "model·effort") is appended as an audit line on the
   * card body when present — the record of which model/effort actually launched.
   * `substrate` (T102) is written onto the card as the RESOLVED substrate this
   * dispatch actually ran on (post any per-card operator override). `executedIn`
   * (T190) is the SPAWN folder's short branch name — the card's durable OWNER,
   * distinct from `folderPath` above (which is the card's own home folder, used
   * only for the write location) — stamped in the same call, never cleared later.
   */
  function bindSession(
    slug: string,
    sessionId: string,
    dispatchedWith?: string,
    substrate?: string,
    executedIn?: string
  ): ReturnType<typeof window.api.roadmapBindSession> {
    return window.api.roadmapBindSession({
      folder: folderPath.value ?? '',
      slug,
      sessionId,
      ...(dispatchedWith ? { dispatchedWith } : {}),
      ...(substrate ? { substrate } : {}),
      ...(executedIn ? { executedIn } : {})
    })
  }

  /**
   * S2 (card-detail edit engine): full-replace a card's body through the
   * serialized `roadmap:replaceBody` IPC (frontmatter untouched). Optimistic
   * update mirrors `setStatus`/`closeCard`: the local body flips immediately so
   * both the edit-mode Save and the live AC-checkbox toggle feel instant; a
   * failure reverts by reloading. `stampVoided` (ACK-only, never re-derived
   * here) is threaded straight back to the caller — the modal decides whether
   * to show the "manifest ✓ was invalidated" toast.
   */
  async function replaceBody(
    slug: string,
    body: string
  ): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const card = findCard(slug)
    const prev = card?.body
    if (card) card.body = body
    const res = await window.api.roadmapReplaceBody({ folder: path, slug, body })
    if (!res.ok) {
      if (card && prev !== undefined) card.body = prev
      void open(path)
    }
    return res
  }

  /**
   * T130 S4 (E7): append a provenance-stamped entry to a card's body through
   * the serialized `roadmap:appendBody` IPC — the human counterpart to the
   * agent's `update_card.appendBody`. Optimistic update mirrors `replaceBody`:
   * the local body gets the SAME `entry\n\n> provenance: …` shape
   * `appendMemoryEntry` writes server-side (today's date, `author: human`), so
   * the Open-questions "Send" flip (answered block appears, badge drops) feels
   * instant; a failure reverts by reloading.
   */
  async function appendBody(
    slug: string,
    entry: string
  ): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const card = findCard(slug)
    const prev = card?.body
    if (card) {
      const trimmed = card.body.replace(/\s+$/, '')
      const spacer = trimmed.length > 0 ? '\n\n' : ''
      const today = new Date().toISOString().slice(0, 10)
      card.body = `${trimmed}${spacer}${entry.trim()}\n\n> provenance: author=human · at=${today}\n`
    }
    const res = await window.api.roadmapAppendBody({ folder: path, slug, entry })
    if (!res.ok) {
      if (card && prev !== undefined) card.body = prev
      void open(path)
    }
    return res
  }

  /**
   * T130 S4 (M8-Generate, E8): plan a Generate dispatch — the SAME
   * auto-vs-confirm gate `planDispatch` uses (§3.4/T104 §2.4), but for the
   * 3-tier GENERATOR prompt of one artifact instead of the card's own boot
   * prompt. The board spawns (never binds — Generate is a side-task, not a
   * dispatch of the card itself); on spawn failure it must
   * `releaseDispatch(grantId)`, exactly like a normal auto-dispatch.
   */
  function planGenerate(
    slug: string,
    artifact: import('../../../preload').ArtifactKey,
    labels: GeneratorPromptLabels
  ): ReturnType<typeof window.api.roadmapPlanGenerate> {
    return window.api.roadmapPlanGenerate({
      folder: folderPath.value ?? '',
      slug,
      artifact,
      labels
    })
  }

  /**
   * S2: the title inline-edit affordance — writes `title` through the
   * serialized frontmatter writer. Optimistic update mirrors `replaceBody`.
   */
  async function setTitle(
    slug: string,
    title: string
  ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const card = findCard(slug)
    const prev = card?.title
    if (card) card.title = title
    const res = await window.api.roadmapSetTitle({ folder: path, slug, title })
    if (!res.ok) {
      if (card && prev !== undefined) card.title = prev
      void open(path)
    }
    return res
  }

  /**
   * T80 S2 PR3 (M14/B8/E5): the board's `+ New card` — reuses the SAME id-mint/
   * slug/template engine the agent's `create_card` uses, human-stamped. The
   * card is ALWAYS born Backlog (never an input here). On success the fresh
   * card is upserted into the local set immediately (mirrors `setStatus`'s
   * optimism) so the caller can open its detail modal without waiting on the
   * watcher's own `card:added` event.
   */
  async function createCard(input: {
    title: string
    kind: string
    complexity: string
    body: string
  }): Promise<{ ok: true; slug: string } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const res = await window.api.roadmapCreateCard({ folder: path, ...input })
    if (!res.ok) return res
    upsertCard(repoKey.value ?? '', res.card)
    return { ok: true, slug: res.slug }
  }

  /**
   * T148: archive a card — moves it out of the active board into
   * `roadmap-archive/`. Optimistically drops it from the local set on success
   * (mirrors `createCard`'s immediate upsert); the watcher's own `unlink`
   * event reconciles independently, so this is purely for perceived speed.
   */
  async function archiveCard(
    slug: string
  ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const res = await window.api.roadmapArchiveCard({ folder: path, slug })
    // Only reconcile the local set if the board still shows the folder this
    // archive was issued for — the user may have navigated away mid-flight.
    if (res.ok && folderPath.value === path) {
      cards.value = cards.value.filter((c) => c.slug !== slug)
    }
    return res
  }

  /**
   * Undo for {@link archiveCard} — restores the card and upserts it back in.
   * `folderOverride` lets the caller pin the restore to the folder the card was
   * archived FROM (captured before the archive), so an Undo clicked after the
   * board navigated elsewhere still targets the right board instead of
   * re-resolving against whatever is open now. The local upsert uses the repo
   * key captured at call-start and only runs if that folder is still the open
   * one — a restore into a since-closed board never mutates the current set.
   */
  async function restoreCard(
    slug: string,
    folderOverride?: string
  ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderOverride ?? folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const originRepoKey = repoKey.value
    const res = await window.api.roadmapRestoreCard({ folder: path, slug })
    if (!res.ok) return res
    if (folderPath.value === path) upsertCard(originRepoKey ?? '', res.card)
    return { ok: true }
  }

  /**
   * T148: permanently delete a card. Irreversible — the modal confirms with
   * the operator before calling this. Optimistic removal, same as `archiveCard`.
   */
  async function deleteCard(
    slug: string
  ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
    const path = folderPath.value
    if (!path) return { ok: false, code: 'bad-args' }
    const res = await window.api.roadmapDeleteCard({ folder: path, slug })
    // Same stale-board guard as `archiveCard`: don't drop a card from a board
    // the user has since navigated away from.
    if (res.ok && folderPath.value === path) {
      cards.value = cards.value.filter((c) => c.slug !== slug)
    }
    return res
  }

  /** The per-kind delegation-packet templates (T105 §3) — seeds the create-mode textarea. */
  function cardTemplates(): Promise<Record<string, string>> {
    return window.api.roadmapCardTemplates()
  }

  /**
   * T130 S3 (E6): convention-scan for a card's prd/adr — a display-only hint
   * the modal's Docs row shows for a required-and-missing artifact; never
   * durable (only the explicit `prd:`/`adr:` field is).
   */
  function scanArtifacts(id: string): Promise<{ prd: string | null; adr: string | null }> {
    const path = folderPath.value
    if (!path) return Promise.resolve({ prd: null, adr: null })
    return window.api.roadmapScanArtifacts({ folder: path, id })
  }

  /**
   * Resolve the routing table's model+effort for a card kind (T97): reads the
   * folder's stored table (human-owned, `routing-policy.json`) merged with the
   * hardcoded per-kind defaults. Called at dispatch time on BOTH paths (manual
   * confirm and the manifest drain) so the resolution is identical either way.
   */
  function resolveRouting(
    kind: string | undefined
  ): ReturnType<typeof window.api.routingPolicyResolve> {
    return window.api.routingPolicyResolve({ folder: folderPath.value ?? '', kind })
  }

  return {
    cards,
    repoKey,
    folderPath,
    loading,
    error,
    columns,
    inProgressCount,
    open,
    findCard,
    setStatus,
    bootPrompt,
    planDispatch,
    releaseDispatch,
    grantStatus,
    mergeEvidence,
    moveToReview,
    closeCard,
    bindSession,
    replaceBody,
    appendBody,
    planGenerate,
    setTitle,
    archiveCard,
    restoreCard,
    deleteCard,
    createCard,
    cardTemplates,
    scanArtifacts,
    resolveRouting
  }
})
