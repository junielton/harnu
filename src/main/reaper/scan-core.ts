// Pure scan-core for the Reaper cleanup engine: parsers + inventory cross-reference.
// No I/O — the shell (scanner-shell.ts) gathers raw command output and calls into here.

import {
  classify,
  classifyDetachedWorktree,
  type BranchFacts,
  type PrFacts,
  type PrProvenance,
  type ReapItem,
  type ReapVerdict
} from './reaper-core'
import type { WorktreeListEntry, WorktreeStatus } from '../worktree-core'

export interface LocalBranchRef {
  branch: string
  sha: string
  /** Milliseconds since epoch (converted from git's unix-seconds `committerdate:unix`). */
  committedAt: number | null
  upstream: string | null
}

/** Parses `for-each-ref --format=%(refname:short)\t%(objectname)\t%(committerdate:unix)\t%(upstream:short)`. */
export function parseForEachRef(stdout: string): LocalBranchRef[] {
  const out: LocalBranchRef[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length !== 4) continue
    const [branch, sha, committedAtRaw, upstream] = parts
    if (!branch || !sha) continue
    const seconds = Number(committedAtRaw)
    if (!Number.isFinite(seconds)) continue
    out.push({ branch, sha, committedAt: seconds * 1000, upstream: upstream ? upstream : null })
  }
  return out
}

type NormalizedCi = 'failing' | 'pending' | 'passing' | 'unknown'

/**
 * Normalizes one statusCheckRollup entry to a CI state. gh mixes two shapes:
 * a legacy `StatusContext` (has `state`) and a modern `CheckRun` (has `status`
 * and, once COMPLETED, `conclusion`). Both must be understood or a failing
 * CheckRun would be silently treated as passing.
 */
function normalizeCheckEntry(entry: Record<string, unknown>): NormalizedCi {
  const state = typeof entry.state === 'string' ? entry.state.toUpperCase() : null
  if (state) {
    if (state === 'FAILURE' || state === 'ERROR') return 'failing'
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
    if (state === 'SUCCESS') return 'passing'
    return 'unknown'
  }
  const status = typeof entry.status === 'string' ? entry.status.toUpperCase() : null
  if (
    status === 'QUEUED' ||
    status === 'IN_PROGRESS' ||
    status === 'WAITING' ||
    status === 'PENDING'
  )
    return 'pending'
  if (status === 'COMPLETED') {
    const conclusion = typeof entry.conclusion === 'string' ? entry.conclusion.toUpperCase() : null
    if (
      conclusion === 'FAILURE' ||
      conclusion === 'TIMED_OUT' ||
      conclusion === 'CANCELLED' ||
      conclusion === 'STARTUP_FAILURE' ||
      conclusion === 'ACTION_REQUIRED'
    )
      return 'failing'
    if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED')
      return 'passing'
    return 'unknown'
  }
  return 'unknown'
}

function worstCiState(rollup: Array<Record<string, unknown>>): PrFacts['ci'] {
  let sawPending = false
  let sawPassing = false
  for (const entry of rollup) {
    if (!entry || typeof entry !== 'object') continue
    const s = normalizeCheckEntry(entry)
    if (s === 'failing') return 'failing' // failing beats pending beats passing
    if (s === 'pending') sawPending = true
    else if (s === 'passing') sawPassing = true
  }
  if (sawPending) return 'pending'
  if (sawPassing) return 'passing'
  return 'unknown' // empty rollup, or only unrecognized entries
}

interface PrCandidate {
  branch: string
  pr: PrFacts
  crossRepo: boolean
}

/** Reads the head repository identity of a raw gh PR entry, or null when absent. */
function headRepoId(raw: Record<string, unknown>): string | null {
  const headRepo = raw.headRepository
  if (headRepo && typeof headRepo === 'object' && 'id' in headRepo) {
    const id = (headRepo as Record<string, unknown>).id
    if (typeof id === 'string' || typeof id === 'number') return String(id)
  }
  return null
}

/** Parses `gh pr list --json headRefName,number,state,mergedAt,reviewDecision,statusCheckRollup,headRepository,isCrossRepository`. */
export function parseGhPrList(stdout: string): Map<string, PrFacts> {
  const map = new Map<string, PrFacts>()
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return map
  }
  if (!Array.isArray(parsed)) return map

  // Scope dedup to the (source repo, branch) pair so a fork PR cannot clobber a
  // same-origin PR that happens to share a head branch name. gh returns
  // newest-first; iterate reversed so the last write per (repo, branch) is the
  // newest — preserving "keep the newest PR per branch" within each repo.
  const byRepoBranch = new Map<string, PrCandidate>()
  for (let i = parsed.length - 1; i >= 0; i--) {
    const raw = parsed[i] as Record<string, unknown>
    if (!raw || typeof raw.headRefName !== 'string') continue
    const branch = raw.headRefName
    const rollup = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []
    const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN'
    const pr: PrFacts = {
      number: typeof raw.number === 'number' ? raw.number : 0,
      state,
      reviewDecision:
        typeof raw.reviewDecision === 'string' && raw.reviewDecision ? raw.reviewDecision : null,
      ci: worstCiState(rollup as Array<Record<string, unknown>>),
      mergedAt: typeof raw.mergedAt === 'string' ? raw.mergedAt : null,
      // Absent on every entry cached before BUG-93, and on any gh that did not
      // return the field. Null degrades an upstream-resolved PR to
      // `upstream-unverified`, i.e. to the pre-BUG-93 behaviour — safe, so the
      // cache version is deliberately NOT bumped for it (a bump would force
      // `complete: false` and re-open BUG-74's gap-fill storm for one field).
      headRefOid: typeof raw.headRefOid === 'string' && raw.headRefOid ? raw.headRefOid : null
    }
    // Branch names cannot contain ':' (git ref rule), so '::' is a safe key sep.
    byRepoBranch.set(`${headRepoId(raw) ?? ''}::${branch}`, {
      branch,
      pr,
      crossRepo: raw.isCrossRepository === true
    })
  }

  // Collapse to a branch-keyed map for the local-branch cross-reference,
  // preferring the same-origin (non-fork) PR whenever a branch name collides
  // across repos. At most one non-fork candidate can exist per branch (same
  // repo+branch dedups to one key above), so a non-fork always wins cleanly.
  const chosen = new Map<string, PrCandidate>()
  for (const cand of byRepoBranch.values()) {
    const existing = chosen.get(cand.branch)
    if (!existing || (existing.crossRepo && !cand.crossRepo)) {
      chosen.set(cand.branch, cand)
      map.set(cand.branch, cand.pr)
    }
  }
  return map
}

/**
 * The cap Harnu asks `gh pr list` for. gh paginates internally up to this many
 * rows, so one call exhausts any repo below the cap — the measured corpus that
 * motivated BUG-74 had 169 PRs against a cap of 100.
 */
export const PR_LIST_LIMIT = 1000

/**
 * The execFile budget for a bulk `gh pr list --json … statusCheckRollup`. It
 * lives here so the Reaper scan and the PR Stack canvas size the same query the
 * same way: the 15s network budget and 1 MiB buffer of an ordinary `gh` call do
 * not survive a hundred rows with their check rollups, and a timeout on this
 * call used to degrade to "GitHub CLI is unavailable" (BUG-148).
 */
export const GH_PR_LIST_OPTS = { windowsHide: true, timeout: 120_000, maxBuffer: 64 << 20 } as const

export interface GhPrListResult {
  prByBranch: Map<string, PrFacts>
  /**
   * Whether the list exhausted the repo's PRs. False when gh returned exactly
   * `limit` rows (the list was capped, so a branch's absence proves nothing)
   * and false when the output could not be counted at all (BUG-74).
   */
  complete: boolean
}

/**
 * Parses a `gh pr list` payload *and* reports whether it was capped.
 *
 * Completeness is counted over the RAW rows, not the returned map: the map
 * dedups to one PR per branch, so a repo whose limit-many rows collapse to
 * fewer branches would otherwise read as complete.
 */
export function parseGhPrListResult(stdout: string, limit: number): GhPrListResult {
  let rows: number | null = null
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (Array.isArray(parsed)) rows = parsed.length
  } catch {
    rows = null // malformed output — we cannot claim the set is exhaustive
  }
  return { prByBranch: parseGhPrList(stdout), complete: rows !== null && rows < limit }
}

// ---- gh disk cache entry (pure read side) ------------------------------------

/**
 * Bump whenever the entry shape changes. An entry written by an older Harnu
 * carries no `complete` flag, so trusting it would re-assert BUG-74 from cache
 * with no network call to correct it — {@link readGhCacheEntry} therefore reads
 * any entry that is not exactly this version as incomplete.
 */
export const GH_CACHE_VERSION = 2

/** Default lifetime of an individual per-branch lookup. */
export const GAP_FILL_TTL_MS = 7 * 24 * 60 * 60_000

/** One per-branch `gh pr list --head <branch>` result; `prs: []` is a real answer ("no PR"). */
export interface GhGapFill {
  probedAt: number
  /** The raw gh array for that branch, round-tripped through the same parser. */
  prs: unknown
}

export interface GhCacheEntry {
  /** Absent on entries written before BUG-74 — see {@link GH_CACHE_VERSION}. */
  version?: number
  fetchedAt: number
  /** The raw bulk `gh pr list` array. */
  prs: unknown
  /** Whether the bulk list was exhaustive. Absent ⇒ unknown ⇒ incomplete. */
  complete?: boolean
  /** Branch → individual lookup that filled a gap the bulk list left. */
  gapFills?: Record<string, GhGapFill>
}

export interface GhCacheRead {
  fetchedAt: number
  prByBranch: Map<string, PrFacts>
  /** Whether the cached bulk set is authoritative about a branch's absence. */
  complete: boolean
  /** Branches with a definitive individual answer — a hit *or* a proven miss. */
  probed: Set<string>
  /** The still-fresh gap fills, to be carried forward when the bulk list refreshes. */
  gapFills: Record<string, GhGapFill>
}

/**
 * Folds per-branch gap fills into a bulk-derived branch map, in place.
 *
 * The bulk window wins on a collision: it is the fresher of the two, and a
 * branch present in it was never a gap in the first place.
 */
export function mergeGapFills(
  prByBranch: Map<string, PrFacts>,
  gapFills: Record<string, GhGapFill>
): Map<string, PrFacts> {
  for (const [branch, fill] of Object.entries(gapFills)) {
    if (prByBranch.has(branch)) continue
    const found = parseGhPrList(JSON.stringify(fill.prs ?? [])).get(branch)
    if (found) prByBranch.set(branch, found)
  }
  return prByBranch
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Reads one cache entry into scan facts, or null when it is unusable.
 *
 * A wrong-version (or versionless) entry keeps its PRs — those are real PRs —
 * but is forced `complete: false` and has its gap fills dropped, since their
 * shape is not known to be the current one. Expired gap fills are dropped the
 * same way; an unexpired one is authoritative even when its `prs` is empty,
 * which is exactly the "this branch genuinely has no PR" answer that stops the
 * next scan re-running the same 15-second lookup (BUG-74).
 */
export function readGhCacheEntry(
  raw: unknown,
  now: number,
  gapTtlMs = GAP_FILL_TTL_MS
): GhCacheRead | null {
  const entry = asRecord(raw)
  if (!entry || typeof entry.fetchedAt !== 'number') return null
  const current = entry.version === GH_CACHE_VERSION
  const prByBranch = parseGhPrList(JSON.stringify(entry.prs ?? []))
  const complete = current && entry.complete === true

  const probed = new Set<string>()
  const gapFills: Record<string, GhGapFill> = {}
  const rawFills = current ? asRecord(entry.gapFills) : null
  if (rawFills) {
    for (const [branch, value] of Object.entries(rawFills)) {
      const fill = asRecord(value)
      if (!fill || typeof fill.probedAt !== 'number') continue
      if (now - fill.probedAt >= gapTtlMs) continue
      gapFills[branch] = { probedAt: fill.probedAt, prs: fill.prs ?? [] }
      probed.add(branch)
    }
    mergeGapFills(prByBranch, gapFills)
  }
  return { fetchedAt: entry.fetchedAt, prByBranch, complete, probed, gapFills }
}

/**
 * How many individual `--head` lookups one repo may spend per scan filling the
 * gaps a capped bulk list left. Each is a network round trip, so the budget is
 * small; what it does not reach stays honestly `unknown` rather than being
 * asserted to have no PR, and later scans work through the remainder.
 */
export const GAP_FILL_BUDGET = 25

/**
 * Which branches are worth an individual PR lookup this scan.
 *
 * Skips anything already answered — a branch found in the bulk list, and a
 * branch already *probed*, including one probed and proven to have no PR. That
 * second skip is the whole reason misses are cached: without it an hourly scan
 * would re-run the same 124 fruitless 15-second lookups forever (BUG-74).
 */
export function gapFillCandidates(
  branches: readonly string[],
  prByBranch: ReadonlyMap<string, PrFacts>,
  probed: ReadonlySet<string>,
  budget = GAP_FILL_BUDGET
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const branch of branches) {
    if (out.length >= budget) break
    if (seen.has(branch) || prByBranch.has(branch) || probed.has(branch)) continue
    seen.add(branch)
    out.push(branch)
  }
  return out
}

/** Parses `ls-remote --heads origin` output into a map of short branch name → OID. */
export function parseLsRemoteHeads(stdout: string): Map<string, string> {
  const out = new Map<string, string>()
  const prefix = 'refs/heads/'
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length !== 2) continue
    const [oid, ref] = parts
    if (!oid || !ref.startsWith(prefix)) continue
    out.set(ref.slice(prefix.length), oid)
  }
  return out
}

// ---- squash-equivalence probe (BUG-93, pure half) ----------------------------

/**
 * How many commits of the default branch the containment probe compares a branch
 * against.
 *
 * Bounded because the history side is one `git log -p` over the whole window and
 * a repo's default branch is unbounded. A squash commit lands on the default
 * branch within a handful of commits of the branch it collapsed (the measured
 * corpus sat 30–65 commits behind), so the window is generous; a branch whose
 * squash landed beyond it simply stays unproven, which is the safe direction —
 * the probe is positive-only evidence.
 */
export const SQUASH_PROBE_HISTORY = 500

/**
 * The two argv the probe runs to read the default branch's patch ids, piped
 * child-to-child so the diff never lands in Node's heap.
 *
 * Exported so "the scan writes no git objects" is a unit test over the commands
 * themselves. The spec's own recipe used `git commit-tree`, which creates a real
 * dangling object in every repo Harnu knows on every hourly tick; this yields the
 * same evidence and writes nothing.
 */
export function squashHistoryArgv(
  repoPath: string,
  defaultBranch: string
): { log: string[]; patchId: string[] } {
  return {
    log: [
      '-C',
      repoPath,
      'log',
      '--no-merges',
      `--max-count=${SQUASH_PROBE_HISTORY}`,
      '-p',
      `origin/${defaultBranch}`
    ],
    patchId: ['-C', repoPath, 'patch-id', '--stable']
  }
}

/**
 * The two argv that reduce one branch to a single patch id: its net diff against
 * the merge-base with the default branch (`...`, three dots), hashed. That net
 * diff is exactly what a squash merge collapses onto the default branch, which
 * is why one id can match one squash commit.
 *
 * Uses the *resolved* default branch — it may be `master` or `develop`; never
 * transcribe `origin/main`.
 */
export function squashBranchArgv(
  repoPath: string,
  defaultBranch: string,
  branch: string
): { diff: string[]; patchId: string[] } {
  return {
    diff: ['-C', repoPath, 'diff', `origin/${defaultBranch}...${branch}`],
    patchId: ['-C', repoPath, 'patch-id', '--stable']
  }
}

/** Reads the first field of every `git patch-id` line into a set of patch ids. */
export function parsePatchIdSet(stdout: string): Set<string> {
  const out = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.trim().split(/\s+/)[0]
    if (id) out.add(id)
  }
  return out
}

/** The single patch id `git patch-id` printed, or null when it printed nothing. */
export function parsePatchId(stdout: string): string | null {
  const id = stdout.trim().split(/\s+/)[0]
  return id ? id : null
}

/**
 * Containment verdict for one branch: does its net-diff patch id appear among the
 * default branch's?
 *
 * Two rules the spec requires be implemented, not merely noted:
 *
 *  1. **Positive-only.** A match proves containment. A miss proves nothing — a
 *     merge that resolved conflicts alters the diff, and the history window is
 *     bounded — so `false` here means "not proven", and no red is ever derived
 *     from it (see `BranchFacts.patchIdContained`).
 *  2. **Empty output is not containment.** A branch whose net diff against the
 *     merge-base is empty — a commit plus its revert — makes `git patch-id`
 *     print nothing at all, and the natural reading ("nothing listed, therefore
 *     contained") would make that a false positive. Empty is `false`.
 */
export function isPatchIdContained(branchStdout: string, history: ReadonlySet<string>): boolean {
  const id = parsePatchId(branchStdout)
  if (id === null) return false
  return history.has(id)
}

// ---- upstream-resolved PRs (BUG-93, the guarded fallback) --------------------

/** The remote whose branches are this repo's PR heads; the only upstream we follow. */
const ORIGIN_PREFIX = 'origin/'

/**
 * Resolves the PR for one local branch, and reports how it was found.
 *
 * The branch's own name first — that path is untouched and always
 * `'own-name'`. Only when it comes up empty do we follow `%(upstream:short)`,
 * which `parseForEachRef` has always captured and `buildRepoItems` never read.
 *
 * The fallback is **headroom, not a measured win**: on the corpus that motivated
 * it, its own example fails the guard below (tip `f6e35d90` against a PR head of
 * `b1791f29`), so it recovers nothing there. It is ranked accordingly — an
 * uncorroborated hit cannot mint a merge signal on its own, only patch-id
 * containment can promote it, so the squash probe strictly outranks it.
 *
 * Only `origin/` upstreams are followed: a branch tracking some other remote is
 * not a head of this repo's PRs, and guessing otherwise is how the fallback
 * turns into data loss.
 */
export function resolvePrForBranch(
  prByBranch: Map<string, PrFacts> | null,
  branch: string,
  upstream: string | null,
  localSha: string | null
): { pr: PrFacts | null; provenance: PrProvenance } {
  const own = prFor(prByBranch, branch)
  if (own) return { pr: own, provenance: 'own-name' }
  if (!upstream || !upstream.startsWith(ORIGIN_PREFIX)) return { pr: null, provenance: 'own-name' }
  const upstreamBranch = upstream.slice(ORIGIN_PREFIX.length)
  if (!upstreamBranch || upstreamBranch === branch) return { pr: null, provenance: 'own-name' }
  const viaUpstream = prFor(prByBranch, upstreamBranch)
  if (!viaUpstream) return { pr: null, provenance: 'own-name' }
  const corroborated =
    viaUpstream.headRefOid !== null && localSha !== null && viaUpstream.headRefOid === localSha
  return {
    pr: viaUpstream,
    provenance: corroborated ? 'upstream-corroborated' : 'upstream-unverified'
  }
}

/** Whether a gh PR cache entry fetched at `fetchedAt` is still fresh at `now` (default TTL 30min). */
export function ghCacheFresh(fetchedAt: number, now: number, ttlMs = 30 * 60_000): boolean {
  return now - fetchedAt < ttlMs
}

export interface RepoScanInput {
  repoPath: string
  defaultBranch: string
  protectedBranches: string[]
  worktrees: WorktreeListEntry[]
  mainWorktreePath: string
  localBranches: LocalBranchRef[]
  /** Short branch name → remote OID (from `ls-remote`), or null when the probe failed. */
  remoteHeads: Map<string, string> | null
  prByBranch: Map<string, PrFacts> | null
  ghAvailable: boolean
  /**
   * Whether the bulk PR list was exhaustive. False when gh capped it (BUG-74):
   * a branch missing from a capped list gets `prSetComplete: false` and its PR
   * checkpoints resolve to `unknown`, never `na`.
   *
   * Required, deliberately: an optional flag defaulting to "complete" would let
   * a caller re-introduce BUG-74 by simply forgetting the field.
   */
  prSetComplete: boolean
  /**
   * Branches resolved by an individual `--head` lookup, hit or miss. Such a
   * branch is authoritative on its own even when the bulk list was capped.
   */
  prProbedBranches?: Set<string>
  hiddenPaths: string[]
  liveFolders: Set<string>
  /**
   * Worktree status keyed by path — tracked-dirtiness and the untracked list,
   * split (BUG-75). `null` means the probe failed for that path, which the
   * classifier reads as "unknown", exactly as the old `dirty: null` did.
   */
  statusByPath: Map<string, WorktreeStatus | null>
  unpushedByPath: Map<string, boolean | null>
  ancestorByBranch: Map<string, boolean | null>
  /**
   * Patch-id containment keyed by branch — the squash-merge signal (BUG-93).
   * `true` proves the branch's net diff is already in the default branch; a
   * missing key or `null` means the probe did not run for it, and `false` means
   * it ran and proved nothing. Only `true` is ever acted on.
   *
   * Required, deliberately, for the same reason `prSetComplete` is: an optional
   * map is a field a future caller forgets, and forgetting it silently restores
   * the gap this card exists to close.
   */
  patchIdContainedByBranch: Map<string, boolean | null>
  /**
   * Commit date (ms since epoch) keyed by commit sha — the only way to age a
   * detached HEAD, which has no branch ref for `for-each-ref` to date. Optional:
   * absent means "not probed", and the detached item reports a null age.
   */
  commitDateBySha?: Map<string, number | null>
  /**
   * Measured checkout size in bytes keyed by worktree path. Optional; absent
   * means "not measured" and the item reports a null disk figure.
   */
  diskBytesByPath?: Map<string, number | null>
  now: number
}

function remoteExistsFor(remoteHeads: Map<string, string> | null, branch: string): boolean | null {
  return remoteHeads === null ? null : remoteHeads.has(branch)
}

function remoteShaFor(remoteHeads: Map<string, string> | null, branch: string): string | null {
  return remoteHeads ? (remoteHeads.get(branch) ?? null) : null
}

function prFor(prByBranch: Map<string, PrFacts> | null, branch: string): PrFacts | null {
  return prByBranch ? (prByBranch.get(branch) ?? null) : null
}

/**
 * Whether the PR set is authoritative about *this* branch: either the bulk list
 * exhausted the repo, or this branch was resolved by its own lookup (BUG-74).
 */
function prSetCompleteFor(
  setComplete: boolean,
  probed: Set<string> | undefined,
  branch: string
): boolean {
  return setComplete || probed?.has(branch) === true
}

export function buildRepoItems(input: RepoScanInput): ReapItem[] {
  const {
    repoPath,
    defaultBranch,
    protectedBranches,
    worktrees,
    mainWorktreePath,
    localBranches,
    remoteHeads,
    prByBranch,
    ghAvailable,
    prSetComplete,
    prProbedBranches,
    hiddenPaths,
    liveFolders,
    statusByPath,
    unpushedByPath,
    ancestorByBranch,
    patchIdContainedByBranch,
    commitDateBySha,
    diskBytesByPath,
    now
  } = input

  const protectedSet = new Set([defaultBranch, ...protectedBranches])
  const hiddenSet = new Set(hiddenPaths)
  const branchToWorktree = new Map<string, WorktreeListEntry>()
  // A worktree with no branch (detached HEAD) cannot be keyed by branch and used
  // to be dropped here entirely — 15 of 48 entries and 36% of the checkout disk
  // on the corpus measured 2026-08-28 (BUG-95). It gets its own item instead.
  const detachedWorktrees: WorktreeListEntry[] = []

  for (const w of worktrees) {
    if (w.bare) continue
    if (w.path === mainWorktreePath) continue
    if (w.detached || !w.branch) {
      detachedWorktrees.push(w)
      continue
    }
    if (protectedSet.has(w.branch)) continue
    branchToWorktree.set(w.branch, w)
  }

  const items: ReapItem[] = []

  // Detached first, and deliberately through a separate pure classifier: no
  // branch means no PR lookup, no ancestry read and no upstream — there is no
  // branch name to key any of them on.
  for (const w of detachedWorktrees) {
    items.push(
      classifyDetachedWorktree(
        {
          repoPath,
          path: w.path,
          head: w.head,
          hidden: hiddenSet.has(w.path),
          sessionLive: liveFolders.has(w.path),
          lastCommitAt: commitDateBySha?.get(w.head) ?? null,
          diskBytes: diskBytesByPath?.get(w.path) ?? null
        },
        now
      )
    )
  }
  const localByBranch = new Map(localBranches.map((r) => [r.branch, r]))

  for (const [branch, w] of branchToWorktree) {
    const localRef = localByBranch.get(branch) ?? null
    const hidden = hiddenSet.has(w.path)
    const status = statusByPath.get(w.path) ?? null
    const resolved = resolvePrForBranch(
      prByBranch,
      branch,
      localRef?.upstream ?? null,
      localRef?.sha ?? null
    )
    const facts: BranchFacts = {
      kind: hidden ? 'hidden-folder' : 'worktree',
      repoPath,
      branch,
      path: w.path,
      hidden,
      sessionLive: liveFolders.has(w.path),
      trackedDirty: status?.trackedDirty ?? null,
      untracked: status?.untracked ?? [],
      unpushed: unpushedByPath.get(w.path) ?? null,
      remoteExists: remoteExistsFor(remoteHeads, branch),
      remoteSha: remoteShaFor(remoteHeads, branch),
      ancestorOfDefault: ancestorByBranch.get(branch) ?? null,
      patchIdContained: patchIdContainedByBranch.get(branch) ?? null,
      lastCommitAt: localRef?.committedAt ?? null,
      pr: resolved.pr,
      ghAvailable,
      prSetComplete: prSetCompleteFor(prSetComplete, prProbedBranches, branch),
      prProvenance: resolved.provenance
    }
    items.push(classify(facts, now))
  }

  for (const ref of localBranches) {
    if (protectedSet.has(ref.branch)) continue
    if (branchToWorktree.has(ref.branch)) continue
    const resolved = resolvePrForBranch(prByBranch, ref.branch, ref.upstream, ref.sha)
    const facts: BranchFacts = {
      kind: 'local-branch',
      repoPath,
      branch: ref.branch,
      path: undefined,
      hidden: false,
      sessionLive: false,
      trackedDirty: null,
      untracked: [],
      unpushed: null,
      remoteExists: remoteExistsFor(remoteHeads, ref.branch),
      remoteSha: remoteShaFor(remoteHeads, ref.branch),
      ancestorOfDefault: ancestorByBranch.get(ref.branch) ?? null,
      patchIdContained: patchIdContainedByBranch.get(ref.branch) ?? null,
      lastCommitAt: ref.committedAt,
      pr: resolved.pr,
      ghAvailable,
      prSetComplete: prSetCompleteFor(prSetComplete, prProbedBranches, ref.branch),
      prProvenance: resolved.provenance
    }
    items.push(classify(facts, now))
  }

  if (remoteHeads) {
    const localBranchNames = new Set(localBranches.map((r) => r.branch))
    for (const [branch, remoteSha] of remoteHeads) {
      if (protectedSet.has(branch)) continue
      if (branchToWorktree.has(branch)) continue
      if (localBranchNames.has(branch)) continue
      const pr = prFor(prByBranch, branch)
      if (!pr) continue // pure remote orphans without PR context stay invisible
      const facts: BranchFacts = {
        kind: 'remote-branch',
        repoPath,
        branch,
        path: undefined,
        hidden: false,
        sessionLive: false,
        trackedDirty: null,
        untracked: [],
        unpushed: null,
        remoteExists: true,
        remoteSha,
        ancestorOfDefault: ancestorByBranch.get(branch) ?? null,
        patchIdContained: patchIdContainedByBranch.get(branch) ?? null,
        lastCommitAt: null,
        pr,
        ghAvailable,
        // A remote-branch item only exists when a PR was found for it, so the
        // set is authoritative about it by construction.
        prSetComplete: true,
        // Found by this branch's own name, above — there is no local ref here to
        // carry an upstream, so the fallback never applies.
        prProvenance: 'own-name'
      }
      items.push(classify(facts, now))
    }
  }

  return items
}

export interface ReaperSnapshot {
  scannedAt: number
  repos: Array<{ repoPath: string; items: ReapItem[] }>
}

export function snapshotTotals(snap: ReaperSnapshot): {
  items: number
  harvestable: number
  reclaimableBytes: number
} {
  let items = 0
  let harvestable = 0
  let reclaimableBytes = 0
  for (const repo of snap.repos) {
    for (const item of repo.items) {
      items++
      if (item.verdict === 'harvestable') {
        harvestable++
        reclaimableBytes += item.diskBytes ?? 0
      }
    }
  }
  return { items, harvestable, reclaimableBytes }
}

export function newlyHarvestable(prev: ReaperSnapshot | null, next: ReaperSnapshot): ReapItem[] {
  const prevVerdicts = new Map<string, ReapVerdict>()
  if (prev) {
    for (const repo of prev.repos) {
      for (const item of repo.items) prevVerdicts.set(item.id, item.verdict)
    }
  }
  const result: ReapItem[] = []
  for (const repo of next.repos) {
    for (const item of repo.items) {
      if (item.verdict !== 'harvestable') continue
      if (prevVerdicts.get(item.id) !== 'harvestable') result.push(item)
    }
  }
  return result
}
