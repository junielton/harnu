/**
 * T198 — PR Stack Canvas: the imperative shell.
 *
 * Gathers the real `gh`/`git` state for ONE repo and hands it to the pure
 * `pr-stack-core` to assemble the merge graph. No decision logic lives here:
 * which PR is a staging tip, which is merge-next, and where a card sits are
 * all decided in the core.
 *
 * env-bound (`child_process` + electron `ipcMain`) ⇒ e2e-only per ADR-0001;
 * the logic surface is unit-tested in `tests/pr-stack-core.test.ts`.
 */

import { execFile, type ExecFileOptions } from 'node:child_process'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { ipcMain } from 'electron'
import { spawnEnvOnce } from './appimage-env'
import {
  UNSURE,
  readHead,
  readRef,
  readSymbolicRef,
  resolveGitDirs,
  type GitDirs
} from './git/refs'
import { isOpenPrViewJson, matchPrLinkToRemote } from './github-remote'
import { ciOfRuns, type CiRun, type GateCi } from './mission-gates'
import { readPrefs, writePrefs, type PrStackPrefs } from './pr-stack-prefs'
import { GH_PR_LIST_OPTS } from './reaper/scan-core'
import {
  parsePrList,
  buildGraph,
  layoutGraph,
  graphEdges,
  kpis,
  shapeKey,
  parseReviewThreads,
  withReviewThreads,
  PR_LIST_LIMIT,
  REVIEW_THREADS_QUERY,
  behindBaseRef,
  parseBehindCount,
  classifyGhFailure,
  type GhFailure,
  type PrEntry,
  type PrGraph,
  type PrStackSnapshot,
  type PrThreadCounts,
  type WorktreeNode
} from './pr-stack-core'

export type { PrStackSnapshot }

const execFileAsync = promisify(execFile)

/**
 * Every subprocess on this path goes through here so it is spawned with the
 * user's login-shell PATH (BUG-34). A Dock-launched macOS build inherits
 * launchd's minimal PATH, which has no `/opt/homebrew/bin` — bare `gh` is then
 * ENOENT and the canvas reports "GitHub CLI is unavailable here" to a user
 * whose `gh` is installed and authenticated.
 */
async function runFile(
  file: string,
  args: readonly string[],
  opts: Omit<ExecFileOptions, 'env'>
): Promise<{ stdout: string }> {
  // `encoding` is pinned so the promisified overload resolves to the string
  // form (utf8 is execFile's own default — no behavior change).
  return execFileAsync(file, [...args], {
    ...opts,
    encoding: 'utf8',
    env: await spawnEnvOnce()
  })
}

const GIT_OPTS = { windowsHide: true, timeout: 30_000, maxBuffer: 1 << 20 } as const
/** Budget for the small `gh api graphql` thread query. The PR list uses `GH_PR_LIST_OPTS`. */
const GH_OPTS = { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 22 } as const

/**
 * The fields the canvas needs. `baseRefName` is the one that matters — it is
 * the entire DAG, and the only reason this query differs in kind from the one
 * the Reaper already runs.
 *
 * The second block is T280's widening: every remaining signal the card row
 * wants, asked for ONCE. Appending a name here costs no extra round trip and
 * no extra rate-limit point (spec §3.1), so the query is deliberately wider
 * than what is drawn today — the render units that consume these fields land
 * afterwards, against a `PrEntry` that already carries them.
 */
const GH_FIELDS = [
  'number',
  'title',
  'headRefName',
  'baseRefName',
  'state',
  'isDraft',
  'mergeable',
  'reviewDecision',
  'statusCheckRollup',
  'url',
  'author',
  'updatedAt',
  'createdAt',
  'mergedAt',
  'mergeStateStatus',
  'additions',
  'deletions',
  'changedFiles',
  'reviewRequests',
  'labels',
  'autoMergeRequest'
].join(',')

/** BUG-240: every cache below holds at most this many entries; the oldest insertion goes first. */
const CACHE_MAX = 512

/** A `Map` that evicts its oldest insertion once it holds {@link CACHE_MAX} entries. */
class BoundedCache<V> {
  private readonly map = new Map<string, V>()
  get(key: string): V | undefined {
    return this.map.get(key)
  }
  set(key: string, value: V): void {
    this.map.delete(key)
    if (this.map.size >= CACHE_MAX) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, value)
  }
  delete(key: string): void {
    this.map.delete(key)
  }
  clear(): void {
    this.map.clear()
  }
}

/**
 * Single-flight memo: concurrent callers of one `key` await ONE promise. A rejection is
 * never kept, and neither is a value `keep` refuses (a "could not tell" answer), so the
 * next caller asks again.
 */
function singleFlight<V>(
  cache: BoundedCache<Promise<V>>,
  key: string,
  compute: () => Promise<V>,
  keep: (value: V) => boolean = () => true
): Promise<V> {
  const hit = cache.get(key)
  if (hit) return hit
  const flight = compute()
  cache.set(key, flight)
  flight.then(
    (value) => {
      if (!keep(value) && cache.get(key) === flight) cache.delete(key)
    },
    () => {
      if (cache.get(key) === flight) cache.delete(key)
    }
  )
  return flight
}

const headCache = new BoundedCache<Promise<Omit<WorktreePrJoin, 'prs'>>>()
const aheadCache = new BoundedCache<Promise<number | undefined>>()
const mergeOidCache = new BoundedCache<Promise<string | null>>()
const verdictCache = new BoundedCache<{
  settledAt: number | null
  ttlMs: number
  result: Promise<GateCi>
}>()
const defaultBranchCache = new BoundedCache<{ at: number; name: Promise<string> }>()

/** Test seam: forget everything the git/gh join caches hold. */
export function resetGitJoinCachesForTest(): void {
  headCache.clear()
  aheadCache.clear()
  mergeOidCache.clear()
  verdictCache.clear()
  defaultBranchCache.clear()
  prCache.clear()
}

/** How long a repo with no `origin/HEAD` keeps its `main` fallback before asking git again. */
const NO_ORIGIN_HEAD_TTL_MS = 10 * 60_000

/** Today's answer: ask git for the repo's default branch, falling back to `main`. */
async function defaultBranchFromGit(repoPath: string): Promise<string> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      GIT_OPTS
    )
    const short = stdout.trim()
    if (!short) return 'main'
    return short.startsWith('origin/') ? short.slice('origin/'.length) : short
  } catch {
    return 'main'
  }
}

/**
 * Resolves the repo's default branch, falling back to `main`.
 *
 * BUG-240: `origin/HEAD` is read from the repo's own file, so the answer follows it the
 * moment it moves and costs no spawn. A repo without one (or one this reader cannot
 * judge) asks git, and the former keeps its `main` fallback for 10 minutes.
 */
async function defaultBranchOf(repoPath: string): Promise<string> {
  const dirs = await resolveGitDirs(repoPath)
  if (dirs === null || dirs === UNSURE) return defaultBranchFromGit(repoPath)
  const target = await readSymbolicRef(dirs, 'refs/remotes/origin/HEAD')
  if (target === UNSURE) return defaultBranchFromGit(repoPath)
  if (target !== null) {
    const name = target.startsWith('refs/remotes/origin/')
      ? target.slice('refs/remotes/origin/'.length)
      : ''
    return name || defaultBranchFromGit(repoPath)
  }
  const hit = defaultBranchCache.get(dirs.commonDir)
  if (hit && Date.now() - hit.at < NO_ORIGIN_HEAD_TTL_MS) return hit.name
  const entry = { at: Date.now(), name: defaultBranchFromGit(repoPath) }
  defaultBranchCache.set(dirs.commonDir, entry)
  return entry.name
}

/** One `gh pr list` answer: the PRs, whether `gh` is usable, and why a usable one failed. */
type PrFetch = { prs: PrEntry[]; ghAvailable: boolean; ghFailure: GhFailure | null }

/**
 * `ghAvailable: false` is reserved for "gh genuinely cannot be used here" (no
 * binary, no login, not a GitHub remote). A slow or failed answer from a usable
 * `gh` is `ghFailure` instead: the caller must treat `prs: []` there as "unknown",
 * not "no PRs" (BUG-148). Sized with the Reaper's bulk-list budget, which the
 * old 15s / 4 MiB one could not survive.
 */
async function fetchPrs(repoPath: string): Promise<PrFetch> {
  try {
    const { stdout } = await runFile(
      'gh',
      ['pr', 'list', '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', GH_FIELDS],
      { ...GH_PR_LIST_OPTS, cwd: repoPath }
    )
    return { prs: parsePrList(stdout), ghAvailable: true, ghFailure: null }
  } catch (err) {
    // Degrade to an empty result rather than an error dialog; the snapshot
    // carries WHY so the store can keep the last good canvas.
    const failure = classifyGhFailure(err)
    return { prs: [], ghAvailable: failure !== null, ghFailure: failure }
  }
}

/** How long one `gh pr list` serves the mission reads of a repo (Mission v3 §3.8). */
const PR_CACHE_TTL_MS = 60_000

/** Per repo root: the fetch in flight, or the last good one and when it landed. */
const prCache = new Map<string, { settledAt: number | null; result: Promise<PrFetch> }>()

/**
 * Mission v3 §3.8 — {@link fetchPrs} for the mission reads: a single-flight
 * promise per repo root, kept {@link PR_CACHE_TTL_MS} after it lands. Every
 * `mission_get`, every `mission:list` derive and every door re-derive (MCP and
 * IPC run in this one main process) share it, so a list pass over a repo's
 * missions costs one `gh` round trip, not one per mission. A failure is not
 * kept: the next read retries. The canvas keeps its own fresh fetch.
 */
function fetchPrsCached(repoPath: string): Promise<PrFetch> {
  const key = path.resolve(repoPath)
  const hit = prCache.get(key)
  if (hit && (hit.settledAt === null || Date.now() - hit.settledAt < PR_CACHE_TTL_MS)) {
    return hit.result
  }
  const entry = { settledAt: null as number | null, result: fetchPrs(key) }
  prCache.set(key, entry)
  void entry.result.then((r) => {
    if (prCache.get(key) !== entry) return
    if (r.ghAvailable && r.ghFailure === null) entry.settledAt = Date.now()
    else prCache.delete(key)
  })
  return entry.result
}

/** `pending`, or the "gh could not answer in time" result once `ms` elapses. */
async function withinBudget(pending: Promise<PrFetch>, ms: number | undefined): Promise<PrFetch> {
  if (ms === undefined) return pending
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<PrFetch>((resolve) => {
    timer = setTimeout(() => resolve({ prs: [], ghAvailable: false, ghFailure: null }), ms)
  })
  try {
    return await Promise.race([pending, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * T275 — unresolved review threads for every open PR, in ONE `gh api graphql`
 * call (1 rate-limit point for the whole repo — see `REVIEW_THREADS_QUERY`).
 * `gh pr list --json` has no field for thread resolution; it exists only on
 * GraphQL's `reviewThreads`.
 *
 * Degrades exactly like {@link fetchPrs}: a missing or unauthenticated `gh`, a
 * spent rate limit, or a non-GitHub remote (the `{owner}`/`{repo}` placeholders
 * then fail to resolve) is `null` — no thread data, an unchanged canvas — and
 * never a throw.
 */
async function fetchReviewThreads(repoPath: string): Promise<Map<number, PrThreadCounts> | null> {
  try {
    const { stdout } = await runFile(
      'gh',
      [
        'api',
        'graphql',
        '-F',
        'owner={owner}',
        '-F',
        'name={repo}',
        '-f',
        `query=${REVIEW_THREADS_QUERY}`
      ],
      { ...GH_OPTS, cwd: repoPath }
    )
    return parseReviewThreads(stdout)
  } catch {
    return null
  }
}

/**
 * How many commits each PR branch is behind its base — the "4 behind" chip's
 * magnitude. Best-effort and individually guarded.
 *
 * A measured `0` IS recorded (T274): it is the only evidence the card has for
 * "up to date". A branch that is not fetched locally has no key at all, which
 * the card reads as "could not measure locally" — never as zero. Whether the
 * chip shows at all is decided with GitHub's `mergeStateStatus`
 * (`prBehindState()` in `pr-stack-format.ts`); this count only enriches it.
 * The yardstick is the PR's own base (`behindBaseRef()`), and both it and the
 * parse (`parseBehindCount()`) are unit-tested in `pr-stack-core`.
 */
async function behindCounts(repoPath: string, graph: PrGraph): Promise<Record<number, number>> {
  const out: Record<number, number> = {}
  await Promise.all(
    graph.nodes.map(async (node) => {
      const base = behindBaseRef(node, graph.defaultBranch)
      try {
        const { stdout } = await runFile(
          'git',
          ['-C', repoPath, 'rev-list', '--count', `${node.pr.branch}..${base}`],
          GIT_OPTS
        )
        const n = parseBehindCount(stdout)
        if (n !== null) out[node.pr.number] = n
      } catch {
        /* branch not present locally — no count, and that is not an error */
      }
    })
  )
  return out
}

/**
 * Builds the snapshot for one repo.
 *
 * `worktrees` is supplied by the caller (the Reaper snapshot already knows
 * every worktree and its {@link import('./reaper/reaper-core').ReapVerdict}),
 * so the verdict is never recomputed here — the canvas and the Cleanup view
 * must never disagree about whether a worktree is done with.
 */
export async function loadPrStack(
  repoPath: string,
  worktrees: WorktreeNode[] = []
): Promise<PrStackSnapshot> {
  // Started first and awaited last: the thread query overlaps the branch
  // probe, `gh pr list` and the behind fan-out instead of queueing after them,
  // so it costs a refresh no extra wall-clock beyond its own round trip.
  const threadsPending = fetchReviewThreads(repoPath)
  const defaultBranch = await defaultBranchOf(repoPath)
  const { prs, ghAvailable, ghFailure } = await fetchPrs(repoPath)
  const topology = buildGraph(prs, defaultBranch)
  const { placements, width, height } = layoutGraph(topology)
  const [behind, threads] = await Promise.all([behindCounts(repoPath, topology), threadsPending])
  const graph = withReviewThreads(topology, threads)

  return {
    repoPath,
    defaultBranch,
    graph,
    placements,
    edges: graphEdges(graph, worktrees),
    // A harvestable worktree leaves the graph for the tray; live ones stay.
    worktrees,
    kpis: kpis(graph),
    world: { width, height },
    shape: shapeKey(graph),
    fetchedAt: Date.now(),
    ghAvailable,
    ghFailure,
    behind
  }
}

/** A linked worktree's git state plus the PRs whose head is its branch (T358 S6). */
export interface WorktreePrJoin {
  exists: boolean
  /** `null` for a detached HEAD or a path git cannot read. */
  branch: string | null
  head: { sha: string; subject: string; at: string } | null
  /**
   * T547: commits on this worktree's HEAD beyond its step's base — the branch
   * its open PR merges into, else the repo's default branch. Absent when git
   * could not count — never `0` for "unknown".
   */
  commits?: number
  prs: PrEntry[]
}

/** {@link findPrsForWorktrees}'s answer, keyed by the refs it was asked about. */
export interface MissionPrJoin {
  /** `null` when nothing needed `gh` (it was never called); `false` when it is absent or failed. */
  ghAvailable: boolean | null
  worktrees: Record<string, WorktreePrJoin>
  branches: Record<string, PrEntry[]>
  /** `null` for a number not in the repo's recent PRs (or when `gh` is unavailable). */
  numbers: Record<number, PrEntry | null>
}

/** Today's count: the first base ref that resolves wins; `undefined` when none does. */
async function commitsAheadFromGit(
  worktreePath: string,
  bases: readonly string[]
): Promise<number | undefined> {
  for (const base of bases) {
    for (const ref of [`origin/${base}`, base]) {
      try {
        const { stdout } = await runFile(
          'git',
          ['-C', worktreePath, 'rev-list', '--count', `${ref}..HEAD`],
          GIT_OPTS
        )
        const n = Number(stdout.trim())
        if (Number.isInteger(n) && n >= 0) return n
      } catch {
        /* this base ref does not exist here — try the next */
      }
    }
  }
  return undefined
}

/** The sha `HEAD` points at, read from the git dir; `UNSURE` / `null` when it cannot be. */
async function headShaOf(
  dirs: GitDirs
): Promise<{ sha: string; symbolic: string } | typeof UNSURE | null> {
  const head = await readHead(dirs)
  if (head === UNSURE) return UNSURE
  if (head.kind === 'detached') return { sha: head.sha, symbolic: 'detached' }
  const sha = await readRef(dirs, head.ref)
  if (sha === UNSURE) return UNSURE
  return sha === null ? null : { sha, symbolic: head.ref }
}

/**
 * Commits HEAD holds beyond `base` — the branch the step's open PR merges into,
 * else the repo's default branch — or `undefined` when no base ref resolves here
 * (a fresh clone with neither `origin/<base>` nor the local branch). A stacked
 * unit therefore counts only its own commits, not its parents'.
 * `origin/<base>` wins over the local branch: the local one may have moved.
 *
 * BUG-240: the answer is a pure function of HEAD's sha and of every ref a candidate
 * name can resolve to, so it is cached under exactly those. Anything the ref reader
 * cannot judge runs the spawn loop and stores nothing.
 */
async function commitsAhead(
  worktreePath: string,
  prBase: string | undefined
): Promise<number | undefined> {
  const defaultBranch = await defaultBranchOf(worktreePath)
  const bases = [prBase, defaultBranch].filter(
    (b, i, all): b is string => !!b && all.indexOf(b) === i
  )
  const dirs = await resolveGitDirs(worktreePath)
  if (dirs === null || dirs === UNSURE) return commitsAheadFromGit(worktreePath, bases)
  const head = await headShaOf(dirs)
  if (head === null || head === UNSURE) return commitsAheadFromGit(worktreePath, bases)

  // Every ref `git rev-list <name>..HEAD` could resolve `<name>` through.
  const names = bases.flatMap((b) => [`origin/${b}`, b])
  const shas: string[] = []
  for (const name of names) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/tags/${name}`]) {
      const sha = await readRef(dirs, ref)
      if (sha === UNSURE) return commitsAheadFromGit(worktreePath, bases)
      shas.push(sha ?? 'missing')
    }
  }
  const key = [dirs.commonDir, head.sha, prBase ?? '', defaultBranch, shas.join(',')].join('\0')
  return singleFlight(aheadCache, key, () => commitsAheadFromGit(worktreePath, bases))
}

/** Branch + head commit of one worktree path, asked of git (two spawns). */
async function worktreeHeadFromGit(worktreePath: string): Promise<Omit<WorktreePrJoin, 'prs'>> {
  try {
    const { stdout } = await runFile(
      'git',
      ['-C', worktreePath, 'log', '-1', '--format=%H%x00%s%x00%cI'],
      GIT_OPTS
    )
    const [sha = '', subject = '', at = ''] = stdout.trim().split('\u0000')
    let branch: string | null = null
    try {
      const ref = await runFile(
        'git',
        ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        GIT_OPTS
      )
      const name = ref.stdout.trim()
      branch = name && name !== 'HEAD' ? name : null
    } catch {
      /* unborn or unreadable HEAD — no branch to join on */
    }
    return { exists: true, branch, head: sha ? { sha, subject, at } : null }
  } catch {
    return { exists: false, branch: null, head: null }
  }
}

/**
 * Branch + head commit of one worktree path; `exists: false` when git cannot read it.
 *
 * BUG-240: a path that is not a working tree is answered without a spawn (git's
 * failure is the only answer it could give). A working tree is cached under
 * `(git dir, head sha, symbolic ref)`: the subject and date are fixed by the sha, so
 * a hit is exact and a commit or checkout changes the key.
 */
async function worktreeHead(worktreePath: string): Promise<Omit<WorktreePrJoin, 'prs'>> {
  const dirs = await resolveGitDirs(worktreePath)
  if (dirs === null) return { exists: false, branch: null, head: null }
  if (dirs === UNSURE) return worktreeHeadFromGit(worktreePath)
  const head = await headShaOf(dirs)
  if (head === null || head === UNSURE) return worktreeHeadFromGit(worktreePath)
  const found = await singleFlight(
    headCache,
    [dirs.gitDir, head.sha, head.symbolic].join('\0'),
    () => worktreeHeadFromGit(worktreePath),
    (v) => v.exists
  )
  // A copy per caller: the cached object must not be shared into a mutable result.
  return { ...found, head: found.head ? { ...found.head } : null }
}

/**
 * T358 S6 — the one join `mission_get` reads commits and PRs through (design
 * §7): each linked worktree → its branch, head commit and the PRs whose head is
 * that branch; plus bare branches (a card's `executedIn`) and PR numbers (a
 * `pr` link). The same `gh pr list` the canvas runs ({@link fetchPrs}), asked
 * ONCE for the repo, so a mission with many links costs one round trip — and,
 * through {@link fetchPrsCached}, shared for 60 s by every mission of that repo.
 *
 * Degrades like the canvas: `gh` absent or failing is `ghAvailable: false` with
 * empty PR lists, never a throw. `gh` is not called at all when no ref needs it.
 * A PR number is looked up among the repo's {@link PR_LIST_LIMIT} most recent.
 *
 * `waitMs` bounds how long THIS call waits for `gh` (a door's re-derive): past
 * it the answer is `ghAvailable: false` — the mission reads its sticky
 * last-known states — while the fetch runs on and lands in the cache.
 */
export async function findPrsForWorktrees(
  repoPath: string,
  refs: { worktrees: readonly string[]; branches: readonly string[]; numbers: readonly number[] },
  opts: { waitMs?: number } = {}
): Promise<MissionPrJoin> {
  const heads = await Promise.all(refs.worktrees.map(worktreeHead))
  const wanted = new Set([...refs.branches, ...heads.flatMap((h) => (h.branch ? [h.branch] : []))])
  const needsGh = wanted.size > 0 || refs.numbers.length > 0
  const fetched = needsGh ? await withinBudget(fetchPrsCached(repoPath), opts.waitMs) : null
  const prs = fetched?.prs ?? []
  // A transient failure is "absent or failed" here too: this join has no
  // previous snapshot to fall back on, so it reports what it could not read.
  const ghAvailable = fetched ? fetched.ghAvailable && fetched.ghFailure === null : null
  const onBranch = (branch: string | null): PrEntry[] =>
    branch ? prs.filter((p) => p.branch === branch) : []
  const worktrees: Record<string, WorktreePrJoin> = {}
  // T547: commits are counted from the open PR's base once the PRs are known.
  const commits = await Promise.all(
    refs.worktrees.map((wt, i) =>
      heads[i].head
        ? commitsAhead(wt, onBranch(heads[i].branch).find((p) => p.state === 'OPEN')?.base)
        : undefined
    )
  )
  refs.worktrees.forEach((wt, i) => {
    worktrees[wt] = {
      ...heads[i],
      ...(commits[i] !== undefined ? { commits: commits[i] } : {}),
      prs: onBranch(heads[i].branch)
    }
  })
  const branches: Record<string, PrEntry[]> = {}
  for (const b of refs.branches) branches[b] = onBranch(b)
  const numbers: Record<number, PrEntry | null> = {}
  for (const n of refs.numbers) numbers[n] = prs.find((p) => p.number === n) ?? null
  return { ghAvailable, worktrees, branches, numbers }
}

/** How long a `pending` main-CI verdict is trusted before `gh` is asked again. */
const CI_PENDING_TTL_MS = 60_000
/** How long a finished (or empty) main-CI verdict is trusted — a CI re-run shows within this. */
const CI_FINISHED_TTL_MS = 10 * 60_000

/** A merged PR's merge-commit oid, or `null` when `gh` reports none. */
async function mergeOidOf(repoPath: string, number: number): Promise<string | null> {
  const view = await runFile('gh', ['pr', 'view', String(number), '--json', 'mergeCommit'], {
    ...GH_OPTS,
    cwd: repoPath
  })
  const oid = (JSON.parse(view.stdout) as { mergeCommit?: { oid?: unknown } | null }).mergeCommit
    ?.oid
  return typeof oid === 'string' && oid.length > 0 ? oid : null
}

/** The verdict of commit `oid`'s workflow runs, held per its own freshness window. */
function verdictOf(repoPath: string, oid: string): Promise<GateCi> {
  const key = `${repoPath}#${oid}`
  const hit = verdictCache.get(key)
  if (hit && (hit.settledAt === null || Date.now() - hit.settledAt < hit.ttlMs)) return hit.result
  const fresh = {
    settledAt: null as number | null,
    ttlMs: CI_FINISHED_TTL_MS,
    result: runFile(
      'gh',
      ['run', 'list', '--commit', oid, '--limit', '30', '--json', 'status,conclusion'],
      { ...GH_OPTS, cwd: repoPath }
    ).then(({ stdout }) => ciOfRuns(JSON.parse(stdout) as CiRun[]))
  }
  verdictCache.set(key, fresh)
  fresh.result.then(
    (verdict) => {
      fresh.settledAt = Date.now()
      fresh.ttlMs = verdict === 'pending' ? CI_PENDING_TTL_MS : CI_FINISHED_TTL_MS
    },
    () => {
      if (verdictCache.get(key) === fresh) verdictCache.delete(key)
    }
  )
  return fresh.result
}

/**
 * CI of PR `number`'s merge commit on the default branch; `null` when it cannot be read.
 * BUG-240: the merge commit of a merged PR never changes, so it is asked once per
 * process; the runs are asked again only when their cached verdict has aged out.
 */
async function mainCiOf(repoPath: string, number: number): Promise<GateCi | null> {
  const oid = await singleFlight(
    mergeOidCache,
    `${repoPath}#${number}`,
    () => mergeOidOf(repoPath, number),
    (v) => v !== null
  )
  return oid === null ? null : verdictOf(repoPath, oid)
}

/**
 * Campaign spec §3.2 `main` gate — the CI status of each merged PR's merge commit
 * on the default branch (`gh pr view --json mergeCommit`, then the workflow runs of
 * that commit). Degrades like {@link findPrsForWorktrees}: `gh` absent or failing is
 * `ghAvailable: false` with no answers, never a throw, so the caller reads its sticky
 * last-known value. `waitMs` bounds how long THIS call waits; the lookup keeps running
 * and lands in the caches above.
 */
export async function findMainCi(
  repoPath: string,
  numbers: readonly number[],
  opts: { waitMs?: number } = {}
): Promise<{ ghAvailable: boolean | null; byNumber: Record<number, GateCi | null> }> {
  if (numbers.length === 0) return { ghAvailable: null, byNumber: {} }
  const repo = path.resolve(repoPath)
  const byNumber: Record<number, GateCi | null> = {}
  let failed = false
  const one = async (n: number): Promise<void> => {
    try {
      byNumber[n] = await mainCiOf(repo, n)
    } catch {
      failed = true
    }
  }
  const all = Promise.all(numbers.map(one))
  if (opts.waitMs === undefined) await all
  else {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), opts.waitMs)
    })
    try {
      if ((await Promise.race([all.then(() => 'done' as const), late])) === 'late') failed = true
    } finally {
      clearTimeout(timer)
    }
  }
  return { ghAvailable: !failed, byNumber: failed ? {} : byNumber }
}

/** A `gh`/`git` round-trip for a link click must not stall the click for long. */
const LINK_OPTS = { windowsHide: true, timeout: 5_000, maxBuffer: 1 << 20 } as const

/**
 * Option+click on a PR link in a transcript: the PR number when `url` is an
 * OPEN pull request of this folder's own repo, else `null` (the renderer then
 * falls back to the browser). Never rejects — a missing or unauthenticated
 * `gh`, a timeout or any other error is simply "not resolvable".
 */
async function resolvePrLink(
  folderPath: unknown,
  url: unknown
): Promise<{ prNumber: number } | null> {
  if (typeof folderPath !== 'string' || !folderPath || typeof url !== 'string') return null
  try {
    const { stdout: remote } = await runFile(
      'git',
      ['-C', folderPath, 'remote', 'get-url', 'origin'],
      LINK_OPTS
    )
    const prNumber = matchPrLinkToRemote(remote, url)
    if (prNumber === null) return null
    const { stdout } = await runFile('gh', ['pr', 'view', String(prNumber), '--json', 'state'], {
      ...LINK_OPTS,
      cwd: folderPath
    })
    return isOpenPrViewJson(stdout) ? { prNumber } : null
  } catch {
    return null
  }
}

/** Registers the renderer-facing channels. Called once from `src/main/index.ts`. */
export function registerPrStack(): void {
  ipcMain.handle(
    'pr-stack:load',
    async (_e, repoPath: string, worktrees?: WorktreeNode[]): Promise<PrStackSnapshot> =>
      loadPrStack(repoPath, Array.isArray(worktrees) ? worktrees : [])
  )
  ipcMain.handle('pr-stack:resolveLink', (_e, folderPath: unknown, url: unknown) =>
    resolvePrLink(folderPath, url)
  )
  // Whole-object GET/PUT, same contract shape as the Reaper's prefs verbs —
  // the normalization on the way in is what makes a corrupt file harmless.
  ipcMain.handle('pr-stack:prefs', async (): Promise<PrStackPrefs> => readPrefs())
  ipcMain.handle('pr-stack:setPrefs', async (_e, raw: unknown): Promise<PrStackPrefs> =>
    writePrefs(raw)
  )
}
