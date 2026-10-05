/**
 * Roadmap board chrome (T80 S2 PR2) — the PURE logic behind the filter bar,
 * group-by, and per-repo filter persistence. Renderer-local, no IPC: mirrors
 * `roadmap-core.CARD_KINDS`'s order rather than cross-importing main (see
 * `card-detail.ts` for the same convention).
 */

/** The card fields the filter/group/chip helpers need — a structural subset of
 *  `RoadmapCard`, kept local so this module never cross-imports the main process. */
export interface FilterableCard {
  id: string
  slug: string
  title: string
  column: string
  kind?: string
  parent?: string
  /** T190: origin branch (`provenance.branch`) — "who raised this", immutable. */
  originBranch?: string
  /** T190: owner branch (`executedIn`) — "where is this being worked", mutable. */
  executedIn?: string
}

/** Kind chips, in the mockup/spec order (not `CARD_KINDS`'s own order). */
export const KIND_FILTERS = ['bug', 'feature', 'chore', 'scout', 'review'] as const
export type KindFilter = (typeof KIND_FILTERS)[number]

export type GroupMode = 'epic' | 'kind' | 'none'
const GROUP_MODES: readonly GroupMode[] = ['epic', 'kind', 'none']

export function isGroupMode(v: unknown): v is GroupMode {
  return typeof v === 'string' && (GROUP_MODES as readonly string[]).includes(v)
}

/** The three persisted preferences (E9) — search is deliberately excluded (ephemeral). */
export interface RoadmapFilterState {
  kinds: string[]
  group: GroupMode
  hideDone: boolean
}

export const DEFAULT_FILTER_STATE: RoadmapFilterState = {
  kinds: [...KIND_FILTERS],
  group: 'epic',
  hideDone: true
}

// ---- Search ------------------------------------------------------------------

function normalizeSearch(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase()
}

/** Case-insensitive substring match against a card's id + title (mockup's `data-search`). */
export function matchesSearch(card: Pick<FilterableCard, 'id' | 'title'>, query: string): boolean {
  const q = normalizeSearch(query)
  if (!q) return true
  return card.id.toLowerCase().includes(q) || card.title.toLowerCase().includes(q)
}

// ---- Kind filter ---------------------------------------------------------------

/**
 * Mirrors the mockup's own filter semantics: zero active chips means "no
 * filter" (everything passes), not "hide everything" — and a card with no
 * `kind` at all always passes (a filter can't hide what it can't classify).
 */
export function matchesKindFilter(
  kind: string | undefined,
  activeKinds: ReadonlySet<string>
): boolean {
  if (activeKinds.size === 0) return true
  if (!kind) return true
  return activeKinds.has(kind)
}

// ---- Worktree scope (T190) -----------------------------------------------------

/**
 * The board's ephemeral worktree filter (D6 — never persisted, lives in
 * `RoadmapBoard.vue` component state, resets on every open). `branch: null`
 * means "everything" — the escape hatch a preset auto-scope (D2) always leaves
 * one click away.
 */
export interface WorktreeScope {
  /** Short branch name to scope to, or null for "everything". */
  branch: string | null
}

/**
 * Union match (D3): a card matches a non-null scope when it was born on
 * `branch` (origin) OR is/was executed on it (owner) — either fact alone is
 * enough. A card with neither fact recorded never matches a real scope, and a
 * null scope always matches everything. Case-sensitive, same as git itself.
 */
export function matchesWorktreeScope(
  card: Pick<FilterableCard, 'originBranch' | 'executedIn'>,
  scope: WorktreeScope
): boolean {
  if (scope.branch === null) return true
  return card.originBranch === scope.branch || card.executedIn === scope.branch
}

/**
 * Runtime-only derivation (D4 fallback, §1) for a card with no `executedIn`:
 * match its id against the repo's local branch names, the SAME plain substring
 * rule `create_worktree`'s `existingWork` check uses
 * (`worktree-core.findExistingWorkForSlug` — `.includes(id)`, no normalization).
 * Exactly one match wins; zero OR more than one match returns `undefined` —
 * never guess between candidates, and never persisted (the caller re-derives
 * this on every render).
 */
export function deriveExecutedBranch(
  cardId: string,
  localBranches: readonly string[]
): string | undefined {
  if (!cardId) return undefined
  const matches = localBranches.filter((b) => b.includes(cardId))
  return matches.length === 1 ? matches[0] : undefined
}

// ---- Combined filter -----------------------------------------------------------

export interface FilterOpts {
  search?: string
  kinds: ReadonlySet<string>
  /** T190: omitted (or `{ branch: null }`) behaves exactly like no scope at all. */
  scope?: WorktreeScope
}

/** Stable filter (preserves input order — the caller has already sorted). */
export function filterCards<T extends FilterableCard>(cards: readonly T[], opts: FilterOpts): T[] {
  return cards.filter(
    (c) =>
      matchesSearch(c, opts.search ?? '') &&
      matchesKindFilter(c.kind, opts.kinds) &&
      matchesWorktreeScope(c, opts.scope ?? { branch: null })
  )
}

// ---- Group-by --------------------------------------------------------------------

export interface CardGroup<T> {
  /** Stable key for `v-for` — the parent ref, kind, or a sentinel for the unlabeled bucket. */
  key: string
  /** null = the trailing unlabeled bucket (no group-head rendered). */
  label: string | null
  count: number
  cards: T[]
}

const UNLABELED = '__unlabeled__'

function bucketBy<T extends FilterableCard>(
  cards: readonly T[],
  keyOf: (c: T) => string
): { order: string[]; buckets: Map<string, T[]> } {
  const order: string[] = []
  const buckets = new Map<string, T[]>()
  for (const c of cards) {
    const key = keyOf(c)
    if (!buckets.has(key)) {
      buckets.set(key, [])
      order.push(key)
    }
    buckets.get(key)!.push(c)
  }
  return { order, buckets }
}

/** Resolve a `parent` ref to `"{id} · {title}"`, falling back to the raw ref off-board. */
function epicLabel<T extends FilterableCard>(
  parentRef: string,
  cardsById: ReadonlyMap<string, T>
): string {
  const parent = cardsById.get(parentRef)
  if (!parent) return parentRef
  return parent.title ? `${parent.id} · ${parent.title}` : parent.id
}

/**
 * Bucket `cards` per `mode`, preserving each card's incoming order within its
 * bucket. The unlabeled/no-parent/no-kind bucket (`label: null`) always sorts
 * LAST, regardless of where it would land by first appearance.
 */
export function groupCards<T extends FilterableCard>(
  cards: readonly T[],
  mode: GroupMode,
  cardsById: ReadonlyMap<string, T>
): CardGroup<T>[] {
  if (mode === 'none') {
    if (cards.length === 0) return []
    return [{ key: '__all__', label: null, count: cards.length, cards: [...cards] }]
  }

  const keyOf =
    mode === 'kind'
      ? (c: T): string => c.kind ?? UNLABELED
      : (c: T): string => c.parent ?? UNLABELED
  const { order, buckets } = bucketBy(cards, keyOf)

  const labeled = order.filter((k) => k !== UNLABELED)
  const groups: CardGroup<T>[] = labeled.map((key) => ({
    key,
    label: mode === 'kind' ? key : epicLabel(key, cardsById),
    count: buckets.get(key)!.length,
    cards: buckets.get(key)!
  }))
  if (buckets.has(UNLABELED)) {
    const unlabeled = buckets.get(UNLABELED)!
    groups.push({ key: UNLABELED, label: null, count: unlabeled.length, cards: unlabeled })
  }
  return groups
}

// ---- Compact-card chip tokens ----------------------------------------------------

/** Kind chip tokens — mirrors `CardDetailModal.vue`'s `kindChipClass` (B9: they can never disagree). */
export function kindChipClass(kind: string | undefined): string {
  if (kind === 'bug') return 'border-transparent bg-red-soft text-red'
  if (kind === 'feature') return 'border-accent-line bg-accent-soft text-accent'
  return 'border-border-2 bg-surface-2 text-text-3'
}

/** The bound-session chip's id text (B12) — first 7 chars, mono. */
export function sessionShortId(sessionId: string): string {
  return sessionId.slice(0, 7)
}

// ---- Per-repo persistence (E9) ----------------------------------------------------

export function filterStorageKey(repoKey: string): string {
  return `om2tab.roadmap.filters.${repoKey}`
}

export function serializeFilters(state: RoadmapFilterState): string {
  return JSON.stringify(state)
}

/** Parse + validate a persisted filter state; any shape mismatch or corrupt JSON → null (caller falls back to the default). */
export function parsePersistedFilters(raw: string | null): RoadmapFilterState | null {
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const kinds = obj.kinds
  const group = obj.group
  const hideDone = obj.hideDone
  if (!Array.isArray(kinds) || !kinds.every((k) => typeof k === 'string')) return null
  if (!isGroupMode(group)) return null
  if (typeof hideDone !== 'boolean') return null
  return { kinds: kinds as string[], group, hideDone }
}
