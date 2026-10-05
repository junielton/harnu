/**
 * T387 — the PR Stack Canvas filter: a pure query parser, a pure matcher and the
 * Hide-mode layout. Kept out of the SFCs so the whole grammar is unit-testable
 * (the repo's `*-format.ts` convention).
 *
 * Contract: `docs/specs/2026-10-01-pr-stack-filters/feature-spec.md`.
 *
 * The query STRING is the one source of truth. A facet checkbox is just a view
 * of "is this `key:value` token in the string", so checking a box and typing the
 * token can never disagree ({@link hasToken} / {@link toggleToken}).
 */
import {
  CARD_WIDTH,
  layoutGraph,
  type Edge,
  type PrEntry,
  type PrGraph,
  type PrNode
} from '../../../main/pr-stack-core'
import { prStatusInput } from './pr-stack-format'

// ── Grammar ───────────────────────────────────────────────────────────────

export const QUALIFIER_KEYS = [
  'is',
  'author',
  'review',
  'review-requested',
  'ci',
  'threads',
  'label',
  'base',
  'chain'
] as const

export type QualifierKey = (typeof QUALIFIER_KEYS)[number]

/** Closed value sets. Keys not listed here take a free value (a login, a label…). */
export const QUALIFIER_VALUES: Partial<Record<QualifierKey, readonly string[]>> = {
  is: ['tip', 'merge-next', 'blocked', 'stale', 'draft'],
  review: ['approved', 'changes', 'required', 'none'],
  ci: ['passing', 'failing', 'pending'],
  threads: ['unresolved', 'none']
}

/** The three header KPIs that double as one-click presets. */
export const KPI_PRESETS = {
  ready: 'is:merge-next',
  threads: 'threads:unresolved',
  retarget: 'is:stale'
} as const

export type KpiPreset = keyof typeof KPI_PRESETS

/**
 * - `ok` — a term the matcher understands.
 * - `unknown` — an unknown key or an unknown value for a closed key. It is KEPT
 *   (and drawn in the warning tone) rather than ignored, so a typo is visible.
 * - `pending` — a term still being typed (`is:`, `-`). Ignored by the matcher.
 */
export type TermStatus = 'ok' | 'unknown' | 'pending'

export interface QueryTerm {
  /** The term as typed, quotes included — what a chip shows. */
  raw: string
  negated: boolean
  /** `null` for free text. An unrecognised key is also `null` + `unknownKey`. */
  key: QualifierKey | null
  /** Set only for a `key:value` term whose key is not in the grammar. */
  unknownKey: string | null
  value: string
  status: TermStatus
}

export interface ParsedQuery {
  terms: QueryTerm[]
}

const QUALIFIER_RE = /^([A-Za-z][A-Za-z-]*):([\s\S]*)$/

/** Whitespace-separated, except inside double quotes (`label:"good first issue"`). */
function splitTerms(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (const ch of input) {
    if (ch === '"') {
      inQuote = !inQuote
      cur += ch
    } else if (!inQuote && /\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

function unquote(v: string): string {
  const s = v.startsWith('"') ? v.slice(1) : v
  return s.endsWith('"') ? s.slice(0, -1) : s
}

function isKey(k: string): k is QualifierKey {
  return (QUALIFIER_KEYS as readonly string[]).includes(k)
}

function parseTerm(raw: string): QueryTerm {
  const negated = raw.startsWith('-')
  const body = negated ? raw.slice(1) : raw
  const m = QUALIFIER_RE.exec(body)
  if (!m) {
    const value = unquote(body)
    return {
      raw,
      negated,
      key: null,
      unknownKey: null,
      value,
      status: value === '' ? 'pending' : 'ok'
    }
  }
  const keyText = m[1].toLowerCase()
  const value = unquote(m[2])
  if (!isKey(keyText)) {
    return { raw, negated, key: null, unknownKey: keyText, value, status: 'unknown' }
  }
  if (value === '')
    return { raw, negated, key: keyText, unknownKey: null, value, status: 'pending' }
  const closed = QUALIFIER_VALUES[keyText]
  const valid = closed
    ? closed.includes(value.toLowerCase())
    : keyText === 'chain'
      ? /^#?\d+$/.test(value)
      : true
  return { raw, negated, key: keyText, unknownKey: null, value, status: valid ? 'ok' : 'unknown' }
}

export function parseQuery(input: string): ParsedQuery {
  return { terms: splitTerms(input).map(parseTerm) }
}

/** A query filters only once it holds a term that is not still being typed. */
export function isFilterActive(query: ParsedQuery): boolean {
  return query.terms.some((t) => t.status !== 'pending')
}

/** Whitespace-collapsed, lowercased — for "is this exactly that preset". */
export function normalizeQuery(input: string): string {
  return splitTerms(input)
    .map((t) => t.toLowerCase())
    .join(' ')
}

export function presetActive(query: string, preset: KpiPreset): boolean {
  return normalizeQuery(query) === KPI_PRESETS[preset]
}

// ── Matching ──────────────────────────────────────────────────────────────

export interface FilterContext {
  /** PR number → index of the connected chain it belongs to. */
  chainOf: Map<number, number>
}

export function buildFilterContext(nodes: readonly PrNode[]): FilterContext {
  return { chainOf: new Map(nodes.map((n) => [n.pr.number, n.chain])) }
}

/**
 * The canvas's own `blocked` signal (`PrStackCard.vue`): failing CI, or GitHub
 * saying the PR cannot merge (`DIRTY` counts as that, via `prStatusInput`).
 */
function isBlocked(pr: PrEntry): boolean {
  return pr.ci === 'failing' || prStatusInput(pr, false).mergeable === false
}

const REVIEW_DECISION: Record<string, string | null> = {
  approved: 'APPROVED',
  changes: 'CHANGES_REQUESTED',
  required: 'REVIEW_REQUIRED',
  none: null
}

const stripAt = (v: string): string => (v.startsWith('@') ? v.slice(1) : v)

/** Whether ONE well-formed term holds for a node, ignoring negation. */
function holds(node: PrNode, term: QueryTerm, ctx: FilterContext): boolean {
  if (term.status !== 'ok') return false
  const { pr } = node
  const v = term.value.toLowerCase()
  switch (term.key) {
    case null: {
      if (v.startsWith('#') && /^#\d+$/.test(v) && Number(v.slice(1)) === pr.number) return true
      return pr.title.toLowerCase().includes(v) || pr.branch.toLowerCase().includes(v)
    }
    case 'is':
      if (v === 'tip') return node.isStagingTip
      if (v === 'merge-next') return node.isMergeNext
      if (v === 'blocked') return isBlocked(pr)
      if (v === 'stale') return node.baseKind === 'merged'
      return pr.isDraft
    case 'author':
      return pr.author.toLowerCase() === stripAt(v)
    case 'review':
      return pr.reviewDecision === REVIEW_DECISION[v]
    case 'review-requested':
      return pr.reviewRequests.some((r) => r.login.toLowerCase() === stripAt(v))
    case 'ci':
      return pr.ci === v
    case 'threads':
      if (pr.unresolvedThreads === null) return false // unread matches neither
      return v === 'unresolved' ? pr.unresolvedThreads > 0 : pr.unresolvedThreads === 0
    case 'label':
      return pr.labels.some((l) => l.toLowerCase() === v)
    case 'base':
      return pr.base.toLowerCase() === v
    case 'chain': {
      const chain = ctx.chainOf.get(Number(v.replace('#', '')))
      return chain !== undefined && chain === node.chain
    }
  }
  return false
}

/**
 * Terms are ANDed; repeating a key ORs its values; `-` negates.
 *
 * An unknown term "matches nothing": positive, it empties the group it is in
 * (unless OR-ed with a valid value of the same key); negated, it excludes
 * nothing. Pending terms are skipped.
 */
export function matchesNode(node: PrNode, query: ParsedQuery, ctx: FilterContext): boolean {
  const positiveByKey = new Map<string, QueryTerm[]>()
  for (const term of query.terms) {
    if (term.status === 'pending') continue
    if (term.negated) {
      if (holds(node, term, ctx)) return false
      continue
    }
    if (term.key === null && term.unknownKey === null) {
      // Free text: every positive text term has to hold.
      if (!holds(node, term, ctx)) return false
      continue
    }
    const k = term.key ?? `?${term.unknownKey}`
    positiveByKey.set(k, [...(positiveByKey.get(k) ?? []), term])
  }
  for (const group of positiveByKey.values()) {
    if (!group.some((t) => holds(node, t, ctx))) return false
  }
  return true
}

/** PR numbers of the nodes matching `query`. */
export function matchNodes(
  nodes: readonly PrNode[],
  query: ParsedQuery,
  ctx: FilterContext
): number[] {
  return nodes.filter((n) => matchesNode(n, query, ctx)).map((n) => n.pr.number)
}

// ── Facets ↔ query tokens ─────────────────────────────────────────────────

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

function sameToken(term: QueryTerm, key: QualifierKey, value: string): boolean {
  return (
    !term.negated &&
    term.key === key &&
    stripAt(term.value.toLowerCase()) === stripAt(value.toLowerCase())
  )
}

export function hasToken(query: string, key: QualifierKey, value: string): boolean {
  return parseQuery(query).terms.some((t) => sameToken(t, key, value))
}

/** Checks the box (appends the token) or unchecks it (removes every copy). */
export function toggleToken(query: string, key: QualifierKey, value: string): string {
  if (hasToken(query, key, value)) {
    return splitTerms(query)
      .filter((raw) => !sameToken(parseTerm(raw), key, value))
      .join(' ')
  }
  return [...splitTerms(query), `${key}:${quoteIfNeeded(value)}`].join(' ')
}

/** How many positive tokens of these keys the query holds — a facet's badge. */
export function tokenCount(query: string, keys: readonly QualifierKey[]): number {
  return parseQuery(query).terms.filter((t) => !t.negated && t.key !== null && keys.includes(t.key))
    .length
}

/**
 * Live facet counts: how many PRs each option matches ON ITS OWN, over the whole
 * snapshot — never over the current result, so a count does not collapse as the
 * operator narrows the query.
 */
export function facetCounts(
  nodes: readonly PrNode[],
  key: QualifierKey,
  values: readonly string[]
): Record<string, number> {
  const ctx = buildFilterContext(nodes)
  const out: Record<string, number> = {}
  for (const value of values) {
    out[value] = matchNodes(nodes, parseQuery(`${key}:${quoteIfNeeded(value)}`), ctx).length
  }
  return out
}

// ── Hide-mode layout ──────────────────────────────────────────────────────

/** The dashed "N hidden · #a #b" pill, in world px. */
export const GHOST_WIDTH = 176
export const GHOST_HEIGHT = 24
/** Offset inside the card slot the layout reserved, so the pill sits mid-row. */
const GHOST_TOP = 40

export interface GhostPill {
  /** Layout id (`ghost:<n>`), the key edges and boxes use. */
  id: string
  x: number
  y: number
  /** Skipped ancestors, base-most first. */
  hidden: number[]
  /** The matches whose path to base this pill stands in for. */
  matches: number[]
}

export interface HiddenLayout {
  /** Matches only, in the same `Placement` shape the store already draws. */
  placements: Array<{ id: string; x: number; y: number }>
  ghosts: GhostPill[]
  edges: Edge[]
  world: { width: number; height: number }
}

/**
 * Re-lays out the canvas over the matches only.
 *
 * A match whose ancestors are filtered out would be orphaned — and an orphan
 * reads as "this PR is on main", which is a lie about the chain. So every
 * contiguous run of skipped ancestors collapses into one pill that keeps the
 * path to base. Siblings under the same skipped parent share one pill.
 */
export function layoutHidden(graph: PrGraph, match: ReadonlySet<number>): HiddenLayout {
  const byNumber = new Map(graph.nodes.map((n) => [n.pr.number, n]))
  const matches = graph.nodes
    .filter((n) => match.has(n.pr.number))
    .sort((a, b) => a.pr.number - b.pr.number)

  interface Ghost {
    key: number
    hidden: number[]
    matches: number[]
    /** Nearest matching ancestor above the run, or `null` → base. */
    parent: number | null
    rootKind: Edge['kind']
    origin: PrNode
  }
  const ghosts = new Map<number, Ghost>()
  /** layout parent per match: a match number, `-ghostKey`, or `null` for base. */
  const parentOf = new Map<number, number | null>()

  for (const m of matches) {
    const run: number[] = []
    let cur = m.parent
    while (cur !== null && !match.has(cur)) {
      run.push(cur)
      cur = byNumber.get(cur)?.parent ?? null
    }
    if (run.length === 0) {
      parentOf.set(m.pr.number, cur)
      continue
    }
    const key = run[0]
    const existing = ghosts.get(key)
    if (existing) {
      existing.matches.push(m.pr.number)
    } else {
      const top = byNumber.get(run[run.length - 1])
      ghosts.set(key, {
        key,
        hidden: [...run].reverse(),
        matches: [m.pr.number],
        parent: cur,
        rootKind: top?.baseKind === 'merged' ? 'orphan' : 'merge',
        origin: byNumber.get(key) as PrNode
      })
    }
    parentOf.set(m.pr.number, -key)
  }

  // Depth over the visible nodes only.
  const depthMemo = new Map<number, number>()
  const depthOf = (id: number | null): number => {
    if (id === null) return -1
    const hit = depthMemo.get(id)
    if (hit !== undefined) return hit
    const parent = id < 0 ? (ghosts.get(-id)?.parent ?? null) : (parentOf.get(id) ?? null)
    const d = depthOf(parent) + 1
    depthMemo.set(id, d)
    return d
  }

  const layoutNodes: PrNode[] = []
  for (const m of matches) {
    layoutNodes.push({ ...m, depth: depthOf(m.pr.number) })
  }
  for (const g of ghosts.values()) {
    layoutNodes.push({
      ...g.origin,
      pr: { ...g.origin.pr, number: -g.key },
      depth: depthOf(-g.key)
    })
  }

  // Chains: one group per original chain, deepest first like the full layout.
  const members = new Map<number, number[]>()
  for (const n of layoutNodes) members.set(n.chain, [...(members.get(n.chain) ?? []), n.pr.number])
  const depthByNumber = new Map(layoutNodes.map((n) => [n.pr.number, n.depth]))
  const chains = [...members.entries()]
    .sort(
      ([ai, a], [bi, b]) =>
        Math.max(...b.map((x) => depthByNumber.get(x) ?? 0)) -
          Math.max(...a.map((x) => depthByNumber.get(x) ?? 0)) || ai - bi
    )
    .map(([, ids]) => ids)

  const laid = layoutGraph({ defaultBranch: graph.defaultBranch, nodes: layoutNodes, chains })

  const placements: HiddenLayout['placements'] = []
  const pills: GhostPill[] = []
  for (const p of laid.placements) {
    if (!p.id.startsWith('-')) {
      placements.push(p)
      continue
    }
    const g = ghosts.get(-Number(p.id))
    if (!g) continue
    pills.push({
      id: `ghost:${g.key}`,
      x: p.x + (CARD_WIDTH - GHOST_WIDTH) / 2,
      y: p.y + GHOST_TOP,
      hidden: g.hidden,
      matches: g.matches
    })
  }

  const idOf = (n: number | null): string =>
    n === null ? 'base' : n < 0 ? `ghost:${-n}` : String(n)
  const edges: Edge[] = []
  for (const m of matches) {
    const parent = parentOf.get(m.pr.number) ?? null
    edges.push({
      from: String(m.pr.number),
      to: idOf(parent),
      kind: parent === null && m.baseKind === 'merged' ? 'orphan' : 'merge'
    })
  }
  for (const g of ghosts.values()) {
    edges.push({
      from: `ghost:${g.key}`,
      to: idOf(g.parent),
      kind: g.parent === null ? g.rootKind : 'merge'
    })
  }

  return { placements, ghosts: pills, edges, world: { width: laid.width, height: laid.height } }
}
