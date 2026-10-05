/**
 * T198 — PR Stack Canvas: the pure core.
 *
 * Turns a `gh pr list` payload into the merge-chain graph the canvas draws,
 * and answers the two questions GitHub answers nowhere:
 *
 *   - which branch do I deploy to staging so it carries the whole stack
 *     (the STAGING TIP of each chain), and
 *   - which PR can I actually merge next (the base-most one that is green,
 *     approved and already targeting the default branch).
 *
 * Those are opposite ends of the same chain — merge order runs bottom-up,
 * deploy order runs top-down — so they are two distinct roles and a one-PR
 * chain legitimately holds both.
 *
 * Everything here is pure: no fs, no child_process, no Electron. The shell
 * that actually runs `gh`/`git` lives in `pr-stack.ts`.
 *
 * Visual contract: `docs/specs/2026-08-02-pr-stack-canvas/spec.html`.
 */

// ── Wire types (what `gh pr list --json …` gives us) ──────────────────────

export type PrLifecycle = 'OPEN' | 'MERGED' | 'CLOSED'
export type CiState = 'passing' | 'failing' | 'pending' | 'unknown'

/** One check row, kept only for the expanded drawer. */
export interface PrCheck {
  name: string
  state: CiState
  /** Human-ready duration or status word, already formatted upstream. */
  detail: string
}

/**
 * GitHub's own merge-state verdict (`gh pr list --json mergeStateStatus`),
 * computed server-side against the real refs.
 *
 * Kept as a closed union rather than `string` on purpose: the consumer (T274)
 * branches on it, and a bare `string` would let a typo compile into a chip that
 * silently never shows. `UNKNOWN` is a value GitHub itself returns — "not
 * computed yet" — and is therefore NOT the same as `null`, which means the app
 * did not read the field at all.
 */
export type MergeStateStatus =
  'CLEAN' | 'BEHIND' | 'DIRTY' | 'BLOCKED' | 'UNSTABLE' | 'DRAFT' | 'HAS_HOOKS' | 'UNKNOWN'

/**
 * One PENDING review request — someone who was asked and has not answered.
 *
 * The two payload shapes are not symmetric, which is the trap: `gh` exports a
 * user as `{ __typename: 'User', login }` but a team as
 * `{ __typename: 'Team', name, slug }` — **a team request carries no `login`
 * at all** (verified against `gh`'s own exporter, `api/export_pr.go`). We
 * normalise the team's `slug` — its stable @-handle — into the same field so a
 * team-only request is a row like any other instead of a dropped one.
 */
export interface PrReviewRequest {
  kind: 'user' | 'team'
  /**
   * A user's `login`, or a team's `slug`. Never empty.
   *
   * One caveat for whoever renders this: when a team payload arrives with no
   * `slug`, this holds the team's display `name` instead — which may contain
   * spaces and is NOT an addressable handle. Keeping the row beats dropping
   * it (an unanswered request must not silently vanish), so treat the value
   * as text and do not unconditionally prefix it with `@`.
   */
  login: string
}

/**
 * An armed auto-merge (`gh pr list --json autoMergeRequest`). Its mere
 * presence is the signal T279 draws: this PR lands without the operator.
 *
 * `enabledBy` is flattened from GitHub's actor object to the login string —
 * the only part the drawer names.
 */
export interface PrAutoMerge {
  /** `MERGE` / `REBASE` / `SQUASH`, or `null` when GitHub did not say. */
  mergeMethod: string | null
  /** Login of whoever armed it, or `null` when GitHub did not say. */
  enabledBy: string | null
}

/** A PR as parsed off the wire, before any graph reasoning. */
export interface PrEntry {
  number: number
  title: string
  /** The PR's own branch. */
  branch: string
  /** The branch this PR merges INTO — the field the whole DAG hangs on. */
  base: string
  state: PrLifecycle
  isDraft: boolean
  /** `null` when GitHub has not computed mergeability yet. */
  mergeable: boolean | null
  reviewDecision: string | null
  ci: CiState
  checks: PrCheck[]
  url: string
  author: string
  updatedAt: string | null
  /**
   * `headRefOid` — the PR's current head SHA, or `null` when the caller did not
   * ask `gh` for it. The review pane compares it against its local copy of the
   * ref to answer "is what I am reading still the head?" with a boolean instead
   * of an age; an age describes the CODE ("this commit is 3 days old"), never
   * the operator's copy, and a three-day-old head can be perfectly current.
   */
  headOid: string | null
  /**
   * The PR's GraphQL **node ID** (`gh pr list --json id`), or `null` when the
   * caller did not ask for it.
   *
   * Not the number: every GraphQL mutation that acts on a pull request —
   * `markFileAsViewed` among them (T243) — takes `pullRequestId`, and a PR
   * number is not accepted anywhere it is wanted. It rides the same already
   * cached `gh pr list` call, so having it costs nothing.
   */
  nodeId: string | null
  /**
   * GitHub's server-side merge verdict, or `null` when the caller did not ask
   * for it (or GitHub answered with something outside the known set).
   */
  mergeStateStatus: MergeStateStatus | null
  /**
   * Diff size. `null` — never `0` — when absent: "+0 −0" is a claim that the
   * PR is empty, and the app has no evidence for it.
   */
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  /** Pending review requests; `[]` when absent or none. */
  reviewRequests: PrReviewRequest[]
  /**
   * Label NAMES only. GitHub also returns a per-label hex `color`; it is
   * dropped here deliberately and must not be reintroduced — piping
   * `#RRGGBB` into the renderer violates the no-raw-colours contract
   * (`CLAUDE.md`, `design.md` §9). The label's text is the signal.
   */
  labels: string[]
  /** The armed auto-merge, or `null` when auto-merge is not armed. */
  autoMergeRequest: PrAutoMerge | null
  /**
   * T275 — unresolved review threads that still point at live code
   * (`isResolved === false && isOutdated === false`), or `null` when the thread
   * query did not run, failed, or did not cover this PR.
   *
   * Not from `gh pr list` — it has no field for thread resolution at all — but
   * from the separate {@link REVIEW_THREADS_QUERY}, merged in by
   * {@link withReviewThreads}. `null` is never drawn as `0`: "0 unresolved" is
   * a claim, and a failed call supports no claim.
   */
  unresolvedThreads: number | null
  /**
   * Unresolved threads anchored to a diff hunk that has since been rewritten.
   * The code they point at no longer exists, so they are noise for the chip and
   * are listed only in the drawer. `null` exactly when `unresolvedThreads` is.
   */
  outdatedThreads: number | null
  /**
   * GitHub holds more threads on this PR than were read (or one was
   * unreadable), so both counts are lower bounds and render as `N+`.
   */
  threadsTruncated: boolean
}

// ── Graph types ───────────────────────────────────────────────────────────

/**
 * How a node reaches its base.
 *
 * `merged` is the hazard the canvas exists to surface: GitHub silently
 * retargets a PR onto the default branch when its base branch is deleted, so
 * the diff reviewed afterwards is not the diff reviewed before.
 */
export type BaseKind = 'pr' | 'default' | 'merged' | 'missing'

export interface PrNode {
  pr: PrEntry
  /** PR number of the base, when the base is itself an open PR. */
  parent: number | null
  children: number[]
  baseKind: BaseKind
  /** Distance from the chain root (the PR sitting on the default branch). */
  depth: number
  /** Nothing is based on this PR — deploy it and you carry `carries` PRs. */
  isStagingTip: boolean
  /** PRs on the path from this node down to the chain root, inclusive. */
  carries: number
  /** Base is the default branch, CI green, approved, no conflict, not draft. */
  isMergeNext: boolean
  /** Index of the chain (connected component) this node belongs to. */
  chain: number
}

export interface PrGraph {
  defaultBranch: string
  nodes: PrNode[]
  /** Chain roots, deepest chain first — the left-to-right column order. */
  chains: number[][]
}

/** A Harnu worktree the canvas knows about, in either of its two roles. */
export interface WorktreeNode {
  path: string
  branch: string
  title: string
  /** Absolute path of the `bornFrom` mother (T191), when Harnu recorded one. */
  bornFrom: string | null
  sessionLive: boolean
  /** Reaper's verdict; only `harvestable` sends a worktree to the tray. */
  harvestable: boolean
  /** The merged PR that made it harvestable, for the tray row's "why". */
  mergedPr: number | null
  sizeBytes: number
}

// ── Parsing ───────────────────────────────────────────────────────────────

const CI_FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED'])
const CI_PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/**
 * Reads one `statusCheckRollup` entry. Mirrors the Reaper's
 * `normalizeCheckEntry` (scan-core.ts) deliberately: the two must never
 * disagree about what "green" means, or the canvas and the Cleanup view would
 * tell the operator different stories about the same PR.
 */
function checkState(raw: Record<string, unknown>): CiState {
  const status = typeof raw.status === 'string' ? raw.status.toUpperCase() : null
  if (status === 'QUEUED' || status === 'IN_PROGRESS' || status === 'PENDING') return 'pending'
  const conclusion = typeof raw.conclusion === 'string' ? raw.conclusion.toUpperCase() : null
  if (conclusion && CI_FAIL.has(conclusion)) return 'failing'
  if (conclusion && CI_PASS.has(conclusion)) return 'passing'
  // Legacy commit statuses use `state` instead of status/conclusion.
  const state = typeof raw.state === 'string' ? raw.state.toUpperCase() : null
  if (state === 'FAILURE' || state === 'ERROR') return 'failing'
  if (state === 'SUCCESS') return 'passing'
  if (state === 'PENDING') return 'pending'
  return 'unknown'
}

/** Failing beats pending beats passing — the worst signal is the honest one. */
export function worstCi(checks: PrCheck[]): CiState {
  let sawPending = false
  let sawPassing = false
  for (const c of checks) {
    if (c.state === 'failing') return 'failing'
    if (c.state === 'pending') sawPending = true
    else if (c.state === 'passing') sawPassing = true
  }
  if (sawPending) return 'pending'
  if (sawPassing) return 'passing'
  return 'unknown'
}

function checkName(raw: Record<string, unknown>): string {
  for (const key of ['name', 'context', 'workflowName']) {
    const v = raw[key]
    if (typeof v === 'string' && v) return v
  }
  return 'check'
}

const MERGE_STATE_STATUSES: ReadonlySet<string> = new Set<MergeStateStatus>([
  'CLEAN',
  'BEHIND',
  'DIRTY',
  'BLOCKED',
  'UNSTABLE',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN'
])

/** Anything outside the documented set is `null`, not a cast. */
function mergeStateOf(raw: unknown): MergeStateStatus | null {
  if (typeof raw !== 'string') return null
  const up = raw.toUpperCase()
  return MERGE_STATE_STATUSES.has(up) ? (up as MergeStateStatus) : null
}

/**
 * A count, or `null` when there is nothing honest to say.
 *
 * Deliberately NOT `Number(raw) || 0`: coercing an absent field to `0` turns
 * "we do not know" into "we measured, and it is zero", which the card would
 * then draw as fact.
 */
function countOf(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
}

/** Pending review requests, normalised across the user and team shapes. */
function reviewRequestsOf(raw: unknown): PrReviewRequest[] {
  if (!Array.isArray(raw)) return []
  const out: PrReviewRequest[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (r.__typename === 'Team') {
      // No `login` on this shape at all — `slug` is the team's handle, `name`
      // its display text. Preferring `slug` keeps it addressable; the `name`
      // fallback is a last resort that is deliberately NOT handle-shaped (see
      // `PrReviewRequest.login`), because losing the row would be worse.
      const slug = typeof r.slug === 'string' && r.slug ? r.slug : null
      const name = typeof r.name === 'string' && r.name ? r.name : null
      const handle = slug ?? name
      if (handle) out.push({ kind: 'team', login: handle })
      continue
    }
    const login = typeof r.login === 'string' && r.login ? r.login : null
    if (login) out.push({ kind: 'user', login })
  }
  return out
}

/** Label names. The hex `color` GitHub also sends is dropped here, on purpose. */
function labelNamesOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const name = (item as Record<string, unknown>).name
    if (typeof name === 'string' && name) out.push(name)
  }
  return out
}

/**
 * The armed auto-merge.
 *
 * An object whose innards are unreadable still parses to an object with `null`
 * members rather than to `null`: the presence of `autoMergeRequest` IS the
 * "armed" signal, and discarding it because the merge method was unfamiliar
 * would report an armed PR as un-armed.
 */
function autoMergeOf(raw: unknown): PrAutoMerge | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const by = r.enabledBy
  const login = by && typeof by === 'object' ? (by as Record<string, unknown>).login : undefined
  return {
    mergeMethod: typeof r.mergeMethod === 'string' && r.mergeMethod ? r.mergeMethod : null,
    enabledBy: typeof login === 'string' && login ? login : null
  }
}

/**
 * Parses `gh pr list --json
 * number,title,headRefName,baseRefName,state,isDraft,mergeable,reviewDecision,statusCheckRollup,url,author,updatedAt,mergeStateStatus,additions,deletions,changedFiles,reviewRequests,labels,autoMergeRequest`
 * (`headRefOid` and `id` too, when the caller asked for them — see
 * {@link PrEntry.headOid} and {@link PrEntry.nodeId}).
 *
 * Every field is optional on the way in and every absent one lands as `null`
 * (or `[]`), never as `0` — see {@link countOf}.
 *
 * Tolerant by design: a malformed payload yields an empty list rather than
 * throwing, because a canvas that renders nothing is recoverable and a main
 * process that throws on someone else's JSON is not.
 */
export function parsePrList(stdout: string): PrEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: PrEntry[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const raw = item as Record<string, unknown>
    if (typeof raw.headRefName !== 'string' || !raw.headRefName) continue
    if (typeof raw.number !== 'number') continue

    const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []
    const checks: PrCheck[] = []
    for (const entry of rollup) {
      if (!entry || typeof entry !== 'object') continue
      const r = entry as Record<string, unknown>
      checks.push({ name: checkName(r), state: checkState(r), detail: '' })
    }

    const author = raw.author
    out.push({
      number: raw.number,
      title: typeof raw.title === 'string' ? raw.title : '',
      branch: raw.headRefName,
      base: typeof raw.baseRefName === 'string' ? raw.baseRefName : '',
      state: raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN',
      isDraft: raw.isDraft === true,
      mergeable:
        raw.mergeable === 'MERGEABLE' ? true : raw.mergeable === 'CONFLICTING' ? false : null,
      reviewDecision:
        typeof raw.reviewDecision === 'string' && raw.reviewDecision ? raw.reviewDecision : null,
      ci: worstCi(checks),
      checks,
      url: typeof raw.url === 'string' ? raw.url : '',
      author:
        author &&
        typeof author === 'object' &&
        typeof (author as Record<string, unknown>).login === 'string'
          ? ((author as Record<string, unknown>).login as string)
          : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      headOid: typeof raw.headRefOid === 'string' && raw.headRefOid ? raw.headRefOid : null,
      nodeId: typeof raw.id === 'string' && raw.id ? raw.id : null,
      mergeStateStatus: mergeStateOf(raw.mergeStateStatus),
      additions: countOf(raw.additions),
      deletions: countOf(raw.deletions),
      changedFiles: countOf(raw.changedFiles),
      reviewRequests: reviewRequestsOf(raw.reviewRequests),
      labels: labelNamesOf(raw.labels),
      autoMergeRequest: autoMergeOf(raw.autoMergeRequest),
      // Not on this payload — see `withReviewThreads`.
      unresolvedThreads: null,
      outdatedThreads: null,
      threadsTruncated: false
    })
  }
  return out
}

// ── Review threads (T275) ─────────────────────────────────────────────────

/**
 * How many PRs `gh pr list` asks for, shared with the thread query so the two
 * can never drift apart again (spec T272 §7.3).
 */
export const PR_LIST_LIMIT = 100

/**
 * Threads read per PR — `reviewThreads(last: M)`. Past it, counts are `N+`.
 *
 * `last`, not `first`: the connection is oldest-first (verified on this repo,
 * 2026-09-11), so on a PR with more than M threads the unread slice would be
 * the newest ones — the likeliest to still be open. Reading the newest M makes
 * a truncated count miss the old, mostly-resolved threads instead.
 */
export const THREADS_PER_PR_LIMIT = 100

/**
 * Unresolved review threads for every open PR, in ONE call.
 *
 * **Why the bounds reconcile.** `gh pr list --state all --limit 100` returns
 * the 100 most recently *created* PRs of any state (its own `orderBy` is
 * `CREATED_AT DESC`). This asks for the 100 most recently created OPEN PRs in
 * the same order — a superset of every open PR the canvas can draw, so no drawn
 * card falls outside it. The one gap is a PR opened between the two calls,
 * which gets no thread data (`null`, not `0`) until the next refresh.
 *
 * **Cost.** GitHub prices a query by the connections it may traverse, not by
 * what it returns: `(1 + 100) / 100` rounds to **1 rate-limit point** for the
 * whole repo, measured on this repo (2026-09-03 at 50×50, 2026-09-10 at
 * 100×100).
 *
 * `$owner`/`$name` are filled by `gh`'s own `{owner}`/`{repo}` placeholders
 * from the repo in `cwd`, so the shell never has to parse a remote URL.
 */
export const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PR_LIST_LIMIT}, states: OPEN, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number
        reviewThreads(last: ${THREADS_PER_PR_LIMIT}) {
          totalCount
          nodes { isResolved isOutdated }
        }
      }
    }
  }
}`

/** One PR's thread counts, as read off the GraphQL payload. */
export interface PrThreadCounts {
  /** Unresolved AND not outdated — the pending action the chip draws. */
  unresolved: number
  /** Unresolved but outdated — drawer only. */
  outdated: number
  /** Both counts are lower bounds: more threads exist than were read. */
  truncated: boolean
}

function recordOf(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null
}

/**
 * Parses the {@link REVIEW_THREADS_QUERY} payload into counts keyed by PR
 * number.
 *
 * `null` — no thread data at all — when the payload is not the expected shape
 * (a GraphQL error body, malformed JSON). A PR whose own `reviewThreads` is
 * unreadable is simply absent from the map, so it too lands as `null` rather
 * than `0`. A single thread that cannot be classified is skipped and marks the
 * PR `truncated`: the counts become a lower bound instead of a silent
 * undercount.
 */
export function parseReviewThreads(stdout: string): Map<number, PrThreadCounts> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const repository = recordOf(recordOf(recordOf(parsed)?.data)?.repository)
  const nodes = recordOf(repository?.pullRequests)?.nodes
  if (!Array.isArray(nodes)) return null

  const out = new Map<number, PrThreadCounts>()
  for (const item of nodes) {
    const pr = recordOf(item)
    if (!pr || typeof pr.number !== 'number') continue
    const threads = recordOf(pr.reviewThreads)
    if (!threads || !Array.isArray(threads.nodes)) continue

    const counts: PrThreadCounts = { unresolved: 0, outdated: 0, truncated: false }
    if (typeof threads.totalCount === 'number' && threads.totalCount > threads.nodes.length) {
      counts.truncated = true
    }
    for (const t of threads.nodes) {
      const thread = recordOf(t)
      if (
        !thread ||
        typeof thread.isResolved !== 'boolean' ||
        typeof thread.isOutdated !== 'boolean'
      ) {
        counts.truncated = true
        continue
      }
      if (thread.isResolved) continue
      if (thread.isOutdated) counts.outdated += 1
      else counts.unresolved += 1
    }
    out.set(pr.number, counts)
  }
  return out
}

/**
 * Merges thread counts onto the graph's PRs. `threads === null` (the call
 * failed) and a PR missing from the map both leave the fields at their absent
 * values — `null`, never `0`.
 */
export function withReviewThreads(
  graph: PrGraph,
  threads: Map<number, PrThreadCounts> | null
): PrGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const counts = threads?.get(node.pr.number)
      return {
        ...node,
        pr: {
          ...node.pr,
          unresolvedThreads: counts ? counts.unresolved : null,
          outdatedThreads: counts ? counts.outdated : null,
          threadsTruncated: counts ? counts.truncated : false
        }
      }
    })
  }
}

// ── Graph construction ────────────────────────────────────────────────────

/**
 * Builds the merge DAG.
 *
 * A chain is a connected component rooted at a PR whose base is the default
 * branch. It is a TREE, not necessarily a line: two PRs may legitimately be
 * based on the same PR, and pretending otherwise would drop one of them.
 */
export function buildGraph(prs: PrEntry[], defaultBranch: string): PrGraph {
  const open = prs.filter((p) => p.state === 'OPEN')
  const mergedBranches = new Set(prs.filter((p) => p.state === 'MERGED').map((p) => p.branch))
  const byBranch = new Map<string, PrEntry>()
  for (const p of open) byBranch.set(p.branch, p)

  const nodes = new Map<number, PrNode>()
  for (const pr of open) {
    const parentPr = pr.base === defaultBranch ? undefined : byBranch.get(pr.base)
    const baseKind: BaseKind =
      pr.base === defaultBranch
        ? 'default'
        : parentPr
          ? 'pr'
          : mergedBranches.has(pr.base)
            ? 'merged'
            : 'missing'
    nodes.set(pr.number, {
      pr,
      parent: parentPr ? parentPr.number : null,
      children: [],
      baseKind,
      depth: 0,
      isStagingTip: false,
      carries: 1,
      isMergeNext: false,
      chain: -1
    })
  }
  for (const node of nodes.values()) {
    if (node.parent !== null) nodes.get(node.parent)?.children.push(node.pr.number)
  }

  // A `merged`/`missing` base means the PR is effectively rooted on the
  // default branch already (GitHub retargets it there), so it opens its own
  // chain rather than dangling.
  const roots = [...nodes.values()].filter((n) => n.parent === null)

  const chains: number[][] = []
  for (const root of roots) {
    const chainIdx = chains.length
    const members: number[] = []
    // Depth-first so a node's depth is always assigned after its parent's.
    const stack: Array<{ n: PrNode; depth: number }> = [{ n: root, depth: 0 }]
    const seen = new Set<number>()
    while (stack.length > 0) {
      const { n, depth } = stack.pop() as { n: PrNode; depth: number }
      if (seen.has(n.pr.number)) continue // defensive: a base cycle can not hang us
      seen.add(n.pr.number)
      n.depth = depth
      n.chain = chainIdx
      members.push(n.pr.number)
      for (const childNumber of n.children) {
        const child = nodes.get(childNumber)
        if (child) stack.push({ n: child, depth: depth + 1 })
      }
    }
    chains.push(members)
  }

  for (const node of nodes.values()) {
    node.isStagingTip = node.children.length === 0
    node.carries = node.depth + 1
    node.isMergeNext = node.depth === 0 && isMergeable(node)
  }

  // Deepest chain first — a deeper chain is the one that costs the most to
  // get wrong, so it earns the leftmost column.
  const order = chains
    .map((members, i) => ({ i, members }))
    .sort((a, b) => chainDepth(b.members, nodes) - chainDepth(a.members, nodes) || a.i - b.i)
    .map((c) => c.members)

  return { defaultBranch, nodes: [...nodes.values()], chains: order }
}

function chainDepth(members: number[], nodes: Map<number, PrNode>): number {
  let max = 0
  for (const number of members) {
    const n = nodes.get(number)
    if (n && n.depth + 1 > max) max = n.depth + 1
  }
  return max
}

/**
 * "Merge next" is deliberately strict: green, approved, no conflict, not a
 * draft. A yellow one would be a suggestion, and the whole point of the
 * marker is that you can act on it without checking anything else.
 */
function isMergeable(node: PrNode): boolean {
  const { pr } = node
  if (node.baseKind !== 'default') return false
  if (pr.isDraft) return false
  if (pr.mergeable === false) return false
  if (pr.ci !== 'passing') return false
  return pr.reviewDecision === 'APPROVED'
}

// ── Layout ────────────────────────────────────────────────────────────────

/** Plan-locked geometry — see design.md §6 "PR Stack Canvas". */
export const CARD_WIDTH = 272
export const COLUMN_PITCH = 304
export const ROW_PITCH = 166
/** Fit-to-view insets the world so a tip card is never born under the controls. */
export const TOP_INSET = 58

export interface Placement {
  /** PR number, or `wt:<path>` for a draft worktree node. */
  id: string
  x: number
  y: number
}

/**
 * Bottom-aligned columns: every chain's root sits on the same bottom row and
 * the chain grows upward, so stack depth reads as column height without
 * tracing a single edge. A branching chain widens into adjacent sub-columns
 * rather than overlapping, so a column never holds two chains.
 */
export function layoutGraph(graph: PrGraph): {
  placements: Placement[]
  width: number
  height: number
} {
  const byNumber = new Map(graph.nodes.map((n) => [n.pr.number, n]))
  const placements: Placement[] = []
  let column = 0
  let maxDepth = 0

  for (const members of graph.chains) {
    const depths = new Map<number, number>() // depth -> how many already placed
    let widest = 1
    // Place shallowest first so siblings at the same depth pack left to right.
    const ordered = [...members].sort(
      (a, b) => (byNumber.get(a)?.depth ?? 0) - (byNumber.get(b)?.depth ?? 0) || a - b
    )
    for (const number of ordered) {
      const node = byNumber.get(number)
      if (!node) continue
      const slot = depths.get(node.depth) ?? 0
      depths.set(node.depth, slot + 1)
      if (slot + 1 > widest) widest = slot + 1
      if (node.depth > maxDepth) maxDepth = node.depth
      placements.push({
        id: String(number),
        x: (column + slot) * COLUMN_PITCH,
        y: node.depth * ROW_PITCH
      })
    }
    column += widest
  }

  // Flip to bottom-aligned: depth 0 belongs on the bottom row.
  const rows = maxDepth + 1
  for (const p of placements) {
    p.y = TOP_INSET + (rows - 1) * ROW_PITCH - p.y
  }

  return {
    placements,
    width: Math.max(1, column) * COLUMN_PITCH,
    height: TOP_INSET + rows * ROW_PITCH
  }
}

/**
 * Applies operator position overrides on top of the computed layout.
 *
 * The computed arrangement is the DEFAULT, not the law: cards drag freely and
 * the edges — anchored to card edges — carry the chain, so a moved card can
 * never make the graph lie. Overrides are keyed by PR number, so an untouched
 * node keeps flowing with the layout, a new PR is auto-placed, and a closed PR
 * takes its override with it.
 */
export function applyOverrides(
  placements: Placement[],
  overrides: Record<string, { x: number; y: number }>
): { placements: Placement[]; movedCount: number } {
  let movedCount = 0
  const out = placements.map((p) => {
    const o = overrides[p.id]
    if (!o) return p
    movedCount += 1
    return { id: p.id, x: o.x, y: o.y }
  })
  return { placements: out, movedCount }
}

/** Drops overrides whose node no longer exists (the PR closed or merged). */
export function pruneOverrides(
  overrides: Record<string, { x: number; y: number }>,
  liveIds: Iterable<string>
): Record<string, { x: number; y: number }> {
  const live = new Set(liveIds)
  const out: Record<string, { x: number; y: number }> = {}
  for (const [id, pos] of Object.entries(overrides)) if (live.has(id)) out[id] = pos
  return out
}

// ── Zoom ──────────────────────────────────────────────────────────────────

export type Lod = 'full' | 'compact' | 'far'

/**
 * Zoom sheds DETAIL, not pixels. Fit-to-view over twenty cards that only
 * scales produces a graph that fits and can not be read — "does not fit"
 * traded for "fits, illegible".
 */
export function lodForScale(scale: number): Lod {
  if (scale > 0.7) return 'full'
  if (scale >= 0.45) return 'compact'
  return 'far'
}

export const MIN_SCALE = 0.2
export const MAX_SCALE = 2

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/**
 * Scale + translation that brings the whole world into the viewport with a
 * uniform margin. Never zooms past 1: a four-card graph should sit at natural
 * size, not balloon.
 */
export function fitToView(
  world: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 32
): { scale: number; x: number; y: number } {
  const availableW = Math.max(1, viewport.width - margin * 2)
  const availableH = Math.max(1, viewport.height - margin * 2)
  const raw = Math.min(
    availableW / Math.max(1, world.width),
    availableH / Math.max(1, world.height),
    1
  )
  const scale = clampScale(raw)
  return {
    scale,
    x: (viewport.width - world.width * scale) / 2,
    y: (viewport.height - world.height * scale) / 2
  }
}

/**
 * The view that brings one card to the middle of the viewport. Keeps the
 * current scale — a link click should not rescale the picture the operator is
 * reading — unless the card, at that scale, would not fit inside the viewport
 * (minus `margin`), in which case the scale drops just enough that it does.
 */
export function focusOnBox(
  box: { x: number; y: number; w: number; h: number },
  viewport: { width: number; height: number },
  scale: number,
  margin = 32
): { scale: number; x: number; y: number } {
  const availableW = Math.max(1, viewport.width - margin * 2)
  const availableH = Math.max(1, viewport.height - margin * 2)
  const fits = box.w * scale <= availableW && box.h * scale <= availableH
  const next = fits
    ? clampScale(scale)
    : clampScale(Math.min(availableW / Math.max(1, box.w), availableH / Math.max(1, box.h)))
  return {
    scale: next,
    x: viewport.width / 2 - (box.x + box.w / 2) * next,
    y: viewport.height / 2 - (box.y + box.h / 2) * next
  }
}

/** Card height used to centre a focus, by zoom level (mirrors the canvas' `heightOf`). */
export function focusCardHeight(lod: Lod): number {
  return lod === 'far' ? 32 : lod === 'compact' ? 62 : 101
}

/**
 * Whether a pending focus request may run now: it needs a snapshot that
 * contains the card, and — when the request names a repo — that the canvas is
 * already on that repo, so a stale snapshot of ANOTHER repo that happens to
 * hold the same PR number can never be focused by mistake.
 */
export function resolveFocusTarget(
  pending: { number: number; repo: string | null } | null,
  currentRepo: string | null,
  placements: readonly Placement[]
): Placement | null {
  if (!pending) return null
  if (pending.repo !== null && pending.repo !== currentRepo) return null
  return placements.find((p) => p.id === String(pending.number)) ?? null
}

/**
 * A fingerprint of the graph's SHAPE — node identity and parentage, never
 * readiness. Fit re-runs when this changes and not on a plain data refresh,
 * which would move the view under the operator mid-read.
 */
export function shapeKey(graph: PrGraph): string {
  return graph.nodes
    .map((n) => `${n.pr.number}>${n.parent ?? n.baseKind}`)
    .sort()
    .join('|')
}

// ── Edges ─────────────────────────────────────────────────────────────────

export interface Edge {
  from: string
  to: string
  kind: 'merge' | 'lineage' | 'orphan'
}

/**
 * One outgoing edge per node. A node whose base is not another open PR points
 * at the base node; when that happened because the base branch was merged,
 * the edge itself carries the hazard (`orphan`) rather than only the card.
 */
export function graphEdges(graph: PrGraph, worktrees: WorktreeNode[] = []): Edge[] {
  const edges: Edge[] = []
  for (const node of graph.nodes) {
    if (node.parent !== null) {
      edges.push({ from: String(node.pr.number), to: String(node.parent), kind: 'merge' })
    } else {
      edges.push({
        from: String(node.pr.number),
        to: 'base',
        kind: node.baseKind === 'merged' ? 'orphan' : 'merge'
      })
    }
  }
  // A worktree with no PR yet is live work: it hangs off its bornFrom mother
  // with a lineage edge. A harvestable one never reaches the graph at all.
  const byPath = new Map(worktrees.map((w) => [w.path, w]))
  for (const wt of worktrees) {
    if (wt.harvestable) continue
    if (!wt.bornFrom || !byPath.has(wt.bornFrom)) continue
    edges.push({ from: `wt:${wt.path}`, to: `wt:${wt.bornFrom}`, kind: 'lineage' })
  }
  return edges
}

/**
 * Everything the canvas needs for one repo, in one payload.
 *
 * Lives in the CORE, not the shell: it is pure data, and keeping it here is
 * what lets the preload/renderer import it without dragging `electron` and
 * `child_process` into the renderer's type graph.
 */
/** A transient `gh` failure: the CLI is usable, this call did not come back. */
export type GhFailure = 'timeout' | 'outputTooLarge' | 'network' | 'other'

/** What a failed `gh` child error says about the CLI. Duck-typed: execFile errors are plain objects. */
interface ExecFailure {
  code?: unknown
  killed?: unknown
  signal?: unknown
  stderr?: unknown
}

/**
 * Sorts a `gh` failure into "gh genuinely cannot be used here" (`null`) or a
 * transient one worth keeping the last good canvas through (BUG-148).
 *
 * `null` is deliberately narrow — a missing binary, no login, a non-GitHub
 * remote — because it is the answer that tells the operator to go install or
 * authenticate something. Anything unrecognised is `'other'`: wrongly calling a
 * hiccup "unavailable" empties a populated canvas and sends the operator to fix
 * a CLI that is fine, while wrongly calling a missing CLI "transient" only
 * costs a retry button on an empty canvas.
 */
export function classifyGhFailure(err: unknown): GhFailure | null {
  const e: ExecFailure = err && typeof err === 'object' ? (err as ExecFailure) : {}
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''

  if (e.code === 'ENOENT') return null
  if (/gh auth login|not logged in|authentication required|GH_TOKEN/i.test(stderr)) return null
  if (/none of the git remotes|not a github|no github remote/i.test(stderr)) return null

  if (e.killed === true || e.signal != null || e.code === 'ETIMEDOUT') return 'timeout'
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'outputTooLarge'
  if (
    /error connecting|could not resolve|no such host|network is unreachable|connection (refused|reset)|timeout|rate limit|HTTP 5\d\d|EOF/i.test(
      stderr
    )
  ) {
    return 'network'
  }
  return 'other'
}

export interface PrStackSnapshot {
  repoPath: string
  defaultBranch: string
  graph: PrGraph
  placements: Placement[]
  edges: Edge[]
  worktrees: WorktreeNode[]
  kpis: PrStackKpis
  world: { width: number; height: number }
  shape: string
  fetchedAt: number
  /** `gh` missing, unauthenticated, or the remote is not GitHub. */
  ghAvailable: boolean
  /**
   * Why `gh pr list` failed TRANSIENTLY (BUG-148): `gh` is usable here, it just
   * did not answer this time, so `graph` is empty because the read failed — not
   * because the repo has no PRs. `null` when the read succeeded, or when `gh`
   * is genuinely unavailable (`ghAvailable: false`).
   */
  ghFailure: GhFailure | null
  /**
   * Commits each PR branch is behind its base, keyed by PR number, as counted
   * by the LOCAL checkout. `0` means measured and current; a missing key means
   * git could not measure it here (branch not fetched) — never zero.
   */
  behind: Record<number, number>
}

/**
 * The ref a PR's behind count is taken against: its REAL base.
 *
 * `pr.base` already equals the parent PR's branch (`pr`) or the default branch
 * (`default`), and counting against it also covers a base that is neither —
 * `develop`, `release/*` (`missing`) — which used to be counted against the
 * default branch and could read "up to date locally" while far behind its real
 * base. A `merged` base is the exception: that branch is gone from GitHub, the
 * PR is effectively rooted on the default branch, and a leftover local copy of
 * the dead branch would be the wrong yardstick.
 */
export function behindBaseRef(
  node: { pr: Pick<PrEntry, 'base'>; baseKind: BaseKind },
  defaultBranch: string
): string {
  if (node.baseKind === 'merged' || !node.pr.base) return defaultBranch
  return node.pr.base
}

/**
 * Parses `git rev-list --count` output. A `0` is kept — it is the only evidence
 * the card has for "up to date" (T274) — and anything that is not a
 * non-negative integer is `null`: no key in `behind`, "could not measure".
 */
export function parseBehindCount(stdout: string): number | null {
  const s = stdout.trim()
  return /^\d+$/.test(s) ? Number.parseInt(s, 10) : null
}

// ── Headline counts ───────────────────────────────────────────────────────

export interface PrStackKpis {
  open: number
  chains: number
  readyToMerge: number
  needsRetarget: number
  stagingTips: number
  /**
   * T275 — PRs with at least one unresolved, non-outdated review thread, or
   * `null` when no PR's threads could be read (the header then omits the
   * count instead of claiming zero).
   */
  withUnresolvedThreads: number | null
}

export function kpis(graph: PrGraph): PrStackKpis {
  return {
    open: graph.nodes.length,
    chains: graph.chains.length,
    // A to-do count (T279, spec T272 §5.7): a merge-next PR with auto-merge
    // armed lands without the operator, so it is not counted. Its role is
    // untouched — the card still says `merge next`.
    readyToMerge: graph.nodes.filter((n) => n.isMergeNext && !n.pr.autoMergeRequest).length,
    needsRetarget: graph.nodes.filter((n) => n.baseKind === 'merged').length,
    stagingTips: graph.nodes.filter((n) => n.isStagingTip).length,
    withUnresolvedThreads: withUnresolvedThreads(graph)
  }
}

function withUnresolvedThreads(graph: PrGraph): number | null {
  const measured = graph.nodes.filter((n) => n.pr.unresolvedThreads !== null)
  if (measured.length === 0) return null
  return measured.filter((n) => (n.pr.unresolvedThreads ?? 0) > 0).length
}
